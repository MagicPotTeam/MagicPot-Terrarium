import { describe, expect, it, vi } from 'vitest'
import { createConfigObservationController, unavailableConfigObservation } from './configObservation'

describe('provider-owned passive configuration observation — display freshness only', () => {
  it('constructs without API/storage/timers and exposes only a stable frozen notready snapshot', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem'), timer = vi.spyOn(window, 'setTimeout'), interval = vi.spyOn(window, 'setInterval')
    try {
      const controller = createConfigObservationController(), source = controller.source, first = source.getSnapshot(), observed = vi.fn()
      expect(first).toEqual({ ready: false, generation: 0 }); expect(source.getSnapshot()).toBe(first)
      expect(Object.isFrozen(controller)).toBe(true); expect(Object.isFrozen(source)).toBe(true); expect(Object.isFrozen(first)).toBe(true)
      expect(Reflect.ownKeys(first).sort()).toEqual(['generation', 'ready']); expect(Reflect.ownKeys(source).sort()).toEqual(['getSnapshot', 'subscribe'])
      const unsubscribe = source.subscribe(observed); expect(observed).not.toHaveBeenCalled(); unsubscribe()
      for (const hook of [get, set, remove, timer, interval]) expect(hook).not.toHaveBeenCalled()
    } finally { get.mockRestore(); set.mockRestore(); remove.mockRestore(); timer.mockRestore(); interval.mockRestore() }
  })
  it('publishes a fresh immutable snapshot before each synchronous notification, including repeated readiness', () => {
    const { source, advance } = createConfigObservationController(), seen: unknown[] = [], listener = vi.fn(() => { seen.push(source.getSnapshot()) })
    source.subscribe(listener); const first = source.getSnapshot()
    advance(true); expect(listener).toHaveBeenCalledOnce(); expect(seen[0]).toEqual({ ready: true, generation: 1 }); expect(seen[0]).toBe(source.getSnapshot()); expect(seen[0]).not.toBe(first)
    advance(true); expect(listener).toHaveBeenCalledTimes(2); expect(source.getSnapshot()).toEqual({ ready: true, generation: 2 }); expect(source.getSnapshot()).not.toBe(seen[0]); expect(Object.isFrozen(source.getSnapshot())).toBe(true)
    advance(false); expect(listener).toHaveBeenCalledTimes(3); expect(source.getSnapshot()).toEqual({ ready: false, generation: 3 })
  })
  it('isolates one throwing observer and never logs or skips the next notification', () => {
    const { source, advance } = createConfigObservationController(), log = vi.spyOn(console, 'error').mockImplementation(() => {}), hook = vi.fn(() => { throw new Error('RAW_OBSERVER_ERROR') }), next = vi.fn()
    try { source.subscribe(hook); source.subscribe(next); expect(() => advance(true)).not.toThrow(); expect(hook).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled() } finally { log.mockRestore() }
  })
  it('retires each exact subscription, even when the same listener was subscribed twice', () => {
    const { source, advance } = createConfigObservationController(), listener = vi.fn(), first = source.subscribe(listener), second = source.subscribe(listener)
    first(); first(); advance(true); expect(listener).toHaveBeenCalledOnce()
    second(); second(); advance(false); expect(listener).toHaveBeenCalledOnce()
  })
  it('keeps provider owners independent and cannot revoke a successor subscription', () => {
    const first = createConfigObservationController(), second = createConfigObservationController(), old = vi.fn(), next = vi.fn(), dispose = first.source.subscribe(old)
    expect(first.source).not.toBe(second.source)
    second.source.subscribe(next); dispose(); first.advance(true); expect(old).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled()
    second.advance(true); expect(next).toHaveBeenCalledOnce(); expect(second.source.getSnapshot()).toEqual({ ready: true, generation: 1 })
  })
  it('handles unsubscribe/reentry without reviving a stale snapshot or losing a later subscription', () => {
    const { source, advance } = createConfigObservationController(), next = vi.fn(); let nested = false, dispose = () => {}
    dispose = source.subscribe(() => { dispose(); source.subscribe(next); if (!nested) { nested = true; advance(false) } })
    const token = advance(true); expect(source.getSnapshot()).toEqual({ ready: false, generation: 2 }); expect(next).toHaveBeenCalledOnce()
    expect(token).toEqual({ ready: true, generation: 1 }); expect(token).not.toBe(source.getSnapshot())
    advance(true); expect(next).toHaveBeenCalledTimes(2); expect(source.getSnapshot()).toEqual({ ready: true, generation: 3 })
  })
  it('missing observation is permanently notready and has no eager notification or writer surface', () => {
    const listener = vi.fn(), snapshot = unavailableConfigObservation.getSnapshot(), dispose = unavailableConfigObservation.subscribe(listener)
    expect(snapshot).toEqual({ ready: false, generation: 0 }); expect(Object.isFrozen(snapshot)).toBe(true); dispose(); dispose()
    expect(listener).not.toHaveBeenCalled(); expect(unavailableConfigObservation.getSnapshot()).toBe(snapshot); expect(Object.hasOwn(unavailableConfigObservation, 'advance')).toBe(false)
  })
})
