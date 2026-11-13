import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceValidator } from '../apiUtils/serviceValidation'
import type { ServiceInvocationContext } from '../apiUtils/serviceInvocation'
import type { IpcInvocationEvent } from './ipcInvocationOrigin'
import { getIpcInvocationOrigin } from './ipcInvocationOrigin'
import { parseStartupStorageMetadataRequest as requestParser, parseStartupStorageMetadataResponse as responseParser, startupStorageMetadataUnavailable as unavailable } from '../startupStorageMetadata'
import { registerStartupStoragePublication } from './startupStoragePublication'
import { registerIpcServer } from './registerIpcServer'

const h = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: h.handle, on: h.on }, MessagePortMain: class {} }))
const candidate = () => ({ status: 'available', source: 'persisted', legacyLayout: false })
const event = () => {
  const sender = { id: 17, getURL: () => 'file:///app/index.html#/agent-management' }, frame = { url: 'file:///app/index.html#/agent-management', parent: null }
  return { sender, senderFrame: frame }
}
type TestApi = { svcState: { readStartupStorageMetadata(req: unknown, invocation?: ServiceInvocationContext): Promise<unknown> } }
type Callback = (event: IpcInvocationEvent, req: unknown) => Promise<unknown>
function setup(options: { request?: ServiceValidator<unknown>; response?: ServiceValidator<unknown>; handler?: TestApi['svcState']['readStartupStorageMetadata']; envelope?: boolean; noValidators?: boolean } = {}) {
  const complete = vi.fn(() => true), cancel = vi.fn()
  const handler = vi.fn(options.handler ?? (async (_req: unknown, invocation?: ServiceInvocationContext) => {
    registerStartupStoragePublication(invocation, { complete, cancel }); return candidate()
  }))
  const api = { svcState: { readStartupStorageMetadata: handler } }
  registerIpcServer<TestApi>({ svcState: { readStartupStorageMetadata: { type: 'unary', ...(options.noValidators ? {} : { request: options.request ?? requestParser, response: options.response ?? responseParser }), ...(options.envelope ? { ipcResult: 'service-error' as const } : {}) } } }, api)
  const callback = h.handle.mock.calls.find(call => call[0] === 'svcState.readStartupStorageMetadata')?.[1] as Callback
  expect(callback).toBeTypeOf('function')
  return { callback, handler, complete, cancel, api }
}
function diagnostics() {
  const hook = vi.fn(() => { throw new Error('fixture diagnostic must not be observed') })
  const error = Object.defineProperties({}, Object.fromEntries(['issues', 'errors', 'message', 'stack', 'name', 'code', 'path', 'then', 'toJSON', Symbol.toPrimitive].map(key => [key, { get: hook }])))
  const proxy = new Proxy(error, { get: hook, getPrototypeOf: hook, ownKeys: hook })
  const revoked = Proxy.revocable(error, {}); revoked.revoke()
  return { hook, error, proxy, revoked: revoked.proxy }
}
beforeEach(() => { h.handle.mockReset(); h.on.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('actual exact-method unary pinned canonical validation BEFORE generic diagnostic formatting', () => {
  it('preserves bound this and original actual invocation through exact synchronous parsers and final capsule', async () => {
    const origin = event(); let seen: ServiceInvocationContext | undefined
    const receiver = vi.fn()
    const f = setup({ handler: async function (this: unknown, req, invocation) {
      receiver(this); seen = invocation
      expect(req).toEqual({}); expect(Object.isFrozen(req)).toBe(true)
      expect(getIpcInvocationOrigin(invocation)?.sender).toBe(origin.sender); expect(getIpcInvocationOrigin(invocation)?.frame).toBe(origin.senderFrame)
      expect(getIpcInvocationOrigin({ ...invocation!, methodName: 'svcState.readStartupStorageMetadata' })).toBeUndefined()
      expect(registerStartupStoragePublication(invocation, { complete: () => true, cancel: () => {} })).toBe(true)
      return candidate()
    } })
    const result = await f.callback(origin, {})
    expect(result).toEqual(candidate()); expect(Object.isFrozen(result)).toBe(true)
    expect(receiver).toHaveBeenCalledExactlyOnceWith(f.api.svcState); expect(seen?.methodName).toBe('svcState.readStartupStorageMetadata')
    expect(Object.isFrozen(seen)).toBe(true); expect(f.handler).toHaveBeenCalledOnce(); expect(console.error).not.toHaveBeenCalled()
  })
  it.each(['request', 'response'] as const)('rejects unsupported %s parse definitions before invoking diagnostic throwers or handler', async phase => {
    const d = diagnostics()
    for (const error of [d.error, d.proxy, d.revoked]) {
      h.handle.mockClear()
      const parse = vi.fn(() => { throw error }), f = setup({ [phase]: { parse } })
      await expect(f.callback(event(), {})).resolves.toBe(unavailable)
      expect(parse).not.toHaveBeenCalled(); expect(f.handler).not.toHaveBeenCalled()
      expect(f.complete).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled()
    }
    expect(d.hook).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it.each(['request', 'response'] as const)('rejects unsupported %s safeParse before evaluating a failed error accessor or discriminant', async phase => {
    const d = diagnostics()
    for (const result of [{ success: false as const, get error() { return d.hook() } }, { get success() { return d.hook() }, data: {} }, { success: true, get data() { return d.hook() } }, { success: true, data: phase === 'request' ? {} : candidate() }, d.proxy, d.revoked]) {
      h.handle.mockClear()
      const safeParse = vi.fn(() => result), f = setup({ [phase]: { safeParse } as unknown as ServiceValidator<unknown> })
      await expect(f.callback(event(), {})).resolves.toBe(unavailable)
      expect(safeParse).not.toHaveBeenCalled(); expect(f.handler).not.toHaveBeenCalled()
    }
    expect(d.hook).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it.each(['request', 'response'] as const)('rejects unsupported %s validator candidates before creating Promise/thenable/proxy results', async phase => {
    const d = diagnostics()
    for (const result of [Promise.resolve({}), { get then() { return d.hook() } }, d.proxy, d.revoked]) {
      h.handle.mockClear()
      const validator = vi.fn(() => result), f = setup({ [phase]: validator })
      await expect(f.callback(event(), {})).resolves.toBe(unavailable)
      expect(validator).not.toHaveBeenCalled(); expect(f.handler).not.toHaveBeenCalled()
    }
    expect(d.hook).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it.each(['request', 'response'] as const)('prevents rejected native Promise creation by rejecting unsupported %s validators BEFORE invocation', async phase => {
    const d = diagnostics()
    for (const form of ['function', 'async', 'parse', 'safeParse', 'safeParse-data'] as const) {
      h.handle.mockClear()
      const created: Promise<unknown>[] = []
      const validator = form === 'async' ? vi.fn(async () => { throw d.error }) : vi.fn(() => {
        const rejection = Promise.reject(d.error); created.push(rejection)
        if (form === 'safeParse-data') return { success: true, data: rejection }
        return rejection
      })
      const definition = form === 'parse' ? { parse: validator } : form === 'safeParse' || form === 'safeParse-data' ? { safeParse: validator } : validator
      const f = setup({ [phase]: definition as ServiceValidator<unknown> })
      const result = await f.callback(event(), {})
      // Test-only containment if OLD code invokes unsupported code: drain before asserting so
      // the red is an exact zero-invocation assertion, not a process-wide unhandled rejection.
      for (const record of validator.mock.results) if (record.type === 'return' && record.value instanceof Promise) created.push(record.value)
      for (const rejection of created) void rejection.catch(() => undefined)
      expect(result).toBe(unavailable); expect(validator).not.toHaveBeenCalled()
      expect(created).toEqual([]); expect(f.handler).not.toHaveBeenCalled()
    }
    expect(d.hook).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it.each(['request', 'response'] as const)('does not accept wrapped canonical, predicates, transforms or proxied %s definitions', async phase => {
    const parser = phase === 'request' ? requestParser : responseParser, d = diagnostics()
    for (const implementation of [(value: unknown) => parser(value), () => true, () => false, () => phase === 'request' ? {} : candidate()]) {
      h.handle.mockClear(); const validator = vi.fn(implementation), f = setup({ [phase]: validator })
      await expect(f.callback(event(), {})).resolves.toBe(unavailable)
      expect(validator).not.toHaveBeenCalled(); expect(f.handler).not.toHaveBeenCalled()
    }
    for (const definition of [new Proxy(parser, { apply: d.hook, get: d.hook }), d.revoked, Object.defineProperty({}, 'parse', { get: d.hook })]) {
      h.handle.mockClear(); const f = setup({ [phase]: definition as ServiceValidator<unknown> })
      await expect(f.callback(event(), {})).resolves.toBe(unavailable); expect(f.handler).not.toHaveBeenCalled()
    }
    expect(d.hook).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it('rejects extra raw request claims, symbols, accessors, proxies and thenables using pinned parser with zero hooks', async () => {
    const d = diagnostics(), f = setup()
    for (const value of [{ actor: 'user' }, { path: '/private' }, { unused: undefined }, { [Symbol('claim')]: true }, { get policy() { return d.hook() } }, { get then() { return d.hook() } }, d.proxy, d.revoked, Promise.resolve({})]) await expect(f.callback(event(), value)).resolves.toBe(unavailable)
    expect(f.handler).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled(); expect(d.hook).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })
  it('rejects malformed raw handler response and catches diagnostic rejection without formatting', async () => {
    const d = diagnostics()
    const f = setup({ handler: async (_req, invocation) => { registerStartupStoragePublication(invocation, { complete: () => true, cancel: () => {} }); return { ...candidate(), path: '/private' } } })
    await expect(f.callback(event(), {})).resolves.toBe(unavailable)
    h.handle.mockClear(); const failed = setup({ handler: async () => { throw d.proxy } })
    await expect(failed.callback(event(), {})).resolves.toBe(unavailable)
    expect(d.hook).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it('fails closed raw-only when configured with service-error or absent validators, without calling implementation', async () => {
    for (const options of [{ envelope: true }, { noValidators: true }]) {
      h.handle.mockClear(); const f = setup(options)
      await expect(f.callback(event(), {})).resolves.toBe(unavailable); expect(f.handler).not.toHaveBeenCalled()
    }
    expect(console.error).not.toHaveBeenCalled()
  })
  it('does not publish available without a private capsule and rejects async handler invalidation at the final fence', async () => {
    const f = setup({ handler: async () => candidate() })
    await expect(f.callback(event(), {})).resolves.toBe(unavailable)
    h.handle.mockClear(); let current = true
    const stale = setup({ handler: async (_req, invocation) => {
      registerStartupStoragePublication(invocation, { complete: () => current, cancel: () => {} })
      await Promise.resolve(); current = false; return candidate()
    } })
    await expect(stale.callback(event(), {})).resolves.toBe(unavailable)
  })
  it.each(['proxy', 'revoked-proxy', 'type-accessor', 'request-accessor', 'response-accessor', 'streaming-type', 'missing-type'] as const)('denies malformed whole method definition %s before reading its discriminant or invoking hooks', async kind => {
    const d = diagnostics(), handler = vi.fn(async () => candidate())
    const plain = { type: 'unary', request: requestParser, response: responseParser }
    let definition: unknown = plain
    if (kind === 'proxy') definition = new Proxy(plain, { get: d.hook, getPrototypeOf: d.hook, ownKeys: d.hook, getOwnPropertyDescriptor: d.hook })
    if (kind === 'revoked-proxy') { const revoked = Proxy.revocable(plain, {}); revoked.revoke(); definition = revoked.proxy }
    if (kind === 'type-accessor') definition = { ...plain, get type() { return d.hook() } }
    if (kind === 'request-accessor') definition = { ...plain, get request() { return d.hook() } }
    if (kind === 'response-accessor') definition = { ...plain, get response() { return d.hook() } }
    if (kind === 'streaming-type') definition = { ...plain, type: 'serverStreaming' }
    if (kind === 'missing-type') definition = { request: requestParser, response: responseParser }
    const sheet = { svcState: { readStartupStorageMetadata: definition } } as Parameters<typeof registerIpcServer<TestApi>>[0]
    expect(() => registerIpcServer<TestApi>(sheet, { svcState: { readStartupStorageMetadata: handler } })).not.toThrow()
    expect(d.hook).not.toHaveBeenCalled()
    const registrations = h.handle.mock.calls.filter(call => call[0] === 'svcState.readStartupStorageMetadata')
    expect(registrations).toHaveLength(1); expect(h.on).not.toHaveBeenCalled()
    await expect((registrations[0][1] as Callback)(event(), {})).resolves.toBe(unavailable)
    expect(d.hook).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it('leaves unrelated raw unary validator errors on their existing generic diagnostic path', async () => {
    const failure = new Error('existing unrelated validation'), handler = vi.fn(async () => ({}))
    registerIpcServer({ svcDemo: { ping: { type: 'unary' as const, request: { parse: () => { throw failure } } } } }, { svcDemo: { ping: handler } })
    const callback = h.handle.mock.calls.find(call => call[0] === 'svcDemo.ping')![1]
    await expect(callback(event(), {})).rejects.toThrow('existing unrelated validation')
    expect(handler).not.toHaveBeenCalled(); expect(console.error).toHaveBeenCalledOnce()
  })
})
