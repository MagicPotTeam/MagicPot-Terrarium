import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork, type ChildProcess } from 'node:child_process'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteNativeWriteCoordinator } from './nativeWriteCoordinator'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const NOW = 1_900_000_000_000
const roots: string[] = [],
  children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill()
      await exit
    }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-owned-write-process-'))
  roots.push(root)
  const file = path.join(root, 'worker.cjs')
  buildSync({
    entryPoints: [fileURLToPath(new URL('./nativeWriteProcess.worker.ts', import.meta.url))],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:sqlite'],
    tsconfig: path.resolve('config/tsconfig/tsconfig.node.json'),
    logLevel: 'silent'
  })
  const store = new SqliteNativeWriteCoordinator(path.join(root, 'store'), () => NOW)
  const seed = {
    resourceKey: 'a'.repeat(64),
    actionId: 'b'.repeat(32),
    fingerprint: 'c'.repeat(64),
    expiresAt: NOW + 120000
  }
  store.reserve(seed)
  store.release(seed)
  const effects = () =>
    fs.existsSync(path.join(root, 'effects.txt'))
      ? fs.readFileSync(path.join(root, 'effects.txt'), 'utf8').trim().split('\n')
      : []
  return { root, file, effects }
}
function worker(f: ReturnType<typeof fixture>, serial: number, now = NOW) {
  const child = fork(f.file, [f.root, String(serial), String(now)], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '' }
  })
  children.push(child)
  const queued: Array<Record<string, unknown>> = [],
    waiting: Array<(message: Record<string, unknown>) => void> = []
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-3000)
  })
  child.on('message', (message) => {
    const row = message as Record<string, unknown>
    const waiter = waiting.shift()
    if (waiter) waiter(row)
    else queued.push(row)
  })
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code))
  )
  const next = async () => {
    if (queued.length) return queued.shift()!
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned worker timed out: ' + stderr)), 10000)
      waiting.push((message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }
  return { next, exited, send: (command: string) => child.send(command), child }
}
describe('independent process native document coordination', () => {
  it('two separately approved ordinary plans compete; only one writes until its verified result', async () => {
    const f = fixture(),
      a = worker(f, 1),
      b = worker(f, 2)
    expect(await a.next()).toMatchObject({ kind: 'ready', startsEmpty: true })
    expect(await b.next()).toMatchObject({ kind: 'ready', startsEmpty: true })
    a.send('claim')
    b.send('claim')
    const results = await Promise.all([a.next(), b.next()])
    expect(results.filter((r) => r.status === 'ready')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'pending')).toHaveLength(1)
    expect(f.effects()).toHaveLength(1)
    const [winner, loser] = results[0].status === 'ready' ? [a, b] : [b, a]
    winner.send('finish')
    expect(await winner.next()).toMatchObject({ kind: 'finished', state: 'completed' })
    loser.send('claim')
    expect(await loser.next()).toMatchObject({ kind: 'claim', status: 'ready' })
    loser.send('claim')
    expect(await loser.next()).toMatchObject({ kind: 'claim', status: 'ready' })
    expect(f.effects()).toHaveLength(2)
    expect(new Set(f.effects()).size).toBe(2)
    a.send('stop')
    b.send('stop')
    expect(await a.exited).toBe(0)
    expect(await b.exited).toBe(0)
  }, 20000)
  it('abruptly exited writer leaves exclusion, not executable authority, in a new process', async () => {
    const f = fixture(),
      a = worker(f, 1)
    expect(await a.next()).toMatchObject({ kind: 'ready' })
    a.send('crash')
    expect(await a.exited).toBe(73)
    expect(f.effects()).toEqual(['1'])
    const b = worker(f, 2)
    expect(await b.next()).toMatchObject({ kind: 'ready', startsEmpty: true })
    b.send('claim')
    expect(await b.next()).toMatchObject({ status: 'pending' })
    expect(f.effects()).toEqual(['1'])
    b.send('stop')
    expect(await b.exited).toBe(0)
    // Advance the injected test clock beyond the original deadline plus drain, not wall-clock sleep.
    const c = worker(f, 3, NOW + 150001)
    expect(await c.next()).toMatchObject({ kind: 'ready', startsEmpty: true })
    c.send('claim')
    expect(await c.next()).toMatchObject({ status: 'ready' })
    expect(f.effects()).toEqual(['1', '3'])
    c.send('stop')
    expect(await c.exited).toBe(0)
  }, 20000)
})
