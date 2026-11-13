import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Dir, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync, linkSync, truncateSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import { createTerminalPolicyRequest, type PolicyRule } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { CommandJobsToolHost, type CommandJobsSpawnProcess } from './commandJobs'
import { createWindowsJobObjectConfinementAdapter } from './windowsJobObjectConfinement'

const stores: MagicAgentEventStore[] = []
const roots: string[] = []
const approver = { kind: 'user', id: 'user' } as const
function mkdirRealTemp(): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), 'magic-command-jobs-')))
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid: number
  killed = false
  readonly killSignals: (NodeJS.Signals | number | undefined)[] = []

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    this.killSignals.push(signal)
    queueMicrotask(() => this.close(null, typeof signal === 'string' ? signal : 'SIGTERM'))
    return true
  }

  unref(): void {
    // Faithful no-op for the injected ChildProcess harness.
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, signal)
  }
}

type SpawnCall = Readonly<{
  command: string
  args: readonly string[]
  options: SpawnOptions
  child: FakeChildProcess
}>

function createFakeSpawner() {
  const calls: SpawnCall[] = []
  let nextPid = 4100
  const spawnProcess = ((
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {}
  ) => {
    const child = new FakeChildProcess(nextPid++)
    calls.push({ command, args: [...args], options, child })
    queueMicrotask(() => {
      if (!args.includes('--spawn-error')) child.emit('spawn')
      if (path.basename(command).toLowerCase() === 'taskkill.exe') {
        const pid = Number(args[args.indexOf('/PID') + 1])
        calls.find((call) => call.child.pid === pid)?.child.close(null, 'SIGTERM')
        child.close(0)
        return
      }
      if (args.includes('--spawn-error')) {
        Object.defineProperty(child, 'pid', { value: undefined })
        child.emit('error', new Error('fake executable unavailable'))
        child.close(0)
        return
      }
      if (args.includes('--hang')) return
      if (args.includes('--combined-limit')) {
        child.stdout.write('123456')
        child.stderr.write('abcdef')
        return
      }
      child.stdout.write('token=super')
      queueMicrotask(() => {
        child.stdout.write('-secret\nsecond')
        child.stderr.write('warning\n')
        child.close(args.includes('--fail') ? 7 : 0)
      })
    })
    return child as unknown as ChildProcess
  }) as CommandJobsSpawnProcess
  return { calls, spawnProcess }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(
  spawnProcess: CommandJobsSpawnProcess = createFakeSpawner().spawnProcess,
  audit: boolean | 'file' = false,
  resourceConstraints?: Readonly<{
    metadata?: Record<string, boolean | number>
    allowedToolNames?: string[]
    networkHosts?: string[]
  }>,
  confinementAdapter?: import('./commandJobs').CommandJobsConfinementAdapter,
  command = 'fake-command'
) {
  const root = mkdirRealTemp()
  mkdirSync(root, { recursive: true })
  roots.push(root)
  const rule: PolicyRule = {
    ruleId: 'background',
    priority: 1,
    effect: 'require-approval',
    explanation: 'test',
    constraints: {
      requireNoShell: true,
      allowedToolNames: ['commands.background'],
      maxTimeoutMs: 2000,
      maxOutputChars: 65536,
      ...(resourceConstraints ?? {})
    },
    approvalRequirement: {
      scopeKind: 'request',
      scopeValue: '*',
      maxUses: 1,
      expiresInMs: 60_000,
      reason: 'test'
    }
  }
  const databasePath = audit === 'file' ? path.join(root, 'events.sqlite') : ':memory:'
  const policyStore = new MagicAgentEventStore(':memory:')
  stores.push(policyStore)
  const auditStore = audit
    ? audit === 'file'
      ? new MagicAgentEventStore(databasePath)
      : new MagicAgentEventStore(':memory:')
    : policyStore
  if (auditStore !== policyStore) stores.push(auditStore)
  const authorization = new MagicAgentPolicyAuthorizationService({
    store: policyStore,
    rules: [rule],
    policyVersion: '1',
    storeId: root,
    trustedApprovers: [approver]
  })
  const host = new CommandJobsToolHost(authorization, {
    workspaceRoot: root,
    allowedCommands: [command],
    allowedEnvironmentKeys: ['TEST_VALUE'],
    spawnProcess,
    ...(audit ? { auditSink: auditStore } : {}),
    ...(confinementAdapter ? { confinementAdapter } : {})
  })
  return {
    root,
    authorization,
    host,
    command,
    store: auditStore,
    policyStore,
    databasePath
  }
}

function approved(
  root: string,
  authorization: MagicAgentPolicyAuthorizationService,
  args: string[],
  command = 'fake-command'
) {
  const request = createTerminalPolicyRequest({
    requestId: `request-${Math.random()}`,
    actor: { kind: 'agent', id: 'agent' },
    target: { kind: 'tool', id: 'commands.background' },
    command,
    args,
    cwd: root,
    filesystem: { cwd: root, allowedRoots: [root] }
  })
  const grantId = `grant-${Math.random()}`
  authorization.createApprovalGrant({
    grantId,
    request,
    approvedBy: approver,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    maxUses: 1,
    idempotencyKey: grantId
  })
  return {
    authorizationId: `auth-${Math.random()}`,
    idempotencyKey: `exec-${Math.random()}`,
    request,
    routeKey: 'route',
    sessionId: 'session',
    command,
    args,
    cwd: root,
    grantId,
    expectedGrantUseCount: 0
  }
}

async function waitFor(host: CommandJobsToolHost, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const status = host.status({ jobId, routeKey: 'route', sessionId: 'session' })
    if (!['starting', 'running'].includes(status.state)) return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('job did not settle')
}

describe('CommandJobsToolHost', () => {
  it.each<Record<string, number | boolean>>([
    {}, { maxMemoryBytes: 1024 }, { maxCpuTimeMs: 100 },
    { maxMemoryBytes: 2048, maxCpuTimeMs: 100 }, { maxMemoryBytes: 1024, maxCpuTimeMs: 200 }
  ])('refuses missing or weakened mandatory execution caps before permit consumption: %j', async (metadata) => {
    const fake = createFakeSpawner(), { root, authorization, policyStore } = setup(fake.spawnProcess, false, { metadata })
    const prepare = vi.fn(() => fake.spawnProcess)
    const host = new CommandJobsToolHost(authorization, { workspaceRoot: root, spawnProcess: fake.spawnProcess,
      mandatoryResourceLimits: { maxMemoryBytes: 1024, maxCpuTimeMs: 100 },
      confinementAdapter: { platform: 'test', capabilities: { memory: true, cpu: true, processCount: false, networkDeny: false, networkHosts: false }, prepare }
    })
    const input = approved(root, authorization, ['--output'])
    await expect(host.background(input)).rejects.toThrow('mandatory resource cap')
    expect(fake.calls).toHaveLength(0); expect(prepare).not.toHaveBeenCalled()
    expect(policyStore.getResource<{ consumed: boolean }>('policy-audit', input.authorizationId)?.state.consumed).toBe(false)
  })
  it('uses the confinement adapter with actual mandatory permit caps, including tighter caps', async () => {
    const fake = createFakeSpawner(), { root, authorization } = setup(fake.spawnProcess, false, { metadata: { maxMemoryBytes: 512, maxCpuTimeMs: 50 } })
    const bypass = vi.fn(), prepare = vi.fn(() => fake.spawnProcess)
    const host = new CommandJobsToolHost(authorization, { workspaceRoot: root, spawnProcess: bypass as unknown as CommandJobsSpawnProcess,
      mandatoryResourceLimits: { maxMemoryBytes: 1024, maxCpuTimeMs: 100 },
      confinementAdapter: { platform: 'test', capabilities: { memory: true, cpu: true, processCount: false, networkDeny: false, networkHosts: false }, prepare }
    })
    const job = await host.background(approved(root, authorization, ['--output']))
    expect(await waitFor(host, job.jobId)).toMatchObject({ state: 'completed' })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ metadata: { maxMemoryBytes: 512, maxCpuTimeMs: 50 } }))
    expect(bypass).not.toHaveBeenCalled(); expect(fake.calls).toHaveLength(1)
  })
  it.each(['python.run', 'shell.execute', 'notebook.execute-cell'])('rejects a commands request with a permit restricted to %s before spawn', async (allowedName) => {
    const fake = createFakeSpawner(), { root, authorization, host, policyStore } = setup(fake.spawnProcess, false, { allowedToolNames: [allowedName] })
    const input = approved(root, authorization, ['--output'])
    await expect(host.background(input)).rejects.toThrow('exact requested process tool')
    expect(fake.calls).toEqual([])
    expect(policyStore.getResource<{ consumed: boolean }>('policy-audit', input.authorizationId)?.state.consumed).toBe(false)
  })
  it('bounds orphan discovery at the directory iterator instead of materializing an entire directory', () => {
    const { root, authorization } = setup()
    const dir = path.join(root, '.magicpot/command-jobs')
    for (let i = 0; i < 600; i++) writeFileSync(path.join(dir, `ignored-${i}.txt`), '')
    const read = vi.spyOn(Dir.prototype, 'readSync')
    new CommandJobsToolHost(authorization, { workspaceRoot: root })
    expect(read.mock.calls.length).toBeLessThanOrEqual(512)
    expect(read.mock.calls.length).toBeGreaterThan(0)
  })
  it('keeps live identity/state authoritative when executable-writable job JSON is forged or deleted', async () => {
    const fake = createFakeSpawner(), { root, authorization, host } = setup(fake.spawnProcess)
    const input = approved(root, authorization, ['--hang']), job = await host.background(input)
    const file = path.join(root, '.magicpot/command-jobs', `${job.jobId}.json`)
    writeFileSync(file, JSON.stringify({ ...job, state: 'completed', outcome: 'known', routeKey: 'foreign', sessionId: 'foreign' }))
    expect(host.status({ ...input, jobId: job.jobId })).toMatchObject({ state: 'running', routeKey: 'route' })
    await expect(host.stop({ jobId: job.jobId, routeKey: 'foreign', sessionId: 'foreign' })).rejects.toThrow('outside')
    unlinkSync(file)
    expect(await host.stop({ ...input, jobId: job.jobId })).toMatchObject({ state: 'stopped', outcome: 'known' })
    if (process.platform === 'win32') expect(fake.calls.some((call) => path.isAbsolute(call.command) && path.basename(call.command).toLowerCase() === 'taskkill.exe')).toBe(true)
  })
  it('owns and terminates a spawned child even if the first post-spawn persistence fails', async () => {
    const fake = createFakeSpawner()
    let rootForSpawn = ''
    const spawnProcess = ((command, args, options) => {
      const child = fake.spawnProcess(command, args, options)
      if (path.basename(command).toLowerCase() !== 'taskkill.exe') rmSync(path.join(rootForSpawn, '.magicpot/command-jobs'), { recursive: true, force: true })
      return child
    }) as CommandJobsSpawnProcess
    const { root, authorization, host } = setup(spawnProcess); rootForSpawn = root
    const onOwned = vi.fn(), onStarted = vi.fn()
    await expect(host.background({ ...approved(root, authorization, ['--hang']), onOwned, onStarted })).rejects.toThrow('setup failed after spawn')
    expect(onOwned).toHaveBeenCalledOnce(); expect(onStarted).not.toHaveBeenCalled()
    expect(host.status({ jobId: onOwned.mock.calls[0][0].jobId, routeKey: 'route', sessionId: 'session' }).state).not.toBe('running')
    expect(fake.calls).toHaveLength(process.platform === 'win32' ? 2 : 1)
    if (process.platform === 'win32') expect(() => host.assertNoUncertainStop()).not.toThrow()
  })
  it('rejects replaced/linked or oversized logs before allocating an unbounded read', async () => {
    const fake = createFakeSpawner(), { root, authorization, host } = setup(fake.spawnProcess)
    const input = approved(root, authorization, ['--output']), job = await host.background(input)
    await waitFor(host, job.jobId)
    const file = path.join(root, '.magicpot/command-jobs', `${job.jobId}.stdout.log`)
    truncateSync(file, 8 * 1024 * 1024)
    expect(() => host.read({ ...input, jobId: job.jobId, stream: 'stdout', maxBytes: 16 })).toThrow('bound')
    unlinkSync(file)
    const outside = path.join(root, 'outside.txt'); writeFileSync(outside, 'MUST_NOT_READ')
    linkSync(outside, file)
    expect(() => host.read({ ...input, jobId: job.jobId, stream: 'stdout', maxBytes: 16 })).toThrow('linked')
  })
  it('stops on output-storage failure without uncaught stream exceptions or losing child ownership', async () => {
    const fake = createFakeSpawner(), { root, authorization, host } = setup(fake.spawnProcess)
    const input = approved(root, authorization, ['--hang']), job = await host.background(input)
    const file = path.join(root, '.magicpot/command-jobs', `${job.jobId}.stdout.log`)
    writeFileSync(file, 'foreign log bytes')
    expect(() => fake.calls[0].child.stdout.write('x'.repeat(1000))).not.toThrow()
    const stopped = await host.stop({ ...input, jobId: job.jobId })
    expect(stopped).toMatchObject({ state: 'failed', logsTruncated: true, outcome: 'known' })
    expect(() => host.assertNoUncertainStop()).not.toThrow()
  })
  it('runs the synchronous final hook after asynchronous preparation before consuming or spawning', async () => {
    const fake = createFakeSpawner(), { root, authorization, host, policyStore } = setup(fake.spawnProcess)
    const input = approved(root, authorization, ['--hang'])
    await expect(host.background({ ...input, beforeConsume: async () => undefined, beforeDispatch: () => { throw new Error('revoked') } })).rejects.toThrow('revoked')
    expect(fake.calls).toEqual([])
    expect(policyStore.getResource<{ consumed: boolean }>('policy-audit', input.authorizationId)?.state.consumed).toBe(false)
    expect(readdirSync(path.join(root, '.magicpot/command-jobs')).length).toBeGreaterThan(0)
  })
  it('persists completion and supports bounded cursor reads with cross-chunk redaction', async () => {
    const fake = createFakeSpawner()
    const { root, authorization, host } = setup(fake.spawnProcess)
    const input = approved(root, authorization, ['--output'])
    const job = await host.background({ ...input, env: { TEST_VALUE: 'kept' } })
    const settled = await waitFor(host, job.jobId)

    expect(settled).toMatchObject({ state: 'completed', outcome: 'known', exitCode: 0 })
    expect(fake.calls[0]).toMatchObject({ command: 'fake-command', args: ['--output'] })
    expect(fake.calls[0].options).toMatchObject({ cwd: root, shell: false })
    expect(fake.calls[0].options.env).toMatchObject({ TEST_VALUE: 'kept' })

    const first = host.read({
      jobId: job.jobId,
      routeKey: 'route',
      sessionId: 'session',
      stream: 'stdout',
      maxBytes: 12
    })
    const second = host.read({
      jobId: job.jobId,
      routeKey: 'route',
      sessionId: 'session',
      stream: 'stdout',
      cursor: first.nextCursor
    })
    expect(first.data + second.data).toContain('[REDACTED]')
    expect(first.data + second.data).not.toContain('super-secret')
    expect(second.eof).toBe(true)
    expect(host.read({ ...input, jobId: job.jobId, stream: 'stderr' }).data).toBe('warning\n')
    await expect(host.background(input)).rejects.toThrow()
  })

  it('atomically rechecks capacity after concurrent pre-consumption awaits without consuming losing permits', async () => {
    const fake = createFakeSpawner()
    const { root, authorization } = setup(fake.spawnProcess)
    const host = new CommandJobsToolHost(authorization, { workspaceRoot: root, spawnProcess: fake.spawnProcess, maxConcurrentJobs: 1 })
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const one = approved(root, authorization, ['--hang']), two = approved(root, authorization, ['--hang'])
    const first = host.background({ ...one, beforeConsume: () => gate })
    const second = host.background({ ...two, beforeConsume: () => gate }).catch((error) => error)
    resume()
    const job = await first
    expect(await second).toMatchObject({ message: expect.stringContaining('Concurrent') })
    expect(fake.calls.filter((call) => path.basename(call.command).toLowerCase() !== 'taskkill.exe')).toHaveLength(1)
    await host.stop({ ...one, jobId: job.jobId })
  })

  it('refuses dispatch after an await when another owned process enters termination', async () => {
    const fake = createFakeSpawner()
    const { root, authorization, host } = setup(fake.spawnProcess)
    const first = approved(root, authorization, ['--hang']), second = approved(root, authorization, ['--hang'])
    const job = await host.background(first)
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const pending = host.background({ ...second, beforeConsume: () => gate }).catch((error) => error)
    const stopped = host.stop({ ...first, jobId: job.jobId })
    resume()
    expect(await pending).toMatchObject({ message: expect.stringContaining('termination') })
    await stopped
    expect(fake.calls.filter((call) => path.basename(call.command).toLowerCase() !== 'taskkill.exe')).toHaveLength(1)
  })

  it.runIf(process.platform === 'win32')('keeps a nonzero termination controller exit unknown even when the owned child has closed', async () => {
    const fake = createFakeSpawner()
    const spawnProcess = ((command, args, options) => {
      if (path.basename(String(command)).toLowerCase() !== 'taskkill.exe') return fake.spawnProcess(command, args, options)
      const killer = new FakeChildProcess(9900)
      queueMicrotask(() => { fake.calls[0].child.close(1); killer.close(128) })
      return killer as unknown as ChildProcess
    }) as CommandJobsSpawnProcess
    const { root, authorization, host } = setup(spawnProcess)
    const input = approved(root, authorization, ['--hang']), job = await host.background(input)
    const stopped = await host.stop({ ...input, jobId: job.jobId })
    expect(stopped).toMatchObject({ state: 'stopped', outcome: 'unknown', termination: { controllerExitCode: 128, controllerTimedOut: false, controllerFailed: false, childClosed: true } })
    expect(() => host.assertNoUncertainStop()).toThrow('unconfirmed')
    expect(await host.stop({ ...input, jobId: job.jobId })).toMatchObject({ outcome: 'unknown' })
  })
  it('shares one termination completion for abort and an immediately repeated explicit stop', async () => {
    const fake = createFakeSpawner()
    const { root, authorization, host } = setup(fake.spawnProcess)
    const input = approved(root, authorization, ['--hang']), controller = new AbortController()
    const job = await host.background({ ...input, signal: controller.signal })
    controller.abort()
    const stopped = await host.stop({ ...input, jobId: job.jobId })
    expect(stopped).toMatchObject({ state: 'stopped', outcome: 'known' })
    expect(fake.calls.filter((call) => path.basename(call.command).toLowerCase() === 'taskkill.exe')).toHaveLength(process.platform === 'win32' ? 1 : 0)
    expect(() => host.assertNoUncertainStop()).not.toThrow()
  })

  it('terminates the process tree when combined output exceeds the enforced bound', async () => {
    const fake = createFakeSpawner()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { root, authorization, host } = setup(fake.spawnProcess)
    const job = await host.background({
      ...approved(root, authorization, ['--combined-limit']),
      maxLogBytes: 8
    })
    const settled = await waitFor(host, job.jobId)

    expect(settled).toMatchObject({
      state: 'failed',
      outcome: 'known',
      stopOutcome: 'output-limit',
      logsTruncated: true
    })
    if (process.platform === 'win32') {
      expect(
        fake.calls.some((call) => path.basename(call.command).toLowerCase() === 'taskkill.exe' && call.args.includes('/T'))
      ).toBe(true)
    } else {
      expect(kill).toHaveBeenCalledWith(-fake.calls[0].child.pid, 'SIGTERM')
    }
    fake.calls[0].child.close(null, 'SIGTERM')
  })

  it('persists ordered content-free audit events for command lifecycle', async () => {
    const fake = createFakeSpawner()
    const { root, authorization, host, store } = setup(fake.spawnProcess, true)
    const job = await host.background(approved(root, authorization, ['--output']))
    await waitFor(host, job.jobId)

    const events = store.readStream(`command-job:${job.jobId}`)
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [0, 'command-job.started'],
      [1, 'command-job.completed']
    ])
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('fake-command')
    expect(serialized).not.toContain('--output')
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('route')
    expect(serialized).not.toContain('session')
  })

  it('survives SQLite close/reopen without persisting command or output content', async () => {
    const fake = createFakeSpawner()
    const { root, authorization, host, store, databasePath } = setup(fake.spawnProcess, 'file')
    const job = await host.background(approved(root, authorization, ['--output']))
    await waitFor(host, job.jobId)
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const reopened = new MagicAgentEventStore(databasePath)
    stores.push(reopened)
    expect(reopened.readStream(`command-job:${job.jobId}`).map((event) => event.type)).toEqual([
      'command-job.started',
      'command-job.completed'
    ])
    const sqlite = readFileSync(databasePath).toString('latin1')
    for (const content of [
      'fake-command',
      '--output',
      'super-secret',
      'warning',
      root,
      'route',
      'session'
    ])
      expect(sqlite).not.toContain(content)
  })

  it.each<
    [
      string,
      Readonly<{
        metadata?: Record<string, boolean | number>
        networkHosts?: string[]
      }>
    ]
  >([
    ['memory', { metadata: { maxMemoryBytes: 1024 } }],
    ['cpu', { metadata: { maxCpuTimeMs: 100 } }],
    ['process count', { metadata: { maxProcessCount: 1 } }],
    ['network deny', { metadata: { denyNetwork: true } }],
    ['network host allowlist', { networkHosts: ['example.com'] }]
  ])(
    'fails closed before spawn when %s confinement is requested but unavailable',
    async (_name, metadata) => {
      const fake = createFakeSpawner()
      const { root, authorization, host, policyStore } = setup(fake.spawnProcess, false, metadata)
      const input = approved(root, authorization, ['--hang'])
      await expect(host.background(input)).rejects.toThrow(/confinement is unavailable/)
      expect(fake.calls).toHaveLength(0)
      const audit = policyStore.getResource<{ consumed: boolean; status: string }>(
        'policy-audit',
        input.authorizationId
      )
      expect(audit?.state).toMatchObject({ consumed: false, status: 'authorized' })
    }
  )

  it('delegates requested confinement to an explicit adapter after authorization and before permit consumption', async () => {
    const normal = createFakeSpawner()
    const confined = createFakeSpawner()
    const validate = vi.fn()
    const { root, authorization, host, policyStore } = setup(
      normal.spawnProcess,
      false,
      { metadata: { maxMemoryBytes: 1024 } },
      {
        platform: 'test-sandbox',
        capabilities: {
          memory: true,
          cpu: true,
          processCount: true,
          networkDeny: true,
          networkHosts: true
        },
        prepare: (constraints) => {
          validate(constraints)
          return confined.spawnProcess
        }
      }
    )
    const input = approved(root, authorization, ['--output'])
    await host.background(input)

    expect(validate).toHaveBeenCalledOnce()
    expect(normal.calls).toHaveLength(0)
    expect(confined.calls).toHaveLength(1)
    expect(
      policyStore.getResource<{ consumed: boolean }>('policy-audit', input.authorizationId)?.state
    ).toMatchObject({ consumed: true })
  })

  it.runIf(
    process.platform === 'win32' &&
      existsSync(
        path.resolve(
          process.cwd(),
          'packages/runtime-assets/resources/bin/magicpot-command-job/magicpot-command-job.exe'
        )
      )
  )(
    'runs the production CommandJobs path through the verified Windows Job Object helper',
    async () => {
      const helper = path.resolve(
        process.cwd(),
        'packages/runtime-assets/resources/bin/magicpot-command-job/magicpot-command-job.exe'
      )
      const adapter = createWindowsJobObjectConfinementAdapter('win32', [helper])
      expect(adapter).toBeDefined()
      const constraints = {
        metadata: {
          maxMemoryBytes: 512 * 1024 * 1024,
          maxCpuTimeMs: 5_000,
          maxProcessCount: 2
        }
      }
      const { root, authorization, host, policyStore } = setup(
        createFakeSpawner().spawnProcess,
        false,
        constraints,
        adapter,
        process.execPath
      )
      const input = approved(
        root,
        authorization,
        ['-e', "process.stdout.write('job-object-production-path')"],
        process.execPath
      )
      const job = await host.background(input)
      const settled = await waitFor(host, job.jobId)

      expect(settled).toMatchObject({ state: 'completed', outcome: 'known', exitCode: 0 })
      expect(
        host.read({ jobId: job.jobId, routeKey: 'route', sessionId: 'session', stream: 'stdout' })
          .data
      ).toBe('job-object-production-path')
      expect(
        policyStore.getResource<{ consumed: boolean }>('policy-audit', input.authorizationId)?.state
      ).toMatchObject({ consumed: true })
    },
    20_000
  )

  it('rejects adapter capability mismatches before permit consumption or spawn', async () => {
    const normal = createFakeSpawner()
    const confined = createFakeSpawner()
    const { root, authorization, host, policyStore } = setup(
      normal.spawnProcess,
      false,
      { metadata: { maxMemoryBytes: 1024 } },
      {
        platform: 'limited-sandbox',
        capabilities: {
          memory: false,
          cpu: true,
          processCount: true,
          networkDeny: true,
          networkHosts: true
        },
        prepare: () => confined.spawnProcess
      }
    )
    const input = approved(root, authorization, ['--output'])
    await expect(host.background(input)).rejects.toThrow(/unsupported.*memory/i)
    expect(normal.calls).toHaveLength(0)
    expect(confined.calls).toHaveLength(0)
    expect(
      policyStore.getResource<{ consumed: boolean }>('policy-audit', input.authorizationId)?.state
    ).toMatchObject({ consumed: false })
  })

  it('does not consume a permit when confinement preparation fails or returns no spawn function', async () => {
    for (const prepare of [
      () => {
        throw new Error('sandbox setup failed')
      },
      () => undefined as unknown as CommandJobsSpawnProcess
    ]) {
      const normal = createFakeSpawner()
      const { root, authorization, host, policyStore } = setup(
        normal.spawnProcess,
        false,
        { metadata: { maxMemoryBytes: 1024 } },
        {
          platform: 'broken-sandbox',
          capabilities: {
            memory: true,
            cpu: false,
            processCount: false,
            networkDeny: false,
            networkHosts: false
          },
          prepare
        }
      )
      const input = approved(root, authorization, ['--output'])
      await expect(host.background(input)).rejects.toThrow(
        /sandbox setup failed|spawn implementation/
      )
      expect(normal.calls).toHaveLength(0)
      expect(
        policyStore.getResource<{ consumed: boolean }>('policy-audit', input.authorizationId)?.state
      ).toMatchObject({ consumed: false })
    }
  })

  it('finalizes an asynchronous spawn error once even when close follows', async () => {
    const fake = createFakeSpawner()
    const { root, authorization, host } = setup(fake.spawnProcess)
    const job = await host.background(approved(root, authorization, ['--spawn-error']))
    const settled = await waitFor(host, job.jobId)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(settled).toMatchObject({
      state: 'failed',
      outcome: 'known',
      stopOutcome: 'spawn-failed'
    })
    expect(
      host.status({ jobId: job.jobId, routeKey: 'route', sessionId: 'session' })
    ).not.toHaveProperty('exitCode')
    expect(
      host.read({ jobId: job.jobId, routeKey: 'route', sessionId: 'session', stream: 'stderr' })
        .data
    ).toContain('fake executable unavailable')
  })

  it('times out and observes descendant process-group termination', async () => {
    const fake = createFakeSpawner()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { root, authorization, host } = setup(fake.spawnProcess)
    const job = await host.background({
      ...approved(root, authorization, ['--hang']),
      timeoutMs: 10
    })

    expect((await waitFor(host, job.jobId)).state).toBe('timed-out')
    if (process.platform === 'win32') {
      expect(
        fake.calls.some((call) => path.basename(call.command).toLowerCase() === 'taskkill.exe' && call.args.includes('/T'))
      ).toBe(true)
    } else {
      expect(kill).toHaveBeenCalledWith(-fake.calls[0].child.pid, 'SIGTERM')
    }
    fake.calls[0].child.close(null, 'SIGTERM')
  })

  it('stops idempotently, scopes ownership, and marks live metadata interrupted on reopen', async () => {
    const fake = createFakeSpawner()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { root, authorization, host, command } = setup(fake.spawnProcess)
    const running = await host.background(approved(root, authorization, ['--hang']))

    await expect(
      host.stop({ jobId: running.jobId, routeKey: 'other', sessionId: 'session' })
    ).rejects.toThrow('scope')
    expect(
      (await host.stop({ jobId: running.jobId, routeKey: 'route', sessionId: 'session' })).state
    ).toBe('stopped')
    expect(
      (await host.stop({ jobId: running.jobId, routeKey: 'route', sessionId: 'session' })).state
    ).toBe('stopped')

    const orphan = await host.background(approved(root, authorization, ['--hang']))
    const reopened = new CommandJobsToolHost(authorization, {
      workspaceRoot: root,
      allowedCommands: [command],
      spawnProcess: fake.spawnProcess
    })
    expect(
      reopened.status({ jobId: orphan.jobId, routeKey: 'route', sessionId: 'session' })
    ).toMatchObject({
      state: 'stopped-interrupted',
      outcome: 'unknown',
      stopOutcome: 'manager-reopened-without-live-ownership'
    })

    fake.calls
      .filter((call) => call.command === command)
      .forEach((call) => call.child.close(null, 'SIGTERM'))
  })
})
