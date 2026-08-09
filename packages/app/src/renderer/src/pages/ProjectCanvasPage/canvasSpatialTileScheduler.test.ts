import { describe, expect, it, vi } from 'vitest'
import { CanvasSpatialTileScheduler } from './canvasSpatialTileScheduler'

const task = (
  tileKey: string,
  priority: 'visible' | 'overscan' = 'overscan',
  extra: Record<string, unknown> = {}
) => ({
  tileKey,
  priority,
  source: new Blob(),
  descriptor: { sourceWidth: 101, sourceHeight: 99 },
  geometry: {
    address: { level: 1, x: 0, y: 0 },
    decodeRect: { x: 0, y: 0, width: 1, height: 1 },
    levelRect: { x: 0, y: 0, width: 1, height: 1 },
    originalSourceRect: { x: 0, y: 0, width: 1, height: 1 },
    contentOffset: { x: 0, y: 0 }
  },
  scaleDenominator: 2,
  ...extra
})
const result = (value = 'tile') => ({
  blob: new Blob([value]),
  mimeType: 'image/png' as const,
  width: 1,
  height: 1,
  contentRectInBitmap: { x: 0, y: 0, width: 1, height: 1 },
  geometry: task('result').geometry
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('CanvasSpatialTileScheduler', () => {
  it('uses concurrent slots, visible priority, and stable FIFO', async () => {
    const gates = [deferred<any>(), deferred<any>()]
    const calls: string[] = []
    const executor = {
      generate: vi.fn((request: any) => {
        calls.push(request.tileKey)
        return gates[calls.length - 1]?.promise ?? Promise.resolve(result())
      })
    }
    const scheduler = new CanvasSpatialTileScheduler(executor, 2)
    const a = scheduler.schedule(task('a'))
    const b = scheduler.schedule(task('b'))
    const c = scheduler.schedule(task('c', 'visible'))
    expect(calls).toEqual(['a', 'b'])
    gates[0].resolve(result())
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['a', 'b', 'c'])
    gates[1].resolve(result())
    await Promise.all([a, b, c])
  })
  it('dedupes queued/running and upgrades queued priority', async () => {
    const gate = deferred<any>()
    const executor = { generate: vi.fn(() => gate.promise) }
    const scheduler = new CanvasSpatialTileScheduler(executor, 1)
    const first = scheduler.schedule(task('same'))
    const duplicate = scheduler.schedule(task('same', 'visible'))
    expect(scheduler.getMetrics().deduped).toBe(1)
    gate.resolve(result())
    await expect(duplicate).resolves.toBeTruthy()
    await first
  })
  it('cancels queued and disposes running stale results', async () => {
    const gate = deferred<any>()
    const dispose = vi.fn()
    const executor = {
      generate: vi.fn((r: any) => (r.tileKey === 'run' ? gate.promise : Promise.resolve(result())))
    }
    const scheduler = new CanvasSpatialTileScheduler(executor, 1)
    const running = scheduler.schedule(task('run', 'visible', { onStaleResult: dispose }))
    const queued = scheduler.schedule(task('queued'))
    scheduler.cancel('queued')
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    scheduler.cancel('run')
    gate.resolve(result())
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(dispose).toHaveBeenCalled()
    expect(scheduler.getMetrics().staleDisposed).toBe(1)
  })
  it('disposes generation-stale results, counts failures, and does not drop tasks', async () => {
    let current = true
    const executor = {
      generate: vi.fn(async (r: any) => {
        if (r.tileKey === 'fail') throw new Error('fail')
        return result(r.tileKey)
      })
    }
    const scheduler = new CanvasSpatialTileScheduler(executor, 2)
    const staleDispose = vi.fn()
    const stale = scheduler.schedule(
      task('stale', 'visible', { isGenerationCurrent: () => current, onStaleResult: staleDispose })
    )
    current = false
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' })
    await expect(scheduler.schedule(task('fail'))).rejects.toThrow('fail')
    const all = Array.from({ length: 21 }, (_, i) => scheduler.schedule(task(`many-${i}`)))
    await Promise.all(all)
    expect(staleDispose).toHaveBeenCalled()
    expect(scheduler.getMetrics().failed).toBe(1)
    expect(scheduler.getMetrics().completed).toBeGreaterThanOrEqual(21)
  })
})
