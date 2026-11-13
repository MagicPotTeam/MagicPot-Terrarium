import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductionAgentInstanceLifecycle } from './productionAgentInstanceLifecycleOwner'

const h = vi.hoisted(() => ({
  construct: vi.fn(), recover: vi.fn(), listRunning: vi.fn((): { id: string }[] => []),
  recoverOperation: vi.fn(), close: vi.fn((): Promise<void> => Promise.resolve()),
  onServiceClosing: vi.fn(), io: vi.fn((): never => { throw new Error('No read/probe permitted') }),
  services: [] as { closing: boolean; close(): Promise<void> }[]
}))
vi.mock('./persistentAgentInstanceStore', () => ({ PersistentAgentInstanceStore: class {
  constructor(...args: unknown[]) { h.construct('instances', ...args) }
  get = h.io; list = h.io
} }))
vi.mock('./persistentAgentConfigStore', () => ({ PersistentAgentConfigStore: class {
  constructor(...args: unknown[]) { h.construct('configs', ...args) }
  get = h.io; list = h.io
} }))
vi.mock('./persistentAgentTeamStore', () => ({ PersistentAgentTeamStore: class {
  constructor(...args: unknown[]) { h.construct('teams', ...args) }
} }))
vi.mock('./persistentAgentTeamLifecycleOperationStore', () => ({ PersistentAgentTeamLifecycleOperationStore: class {
  constructor(...args: unknown[]) { h.construct('operations', ...args) }
  listRunning() { return h.listRunning() }
  recoverInterrupted(...args: unknown[]) { return h.recoverOperation(...args) }
} }))
vi.mock('./agentInstanceCommandService', () => ({ AgentInstanceCommandService: class {
  constructor(...args: unknown[]) { h.construct('commands', ...args) }
} }))
vi.mock('./agentTeamCommandService', () => ({ AgentTeamCommandService: class {
  constructor(...args: unknown[]) { h.construct('team-commands', ...args) }
} }))
vi.mock('./productionAgentInstanceLifecycle', () => ({ ProductionAgentInstanceLifecycleService: class {
  closing = false
  constructor(...args: unknown[]) { h.construct('service', ...args); h.services.push(this) }
  recoverInterrupted() { h.recover() }
  isClosing() { return this.closing }
  close() { this.closing = true; h.onServiceClosing(); return h.close() }
} }))

type Module = typeof import('./productionAgentInstanceLifecycleOwner')
const options = () => ({
  eventStore: Object.freeze({ fixture: 'no database' }),
  authorization: Object.freeze({ fixture: 'no policy' }),
  platformService: { runAgent: h.io }
}) as unknown as ConstructorParameters<typeof ProductionAgentInstanceLifecycle>[0]
const deferred = () => {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let m: Module
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); h.services.length = 0
  h.recover.mockReset(); h.listRunning.mockReset().mockReturnValue([]); h.recoverOperation.mockReset()
  h.close.mockReset().mockImplementation(() => Promise.resolve()); h.onServiceClosing.mockReset()
  m = await import('./productionAgentInstanceLifecycleOwner')
})

