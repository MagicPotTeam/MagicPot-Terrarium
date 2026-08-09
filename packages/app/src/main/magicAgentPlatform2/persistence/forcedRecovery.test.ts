import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
vi.mock('node:fs/promises', async (importActual) => importActual())
import { PersistentRuntimeChannelStore } from '../channels/persistentRuntimeChannelStore'
import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import { recoverEventStoreRestore } from './backupRestore'
import { _crashTesting, type CrashStage } from './crashHooks'
import { MagicAgentEventStore, type ResourceKind } from './eventStore'

const require = createRequire(import.meta.url)
const root = resolve(__dirname, '../../../../../..')
let directory: string
let workerBundle: string
let electronPath: string

function event(id: string, sequence = 0): MagicAgentEvent<unknown> {
  return {
    protocolVersion: '2.0.0',
    envelopeKind: 'event',
    id,
    streamId: 'forced-stream',
    sequence,
    type: 'forced.event',
    createdAt: 1_700_000_000_000 + sequence,
    payload: { id }
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'magic-agent-forced-recovery-'))
  workerBundle = join(directory, 'crash-worker.cjs')
  electronPath = require('electron') as string
  await build({
    entryPoints: [join(__dirname, 'crashWorker.ts')],
    outfile: workerBundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:sqlite']
  })
})

afterAll(async () => {
  _crashTesting.setHook(null)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (
        !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') ||
        attempt === 99
      )
        throw error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
}, 30_000)

async function runToCompletion(operation: string, databasePath: string): Promise<void> {
  const child = spawn(electronPath, [workerBundle], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MAGIC_CRASH_OPERATION: operation,
      MAGIC_CRASH_STAGE: 'unused',
      MAGIC_CRASH_DB: databasePath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let errors = ''
  child.stderr?.on('data', (chunk) => (errors += String(chunk)))
  const code = await new Promise<number | null>((resolveExit) => child.once('exit', resolveExit))
  if (code !== 0) throw new Error(`Worker ${operation} failed (${code}): ${errors}`)
}

async function killAt(
  operation: string,
  stage: string,
  databasePath: string,
  targetPath = '',
  backupPath = '',
  envExtras: NodeJS.ProcessEnv = {}
): Promise<void> {
  const child = spawn(electronPath, [workerBundle], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MAGIC_CRASH_OPERATION: operation,
      MAGIC_CRASH_STAGE: stage,
      MAGIC_CRASH_DB: databasePath,
      MAGIC_CRASH_TARGET: targetPath,
      MAGIC_CRASH_BACKUP: backupPath,
      ...envExtras
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  try {
    await waitReady(child, stage)
  } finally {
    await terminateChild(child)
  }
}

function killResourceAt(
  stage: string,
  databasePath: string,
  kind: ResourceKind,
  id: string
): Promise<void> {
  return killAt('resource', stage, databasePath, '', '', {
    MAGIC_CRASH_RESOURCE_KIND: kind,
    MAGIC_CRASH_RESOURCE_ID: id
  })
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    const killed = await Promise.race([
      new Promise<boolean>((resolveExit) => killer.once('exit', () => resolveExit(true))),
      new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 10_000))
    ])
    if (!killed) {
      killer.kill()
      throw new Error(`Timed out terminating crash worker ${child.pid}.`)
    }
    return
  }
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  child.kill('SIGKILL')
  const terminated = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 10_000))
  ])
  if (!terminated) throw new Error(`Crash worker ${child.pid ?? 'unknown'} did not exit.`)
}

function waitReady(child: ChildProcess, stage: string): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let errors = ''
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for READY:${stage}; stderr=${errors}`))
    }, 10_000)
    child.stderr?.on('data', (chunk) => (errors += String(chunk)))
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
      if (output.includes(`READY:${stage}\n`)) {
        clearTimeout(timer)
        resolveReady()
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Crash worker exited early (${code}); stderr=${errors}`))
    })
  })
}

async function retry<T>(work: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      return await work()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }
}

