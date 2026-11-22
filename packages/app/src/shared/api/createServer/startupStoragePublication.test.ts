import { describe, expect, it, vi } from 'vitest'
import { createIpcInvocationContext } from './ipcInvocationOrigin'
import type { ServiceInvocationContext } from '../apiUtils/serviceInvocation'
import { startupStorageMetadataUnavailable as unavailable } from '../startupStorageMetadata'
import { registerInstalledCatalogPublication, finalizeInstalledCatalogPublication, INSTALLED_CATALOG_PUBLICATION_METHOD } from './installedCatalogPublication'
import { cancelStartupStoragePublication, finalizeStartupStoragePublication, registerStartupStoragePublication, STARTUP_STORAGE_PUBLICATION_METHOD as method } from './startupStoragePublication'

const context = (name = method) => createIpcInvocationContext(name, { sender: { id: 9, getURL: () => 'file:///app/index.html#/agent-management' }, senderFrame: { url: 'file:///app/index.html#/agent-management', parent: null } })
const value = () => ({ status: 'available', source: 'env', legacyLayout: true })
describe('independent exact startup metadata last synchronous publication capsule', () => {
  it('consumes the exact original invocation only once and returns canonical frozen pathless data', () => {
    const invocation = context(), complete = vi.fn(() => true), cancel = vi.fn(), candidate = value()
    expect(registerStartupStoragePublication(invocation, { complete, cancel })).toBe(true)
    const result = finalizeStartupStoragePublication(method, invocation, candidate)
    expect(result).toEqual(candidate); expect(result).not.toBe(candidate); expect(Object.isFrozen(result)).toBe(true)
    expect(complete).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled()
    expect(finalizeStartupStoragePublication(method, invocation, candidate)).toBe(unavailable)
    cancelStartupStoragePublication(invocation); expect(complete).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled()
    expect(registerStartupStoragePublication(invocation, { complete, cancel })).toBe(false)
  })
  it.each(['missing', 'copy', 'scalar', 'catalog'] as const)('rejects %s authority and cannot borrow catalog registration', kind => {
    const original = context(), complete = vi.fn(() => true), cancel = vi.fn()
    const invocation = kind === 'missing' ? undefined : kind === 'copy' ? { ...original } : kind === 'scalar' ? { methodName: method, senderId: 9 } : context(INSTALLED_CATALOG_PUBLICATION_METHOD)
    expect(registerStartupStoragePublication(invocation, { complete, cancel })).toBe(false)
    expect(finalizeStartupStoragePublication(method, invocation, value())).toBe(unavailable)
    expect(complete).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  })
  it('rejects delayed registration after an unowned terminal request and does not normalize the method name', () => {
    const invocation = context(), complete = vi.fn(() => true), cancel = vi.fn()
    expect(finalizeStartupStoragePublication(method, invocation, value())).toBe(unavailable)
    expect(registerStartupStoragePublication(invocation, { complete, cancel })).toBe(false)
    const original = value(); expect(finalizeStartupStoragePublication('svcState.readStartupStorageMetadata ', invocation, original)).toBe(original)
  })
  it.each(['false', 'throw', 'truthy', 'promise'] as const)('fails closed for owner result %s and cancels once', kind => {
    const invocation = context(), cancel = vi.fn(), complete = vi.fn(() => {
      if (kind === 'throw') throw new Error('do not export owner failure')
      return kind === 'false' ? false : kind === 'truthy' ? 'yes' : Promise.resolve(true)
    }) as unknown as () => boolean
    expect(registerStartupStoragePublication(invocation, { complete, cancel })).toBe(true)
    expect(finalizeStartupStoragePublication(method, invocation, value())).toBe(unavailable)
    cancelStartupStoragePublication(invocation); expect(cancel).toHaveBeenCalledOnce()
    expect(finalizeStartupStoragePublication(method, invocation, value())).toBe(unavailable)
  })
  it.each(['nested-finalize', 'nested-register', 'nested-cancel'] as const)('consumes before %s reentry and rejects the original response too', action => {
    const invocation = context(), cancel = vi.fn(), complete = vi.fn(() => {
      if (action === 'nested-finalize') expect(finalizeStartupStoragePublication(method, invocation, value())).toBe(unavailable)
      if (action === 'nested-register') expect(registerStartupStoragePublication(invocation, { complete: () => true, cancel: () => {} })).toBe(false)
      if (action === 'nested-cancel') cancelStartupStoragePublication(invocation)
      return true
    })
    expect(registerStartupStoragePublication(invocation, { complete, cancel })).toBe(true)
    expect(finalizeStartupStoragePublication(method, invocation, value())).toBe(unavailable)
    expect(complete).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce()
  })
  it.each([unavailable, { ...value(), path: '/private' }, { ...value(), source: 'custom' }, { ...value(), legacyLayout: 'true' }, { status: 'unavailable', reason: 'secret error' }, null, Promise.resolve(value())])('rejects expanded/malformed candidates before owner completion %#', candidate => {
    const invocation = context(), complete = vi.fn(() => true), cancel = vi.fn()
    expect(registerStartupStoragePublication(invocation, { complete, cancel })).toBe(true)
    expect(finalizeStartupStoragePublication(method, invocation, candidate)).toBe(unavailable)
    expect(complete).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce()
  })
  it('never invokes candidate/diagnostic getters, proxies or then hooks, including revoked proxies', () => {
    const hook = vi.fn(() => { throw new Error('private') }), proxy = new Proxy(value(), { getPrototypeOf: hook, ownKeys: hook, get: hook }), revoked = Proxy.revocable(value(), {}); revoked.revoke()
    const error = Object.defineProperties({}, { message: { get: hook }, issues: { get: hook }, errors: { get: hook } })
    for (const candidate of [proxy, revoked.proxy, { ...value(), get then() { return hook() } }, { get status() { return hook() }, source: 'env', legacyLayout: true }]) {
      const invocation = context(), cancel = vi.fn(() => { throw error }), complete = vi.fn(() => true)
      expect(registerStartupStoragePublication(invocation, { complete, cancel })).toBe(true)
      expect(finalizeStartupStoragePublication(method, invocation, candidate)).toBe(unavailable)
      expect(complete).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce()
    }
    expect(hook).not.toHaveBeenCalled()
  })
  it('rejects capsule accessors/extras/proxies without invoking them and may subsequently register valid authority', () => {
    const invocation = context(), hook = vi.fn(() => { throw new Error('not called') }), revoked = Proxy.revocable({ complete: () => true, cancel: () => {} }, {}); revoked.revoke()
    for (const capsule of [{ get complete() { return hook() }, cancel: () => {} }, { complete: () => true, cancel: () => {}, extra: true }, new Proxy({}, { ownKeys: hook, getPrototypeOf: hook }), revoked.proxy]) expect(registerStartupStoragePublication(invocation, capsule as { complete(): boolean; cancel(): void })).toBe(false)
    expect(hook).not.toHaveBeenCalled(); expect(registerStartupStoragePublication(invocation, { complete: () => true, cancel: () => {} })).toBe(true)
    expect(finalizeStartupStoragePublication(method, invocation, value())).toEqual(value())
  })
  it('does not let either exact-method capsule authorize the other and preserves catalog semantics', () => {
    const storage = context(), catalog = context(INSTALLED_CATALOG_PUBLICATION_METHOD), done = vi.fn(() => true)
    expect(registerStartupStoragePublication(storage, { complete: done, cancel: () => {} })).toBe(true)
    expect(registerInstalledCatalogPublication(catalog, { complete: done, cancel: () => {} })).toBe(true)
    expect(registerInstalledCatalogPublication(storage, { complete: done, cancel: () => {} })).toBe(false)
    expect(registerStartupStoragePublication(catalog, { complete: done, cancel: () => {} })).toBe(false)
    expect(finalizeStartupStoragePublication(method, catalog, value())).toBe(unavailable)
    expect(finalizeInstalledCatalogPublication(INSTALLED_CATALOG_PUBLICATION_METHOD, storage, { status: 'available', items: [] })).toEqual(unavailable)
    expect(finalizeStartupStoragePublication(method, storage, value())).toEqual(value())
    expect(finalizeInstalledCatalogPublication(INSTALLED_CATALOG_PUBLICATION_METHOD, catalog, { status: 'available', items: [] })).toEqual({ status: 'available', items: [] })
    expect(done).toHaveBeenCalledTimes(2)
  })
  it('does not execute any external callback after a successful final owner check', () => {
    const invocation = context(), trace: string[] = []
    const candidate = Object.freeze(value()), cancel = vi.fn(() => trace.push('cancel'))
    expect(registerStartupStoragePublication(invocation, { complete: () => { trace.push('last-owner-check'); return true }, cancel })).toBe(true)
    expect(finalizeStartupStoragePublication(method, invocation, candidate)).toEqual(candidate)
    expect(trace).toEqual(['last-owner-check']); expect(cancel).not.toHaveBeenCalled()
  })
})
