import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))

import { join, resolve } from 'node:path'
import type { MagicAgentEvent } from '../../../shared/magicAgentPlatform2'
import { BackupInProgressError, MagicAgentEventStore } from './eventStore'
import { instanceLeaseDirectory } from './writeLock'
import {
  BackupError,
  HashMismatchError,
  RestoreError,
  RestoreRecoveryRequiredError,
  _backupRestoreTesting,
  recoverEventStoreRestore,
  restoreEventStoreBackup,
  type BackupManifest
} from './backupRestore'

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const realOs = await vi.importActual<typeof import('node:os')>('node:os')
const require = createRequire(import.meta.url)
const properLockfilePath = require.resolve('proper-lockfile')

let leaseChild: ChildProcess | undefined

async function startLeaseChild(target: string): Promise<ChildProcess> {
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const lockfile = require(process.env.LOCKFILE_MODULE);
    const directory = process.env.LEASE_DIRECTORY;
    fs.mkdirSync(directory, { recursive: true });
    const anchor = path.join(directory, process.env.LEASE_NAME);
    fs.writeFileSync(anchor, '');
    const release = lockfile.lockSync(anchor, { realpath: false, stale: 30000, update: 10000, retries: 0 });
    process.stdout.write('READY\\n');
    process.stdin.resume();
    process.stdin.once('data', () => { release(); fs.unlinkSync(anchor); process.exit(0); });
  `
  const child = spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      LOCKFILE_MODULE: properLockfilePath,
      LEASE_DIRECTORY: instanceLeaseDirectory(target),
      LEASE_NAME: `${process.pid}-${randomUUID()}.lease`
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  leaseChild = child
  await new Promise<void>((resolveReady, reject) => {
    let output = ''
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
      if (output.includes('READY')) resolveReady()
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Lease child exited before READY: ${code}`)))
  })
  return child
}

async function releaseLeaseChild(child: ChildProcess): Promise<void> {
  child.stdin!.write('release')
  await new Promise<void>((resolveExit, reject) => {
    child.once('exit', (code) =>
      code === 0 ? resolveExit() : reject(new Error(`Lease child: ${code}`))
    )
    child.once('error', reject)
  })
  leaseChild = undefined
}

let directory: string
const stores: MagicAgentEventStore[] = []
function event(sequence: number): MagicAgentEvent<unknown> {
  return {
    protocolVersion: '2.0.0',
    envelopeKind: 'event',
    id: `backup-event-${sequence}`,
    streamId: 'backup-stream',
    sequence,
    type: 'test.backup',
    createdAt: 1000 + sequence,
    payload: { sequence }
  }
}
function open(path: string): MagicAgentEventStore {
  const store = new MagicAgentEventStore(path)
  stores.push(store)
  return store
}
async function backup(sourcePath: string, backupPath: string): Promise<BackupManifest> {
  const store = open(sourcePath)
  store.appendBatch([event(0), event(1)])
  return store.createBackup(backupPath, { createdAt: 42, rate: 1 })
}
beforeEach(async () => {
  directory = await realFs.mkdtemp(join(realOs.tmpdir(), 'magic-backup-restore-'))
})
afterEach(async () => {
  _backupRestoreTesting.setFaultStage(null)
  _backupRestoreTesting.setFailAfterPartialInspect(false)
  if (leaseChild) {
    leaseChild.kill()
    leaseChild = undefined
  }
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      /* tests may close */
    }
  }
  await realFs.rm(directory, { recursive: true, force: true })
})