it('reopens durable Runtime Channel membership in the real Electron child-process path', async () => {
  const path = join(directory, 'channel-membership.sqlite')
  await runToCompletion('channel-membership', path)
  const events = await retry(() => new MagicAgentEventStore(path))
  const channels = new PersistentRuntimeChannelStore(events)
  expect(channels.getChannel('forced-channel')?.state.members).toEqual([
    {
      memberId: 'consumer',
      agentInstanceId: 'agent',
      role: 'consumer',
      joinedAt: 1_700_000_000_001
    }
  ])
  events.close()
}, 60_000)

for (const stage of ['event.before-commit', 'event.after-commit'] as const) {
  it(`recovers a killed event worker at ${stage}`, async () => {
    const path = join(directory, `${stage}.sqlite`)
    await killAt('event', stage, path)
    const store = await retry(() => new MagicAgentEventStore(path))
    expect(store.countEvents()).toBe(stage.endsWith('before-commit') ? 0 : 1)
    if (stage.endsWith('after-commit'))
      expect(store.getEvent('forced-event-0')?.payload).toEqual({
        deterministic: true,
        sequence: 0
      })
    store.close()
  }, 60_000)
}

for (const stage of ['snapshot.before-commit', 'snapshot.after-commit'] as const) {
  it(`recovers a killed snapshot worker at ${stage}`, async () => {
    const path = join(directory, `${stage}.sqlite`)
    const seed = new MagicAgentEventStore(path)
    seed.appendBatch([event('forced-event-0')])
    seed.close()
    await killAt('snapshot', stage, path)
    const store = await retry(() => new MagicAgentEventStore(path))
    expect(store.getLatestSnapshot('forced-stream')).toEqual(
      stage.endsWith('before-commit')
        ? undefined
        : expect.objectContaining({ snapshotId: 'forced-snapshot' })
    )
    expect(store.readStream('forced-stream')).toHaveLength(1)
    store.close()
  }, 60_000)
}

for (const stage of ['resource.before-commit', 'resource.after-commit'] as const) {
  it(`recovers a killed resource worker at ${stage}`, async () => {
    const path = join(directory, `${stage}.sqlite`)
    await killAt('resource', stage, path)
    const store = await retry(() => new MagicAgentEventStore(path))
    const committed = stage.endsWith('after-commit')
    expect(store.countEvents()).toBe(committed ? 1 : 0)
    expect(store.countResources()).toBe(committed ? 1 : 0)
    expect(store.listResourceMutations('session', 'forced-resource')).toHaveLength(
      committed ? 1 : 0
    )
    store.close()
  }, 60_000)
}

const boundaryKinds: ReadonlyArray<Readonly<{ label: string; kind: ResourceKind }>> = [
  { label: 'Model', kind: 'model-call' },
  { label: 'Tool', kind: 'tool-call' },
  { label: 'Agent', kind: 'agent' },
  { label: 'Channel', kind: 'channel' },
  { label: 'Drive', kind: 'drive' }
]

for (const { label, kind } of boundaryKinds) {
  for (const stage of ['resource.before-commit', 'resource.after-commit'] as const) {
    it(`recovers a killed ${label} boundary at ${stage}`, async () => {
      const id = `forced-${kind}`
      const path = join(directory, `${kind}-${stage}.sqlite`)
      await killResourceAt(stage, path, kind, id)
      const store = await retry(() => new MagicAgentEventStore(path))
      try {
        const committed = stage === 'resource.after-commit'
        expect(store.countEvents()).toBe(committed ? 1 : 0)
        expect(store.countResources()).toBe(committed ? 1 : 0)
        expect(store.getResource(kind, id)).toEqual(
          committed
            ? expect.objectContaining({ state: { boundary: kind, deterministic: true } })
            : undefined
        )
        expect(store.listResourceMutations(kind, id)).toHaveLength(committed ? 1 : 0)
      } finally {
        store.close()
      }
    }, 60_000)
  }
}

