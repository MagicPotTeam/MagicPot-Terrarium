import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImportSourceGate, type ImportSourceGate } from './llmProxy/managedMediaStore'
import { clearScopedLocalMediaPathsForTest } from './localMediaAccess'
import {
  authorizeRendererLocalPath,
  checkRendererLocalPath,
  createLocalPathBreaker,
  LOCAL_PATH_BREAKER_MAX_WAIT_MS,
  LOCAL_PATH_BREAKER_SLOW_MS
} from './rendererLocalPathAccess'

// node:fs is the in-memory filesystem of the node test setup.
const root = path.join(process.cwd(), '.magicpot-trash', 'renderer-local-path-access')

afterEach(() => {
  clearScopedLocalMediaPathsForTest()
  fs.rmSync(root, { recursive: true, force: true })
})

/** A realpath on a share that stopped answering. */
const neverAnswers = () => new Promise<string>(() => undefined)

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** libuv's threadpool: `size` threads, queued work started in order, nothing cancelled. */
function createThreadpool(size: number) {
  let busy = 0
  const queue: Array<() => void> = []
  const pool = {
    mostBusy: 0,
    run<T>(work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          busy += 1
          pool.mostBusy = Math.max(pool.mostBusy, busy)
          work().then(
            (value) => {
              busy -= 1
              queue.shift()?.()
              resolve(value)
            },
            (error) => {
              busy -= 1
              queue.shift()?.()
              reject(error)
            }
          )
        }
        if (busy < size) start()
        else queue.push(start)
      })
    }
  }
  return pool
}

