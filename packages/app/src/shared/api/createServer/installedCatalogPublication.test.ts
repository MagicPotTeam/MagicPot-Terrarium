import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceValidationError } from '../apiUtils/serviceValidation'
import type { ServiceInvocationContext } from '../apiUtils/serviceInvocation'
import { createIpcInvocationContext } from './ipcInvocationOrigin'
import { registerIpcServer } from './registerIpcServer'
import { cancelInstalledCatalogPublication, finalizeInstalledCatalogPublication, INSTALLED_CATALOG_PUBLICATION_METHOD as method, registerInstalledCatalogPublication } from './installedCatalogPublication'

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, on: vi.fn() }, MessagePortMain: class {} }))
const url = 'file:///app/index.html#/agent-management'
const event = () => ({ sender: { id: 42, getURL: () => url }, senderFrame: { url, parent: null } })
const invocation = (name = method) => createIpcInvocationContext(name, event())
const candidate = () => Object.freeze({ status: 'available' as const, entries: Object.freeze([{ id: 'demo', name: 'Demo', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' }]) })
const unavailable = { status: 'unavailable', reason: 'unavailable' }
const capsule = () => Object.freeze({ complete: vi.fn(() => true), cancel: vi.fn() })
beforeEach(() => { handle.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('private exact-invocation installed-catalog terminal publication, not renderer claims or a generic permit', () => {
  it('allows one exact registered available candidate, with no cancel callback after successful completion', () => {
    const context = invocation(), owner = capsule(), value = candidate()
    expect(registerInstalledCatalogPublication(context, owner)).toBe(true)
    expect(finalizeInstalledCatalogPublication(method, context, value)).toBe(value)
    expect(owner.complete).toHaveBeenCalledOnce(); expect(owner.cancel).not.toHaveBeenCalled()
    expect(finalizeInstalledCatalogPublication(method, context, value)).toEqual(unavailable)
    cancelInstalledCatalogPublication(context); expect(owner.cancel).not.toHaveBeenCalled()
    expect(registerInstalledCatalogPublication(context, capsule())).toBe(false)
  })
  it.each(['missing', 'scalar', 'copy', 'wrong-method'] as const)('does not register %s origin or treat a DTO as publication authority', kind => {
    const exact = invocation(), owner = capsule()
    const context = kind === 'missing' ? undefined : kind === 'scalar' ? { methodName: method, senderId: 42, senderUrl: url, frameUrl: url, isMainFrame: true } : kind === 'copy' ? { ...exact } : invocation('svcOther.read')
    expect(registerInstalledCatalogPublication(context, owner)).toBe(false)
    expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable)
    expect(owner.complete).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled()
  })
  it('never publishes target available without a capsule or with a capsule belonging to another invocation', () => {
    const first = invocation(), second = invocation(), owner = capsule()
    expect(registerInstalledCatalogPublication(first, owner)).toBe(true)
    expect(finalizeInstalledCatalogPublication(method, second, candidate())).toEqual(unavailable)
    expect(owner.complete).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled()
    expect(finalizeInstalledCatalogPublication(method, first, candidate()).status).toBe('available')
  })
  it.each(['false', 'throws', 'promise', 'truthy'] as const)('completion %s fails closed and releases only the exact capsule once', kind => {
    const context = invocation(), cancel = vi.fn(), complete = vi.fn(() => { if (kind === 'throws') throw new Error('PRIVATE'); return (kind === 'promise' ? Promise.resolve(true) : kind === 'truthy' ? 1 : false) as unknown as boolean })
    expect(registerInstalledCatalogPublication(context, { complete, cancel })).toBe(true)
    expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable)
    expect(complete).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
    cancelInstalledCatalogPublication(context); expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable)
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('explicit unavailable retains its validated static reason and cancels without attempting successful completion', () => {
    const context = invocation(), owner = capsule(), value = Object.freeze({ status: 'unavailable', reason: 'missing-root' })
    expect(registerInstalledCatalogPublication(context, owner)).toBe(true)
    expect(finalizeInstalledCatalogPublication(method, context, value)).toBe(value)
    expect(owner.complete).not.toHaveBeenCalled(); expect(owner.cancel).toHaveBeenCalledOnce()
  })
  it('cancellation consumes before callbacks, is idempotent, and never permits registration or later available publication', () => {
    const context = invocation(), complete = vi.fn(() => true), cancel = vi.fn(() => {
      cancelInstalledCatalogPublication(context)
      expect(registerInstalledCatalogPublication(context, capsule())).toBe(false)
      expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable)
    })
    expect(registerInstalledCatalogPublication(context, { complete, cancel })).toBe(true)
    cancelInstalledCatalogPublication(context); cancelInstalledCatalogPublication(context)
    expect(cancel).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled()
  })
  it('a duplicate registration cannot overwrite the first exact owner', () => {
    const context = invocation(), first = capsule(), second = capsule()
    expect(registerInstalledCatalogPublication(context, first)).toBe(true)
    expect(registerInstalledCatalogPublication(context, second)).toBe(false)
    expect(finalizeInstalledCatalogPublication(method, context, candidate()).status).toBe('available')
    expect(first.complete).toHaveBeenCalledOnce(); expect(second.complete).not.toHaveBeenCalled(); expect(second.cancel).not.toHaveBeenCalled()
  })
  it('nested finalize consumes no new authority and prevents the reentrant outer publication', () => {
    const context = invocation(), cancel = vi.fn(), complete = vi.fn(() => { expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable); return true })
    expect(registerInstalledCatalogPublication(context, { complete, cancel })).toBe(true)
    expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable)
    expect(complete).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
  })
  it('ordinary cancellation callbacks cannot receive or revive the private spent lifecycle entry through this', () => {
    const context = invocation(), complete = vi.fn(() => true), receivers: unknown[] = []
    const cancel = vi.fn(function (this: unknown) {
      receivers.push(this)
      if (this && typeof this === 'object') Reflect.set(this, 'phase', 'pending')
    })
    expect(registerInstalledCatalogPublication(context, { complete, cancel })).toBe(true)
    cancelInstalledCatalogPublication(context)
    expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable)
    expect(complete).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); expect(receivers).toEqual([undefined])
    cancelInstalledCatalogPublication(context); expect(cancel).toHaveBeenCalledOnce()
  })
  it('ordinary completion callbacks cannot receive or clear private reentry interference through this', () => {
    const context = invocation(), cancel = vi.fn(), receivers: unknown[] = []
    const complete = vi.fn(function (this: unknown) {
      receivers.push(this)
      expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable)
      if (this && typeof this === 'object') Reflect.set(this, 'interfered', false)
      return true
    })
    expect(registerInstalledCatalogPublication(context, { complete, cancel })).toBe(true)
    expect(finalizeInstalledCatalogPublication(method, context, candidate())).toEqual(unavailable)
    expect(complete).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce(); expect(receivers).toEqual([undefined])
  })
  it('old cancellation cannot remove a successor invocation installed by its callback', () => {
    const old = invocation(), next = invocation(), successor = capsule()
    expect(registerInstalledCatalogPublication(old, { complete: () => false, cancel: () => { expect(registerInstalledCatalogPublication(next, successor)).toBe(true) } })).toBe(true)
    cancelInstalledCatalogPublication(old); cancelInstalledCatalogPublication(old)
    expect(finalizeInstalledCatalogPublication(method, next, candidate()).status).toBe('available'); expect(successor.complete).toHaveBeenCalledOnce()
  })
  it('detaches callback references at registration and rejects accessor/proxy capsules without running them', () => {
    const context = invocation(), owner = { complete: vi.fn(() => true), cancel: vi.fn() }, original = owner.complete
    expect(registerInstalledCatalogPublication(context, owner)).toBe(true); owner.complete = vi.fn(() => false)
    expect(finalizeInstalledCatalogPublication(method, context, candidate()).status).toBe('available'); expect(original).toHaveBeenCalledOnce(); expect(owner.complete).not.toHaveBeenCalled()
    const getter = vi.fn(() => vi.fn(() => true))
    expect(registerInstalledCatalogPublication(invocation(), { get complete() { return getter() }, cancel: vi.fn() })).toBe(false)
    const trap = vi.fn(); expect(registerInstalledCatalogPublication(invocation(), new Proxy(capsule(), { ownKeys: () => { trap(); return [] } }))).toBe(false)
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled()
  })
  it('unrelated method response identity and target capsule are untouched', () => {
    const context = invocation(), owner = capsule(), value = candidate()
    expect(registerInstalledCatalogPublication(context, owner)).toBe(true)
    expect(finalizeInstalledCatalogPublication('svcOther.read', context, value)).toBe(value)
    expect(owner.complete).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled()
    cancelInstalledCatalogPublication(context); expect(owner.cancel).toHaveBeenCalledOnce()
  })

  const wire = (implementation: (req: Record<string, never>, context?: ServiceInvocationContext) => Promise<ReturnType<typeof candidate>>, response?: (value: unknown) => ReturnType<typeof candidate>) => {
    registerIpcServer({ svcMagicAgentPlatform: { readInstalledCatalog: { type: 'unary', request: (value: unknown) => { if (!value || typeof value !== 'object' || Reflect.ownKeys(value).length) throw new Error('strict empty'); return {} }, response } } }, { svcMagicAgentPlatform: { readInstalledCatalog: implementation } })
    expect(handle).toHaveBeenCalledWith(method, expect.any(Function)); return handle.mock.calls[0][1]
  }
  it('real unary wiring denies an available DTO without private publication registration', async () => {
    const callback = wire(async () => candidate())
    expect(await callback(event(), {})).toEqual(unavailable)
  })
  it('real unary validation preserves exact origin and completes only after response validation finishes', async () => {
    const trace: string[] = [], owner = { complete: vi.fn(() => { trace.push('complete'); return true }), cancel: vi.fn() }
    const value = candidate(), callback = wire(async (_req, context) => { trace.push('handler'); expect(registerInstalledCatalogPublication(context, owner)).toBe(true); await Promise.resolve(); return value }, raw => { trace.push('validation'); return raw as ReturnType<typeof candidate> })
    expect(await callback(event(), {})).toBe(value); expect(trace).toEqual(['handler', 'validation', 'complete']); expect(owner.cancel).not.toHaveBeenCalled()
  })
  it('real response validation can revoke the owner after handler success and before final publication', async () => {
    let live = true; const owner = { complete: vi.fn(() => live), cancel: vi.fn() }
    const callback = wire(async (_req, context) => { expect(registerInstalledCatalogPublication(context, owner)).toBe(true); return candidate() }, raw => { live = false; return raw as ReturnType<typeof candidate> })
    expect(await callback(event(), {})).toEqual(unavailable); expect(owner.complete).toHaveBeenCalledOnce(); expect(owner.cancel).toHaveBeenCalledOnce()
  })
  it.each(['handler', 'validation'] as const)('real %s rejection releases private ownership once and preserves the original error', async kind => {
    const error = new Error('original fixture rejection'), owner = capsule()
    const callback = wire(async (_req, context) => { expect(registerInstalledCatalogPublication(context, owner)).toBe(true); if (kind === 'handler') throw error; return candidate() }, () => { throw error })
    if (kind === 'handler') await expect(callback(event(), {})).rejects.toBe(error)
    else await expect(callback(event(), {})).rejects.toBeInstanceOf(ServiceValidationError)
    expect(owner.cancel).toHaveBeenCalledOnce(); expect(owner.complete).not.toHaveBeenCalled()
  })
})
