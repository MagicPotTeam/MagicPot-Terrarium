import { describe, expect, it } from 'vitest'
import { CooperativeExecutionController } from './cooperativeExecutionController'

async function microtasks() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('pause acknowledgement tickets (not external-effect safe points)', () => {
  it('returns a frozen identity shared only by a continuous pause on one controller', async () => {
    const controller = new CooperativeExecutionController(), other = new CooperativeExecutionController()
    const [first, concurrent] = await Promise.all([controller.requestPause(), controller.requestPause()])
    const foreign = await other.requestPause()
    expect(first).toBeDefined(); expect(Object.isFrozen(first)).toBe(true)
    expect(first).toBe(concurrent); expect(first).not.toBe(foreign)
    expect(controller.isPauseCurrent(first)).toBe(true)
    expect(controller.isPauseCurrent(foreign)).toBe(false)
    expect(controller.isPauseCurrent(Object.freeze({}) as never)).toBe(false)
    controller.resume(); expect(controller.isPauseCurrent(first)).toBe(false)
  })

  it('invalidates an idle resolved acknowledgement before its consumer continuation runs', async () => {
    const controller = new CooperativeExecutionController()
    const pending = controller.requestPause()
    controller.resume()
    const stale = await pending
    expect(controller.isPauseCurrent(stale)).toBe(false)
    const current = await controller.requestPause()
    expect(current).not.toBe(stale); expect(controller.isPauseCurrent(current)).toBe(true)
    expect(controller.isPauseCurrent(stale)).toBe(false)
  })

  it('withdraws a waiting acknowledgement promptly on resume without releasing active work', async () => {
    const controller = new CooperativeExecutionController(), leave = controller.enter('llm-inference')
    let settled = false
    const pending = controller.requestPause()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' }).then(() => { settled = true })
    controller.resume()
    try {
      await microtasks(); expect(settled).toBe(true); expect(controller.isQuiescent()).toBe(false)
    } finally { leave(); await rejected }
    expect(controller.isQuiescent()).toBe(true)
  })

  it('keeps an old drain continuation stale across resume and a new pause in the same turn', async () => {
    const controller = new CooperativeExecutionController(), leave = controller.enter('tool-invocation')
    const stale = controller.requestPause(), rejected = expect(stale).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
    leave(); controller.resume(); const fresh = controller.requestPause()
    await rejected
    const current = await fresh
    expect(controller.isPauseCurrent(current)).toBe(true)
  })

  it('does not let an old waiting acknowledgement inherit a new generation while work is still active', async () => {
    const controller = new CooperativeExecutionController(), leave = controller.enter('assistant-turn')
    const pending = controller.requestPause(), rejected = expect(pending).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
    controller.resume()
    let freshSettled = false
    const fresh = controller.requestPause().then(ticket => { freshSettled = true; return ticket })
    try {
      await rejected; await microtasks()
      expect(freshSettled).toBe(false); expect(controller.isQuiescent()).toBe(false)
    } finally { leave() }
    expect(controller.isPauseCurrent(await fresh)).toBe(true)
  })

  it('revalidates quiescence after receipt if legacy admission reenters while paused', async () => {
    const controller = new CooperativeExecutionController(), ticket = await controller.requestPause()
    expect(() => controller.enter('graph-node')).toThrow(
      expect.objectContaining({ code: 'COOPERATIVE_EXECUTION_PAUSED' })
    )
    // Synthetic pre-hardening/corrupt state, not legal paused admission. Retain
    // real private registration/release to exercise the ticket's defensive check.
    const leave = Reflect.apply(Reflect.get(controller, 'registerActive'), controller, [
      'graph-node'
    ]) as () => void
    let repeated!: Promise<typeof ticket>
    try {
      expect(controller.isPauseCurrent(ticket)).toBe(false)
      let acknowledged = false
      repeated = controller.requestPause().then(next => { acknowledged = true; return next })
      await microtasks(); expect(acknowledged).toBe(false)
    } finally { leave() }
    expect(await repeated).toBe(ticket); expect(controller.isPauseCurrent(ticket)).toBe(true)
  })

  it('settles every superseded waiter and permits a later pause without stale acknowledgement reuse', async () => {
    const controller = new CooperativeExecutionController(), leave = controller.enter('scheduled-task')
    const waits = Array.from({ length: 4 }, () => controller.requestPause())
    const outcomes = Promise.all(waits.map(wait => expect(wait).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })))
    controller.resume(); await outcomes
    expect(controller.isQuiescent()).toBe(false)
    leave()
    const fresh = await controller.requestPause()
    expect(controller.isPauseCurrent(fresh)).toBe(true)
    controller.resume(); controller.resume(); expect(controller.isPauseCurrent(fresh)).toBe(false)
  })
})