describe('MAIN-only already-ready owner capture, immediate dependencies mocked; no DB/native boot', () => {
  it('import/getter/capture never initialize, construct or probe anything', () => {
    expect(m.getProductionAgentInstanceLifecycle()).toBeUndefined()
    for (let i = 0; i < 3; i++) expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    expect(h.construct).not.toHaveBeenCalled(); expect(h.recover).not.toHaveBeenCalled()
    expect(h.listRunning).not.toHaveBeenCalled(); expect(h.recoverOperation).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled(); expect(h.io).not.toHaveBeenCalled()
  })
  it('publishes only after both recoveries, preserves order and exact cached owner', () => {
    const order: string[] = []
    h.recover.mockImplementation(() => {
      order.push('instances'); expect(m.getProductionAgentInstanceLifecycle()).toBeDefined()
      expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    })
    h.listRunning.mockImplementation(() => { order.push('list-operations'); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull(); return [{ id: 'a' }, { id: 'b' }] })
    h.recoverOperation.mockImplementation((input: { id: string }) => { order.push(input.id); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull() })
    const owner = m.startProductionAgentInstanceLifecycle(options())
    expect(order).toEqual(['instances', 'list-operations', 'a', 'b'])
    const capture = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(capture).not.toBeNull(); expect(capture.lifecycle === owner).toBe(true); expect(capture.isCurrent()).toBe(true)
    expect(Object.keys(capture).sort()).toEqual(['isCurrent', 'lifecycle']); expect(Object.isFrozen(capture)).toBe(true)
    expect(Object.isFrozen(owner)).toBe(false); expect(Object.isFrozen(owner.service)).toBe(false)
    expect(m.startProductionAgentInstanceLifecycle(options()) === owner).toBe(true)
    expect(m.getProductionAgentInstanceLifecycle() === owner).toBe(true)
    expect(h.construct).toHaveBeenCalledTimes(7); expect(h.recover).toHaveBeenCalledOnce(); expect(h.io).not.toHaveBeenCalled()
  })
  it('repeated captures/identity checks do not recover, initialize or query', () => {
    const owner = m.startProductionAgentInstanceLifecycle(options()), first = m.captureProductionAgentInstanceLifecycleReadiness()!
    const constructed = h.construct.mock.calls.length
    for (let i = 0; i < 8; i++) {
      const capture = m.captureProductionAgentInstanceLifecycleReadiness()!
      expect(capture).not.toBeNull(); expect(capture.lifecycle === owner).toBe(true); expect(capture.isCurrent()).toBe(true); expect(first.isCurrent()).toBe(true)
    }
    expect(h.construct).toHaveBeenCalledTimes(constructed); expect(h.recover).toHaveBeenCalledOnce()
    expect(h.listRunning).toHaveBeenCalledOnce(); expect(h.close).not.toHaveBeenCalled(); expect(h.io).not.toHaveBeenCalled()
  })
  it.each(['instances', 'list-operations', 'operation'])('never publishes on %s recovery failure or a cached-start retry', phase => {
    const failure = new Error('recovery fixture failure')
    if (phase === 'instances') h.recover.mockImplementationOnce(() => { throw failure })
    if (phase === 'list-operations') h.listRunning.mockImplementationOnce(() => { throw failure })
    if (phase === 'operation') { h.listRunning.mockReturnValueOnce([{ id: 'bad' }]); h.recoverOperation.mockImplementationOnce(() => { throw failure }) }
    expect(() => m.startProductionAgentInstanceLifecycle(options())).toThrow(failure)
    const retained = m.getProductionAgentInstanceLifecycle()!
    expect(retained).toBeDefined(); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    expect(m.startProductionAgentInstanceLifecycle(options()) === retained).toBe(true)
    expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull(); expect(h.recover).toHaveBeenCalledOnce(); expect(h.io).not.toHaveBeenCalled()
  })
  it('canonical start reentry returns the same not-yet-ready owner without a second recovery', () => {
    let nested: ProductionAgentInstanceLifecycle | undefined
    h.recover.mockImplementationOnce(() => {
      nested = m.startProductionAgentInstanceLifecycle(options())
      expect(nested === m.getProductionAgentInstanceLifecycle()).toBe(true)
      expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    })
    const owner = m.startProductionAgentInstanceLifecycle(options())
    expect(nested === owner).toBe(true); expect(h.recover).toHaveBeenCalledOnce()
    expect(m.captureProductionAgentInstanceLifecycleReadiness()?.isCurrent()).toBe(true)
  })
  it('fresh direct recovery on the same object retires old captures before callbacks and publishes a new identity', () => {
    const owner = m.startProductionAgentInstanceLifecycle(options()), old = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(old).not.toBeNull()
    h.recover.mockImplementationOnce(() => { expect(old.isCurrent()).toBe(false); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull() })
    owner.start()
    const latest = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(latest).not.toBeNull(); expect(latest.lifecycle === owner).toBe(true); expect(latest.isCurrent()).toBe(true); expect(old.isCurrent()).toBe(false)
    expect(h.recover).toHaveBeenCalledTimes(2); expect(h.io).not.toHaveBeenCalled()
  })
  it('failed direct recovery keeps prior captures stale and the retained owner unavailable', () => {
    const owner = m.startProductionAgentInstanceLifecycle(options()), old = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(old).not.toBeNull(); const failure = new Error('direct recovery failed')
    h.recover.mockImplementationOnce(() => { expect(old.isCurrent()).toBe(false); throw failure })
    expect(() => owner.start()).toThrow(failure)
    expect(old.isCurrent()).toBe(false); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    expect(m.startProductionAgentInstanceLifecycle(options()) === owner).toBe(true); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
  })
  it('overlapping direct recoveries fail closed instead of publishing a nested or superseded attempt', () => {
    const owner = m.startProductionAgentInstanceLifecycle(options()), old = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(old).not.toBeNull(); let once = false
    h.recover.mockImplementation(() => {
      expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
      if (!once) { once = true; owner.start(); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull() }
    })
    owner.start()
    expect(old.isCurrent()).toBe(false); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    h.recover.mockReset(); owner.start()
    expect(m.captureProductionAgentInstanceLifecycleReadiness()?.isCurrent()).toBe(true); expect(old.isCurrent()).toBe(false)
  })
  it.each(['escape', 'caught'])('unwinds both depths after a nested recovery exception (%s) and permits only a later independent identity', mode => {
    const owner = m.startProductionAgentInstanceLifecycle(options()), old = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(old).not.toBeNull(); const failure = new Error('nested recovery failed'); let entered = false
    h.recover.mockImplementation(() => {
      expect(old.isCurrent()).toBe(false); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
      if (entered) throw failure
      entered = true
      if (mode === 'caught') {
        let caught: unknown
        try { owner.start() } catch (error) { caught = error }
        expect(caught).toBe(failure)
        expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
      } else owner.start()
    })
    let escaped: unknown
    try { owner.start() } catch (error) { escaped = error }
    expect(escaped).toBe(mode === 'escape' ? failure : undefined)
    expect(old.isCurrent()).toBe(false); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    expect(m.startProductionAgentInstanceLifecycle(options()) === owner).toBe(true)
    expect(h.recover).toHaveBeenCalledTimes(3); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    h.recover.mockReset(); owner.start()
    const current = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(current).not.toBeNull(); expect(current.lifecycle === owner).toBe(true); expect(current.isCurrent()).toBe(true)
    expect(old.isCurrent()).toBe(false); expect(h.recover).toHaveBeenCalledOnce(); expect(h.io).not.toHaveBeenCalled()
  })
  it('keeps exact canonical close join/cache during reentry but invalidates before the external close', async () => {
    const owner = m.startProductionAgentInstanceLifecycle(options()), old = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(old).not.toBeNull(); const pending = deferred(); let nested: Promise<void> | undefined
    h.close.mockImplementationOnce(() => {
      expect(old.isCurrent()).toBe(false); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
      expect(m.startProductionAgentInstanceLifecycle(options()) === owner).toBe(true)
      nested = m.closeProductionAgentInstanceLifecycle(); return pending.promise
    })
    const first = m.closeProductionAgentInstanceLifecycle()
    expect(nested).toBe(first); expect(m.closeProductionAgentInstanceLifecycle()).toBe(first)
    expect(m.getProductionAgentInstanceLifecycle() === owner).toBe(true); expect(old.isCurrent()).toBe(false)
    expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull(); expect(h.close).toHaveBeenCalledOnce()
    pending.resolve(); await first
    expect(m.getProductionAgentInstanceLifecycle()).toBeUndefined(); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull(); expect(old.isCurrent()).toBe(false)
    const next = m.startProductionAgentInstanceLifecycle(options()), current = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(next === owner).toBe(false); expect(current).not.toBeNull(); expect(current.lifecycle === next).toBe(true); expect(current.isCurrent()).toBe(true); expect(old.isCurrent()).toBe(false)
  })
  it.each(['throw', 'reject'])('retains failed %s canonical close join without reconstruction or read readiness', async kind => {
    const owner = m.startProductionAgentInstanceLifecycle(options()), old = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(old).not.toBeNull(); const failure = new Error('close failed')
    h.close.mockImplementationOnce(() => { if (kind === 'throw') throw failure; return Promise.reject(failure) })
    const first = m.closeProductionAgentInstanceLifecycle(); await expect(first).rejects.toBe(failure)
    expect(m.closeProductionAgentInstanceLifecycle()).toBe(first); expect(m.getProductionAgentInstanceLifecycle() === owner).toBe(true)
    expect(m.startProductionAgentInstanceLifecycle(options()) === owner).toBe(true)
    expect(old.isCurrent()).toBe(false); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    expect(h.recover).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalledOnce(); expect(h.io).not.toHaveBeenCalled()
  })
  it.each(['class', 'service'])('direct %s close invalidates before its synchronous callback and never revives on retained start', async via => {
    const owner = m.startProductionAgentInstanceLifecycle(options()), old = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(old).not.toBeNull()
    h.onServiceClosing.mockImplementationOnce(() => { expect(old.isCurrent()).toBe(false); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull() })
    await (via === 'class' ? owner.close() : owner.service.close())
    expect(m.startProductionAgentInstanceLifecycle(options()) === owner).toBe(true)
    expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull(); expect(old.isCurrent()).toBe(false)
    owner.start(); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull(); expect(old.isCurrent()).toBe(false)
  })
  it('does not publish after canonical close reenters the first recovery callback', async () => {
    let closing: Promise<void> | undefined
    h.recover.mockImplementationOnce(() => { closing = m.closeProductionAgentInstanceLifecycle(); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull() })
    m.startProductionAgentInstanceLifecycle(options())
    expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull(); await closing
    expect(m.getProductionAgentInstanceLifecycle()).toBeUndefined(); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
  })
  it('does not publish after direct service close during the last team recovery callback', async () => {
    let closing: Promise<void> | undefined
    h.listRunning.mockReturnValueOnce([{ id: 'last' }])
    h.recoverOperation.mockImplementationOnce(() => { closing = m.getProductionAgentInstanceLifecycle()!.service.close(); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull() })
    m.startProductionAgentInstanceLifecycle(options()); await closing
    expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
  })
  it('a detached manually constructed owner does not become the canonical read owner', () => {
    const detached = new m.ProductionAgentInstanceLifecycle(options()); detached.start()
    expect(m.getProductionAgentInstanceLifecycle()).toBeUndefined(); expect(m.captureProductionAgentInstanceLifecycleReadiness()).toBeNull()
    const active = m.startProductionAgentInstanceLifecycle(options()), current = m.captureProductionAgentInstanceLifecycleReadiness()!
    expect(current).not.toBeNull(); expect(current.lifecycle === active).toBe(true); expect(current.lifecycle === detached).toBe(false)
    expect(current.isCurrent()).toBe(true); expect(h.io).not.toHaveBeenCalled()
  })
})
