import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
vi.mock('node:fs/promises', async (importActual) => importActual())

import { acquireEventStoreWriteLock } from './writeLock'

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
