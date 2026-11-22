import { describe, expect, it, vi } from 'vitest'
import {
  CooperativeExecutionController,
  type CooperativeOperationGate
} from './cooperativeExecutionController'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function microtasks() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('callback-owned cooperative admission (not underlying-effect drainage)', () => {
  it('registers a root before invoking its callback and before a same-tick pause can acknowledge', async () => {
    const controller = new CooperativeExecutionController(), work = deferred()
    const callback = vi.fn(async () => { expect(controller.isQuiescent()).toBe(false); await work.promise })
    const running = controller.run('assistant-turn', undefined, callback)
    expect(callback).toHaveBeenCalledOnce()
    let acknowledged = false
    const pause = controller.requestPause().then(() => { acknowledged = true })
    try {
      await microtasks(); expect(acknowledged).toBe(false)
      work.resolve(); await expect(running).resolves.toBeUndefined(); await pause
      expect(controller.isPaused()).toBe(true); expect(controller.isQuiescent()).toBe(true)
    } finally { work.resolve(); controller.resume(); await running; await pause }
  })

  it('rechecks pause after a resume wakeup and does not dispatch across an immediate re-pause', async () => {
    const controller = new CooperativeExecutionController(), abort = new AbortController(), callback = vi.fn(() => undefined)
    const add = vi.spyOn(abort.signal, 'addEventListener'), remove = vi.spyOn(abort.signal, 'removeEventListener')
    await controller.requestPause()
    const pending = controller.run('llm-inference', abort.signal, callback)
    try {
      controller.resume(); await controller.requestPause(); await microtasks()
      expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
      controller.resume(); await expect(pending).resolves.toBeUndefined()
      expect(callback).toHaveBeenCalledOnce(); expect(add.mock.calls.length).toBeGreaterThan(0)
      expect(remove.mock.calls.length).toBe(add.mock.calls.length)
    } finally { controller.resume(); await pending }
  })

  it('lets an exact live child drain while keeping an independent root blocked', async () => {
    const controller = new CooperativeExecutionController(), startChild = deferred(), childDone = deferred()
    const nested = vi.fn(async () => { await childDone.promise }), independent = vi.fn(() => undefined)
    let childGate!: CooperativeOperationGate
    const root = controller.run('assistant-turn', undefined, async turnGate => {
      await startChild.promise
      return turnGate.run('llm-inference', undefined, llmGate => {
        childGate = llmGate
        return llmGate.run('tool-invocation', undefined, nested)
      })
    })
    let acknowledged = false
    const pause = controller.requestPause().then(() => { acknowledged = true })
    const blocked = controller.run('assistant-turn', undefined, independent)
    try {
      startChild.resolve(); await microtasks()
      expect(nested).toHaveBeenCalledOnce(); expect(independent).not.toHaveBeenCalled()
      expect(acknowledged).toBe(false); expect(childGate).not.toBe(controller)
      childDone.resolve(); await root; await pause
      expect(controller.isQuiescent()).toBe(true); expect(independent).not.toHaveBeenCalled()
      controller.resume(); await blocked; expect(independent).toHaveBeenCalledOnce()
    } finally { startChild.resolve(); childDone.resolve(); controller.resume(); await root; await blocked; await pause }
  })

  it('does not let a live operation on another controller bypass root pause', async () => {
    const first = new CooperativeExecutionController(), second = new CooperativeExecutionController(), callback = vi.fn(() => undefined)
    await second.requestPause()
    const running = first.run('assistant-turn', undefined, () => second.run('tool-invocation', undefined, callback))
    try {
      await microtasks(); expect(callback).not.toHaveBeenCalled(); expect(first.isQuiescent()).toBe(false)
      expect(second.isQuiescent()).toBe(true)
      second.resume(); await running; expect(callback).toHaveBeenCalledOnce()
    } finally { second.resume(); await running }
  })

  it('counts parallel children after their parent returns and only a still-live child can admit descendants', async () => {
    const controller = new CooperativeExecutionController(), finishFirst = deferred(), finishSecond = deferred()
    let parentGate!: CooperativeOperationGate, secondGate!: CooperativeOperationGate
    let first!: Promise<void>, second!: Promise<void>
    await controller.run('assistant-turn', undefined, gate => {
      parentGate = gate
      first = gate.run('tool-invocation', undefined, () => finishFirst.promise)
      second = gate.run('tool-invocation', undefined, scope => { secondGate = scope; return finishSecond.promise })
    })
    let acknowledged = false
    const pause = controller.requestPause().then(() => { acknowledged = true })
    try {
      expect(Object.isFrozen(parentGate)).toBe(true)
      await expect(parentGate.run('tool-invocation', undefined, () => undefined)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      finishFirst.resolve(); await first; await microtasks(); expect(acknowledged).toBe(false)
      expect(controller.isQuiescent()).toBe(false)
      await expect(secondGate.run('tool-invocation', undefined, () => undefined)).resolves.toBeUndefined()
      finishSecond.resolve(); await second; await pause
      expect(controller.isQuiescent()).toBe(true)
      await expect(secondGate.run('tool-invocation', undefined, () => undefined)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
    } finally { finishFirst.resolve(); finishSecond.resolve(); await first; await second; await pause }
  })

  it.each([false, true])('rejects a stale captured scope even when currently paused=%s', async paused => {
    const controller = new CooperativeExecutionController(), callback = vi.fn()
    let captured!: CooperativeOperationGate
    await controller.run('assistant-turn', undefined, scope => { captured = scope })
    if (paused) await controller.requestPause()
    await expect(captured.run('tool-invocation', undefined, callback)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
    expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
  })

  it('retains inherited cancellation after its parent settles while a descendant is still live', async () => {
    const controller = new CooperativeExecutionController(), parentAbort = new AbortController(), childDone = deferred()
    let childGate!: CooperativeOperationGate, child!: Promise<void>
    await controller.run('assistant-turn', parentAbort.signal, gate => {
      child = gate.run('llm-inference', undefined, scope => { childGate = scope; return childDone.promise })
    })
    parentAbort.abort(new Error('parent stopped'))
    const callback = vi.fn()
    try {
      await expect(childGate.run('tool-invocation', new AbortController().signal, callback)).rejects.toThrow('parent stopped')
      expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(false)
    } finally { childDone.resolve(); await child }
    expect(controller.isQuiescent()).toBe(true)
  })

  it.each([false, true])('rejects a pre-aborted root before admission paused=%s', async paused => {
    const controller = new CooperativeExecutionController(), abort = new AbortController(), callback = vi.fn()
    if (paused) await controller.requestPause()
    const reason = new Error('pre-abort'); abort.abort(reason)
    await expect(controller.run('assistant-turn', abort.signal, callback)).rejects.toBe(reason)
    expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
  })

  it('aborts paused root waits, removes listeners, and never dispatches on late resume', async () => {
    const controller = new CooperativeExecutionController(), abort = new AbortController(), callback = vi.fn()
    const add = vi.spyOn(abort.signal, 'addEventListener'), remove = vi.spyOn(abort.signal, 'removeEventListener')
    await controller.requestPause()
    const pending = controller.run('tool-invocation', abort.signal, callback), rejected = expect(pending).rejects.toThrow('waiting stopped')
    abort.abort(new Error('waiting stopped')); await rejected
    expect(callback).not.toHaveBeenCalled(); expect(remove.mock.calls.length).toBe(add.mock.calls.length)
    controller.resume(); await microtasks(); expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
  })

  it('checks resume-then-abort before a waiting root registers work', async () => {
    const controller = new CooperativeExecutionController(), abort = new AbortController(), callback = vi.fn()
    await controller.requestPause()
    const pending = controller.run('llm-inference', abort.signal, callback), rejected = expect(pending).rejects.toThrow('same tick stopped')
    controller.resume(); abort.abort(new Error('same tick stopped')); await rejected
    expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
  })

  it('rejects cancelled children even while their admitted parent is still live and paused', async () => {
    const controller = new CooperativeExecutionController(), release = deferred(), abort = new AbortController(), callback = vi.fn()
    let scope!: CooperativeOperationGate
    const root = controller.run('assistant-turn', undefined, gate => { scope = gate; return release.promise })
    const pause = controller.requestPause()
    try {
      abort.abort(new Error('child stopped'))
      await expect(scope.run('tool-invocation', abort.signal, callback)).rejects.toThrow('child stopped')
      expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(false)
    } finally { release.resolve(); await root; await pause }
  })

  it('revokes a synchronous void callback scope before returning in the same turn', async () => {
    const controller = new CooperativeExecutionController(), callback = vi.fn()
    let captured!: CooperativeOperationGate
    const running = controller.run('assistant-turn', undefined, scope => { captured = scope })
    const pause = controller.requestPause(), late = captured.run('tool-invocation', undefined, callback)
    expect(callback).not.toHaveBeenCalled()
    await expect(late).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
    await running; await pause; expect(controller.isQuiescent()).toBe(true)
  })

  it.each(['ancestor', 'child', 'both'])('gives settled-scope rejection precedence over a cancelled %s signal', async source => {
    const controller = new CooperativeExecutionController(), ancestorAbort = new AbortController(), childAbort = new AbortController(), callback = vi.fn()
    let captured!: CooperativeOperationGate
    await controller.run('assistant-turn', ancestorAbort.signal, scope => { captured = scope })
    if (source !== 'child') ancestorAbort.abort(new Error('ancestor aborted'))
    if (source !== 'ancestor') childAbort.abort(new Error('child aborted'))
    await expect(captured.run('tool-invocation', childAbort.signal, callback)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
    expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
  })

  it('binds detached and rebound child run methods to their original controller and lease', async () => {
    const original = new CooperativeExecutionController(), unrelated = new CooperativeExecutionController(), work = deferred()
    let captured!: CooperativeOperationGate
    const root = original.run('assistant-turn', undefined, scope => { captured = scope; return work.promise })
    const pause = original.requestPause()
    await unrelated.requestPause()
    const detached = captured.run, rebound = detached.bind(unrelated)
    try {
      await detached('tool-invocation', undefined, () => undefined)
      await rebound('llm-inference', undefined, () => undefined)
      expect(original.isQuiescent()).toBe(false); expect(unrelated.isQuiescent()).toBe(true)
      work.resolve(); await root; await pause
      const callback = vi.fn()
      await expect(rebound('tool-invocation', undefined, callback)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      expect(callback).not.toHaveBeenCalled()
    } finally { work.resolve(); await root; await pause }
  })

  it('inherits cancellation through multiple settled ancestors while the admitted descendant remains live', async () => {
    const controller = new CooperativeExecutionController(), abort = new AbortController(), finishLeaf = deferred()
    let leafGate!: CooperativeOperationGate, leaf!: Promise<void>
    await controller.run('assistant-turn', abort.signal, scope => scope.run('llm-inference', undefined, child => {
      leaf = child.run('tool-invocation', undefined, gate => { leafGate = gate; return finishLeaf.promise })
    }))
    const callback = vi.fn()
    abort.abort(new Error('root cancelled'))
    try {
      await expect(leafGate.run('tool-invocation', undefined, callback)).rejects.toThrow('root cancelled')
      expect(callback).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(false)
    } finally { finishLeaf.resolve(); await leaf }
    expect(controller.isQuiescent()).toBe(true)
  })

  it.each(['callable-first', 'noncallable-first', 'throwing', 'shadowed-call', 'own-data'])('rejects custom %s thenables without reading or calling their then member', async kind => {
    const controller = new CooperativeExecutionController(), getter = vi.fn(), body = vi.fn(), callback = vi.fn()
    const then = Object.assign((resolve: () => void) => { body(); resolve() }, { call: () => undefined })
    const result = kind === 'own-data' ? { then: 0 } : kind === 'shadowed-call' ? { then } : Object.defineProperty({}, 'then', { get() {
      getter()
      if (kind === 'throwing') throw new Error('must not read')
      if (kind === 'noncallable-first' && getter.mock.calls.length === 1) return undefined
      return (resolve: () => void) => { body(); resolve() }
    } })
    let captured!: CooperativeOperationGate
    const pending = controller.run('assistant-turn', undefined, scope => { captured = scope; return result as never })
    await expect(pending).rejects.toMatchObject({ code: 'COOPERATIVE_CALLBACK_RESULT_UNSUPPORTED' })
    expect(getter).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
    await expect(captured.run('tool-invocation', undefined, callback)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
    expect(callback).not.toHaveBeenCalled()
  })

  it.each([null, 0, 'value', {}, () => undefined])('rejects a synchronous non-void result without adopting its value', async result => {
    const controller = new CooperativeExecutionController()
    await expect(controller.run('assistant-turn', undefined, () => result as never)).rejects.toMatchObject({ code: 'COOPERATIVE_CALLBACK_RESULT_UNSUPPORTED' })
    expect(controller.isQuiescent()).toBe(true)
  })

  it('ignores fulfilled native Promise values instead of assimilating them a second time', async () => {
    const controller = new CooperativeExecutionController(), getter = vi.fn(), body = vi.fn()
    const value = Object.defineProperty({}, 'then', { get() {
      getter(); return getter.mock.calls.length === 1 ? undefined : (resolve: () => void) => { body(); resolve() }
    } })
    const native = Promise.resolve(value)
    expect(getter).toHaveBeenCalledOnce()
    await expect(controller.run('assistant-turn', undefined, () => native as unknown as Promise<void>)).resolves.toBeUndefined()
    expect(getter).toHaveBeenCalledOnce(); expect(body).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
  })

  it.each(['subclass', 'constructor-override', 'then-override', 'proxy'])('rejects a nonordinary %s promise without invoking its overrides', async kind => {
    const controller = new CooperativeExecutionController(), getter = vi.fn()
    class OtherPromise extends Promise<void> {}
    const native = Promise.resolve()
    const result = kind === 'subclass' ? OtherPromise.resolve() : kind === 'proxy' ? new Proxy(native, { get: () => { getter(); throw new Error('proxy touched') } }) : Object.defineProperty(native, kind === 'constructor-override' ? 'constructor' : 'then', { get: () => { getter(); throw new Error('override touched') } })
    await expect(controller.run('assistant-turn', undefined, () => result)).rejects.toMatchObject({ code: 'COOPERATIVE_CALLBACK_RESULT_UNSUPPORTED' })
    expect(getter).not.toHaveBeenCalled(); expect(controller.isQuiescent()).toBe(true)
  })

  it('retains an already-admitted callback through cancellation until that callback actually settles', async () => {
    const controller = new CooperativeExecutionController(), abort = new AbortController(), work = deferred()
    const running = controller.run('tool-invocation', abort.signal, () => work.promise)
    let acknowledged = false, settled = false
    void running.then(() => { settled = true })
    const pause = controller.requestPause().then(() => { acknowledged = true })
    try {
      abort.abort(new Error('callback ignores cancellation')); await microtasks()
      expect(settled).toBe(false); expect(acknowledged).toBe(false); expect(controller.isQuiescent()).toBe(false)
    } finally { work.resolve(); await running; await pause }
    expect(controller.isQuiescent()).toBe(true)
  })

  it('cleans listeners across repeated resume/re-pause wakes without admitting a waiting root', async () => {
    const controller = new CooperativeExecutionController(), abort = new AbortController(), callback = vi.fn()
    const add = vi.spyOn(abort.signal, 'addEventListener'), remove = vi.spyOn(abort.signal, 'removeEventListener')
    await controller.requestPause()
    const pending = controller.run('assistant-turn', abort.signal, callback), rejected = expect(pending).rejects.toThrow('final wait aborted')
    try {
      for (let i = 0; i < 4; i++) {
        controller.resume(); await controller.requestPause(); await microtasks(); expect(callback).not.toHaveBeenCalled()
      }
      abort.abort(new Error('final wait aborted')); await rejected
      expect(add.mock.calls.length).toBeGreaterThan(4); expect(remove.mock.calls.length).toBe(add.mock.calls.length)
      expect(controller.isQuiescent()).toBe(true)
    } finally { abort.abort(new Error('final wait aborted')); controller.resume(); await rejected }
  })

  it('does not leak controller or raw admission methods through a child scope', async () => {
    const controller = new CooperativeExecutionController(), abort = new AbortController(), callback = vi.fn()
    let captured!: CooperativeOperationGate
    await controller.run('assistant-turn', abort.signal, async gate => {
      expect(Object.keys(gate)).toEqual(['run']); expect(Object.isFrozen(gate)).toBe(true); expect(JSON.stringify(gate)).toBe('{}')
      await gate.run('llm-inference', abort.signal, async child => {
        captured = child; await child.run('tool-invocation', abort.signal, callback)
      })
    })
    expect(callback).toHaveBeenCalledOnce()
    const add = vi.spyOn(abort.signal, 'addEventListener')
    await expect(captured.run('tool-invocation', abort.signal, callback)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
    expect(add).not.toHaveBeenCalled(); expect(callback).toHaveBeenCalledOnce(); expect(controller.isQuiescent()).toBe(true)
  })

  it.each(['throw', 'reject'])('releases owned callbacks on %s without changing their errors', async failure => {
    const controller = new CooperativeExecutionController(), error = new Error('callback error')
    const pending = controller.run('tool-invocation', undefined, () => { if (failure === 'throw') throw error; return Promise.reject(error) })
    await expect(pending).rejects.toBe(error); expect(controller.isQuiescent()).toBe(true)
    await controller.requestPause(); expect(controller.isPaused()).toBe(true)
  })
})
