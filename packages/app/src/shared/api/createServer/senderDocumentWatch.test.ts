import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { watchSenderDocument, type SenderDocumentWatcher } from './senderDocumentWatch'

const EVENTS = ['did-start-navigation', 'render-process-gone', 'destroyed'] as const
const counts = (sender: EventEmitter) => EVENTS.map((event) => sender.listenerCount(event))

/** Collects MaxListenersExceededWarning while `run` adds listeners (Node reports it on a later tick). */
async function listenerWarnings(run: () => void): Promise<Error[]> {
  const warnings: Error[] = []
  const onWarning = (warning: Error) => warnings.push(warning)
  process.on('warning', onWarning)
  try {
    run()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('warning', onWarning)
  }
  return warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')
}

/** A fixed, seeded shuffle: the same order on every run. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items]
  let state = seed
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    const other = state % (index + 1)
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

describe('watchSenderDocument: one set of document listeners per sender', () => {
  it('holds one listener of each event for 150 watchers on an emitter with the default limit of 10, and warns never', async () => {
    const sender = new EventEmitter()
    const stops: Array<() => void> = []
    const warnings = await listenerWarnings(() => {
      for (let index = 0; index < 150; index += 1)
        stops.push(watchSenderDocument(sender, { gone: vi.fn() }))
    })
    expect(warnings).toEqual([])
    expect(counts(sender)).toEqual([1, 1, 1])
    for (const stop of stops) stop()
    expect(counts(sender)).toEqual([0, 0, 0])
    expect(sender.eventNames()).toEqual([])
  })

  it("hands every watcher the event it subscribed to, with the navigation event's own arguments", () => {
    const sender = new EventEmitter()
    const watcher = { navigation: vi.fn(), gone: vi.fn(), destroyed: vi.fn() }
    const goneOnly = { gone: vi.fn() }
    watchSenderDocument(sender, watcher)
    watchSenderDocument(sender, goneOnly)
    const details = { isMainFrame: true, isSameDocument: false }
    sender.emit('did-start-navigation', details, 'app://renderer/index.html', false, true, 4, 9)
    sender.emit('did-start-navigation')
    expect(watcher.navigation.mock.calls).toEqual([
      [details, 'app://renderer/index.html', false, true, 4, 9],
      []
    ])
    expect(watcher.gone).not.toHaveBeenCalled()
    sender.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 })
    expect(watcher.gone).toHaveBeenCalledExactlyOnceWith()
    expect(goneOnly.gone).toHaveBeenCalledExactlyOnceWith()
    expect(watcher.destroyed).not.toHaveBeenCalled()
    sender.emit('destroyed')
    expect(watcher.destroyed).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    ['in subscription order', (stops: Array<() => void>) => stops],
    ['in reverse order', (stops: Array<() => void>) => [...stops].reverse()],
    ['in a shuffled order', (stops: Array<() => void>) => shuffled(stops, 7)],
    ['in another shuffled order', (stops: Array<() => void>) => shuffled(stops, 20_261_117)]
  ])(
    'stops 120 watchers %s: the rest keep working, and no listener stays behind',
    (_label, order) => {
      const sender = new EventEmitter()
      const unrelated = vi.fn()
      sender.on('destroyed', unrelated)
      const calls: number[] = []
      const stops = Array.from({ length: 120 }, (_, index) =>
        watchSenderDocument(sender, { gone: () => calls.push(index) })
      )
      const stopOrder = order(stops)
      // Stop the first half in that order: exactly the other half is still called, in subscription order.
      const stopped = new Set(stopOrder.slice(0, 60).map((stop) => stops.indexOf(stop)))
      for (const stop of stopOrder.slice(0, 60)) stop()
      expect(counts(sender)).toEqual([1, 1, 2])
      sender.emit('render-process-gone')
      expect(calls).toEqual(stops.map((_, index) => index).filter((index) => !stopped.has(index)))
      for (const stop of stopOrder.slice(60)) stop()
      expect(counts(sender)).toEqual([0, 0, 1])
      calls.length = 0
      sender.emit('render-process-gone')
      sender.emit('destroyed')
      expect(calls).toEqual([])
      expect(unrelated).toHaveBeenCalledOnce()
      // Stopping twice is harmless, also after another watcher has subscribed again.
      const later = vi.fn()
      const stopLater = watchSenderDocument(sender, { gone: later })
      for (const stop of stops) stop()
      expect(counts(sender)).toEqual([1, 1, 2])
      sender.emit('render-process-gone')
      expect(later).toHaveBeenCalledOnce()
      stopLater()
      expect(counts(sender)).toEqual([0, 0, 1])
    }
  )

  it('calls neither a watcher added during the event nor one stopped during it', () => {
    const sender = new EventEmitter()
    const late = vi.fn()
    const third = vi.fn()
    let stopThird: () => void = () => undefined
    watchSenderDocument(sender, {
      gone: () => {
        watchSenderDocument(sender, { gone: late })
        stopThird()
      }
    })
    const second = vi.fn()
    watchSenderDocument(sender, { gone: second })
    stopThird = watchSenderDocument(sender, { gone: third })
    sender.emit('render-process-gone')
    expect(second).toHaveBeenCalledOnce()
    expect(third).not.toHaveBeenCalled()
    expect(late).not.toHaveBeenCalled()
    sender.emit('render-process-gone')
    expect(late).toHaveBeenCalledOnce()
    expect(third).not.toHaveBeenCalled()
  })

  it('a watcher that stops itself during the event leaves no listener behind when it was the last', () => {
    const sender = new EventEmitter()
    const stops: Array<() => void> = []
    for (let index = 0; index < 100; index += 1) {
      stops.push(watchSenderDocument(sender, { destroyed: () => stops[index]() }))
    }
    sender.emit('destroyed')
    expect(counts(sender)).toEqual([0, 0, 0])
  })

  it('calls every watcher although one fails, then throws that first failure on', () => {
    const sender = new EventEmitter()
    const first = vi.fn()
    const last = vi.fn()
    const failure = new Error('watcher failed')
    watchSenderDocument(sender, { gone: first })
    watchSenderDocument(sender, {
      gone: () => {
        throw failure
      }
    })
    watchSenderDocument(sender, {
      gone: () => {
        throw new Error('second failure')
      }
    })
    watchSenderDocument(sender, { gone: last })
    expect(() => sender.emit('render-process-gone')).toThrow(failure)
    expect(first).toHaveBeenCalledOnce()
    expect(last).toHaveBeenCalledOnce()
  })

  it('treats the same watcher object subscribed twice as two subscriptions', () => {
    const sender = new EventEmitter()
    const watcher: SenderDocumentWatcher = { gone: vi.fn() }
    const stopFirst = watchSenderDocument(sender, watcher)
    const stopSecond = watchSenderDocument(sender, watcher)
    sender.emit('render-process-gone')
    expect(watcher.gone).toHaveBeenCalledTimes(2)
    stopFirst()
    stopFirst()
    sender.emit('render-process-gone')
    expect(watcher.gone).toHaveBeenCalledTimes(3)
    stopSecond()
    expect(counts(sender)).toEqual([0, 0, 0])
  })

  it('keeps the watchers of different senders apart', () => {
    const first = new EventEmitter()
    const second = new EventEmitter()
    const onFirst = vi.fn()
    const onSecond = vi.fn()
    watchSenderDocument(first, { destroyed: onFirst })
    watchSenderDocument(second, { destroyed: onSecond })
    first.emit('destroyed')
    expect(onFirst).toHaveBeenCalledOnce()
    expect(onSecond).not.toHaveBeenCalled()
  })

  const unlistenable = [
    undefined,
    null,
    {},
    { on: () => undefined },
    { removeListener: () => undefined },
    'sender'
  ]
  it.each(unlistenable)('refuses a sender that cannot be listened to: %j', (sender) => {
    const on = vi.fn()
    // A path read or an interaction lease must not start unwatched; their senders used to fail at `on` the same way.
    expect(() => watchSenderDocument(sender, { gone: vi.fn() })).toThrow(TypeError)
    expect(() => watchSenderDocument({ on }, { gone: vi.fn() })).toThrow(TypeError)
    expect(on).not.toHaveBeenCalled()
  })

  it.each(unlistenable)(
    'only with `optional` (IPC streams) leaves such a sender unwatched: %j',
    (sender) => {
      const stop = watchSenderDocument(sender, { gone: vi.fn() }, { optional: true })
      expect(() => stop()).not.toThrow()
      expect(() => stop()).not.toThrow()
    }
  )

  it('a refused sender leaves the watchers of a listenable one untouched', () => {
    const sender = new EventEmitter()
    const gone = vi.fn()
    const stop = watchSenderDocument(sender, { gone })
    expect(() => watchSenderDocument({}, { gone: vi.fn() })).toThrow(TypeError)
    sender.emit('render-process-gone')
    expect(gone).toHaveBeenCalledOnce()
    stop()
    expect(counts(sender)).toEqual([0, 0, 0])
  })
})