describe('secure backup and restore', () => {
  it('backs up populated data with an absolute, frozen manifest and reopens equally', async () => {
    const source = join(directory, 'source.sqlite')
    const target = join(directory, 'backup.sqlite')
    const manifest = await backup(source, target)
    expect(manifest).toMatchObject({
      backupPath: resolve(target),
      sourcePath: resolve(source),
      createdAt: 42,
      counts: { events: 2 }
    })
    expect(Object.isFrozen(manifest)).toBe(true)
    const restored = open(target)
    expect(restored.readStream('backup-stream').map((value) => value.sequence)).toEqual([0, 1])
  })

  it('backs up an empty store', async () => {
    const source = join(directory, 'empty.sqlite')
    const store = open(source)
    const manifest = await store.createBackup(join(directory, 'empty-backup.sqlite'))
    expect(manifest.counts).toEqual({ events: 0, snapshots: 0, resources: 0, mutations: 0 })
  })

  it('never overwrites an existing backup target', async () => {
    const source = join(directory, 'source.sqlite')
    const target = join(directory, 'target.sqlite')
    writeFileSync(target, 'sentinel')
    const store = open(source)
    await expect(store.createBackup(target)).rejects.toBeInstanceOf(BackupError)
    expect(readFileSync(target, 'utf8')).toBe('sentinel')
  })

  it('uses a shared backup gate across instances and releases it after success', async () => {
    const source = join(directory, 'shared.sqlite')
    const first = open(source)
    const second = open(source)
    first.appendBatch([event(0)])
    const pending = first.createBackup(join(directory, 'shared-backup.sqlite'), { rate: 1 })
    expect(() => second.appendBatch([event(1)])).toThrow(BackupInProgressError)
    expect(() => second.checkpoint('FULL')).toThrow(BackupInProgressError)
    expect(() => second.close()).toThrow(BackupInProgressError)
    await pending
    expect(second.appendBatch([event(1)])[0].inserted).toBe(true)
  })

  it('releases the shared backup gate after failure', async () => {
    const source = join(directory, 'failed.sqlite')
    const first = open(source)
    const second = open(source)
    const target = join(directory, 'exists.sqlite')
    writeFileSync(target, 'x')
    await expect(first.createBackup(target)).rejects.toBeInstanceOf(BackupError)
    expect(second.appendBatch([event(0)])[0].inserted).toBe(true)
  })

  it('restores into a missing target and continues appending', async () => {
    const manifest = await backup(
      join(directory, 'source.sqlite'),
      join(directory, 'backup.sqlite')
    )
    const target = join(directory, 'restored.sqlite')
    const result = await restoreEventStoreBackup({
      backupPath: manifest.backupPath,
      targetPath: target,
      expectedSha256: manifest.sha256
    })
    expect(result).toMatchObject({
      targetPath: resolve(target),
      rollbackPath: null,
      replacedExisting: false
    })
    const restored = open(target)
    expect(restored.appendBatch([event(2)])[0].inserted).toBe(true)
  })

  it('replaces an existing target while retaining rollback data', async () => {
    const manifest = await backup(
      join(directory, 'source.sqlite'),
      join(directory, 'backup.sqlite')
    )
    const target = join(directory, 'target.sqlite')
    const old = open(target)
    old.appendBatch([event(9)])
    old.close()
    const result = await restoreEventStoreBackup({
      backupPath: manifest.backupPath,
      targetPath: target,
      expectedSha256: manifest.sha256
    })
    expect(result.replacedExisting).toBe(true)
    expect(result.rollbackPath && existsSync(result.rollbackPath)).toBe(true)
    expect(
      open(target)
        .readStream('backup-stream')
        .map((value) => value.sequence)
    ).toEqual([0, 1])
    expect(
      open(result.rollbackPath!)
        .readStream('backup-stream')
        .map((value) => value.sequence)
    ).toEqual([9])
  })

  it('rejects a bad hash without touching a preexisting target', async () => {
    const manifest = await backup(
      join(directory, 'source.sqlite'),
      join(directory, 'backup.sqlite')
    )
    const target = join(directory, 'sentinel.txt')
    writeFileSync(target, 'preserve')
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: '0'.repeat(64)
      })
    ).rejects.toBeInstanceOf(HashMismatchError)
    expect(readFileSync(target, 'utf8')).toBe('preserve')
  })

  it('rejects restore while every target instance lease remains open', async () => {
    const manifest = await backup(
      join(directory, 'source.sqlite'),
      join(directory, 'backup.sqlite')
    )
    const target = join(directory, 'open.sqlite')
    const first = open(target)
    const second = open(target)
    const leases = (): string[] =>
      readdirSync(instanceLeaseDirectory(target)).filter((name) => name.endsWith('.lease'))
    expect(leases()).toHaveLength(2)
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).rejects.toBeInstanceOf(Error)
    first.close()
    expect(leases()).toHaveLength(1)
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).rejects.toBeInstanceOf(Error)
    second.close()
    expect(leases()).toHaveLength(0)
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).resolves.toMatchObject({ targetPath: resolve(target) })
  })

  it('rejects public recovery while the target is open in this process', async () => {
    const target = join(directory, 'recover-open-target')
    open(target)
    await expect(recoverEventStoreRestore(target)).rejects.toBeInstanceOf(
      RestoreRecoveryRequiredError
    )
  })

  it('cleans an owned pre-journal partial after a normal post-inspection failure', async () => {
    const manifest = await backup(
      join(directory, 'partial-source'),
      join(directory, 'partial-backup')
    )
    const target = join(directory, 'partial-target')
    _backupRestoreTesting.setFailAfterPartialInspect(true)
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).rejects.toBeInstanceOf(RestoreError)
    expect(
      readdirSync(directory).filter((name) => name.includes('.partial-target.restore-'))
    ).toEqual([])
  })

  it('removes a stale empty lease lock directory and does not remain blocked', async () => {
    const manifest = await backup(join(directory, 'stale-source'), join(directory, 'stale-backup'))
    const target = join(directory, 'stale-target')
    const leaseDirectory = instanceLeaseDirectory(target)
    mkdirSync(leaseDirectory, { recursive: true })
    const anchor = join(leaseDirectory, `123-${randomUUID()}.lease`)
    const lockDirectory = `${anchor}.lock`
    writeFileSync(anchor, '')
    mkdirSync(lockDirectory)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockDirectory, old, old)
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).resolves.toMatchObject({ targetPath: resolve(target) })
    expect(existsSync(anchor)).toBe(false)
    expect(existsSync(lockDirectory)).toBe(false)
    await expect(recoverEventStoreRestore(target)).resolves.toBeUndefined()
  })

  it('preserves a nonempty inactive lease lock directory for manual cleanup', async () => {
    const target = join(directory, 'unsafe-stale-target')
    const leaseDirectory = instanceLeaseDirectory(target)
    mkdirSync(leaseDirectory, { recursive: true })
    const anchor = join(leaseDirectory, `123-${randomUUID()}.lease`)
    const lockDirectory = `${anchor}.lock`
    writeFileSync(anchor, '')
    mkdirSync(lockDirectory)
    writeFileSync(join(lockDirectory, 'foreign'), 'preserve')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockDirectory, old, old)
    await expect(recoverEventStoreRestore(target)).rejects.toThrow('manual cleanup')
    expect(readFileSync(join(lockDirectory, 'foreign'), 'utf8')).toBe('preserve')
    expect(existsSync(anchor)).toBe(true)
  })

  it('rejects restore and public recovery for a real child-process lease', async () => {
    const manifest = await backup(join(directory, 'child-source'), join(directory, 'child-backup'))
    const target = join(directory, 'child-target')
    const child = await startLeaseChild(target)
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).rejects.toThrow('active instance lease')
    await expect(recoverEventStoreRestore(target)).rejects.toThrow('active instance lease')
    await releaseLeaseChild(child)
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).resolves.toMatchObject({ targetPath: resolve(target) })
  }, 15_000)

  it('rejects stale sidecars before swap', async () => {
    const manifest = await backup(
      join(directory, 'source.sqlite'),
      join(directory, 'backup.sqlite')
    )
    const target = join(directory, 'sidecar.sqlite')
    writeFileSync(`${target}-wal`, 'stale')
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).rejects.toBeInstanceOf(Error)
  })

  it('hard-link publication is no-replace', () => {
    const source = join(directory, 'source')
    const target = join(directory, 'target')
    writeFileSync(source, 'new')
    writeFileSync(target, 'old')
    expect(() => linkSync(source, target)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('old')
  })
  it('restores from a different-directory backup', async () => {
    const other = join(directory, 'other')
    await realFs.mkdir(other)
    const manifest = await backup(join(directory, 'dd-source.sqlite'), join(other, 'backup.sqlite'))
    const target = join(directory, 'dd-target.sqlite')
    await restoreEventStoreBackup({
      backupPath: manifest.backupPath,
      targetPath: target,
      expectedSha256: manifest.sha256
    })
    expect(open(target).readStream('backup-stream')).toHaveLength(2)
  })

  it.each(['rollback-linking', 'target-removing', 'target-linking'] as const)(
    'recovers crash window %s',
    async (stage) => {
      const manifest = await backup(join(directory, `s-${stage}`), join(directory, `b-${stage}`))
      const target = join(directory, `t-${stage}`)
      const old = open(target)
      old.appendBatch([event(9)])
      old.close()
      _backupRestoreTesting.setFaultStage(stage)
      await expect(
        restoreEventStoreBackup({
          backupPath: manifest.backupPath,
          targetPath: target,
          expectedSha256: manifest.sha256
        })
      ).rejects.toThrow('Simulated')
      _backupRestoreTesting.setFaultStage(null)
      await recoverEventStoreRestore(target)
      expect(
        open(target)
          .readStream('backup-stream')
          .map((x) => x.sequence)
      ).toEqual(stage === 'target-linking' ? [0, 1] : [9])
      expect(existsSync(_backupRestoreTesting.journalPath(target))).toBe(false)
    }
  )

  it('recovers missing-target crash after target link', async () => {
    const manifest = await backup(join(directory, 'ms'), join(directory, 'mb'))
    const target = join(directory, 'mt')
    _backupRestoreTesting.setFaultStage('target-linking')
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).rejects.toThrow()
    _backupRestoreTesting.setFaultStage(null)
    await recoverEventStoreRestore(target)
    expect(open(target).readStream('backup-stream')).toHaveLength(2)
  })

  it('unexpected target identity is manual and preserved', async () => {
    const manifest = await backup(join(directory, 'us'), join(directory, 'ub'))
    const target = join(directory, 'ut')
    _backupRestoreTesting.setFaultStage('target-linking')
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).rejects.toThrow()
    _backupRestoreTesting.setFaultStage(null)
    unlinkSync(target)
    writeFileSync(target, 'foreign')
    await expect(recoverEventStoreRestore(target)).rejects.toBeInstanceOf(
      RestoreRecoveryRequiredError
    )
    expect(readFileSync(target, 'utf8')).toBe('foreign')
    expect(existsSync(_backupRestoreTesting.journalPath(target))).toBe(true)
  })

  it('v1 journal is manual and preserved', async () => {
    const target = join(directory, 'v1')
    const journal = _backupRestoreTesting.journalPath(target)
    writeFileSync(
      journal,
      JSON.stringify({ kind: 'magic-agent-event-store-restore-journal', version: 1 })
    )
    await expect(recoverEventStoreRestore(target)).rejects.toBeInstanceOf(
      RestoreRecoveryRequiredError
    )
    expect(existsSync(journal)).toBe(true)
  })

  it('unknown journal fields are manual and preserved', async () => {
    const target = join(directory, 'unknown')
    const journal = _backupRestoreTesting.journalPath(target)
    writeFileSync(
      journal,
      JSON.stringify({ kind: 'magic-agent-event-store-restore-journal', version: 2, unsafe: true })
    )
    await expect(recoverEventStoreRestore(target)).rejects.toBeInstanceOf(
      RestoreRecoveryRequiredError
    )
    expect(existsSync(journal)).toBe(true)
  })

  it('sidecar during recovery is manual', async () => {
    const manifest = await backup(join(directory, 'ss'), join(directory, 'sb'))
    const target = join(directory, 'st')
    _backupRestoreTesting.setFaultStage('target-linking')
    await expect(
      restoreEventStoreBackup({
        backupPath: manifest.backupPath,
        targetPath: target,
        expectedSha256: manifest.sha256
      })
    ).rejects.toThrow()
    _backupRestoreTesting.setFaultStage(null)
    writeFileSync(`${target}-wal`, 'sidecar')
    await expect(recoverEventStoreRestore(target)).rejects.toBeInstanceOf(
      RestoreRecoveryRequiredError
    )
    expect(existsSync(_backupRestoreTesting.journalPath(target))).toBe(true)
  })

  it('relative restore inputs resolve from cwd', async () => {
    const manifest = await backup(join(directory, 'rs'), join(directory, 'rb'))
    const cwd = process.cwd()
    process.chdir(directory)
    try {
      await restoreEventStoreBackup({
        backupPath: 'rb',
        targetPath: 'rt',
        expectedSha256: manifest.sha256
      })
    } finally {
      process.chdir(cwd)
    }
    expect(existsSync(join(directory, 'rt'))).toBe(true)
  })

  it.each([
    'prepared',
    'rollback-linked',
    'target-removed',
    'target-linked',
    'verifying',
    'verified'
  ] as const)('recognizes v2 stage %s in strict parser', async (stage) => {
    expect(typeof stage).toBe('string')
  })
})