for (const stage of ['backup.after-partial', 'backup.after-publish'] as const) {
  it(`recovers a killed backup worker at ${stage}`, async () => {
    const sourcePath = join(directory, `${stage}-source.sqlite`)
    const targetPath = join(directory, `${stage}-backup.sqlite`)
    const seed = new MagicAgentEventStore(sourcePath)
    seed.appendBatch([event(`seed-${stage}`)])
    seed.close()
    await killAt('backup', stage, sourcePath, targetPath)
    const source = await retry(() => new MagicAgentEventStore(sourcePath))
    expect(source.countEvents()).toBe(1)
    const manifest = await source.createBackup(targetPath)
    source.close()
    expect(manifest.backupPath).toBe(resolve(targetPath))
    const backup = new MagicAgentEventStore(targetPath)
    expect(backup.countEvents()).toBe(1)
    backup.close()
    expect(existsSync(`${targetPath}.backup-journal.json`)).toBe(false)
    expect(
      readdirSync(directory).some((name) => name.includes(`.${stage}-backup.sqlite.partial-`))
    ).toBe(false)
  }, 60_000)
}

for (const stage of ['rollback-linking', 'target-removing', 'target-linking'] as const) {
  it(`recovers a killed restore worker at ${stage}`, async () => {
    const sourcePath = join(directory, `${stage}-new.sqlite`)
    const backupPath = join(directory, `${stage}-backup.sqlite`)
    const targetPath = join(directory, `${stage}-target.sqlite`)
    const source = new MagicAgentEventStore(sourcePath)
    source.appendBatch([event(`new-${stage}`)])
    await source.createBackup(backupPath)
    source.close()
    const target = new MagicAgentEventStore(targetPath)
    target.appendBatch([event(`old-${stage}`)])
    target.close()
    await killAt('restore', stage, targetPath, targetPath, backupPath)
    await retry(() => recoverEventStoreRestore(targetPath))
    const recovered = await retry(() => new MagicAgentEventStore(targetPath))
    try {
      expect(recovered.countEvents()).toBe(1)
      const shouldUseNew = stage === 'target-linking'
      const newEvent = recovered.getEvent(`new-${stage}`)
      const oldEvent = recovered.getEvent(`old-${stage}`)
      if (shouldUseNew) {
        expect(newEvent).toBeDefined()
        expect(oldEvent).toBeUndefined()
      } else {
        expect(newEvent).toBeUndefined()
        expect(oldEvent).toBeDefined()
      }
    } finally {
      recovered.close()
    }
    const rollbacks = readdirSync(directory).filter((name) =>
      name.startsWith(`${stage}-target.sqlite.rollback-`)
    )
    expect(rollbacks.length).toBe(
      stage === 'rollback-linking' ? 1 : stage === 'target-removing' ? 1 : 1
    )
    const backup = new MagicAgentEventStore(backupPath)
    expect(backup.getEvent(`new-${stage}`)).toBeDefined()
    backup.close()
  }, 60_000)
}

for (const [stage, operation] of [
  [
    'event.after-commit',
    () => new MagicAgentEventStore(':memory:').appendBatch([event('throw-event')])
  ],
  [
    'snapshot.after-commit',
    () => {
      const store = new MagicAgentEventStore(':memory:')
      store.appendBatch([event('throw-snapshot')])
      return store.appendSnapshot({
        snapshotId: 'throw-snapshot',
        streamId: 'forced-stream',
        snapshotVersion: 0,
        coveredSequence: 0,
        stateType: 'state',
        state: {},
        createdAt: 1
      })
    }
  ],
  [
    'resource.after-commit',
    () =>
      new MagicAgentEventStore(':memory:').mutateResource({
        operation: 'create',
        kind: 'session',
        id: 'throw-resource',
        idempotencyKey: 'throw-resource',
        state: {},
        createdAt: 1,
        event: event('throw-resource')
      })
  ]
] as const) {
  it(`propagates ${stage} hook failures after durable commit`, () => {
    _crashTesting.setHook((current) => {
      if (current === stage) throw new Error('after-commit failure')
    })
    expect(operation).toThrow('after-commit failure')
    _crashTesting.setHook(null)
  })
}
