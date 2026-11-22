import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
vi.mock('node:fs/promises', async (importActual) => importActual())

import {
  acquireEventStoreWriteLock,
  acquireInstanceLease,
  activeInstanceLeasePids,
  instanceLeaseDirectory
} from './writeLock'

const children = new Set<ChildProcess>()
const directories: string[] = []

function paths(databasePath: string): { anchor: string; lock: string; owner: string } {
  const anchor = join(
    dirname(resolve(databasePath)),
    `${basename(databasePath)}.magicagent.lock-target`
  )
  return { anchor, lock: `${anchor}.lock`, owner: `${anchor}.owner` }
}

async function database(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'magic-agent-write-lock-'))
  directories.push(directory)
  return join(directory, 'events.sqlite')
}

function deadOwner(): { pid: number; token: string; createdAt: number } {
  return { pid: 2_147_483_647, token: randomUUID(), createdAt: Date.now() }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  child.kill('SIGKILL')
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 5_000))
  ])
  if (!stopped && process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await new Promise<void>((resolveExit) => killer.once('exit', () => resolveExit()))
  }
  await exited
}

async function crashWithLock(databasePath: string): Promise<ChildProcess> {
  const { anchor, owner } = paths(databasePath)
  const script = `
    const fs = require('node:fs');
    const lockfile = require('proper-lockfile');
    const anchor = process.argv[1];
    const owner = process.argv[2];
    fs.writeFileSync(anchor, '{}', { flag: 'wx' });
    lockfile.lockSync(anchor, { realpath: false, stale: 30000, update: 10000, retries: 0 });
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token: '${randomUUID()}', createdAt: Date.now() }), { flag: 'wx' });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['-e', script, anchor, owner], {
    cwd: resolve(__dirname, '../../../../../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.add(child)
  await new Promise<void>((resolveReady, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`child timeout: ${stderr}`)), 10_000)
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.includes('READY\n')) {
        clearTimeout(timer)
        resolveReady()
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`child exited early (${code}): ${stderr}`))
    })
  })
  return child
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...children].map(terminate))
  children.clear()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('acquireEventStoreWriteLock', () => {
  it('does not take over a stale proper lock owned by a live PID', async () => {
    const path = await database()
    const release = acquireEventStoreWriteLock(path)
    const lock = paths(path).lock
    const old = new Date(Date.now() - 61_000)
    utimesSync(lock, old, old)

    expect(() => acquireEventStoreWriteLock(path)).toThrow(/already being held/)
    release()
    const releaseAgain = acquireEventStoreWriteLock(path)
    releaseAgain()
  })

  it('immediately recovers a proper lock whose child owner died', async () => {
    const path = await database()
    const child = await crashWithLock(path)
    await terminate(child)
    children.delete(child)

    const release = acquireEventStoreWriteLock(path)
    release()
  })

  it('fails closed when a lock directory has no owner', async () => {
    const path = await database()
    const { anchor, lock } = paths(path)
    writeFileSync(anchor, '{}')
    mkdirSync(lock)

    expect(() => acquireEventStoreWriteLock(path)).toThrow(/manual cleanup/)
    expect(existsSync(lock)).toBe(true)
  })

  it('fails closed when a lock directory has an invalid owner', async () => {
    const path = await database()
    const { anchor, lock, owner } = paths(path)
    writeFileSync(anchor, '{}')
    mkdirSync(lock)
    writeFileSync(owner, '{invalid')

    expect(() => acquireEventStoreWriteLock(path)).toThrow(/manual cleanup/)
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(owner, 'utf8')).toBe('{invalid')
  })

  it('cleans an empty dead-owner lock and acquires it', async () => {
    const path = await database()
    const { anchor, lock, owner } = paths(path)
    writeFileSync(anchor, '{}')
    mkdirSync(lock)
    writeFileSync(owner, JSON.stringify(deadOwner()))

    const release = acquireEventStoreWriteLock(path)
    release()
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(owner)).toBe(false)
  })

  it('preserves a nonempty dead-owner lock for manual cleanup', async () => {
    const path = await database()
    const { anchor, lock, owner } = paths(path)
    writeFileSync(anchor, '{}')
    mkdirSync(lock)
    writeFileSync(join(lock, 'unexpected'), 'preserve')
    writeFileSync(owner, JSON.stringify(deadOwner()))

    expect(() => acquireEventStoreWriteLock(path)).toThrow(/manual cleanup/)
    expect(existsSync(join(lock, 'unexpected'))).toBe(true)
    expect(existsSync(owner)).toBe(true)
  })

  it('reacquires the same anchor after release', async () => {
    const path = await database()
    const first = acquireEventStoreWriteLock(path)
    first()
    const second = acquireEventStoreWriteLock(path)
    expect(second).toBeTypeOf('function')
    second()
  })

  it('release removes owner and proper lock but preserves the anchor', async () => {
    const path = await database()
    const lockPaths = paths(path)
    const release = acquireEventStoreWriteLock(path)
    expect(existsSync(lockPaths.lock)).toBe(true)
    expect(existsSync(lockPaths.owner)).toBe(true)

    release()
    expect(existsSync(lockPaths.lock)).toBe(false)
    expect(existsSync(lockPaths.owner)).toBe(false)
    expect(existsSync(lockPaths.anchor)).toBe(true)
  })
})

async function liveChild(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore']
    }
  )
  children.add(child)
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('child timeout')), 10_000)
    child.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('READY')) {
        clearTimeout(timer)
        resolveReady()
      }
    })
  })
  return child
}

/**
 * Another process that holds a lease next to `databasePath` exactly as acquireInstanceLease does:
 * the lease file, then its proper-lockfile lock (same options). A line on stdin makes it exit
 * normally, which runs proper-lockfile's exit handler.
 */
async function leaseHolder(databasePath: string): Promise<{ child: ChildProcess; lease: string }> {
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { randomUUID } = require('node:crypto');
    const lockfile = require('proper-lockfile');
    const directory = process.argv[1];
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lease = path.join(directory, process.pid + '-' + randomUUID() + '.lease');
    fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
    lockfile.lockSync(lease, { realpath: false, stale: 30000, update: 10000, retries: 0 });
    process.stdin.on('data', () => process.exit(0));
    process.stdout.write('READY ' + lease + '\\n');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['-e', script, instanceLeaseDirectory(databasePath)], {
    cwd: resolve(__dirname, '../../../../../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.add(child)
  const lease = await new Promise<string>((resolveReady, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`holder timeout: ${stderr}`)), 10_000)
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      const ready = /READY (.+\.lease)\n/.exec(stdout)
      if (ready) {
        clearTimeout(timer)
        resolveReady(ready[1])
      }
    })
  })
  return { child, lease }
}

async function exitNormally(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  child.stdin?.write('exit\n')
  await exited
  children.delete(child)
}

describe('activeInstanceLeasePids (read-only)', () => {
  it('reports no holder and creates nothing when the lease directory does not exist', async () => {
    const path = await database()
    expect(activeInstanceLeasePids(path)).toEqual([])
    expect(readdirSync(dirname(path))).toEqual([])
  })

  it('reports a lease only while a live process holds it, and deletes no lease file', async () => {
    const path = await database()
    const own = acquireInstanceLease(path)
    expect(activeInstanceLeasePids(path)).toEqual([process.pid])
    const exiting = await leaseHolder(path)
    const killed = await leaseHolder(path)
    expect(activeInstanceLeasePids(path).sort()).toEqual(
      [process.pid, exiting.child.pid, killed.child.pid].sort()
    )
    writeFileSync(join(dirname(own.path), 'unrelated-entry'), '')
    // A normal exit removes the lock and leaves the lease file behind.
    await exitNormally(exiting.child)
    expect(existsSync(exiting.lease)).toBe(true)
    expect(existsSync(`${exiting.lease}.lock`)).toBe(false)
    expect(activeInstanceLeasePids(path).sort()).toEqual([process.pid, killed.child.pid].sort())
    // A killed holder leaves both; its PID is dead.
    await terminate(killed.child)
    children.delete(killed.child)
    expect(existsSync(`${killed.lease}.lock`)).toBe(true)
    expect(activeInstanceLeasePids(path)).toEqual([process.pid])
    own.release()
    expect(activeInstanceLeasePids(path)).toEqual([])
    // Read-only: the leftovers stay where they were.
    expect(existsSync(exiting.lease)).toBe(true)
    expect(existsSync(killed.lease)).toBe(true)
    expect(existsSync(`${killed.lease}.lock`)).toBe(true)
  })

  it('passes over a leftover lease whose PID now belongs to another process once its lock stays unrefreshed', async () => {
    const path = await database()
    const directory = instanceLeaseDirectory(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    let now = Math.floor(performance.now())
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    // An unrelated live process: its PID stands for one the system reused after the holder ended.
    const reused = (await liveChild()).pid!
    const lease = (state: 'exited' | 'killed' | 'odd-lock'): string => {
      const file = join(directory, `${reused}-${randomUUID()}.lease`)
      writeFileSync(file, '{}')
      // A kill leaves a lock that nobody refreshes any more.
      if (state === 'killed') {
        mkdirSync(`${file}.lock`)
        const hoursAgo = new Date(Date.now() - 2 * 60 * 60_000)
        utimesSync(`${file}.lock`, hoursAgo, hoursAgo)
      }
      if (state === 'odd-lock') writeFileSync(`${file}.lock`, '')
      return file
    }
    // Its holder exited: its lock is gone.
    lease('exited')
    expect(activeInstanceLeasePids(path)).toEqual([])
    // Held until this process has seen the lock keep its mtime for 30 s, then for 10 s more.
    lease('killed')
    expect(activeInstanceLeasePids(path)).toEqual([reused])
    now += 29_999
    expect(activeInstanceLeasePids(path)).toEqual([reused])
    now += 1
    expect(activeInstanceLeasePids(path)).toEqual([reused])
    now += 9_999
    expect(activeInstanceLeasePids(path)).toEqual([reused])
    now += 1
    expect(activeInstanceLeasePids(path)).toEqual([])
    expect(activeInstanceLeasePids(path)).toEqual([])
    // A lock of another shape counts (fail closed), however long it stays as it is.
    lease('odd-lock')
    expect(activeInstanceLeasePids(path)).toEqual([reused])
    now += 2 * 60 * 60_000
    expect(activeInstanceLeasePids(path)).toEqual([reused])
    expect(activeInstanceLeasePids(path)).toEqual([reused])
  })

  it('takes a live holder whose lock looks hours old (a system sleep, a clock step) for a holder', async () => {
    const path = await database()
    const directory = instanceLeaseDirectory(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    let now = Math.floor(performance.now())
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const holder = (await liveChild()).pid!
    const lease = join(directory, `${holder}-${randomUUID()}.lease`)
    writeFileSync(lease, '{}')
    mkdirSync(`${lease}.lock`)
    const refresh = (at: number) => utimesSync(`${lease}.lock`, new Date(at), new Date(at))
    // Just woken up from a sleep of over an hour: the holder last refreshed its lock before the
    // sleep, an hour ago by the wall clock, and refreshes it again up to 10 s after waking up.
    refresh(Date.now() - 61 * 60_000)
    expect(activeInstanceLeasePids(path)).toEqual([holder])
    now += 9_000
    expect(activeInstanceLeasePids(path)).toEqual([holder])
    // Every refresh counts, whatever the wall clock says (stepped hours back or ahead).
    for (let step = 1; step <= 12; step += 1) {
      refresh(Date.now() + (step % 2 ? 3 : -3) * 60 * 60_000 + step * 1_000)
      now += 10_000
      expect(activeInstanceLeasePids(path)).toEqual([holder])
    }
    // A monotonic clock that counts a sleep (Windows): the first check after waking up finds the
    // lock overdue, moments before its holder refreshes it. That alone never ends the lease.
    now += 2 * 60 * 60_000
    expect(activeInstanceLeasePids(path)).toEqual([holder])
    now += 50
    expect(activeInstanceLeasePids(path)).toEqual([holder])
    refresh(Date.now())
    now += 10_000
    expect(activeInstanceLeasePids(path)).toEqual([holder])
  })
})