describe('authorizeRendererLocalPath', () => {
  it('answers null at its deadline when the path never answers, with or without the gate', async () => {
    const file = path.join(root, 'a.png')
    for (const gate of [null, createImportSourceGate({ onSaturated: () => undefined })]) {
      const started = performance.now()
      await expect(
        authorizeRendererLocalPath(file, [root], {
          gate,
          // Its own breaker: the folder keeps a call that never returns.
          breaker: createLocalPathBreaker(),
          timeoutMs: 30,
          realpath: neverAnswers
        })
      ).resolves.toBeNull()
      expect(performance.now() - started).toBeLessThan(5_000)
    }
  })

  it('authorizes a file under a root and refuses one outside it', async () => {
    const inside = path.join(root, 'media', 'a.png')
    const outside = path.join(process.cwd(), '.magicpot-trash', 'elsewhere-secret.txt')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, 'a')
    fs.writeFileSync(outside, 'secret')
    try {
      for (const gate of [null, undefined]) {
        await expect(authorizeRendererLocalPath(inside, [root], { gate })).resolves.toBe(
          fs.realpathSync.native(inside)
        )
        await expect(authorizeRendererLocalPath(outside, [root], { gate })).resolves.toBeNull()
      }
      // Never a synchronous realpath of the named path.
      const sync = vi.spyOn(fs.realpathSync, 'native')
      await authorizeRendererLocalPath(inside, [root], { gate: null })
      expect(sync.mock.calls.filter(([target]) => String(target) === inside)).toEqual([])
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})

/** A gate that refuses every call at once, as one whose slots are all held by stalled calls. */
const saturatedGate: ImportSourceGate = {
  acquire: (_key, _start, refuse) => {
    refuse()
    return () => false
  },
  active: 3,
  overdue: 3
}

describe('checkRendererLocalPath: why a path was refused', () => {
  it('tells a missing file from one that is outside and from one that did not answer', async () => {
    const inside = path.join(root, 'media', 'a.png')
    const outside = path.join(process.cwd(), '.magicpot-trash', 'elsewhere-secret.txt')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, 'a')
    fs.writeFileSync(outside, 'secret')
    const eio = async () => {
      throw Object.assign(new Error('i/o error'), { code: 'EIO' })
    }
    try {
      for (const gate of [null, undefined]) {
        const breaker = createLocalPathBreaker()
        const check = (filePath: string, options = {}) =>
          checkRendererLocalPath(filePath, [root], { gate, breaker, ...options })
        await expect(check(inside)).resolves.toEqual({ canonicalPath: fs.realpathSync(inside) })
        await expect(check(path.join(root, 'media', 'gone.png'))).resolves.toEqual({
          canonicalPath: null,
          reason: 'missing'
        })
        await expect(check(path.join(inside, 'not-a-folder.png'))).resolves.toMatchObject({
          reason: 'missing'
        })
        await expect(check(outside)).resolves.toMatchObject({ reason: 'refused' })
        await expect(check('relative/a.png')).resolves.toMatchObject({ reason: 'refused' })
        // The filesystem failed or gave no answer in time: the file may well be there.
        await expect(check(inside, { realpath: eio })).resolves.toMatchObject({
          reason: 'unavailable'
        })
        await expect(
          check(path.join(root, 'stalls', 'b.png'), { realpath: neverAnswers, timeoutMs: 20 })
        ).resolves.toMatchObject({ reason: 'unavailable' })
      }
      // Every slot of the gate is held by calls past their deadline: an existing file is
      // unavailable, never missing.
      await expect(
        checkRendererLocalPath(inside, [root], { gate: saturatedGate })
      ).resolves.toEqual({ canonicalPath: null, reason: 'unavailable' })
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})

describe('createLocalPathBreaker', () => {
  const deferred = () => {
    let resolve!: (value: string) => void
    const promise = new Promise<string>((done) => (resolve = done))
    return { promise, resolve }
  }
  const settle = () => new Promise((done) => setTimeout(done, 0))

  it('loads a healthy board of a thousand local images, never more than three checks at once', async () => {
    const breaker = createLocalPathBreaker()
    const files = Array.from({ length: 1000 }, (_, index) =>
      path.join(root, 'board', `${index}.png`)
    )
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'x')
    }
    let running = 0
    let mostRunning = 0
    const realpath = async (value: string) => {
      running += 1
      mostRunning = Math.max(mostRunning, running)
      try {
        return await fs.promises.realpath(value)
      } finally {
        running -= 1
      }
    }
    const started = performance.now()
    const results = await Promise.all(
      files.map((file) =>
        authorizeRendererLocalPath(file, [root], { gate: null, breaker, realpath })
      )
    )
    expect(results.filter((value) => value === null)).toEqual([])
    expect(results[999]).toBe(fs.realpathSync.native(files[999]))
    // Every check is a realpath of the image and of the root, two at a time on this root.
    expect(mostRunning).toBeLessThanOrEqual(2)
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  it('refuses at once inside a folder that stopped answering, and only there', async () => {
    const breaker = createLocalPathBreaker({ slowMs: 10 })
    const stalled = deferred()
    const dead = path.join(root, 'cloud', 'photos', '2024', 'a.png')
    const first = breaker.run(dead, () => stalled.promise, 60_000)
    await new Promise((done) => setTimeout(done, 30))

    // No new call is made in the folder of the stalled one...
    const operation = vi.fn(async () => 'value')
    await expect(
      breaker.run(path.join(root, 'cloud', 'photos', '2024', 'b.png'), operation, 60_000)
    ).resolves.toBeNull()
    expect(operation).not.toHaveBeenCalled()
    // ...while the rest of the same root (the app's data, other pictures) keeps working.
    await expect(
      breaker.run(path.join(root, 'userData', 'm.png'), operation, 60_000)
    ).resolves.toEqual({ value: 'value' })
    await expect(
      breaker.run(path.join(root, 'cloud', 'photos', 'b.png'), operation, 60_000)
    ).resolves.toEqual({ value: 'value' })

    // A second folder of the same mount stalls too: the closed folder grows to hold both.
    const stalledToo = deferred()
    const second = breaker.run(
      path.join(root, 'cloud', 'docs', 'c.png'),
      () => stalledToo.promise,
      60_000
    )
    await new Promise((done) => setTimeout(done, 30))
    operation.mockClear()
    await expect(
      breaker.run(path.join(root, 'cloud', 'notes', 'd.png'), operation, 60_000)
    ).resolves.toBeNull()
    await expect(
      breaker.run(path.join(root, 'userData', 'n.png'), operation, 60_000)
    ).resolves.toEqual({ value: 'value' })
    expect(operation).toHaveBeenCalledTimes(1)

    // Once the stalled calls return, the folder answers again.
    stalled.resolve('late')
    stalledToo.resolve('late')
    await expect(first).resolves.toEqual({ value: 'late' })
    await expect(second).resolves.toEqual({ value: 'late' })
    await settle()
    await expect(
      breaker.run(path.join(root, 'cloud', 'photos', '2024', 'b.png'), operation, 60_000)
    ).resolves.toEqual({ value: 'value' })
  })

  it('answers null at the deadline and keeps the folder closed until the call returns', async () => {
    const breaker = createLocalPathBreaker({ slowMs: 60_000 })
    const stalled = deferred()
    const file = path.join(root, 'nas', 'a.png')
    await expect(breaker.run(file, () => stalled.promise, 20)).resolves.toBeNull()
    const operation = vi.fn(async () => 'value')
    await expect(breaker.run(path.join(root, 'nas', 'b.png'), operation, 20)).resolves.toBeNull()
    expect(operation).not.toHaveBeenCalled()
    stalled.resolve('late')
    await settle()
    await expect(breaker.run(path.join(root, 'nas', 'b.png'), operation, 20)).resolves.toEqual({
      value: 'value'
    })
  })

  it('runs two calls at once on one root and queues the next, in order', async () => {
    const breaker = createLocalPathBreaker({ slowMs: 60_000 })
    const held = deferred()
    const calls = [1, 2].map((index) =>
      breaker.run(path.join(root, `${index}.png`), () => held.promise, 60_000)
    )
    const order: string[] = []
    const operation = (name: string) => async () => {
      order.push(name)
      return name
    }
    const third = breaker.run(path.join(root, '3.png'), operation('3'), 60_000)
    const fourth = breaker.run(path.join(root, '4.png'), operation('4'), 60_000)
    await settle()
    expect(order).toEqual([])
    // Another root has its own slots.
    await expect(breaker.run('/Volumes/other/5.png', operation('5'), 60_000)).resolves.toEqual({
      value: '5'
    })
    held.resolve('done')
    await Promise.all(calls)
    await expect(third).resolves.toEqual({ value: '3' })
    await expect(fourth).resolves.toEqual({ value: '4' })
    expect(order).toEqual(['5', '3', '4'])
  })

  it('bounds a burst on dead mounts: three calls hold threads, the rest wait a bounded time', async () => {
    vi.useFakeTimers()
    try {
      const breaker = createLocalPathBreaker({ maxQueuedPerRoot: 100, maxQueued: 250 })
      let started = 0
      const never = () => {
        started += 1
        return new Promise<never>(() => undefined)
      }
      const results: Array<Promise<unknown>> = []
      for (const host of ['a', 'b', 'c', 'd']) {
        for (let index = 0; index < 300; index += 1) {
          results.push(breaker.run(`/Volumes/${host}/${index % 7}/img${index}.png`, never, 15_000))
        }
      }
      // Below libuv's four threads, whatever the number of roots.
      expect(started).toBe(3)
      let settled = 0
      for (const result of results) void result.then(() => (settled += 1))
      // Past the queue bounds: refused at once.
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(1200 - 3 - 250)
      // Past the wait bound: every queued call is refused, and none of them ever ran.
      await vi.advanceTimersByTimeAsync(LOCAL_PATH_BREAKER_MAX_WAIT_MS)
      expect(settled).toBe(1200 - 3)
      expect(started).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never counts a healthy call queued behind a dead mount as slow', async () => {
    vi.useFakeTimers()
    try {
      // libuv: four threads, queued work runs in order, a call that never returns keeps its thread.
      const threads = createThreadpool(4)
      const breaker = createLocalPathBreaker()
      const dead = () => threads.run(() => new Promise<string>(() => undefined))
      const healthy = () => threads.run(() => sleep(50).then(() => 'ok'))
      for (let index = 0; index < 4; index += 1) {
        void breaker.run(`/Volumes/nas/photos/${index}.png`, dead, 15_000)
      }
      const pictures = Array.from({ length: 30 }, (_, index) =>
        breaker.run(`/Users/x/Pictures/${index}.png`, healthy, 15_000)
      )
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(Promise.all(pictures)).resolves.toEqual(pictures.map(() => ({ value: 'ok' })))
      // The dead mount is closed; the pictures folder and the app's data still answer.
      const operation = vi.fn(async () => 'value')
      await expect(breaker.run('/Volumes/nas/photos/9.png', operation, 15_000)).resolves.toBeNull()
      expect(operation).not.toHaveBeenCalled()
      for (const file of [
        '/Users/x/Pictures/new.png',
        '/Users/x/Library/Application Support/MagicPot/.chat_media/a.png'
      ]) {
        await expect(breaker.run(file, operation, 15_000)).resolves.toEqual({ value: 'value' })
      }
      expect(threads.mostBusy).toBeLessThanOrEqual(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a stall in or just below a first directory from closing it, or a home folder', async () => {
    vi.useFakeTimers()
    try {
      const breaker = createLocalPathBreaker()
      const never = () => new Promise<never>(() => undefined)
      void breaker.run('/Users/x.png', never, 15_000)
      void breaker.run('/Users/y/link-to-dead-share.png', never, 15_000)
      await vi.advanceTimersByTimeAsync(LOCAL_PATH_BREAKER_SLOW_MS + 100)
      const operation = vi.fn(async () => 'value')
      // Only the stalled files are closed.
      await expect(breaker.run('/Users/x.png', operation, 15_000)).resolves.toBeNull()
      await expect(
        breaker.run('/Users/y/link-to-dead-share.png', operation, 15_000)
      ).resolves.toBeNull()
      expect(operation).not.toHaveBeenCalled()
      for (const file of [
        '/Users/victim/Library/a.png',
        '/Users/y/Pictures/b.png',
        '/Users/y/c.png'
      ]) {
        await expect(breaker.run(file, operation, 15_000)).resolves.toEqual({ value: 'value' })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a dead mount as a whole once two of its places stalled, never for one', async () => {
    vi.useFakeTimers()
    try {
      const breaker = createLocalPathBreaker()
      const never = () => new Promise<never>(() => undefined)
      void breaker.run('/Volumes/nas/b.png', never, 15_000)
      await vi.advanceTimersByTimeAsync(LOCAL_PATH_BREAKER_SLOW_MS + 100)
      const quick = vi.fn(async () => 'value')
      await expect(breaker.run('/Volumes/nas/b.png', quick, 15_000)).resolves.toBeNull()
      await expect(breaker.run('/Volumes/nas/c.png', quick, 15_000)).resolves.toEqual({
        value: 'value'
      })
      // A second place of the mount stalls too: the whole mount is closed.
      void breaker.run('/Volumes/nas/a/1.png', never, 15_000)
      await vi.advanceTimersByTimeAsync(LOCAL_PATH_BREAKER_SLOW_MS + 100)
      const operation = vi.fn(async () => 'value')
      await expect(breaker.run('/Volumes/nas/c/d/2.png', operation, 15_000)).resolves.toBeNull()
      expect(operation).not.toHaveBeenCalled()
      await expect(breaker.run('/Volumes/other/3.png', operation, 15_000)).resolves.toEqual({
        value: 'value'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a call as slow from when it started, never while it waited for its turn', async () => {
    vi.useFakeTimers()
    try {
      const breaker = createLocalPathBreaker()
      // Each takes 1.5 s: below the slow mark once it runs, but the last ones wait far longer.
      const calls = Array.from({ length: 6 }, (_, index) =>
        breaker.run(`/Volumes/slow-but-alive/photos/${index}.png`, () => sleep(1_500), 15_000)
      )
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(Promise.all(calls)).resolves.toEqual(calls.map(() => ({ value: undefined })))
      const operation = vi.fn(async () => 'value')
      await expect(
        breaker.run('/Volumes/slow-but-alive/photos/next.png', operation, 15_000)
      ).resolves.toEqual({ value: 'value' })
    } finally {
      vi.useRealTimers()
    }
  })
})
