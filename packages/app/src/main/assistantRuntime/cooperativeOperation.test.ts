import { describe, expect, it, vi } from 'vitest'
import { CooperativeExecutionController, type CooperativeOperationGate } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { withCooperativeOperation } from './cooperativeOperation'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function microtasks() { for (let i = 0; i < 24; i++) await Promise.resolve() }

describe('withCooperativeOperation MAIN result capture', () => {
  it('captures data without returning it from the void-only controller callback', async () => {
    const gate = new CooperativeExecutionController(), data = { content: 'data' }
    let callbackResult: unknown
    const traced: CooperativeOperationGate = { run: (kind, signal, operation) => gate.run(kind, signal, child => {
      const pending = operation(child)
      return (async () => { callbackResult = await pending })()
    }) }
    expect(await withCooperativeOperation(traced, 'assistant-turn', undefined, async () => data)).toBe(data)
    expect(callbackResult).toBeUndefined(); expect(gate.isQuiescent()).toBe(true)
  })

  it('retains the real root while nested children finish and leaves independent work blocked until resume', async () => {
    const gate = new CooperativeExecutionController(), childStart = deferred(), finishChild = deferred(), finishOuter = deferred()
    let scoped!: CooperativeOperationGate, childCalls = 0, independentCalls = 0
    const outer = withCooperativeOperation(gate, 'assistant-turn', undefined, async child => { scoped = child!; childStart.resolve(); await finishOuter.promise; return 7 })
    await childStart.promise
    let acknowledged = false
    const pause = gate.requestPause().then(ticket => { acknowledged = true; return ticket }, error => error)
    const independent = withCooperativeOperation(gate, 'assistant-turn', undefined, async () => { independentCalls++; return 9 })
    const nested = withCooperativeOperation(scoped, 'tool-invocation', undefined, async () => { childCalls++; await finishChild.promise; return 8 })
    try {
      await microtasks(); expect(childCalls).toBe(1); expect(independentCalls).toBe(0); expect(acknowledged).toBe(false)
      finishChild.resolve(); expect(await nested).toBe(8); await microtasks(); expect(acknowledged).toBe(false)
      finishOuter.resolve(); expect(await outer).toBe(7); expect(gate.isPauseCurrent(await pause)).toBe(true)
      gate.resume(); expect(await independent).toBe(9)
    } finally { finishChild.resolve(); finishOuter.resolve(); gate.resume(); await nested; await outer; await independent; await pause }
  })

  it('prioritizes a stale child over an already-aborted local signal and never calls the operation', async () => {
    const gate = new CooperativeExecutionController(), abort = new AbortController(), operation = vi.fn(async () => 1)
    let stale!: CooperativeOperationGate
    await withCooperativeOperation(gate, 'assistant-turn', undefined, async child => { stale = child! })
    abort.abort(new Error('cancelled'))
    await expect(withCooperativeOperation(stale, 'tool-invocation', abort.signal, operation)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
    expect(operation).not.toHaveBeenCalled(); expect(gate.isQuiescent()).toBe(true)
  })

  it('keeps no-gate behavior explicit and checks cancellation before the operation', async () => {
    const abort = new AbortController(), operation = vi.fn(async child => { expect(child).toBeUndefined(); return 'ok' })
    expect(await withCooperativeOperation(undefined, 'assistant-turn', undefined, operation)).toBe('ok')
    abort.abort(new Error('pre-abort'))
    await expect(withCooperativeOperation(undefined, 'assistant-turn', abort.signal, operation)).rejects.toThrow('pre-abort')
    expect(operation).toHaveBeenCalledOnce()
  })

  it('preserves the original rejection and releases only after the callback settles', async () => {
    const gate = new CooperativeExecutionController(), finish = deferred(), original = new Error('original')
    const pending = withCooperativeOperation(gate, 'tool-invocation', undefined, async () => { await finish.promise; throw original })
    const rejected = expect(pending).rejects.toBe(original)
    expect(gate.isQuiescent()).toBe(false); finish.resolve(); await rejected; expect(gate.isQuiescent()).toBe(true)
  })
})
