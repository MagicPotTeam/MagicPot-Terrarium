import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { createIpcInvocationContext } from '@shared/api/createServer/ipcInvocationOrigin'
import { finalizeStartupStoragePublication, registerStartupStoragePublication } from '@shared/api/createServer/startupStoragePublication'
import { registerIpcServer } from '@shared/api/createServer/registerIpcServer'
import { stateSvcDef } from '@shared/api/svcState'
import { parseStartupStorageMetadataRequest, parseStartupStorageMetadataResponse, startupStorageMetadataUnavailable as unavailable, type StartupStorageMetadataResponse } from '@shared/api/startupStorageMetadata'
import { createStartupStorageSnapshot } from '../config/startupStorageSnapshot'
import { createStartupStorageReadHost, type StartupStorageReadDelegate, type StartupStorageReadHost } from '../storageMetadata/startupStorageReadBinding'
import { evaluateStartupStorageReadPolicy } from '../storageMetadata/startupStorageReadPolicy'
import { StateSvcImpl } from './svcStateImpl'

const h = vi.hoisted(() => ({ effect: vi.fn(), handle: vi.fn(), on: vi.fn() }))
vi.mock('../config/config', () => ({ getConfig: h.effect, saveConfig: h.effect, listenConfig: h.effect, onConfigCommitted: h.effect }))
vi.mock('../config/userDataDirectory', () => ({ getCurrentUserDataDirectoryState: h.effect, beginUserDataDirectoryChange: h.effect }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: h.effect }))
vi.mock('../config/storageLocations', () => ({ getStorageLocations: h.effect }))
vi.mock('../mcp/status', () => ({ getMcpRuntimeStatus: h.effect }))
vi.mock('../llmProxy/accessUsage', () => ({ getLlmProxyAccessUsageSnapshot: h.effect }))
vi.mock('../llmProxy/server', () => ({ getLLMProxyServerStatus: h.effect }))
vi.mock('electron', () => ({ app: { relaunch: h.effect, quit: h.effect }, ipcMain: { handle: h.handle, on: h.on }, MessagePortMain: class {} }))

type PlannedRead = { readStartupStorageMetadata(req: unknown, invocation?: ServiceInvocationContext): Promise<StartupStorageMetadataResponse> }
// Test-first facade permits a valid missing-method red without production stubs or public wiring.
const makeService = (read?: StartupStorageReadDelegate) => new (StateSvcImpl as unknown as new (deps?: { startupStorageRead?: StartupStorageReadDelegate }) => StateSvcImpl & PlannedRead)({ startupStorageRead: read })
const base = 'file:///app/index.html', url = base + '#/agent-management', method = 'svcState.readStartupStorageMetadata'
class Sender extends EventEmitter {
  readonly id = 83
  mainFrame = { url, parent: null as unknown, detached: false }
  getURL() { return this.mainFrame.url }
  isDestroyed() { return false }
}
const origin = () => { const sender = new Sender(); return { sender, senderFrame: sender.mainFrame } }
const available = Object.freeze({ status: 'available' as const, source: 'env' as const, legacyLayout: false })
const hosts: StartupStorageReadHost[] = []
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })
function readService(service: PlannedRead, payload: unknown, invocation?: ServiceInvocationContext) {
  expect(service.readStartupStorageMetadata).toBeTypeOf('function')
  return service.readStartupStorageMetadata(payload, invocation)
}

describe('actual StateSvc startup metadata optional delegate and canonical definition', () => {
  it('default service denies without configuration/discovery/runtime or initialized global host', async () => {
    const service = makeService(), invocation = createIpcInvocationContext(method, origin())
    expect(await readService(service, {}, invocation)).toBe(unavailable)
    expect(h.effect).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it('forwards only the original payload and actual invocation to an injected MAIN delegate', async () => {
    const invocation = createIpcInvocationContext(method, origin()), payload = Object.freeze({}), delegate = vi.fn(async (_payload: unknown, context?: ServiceInvocationContext) => {
      registerStartupStoragePublication(context, { complete: () => true, cancel: () => {} }); return available
    })
    const result = await readService(makeService(delegate), payload, invocation)
    expect(delegate).toHaveBeenCalledExactlyOnceWith(payload, invocation)
    expect(result).toEqual(available); expect(Object.isFrozen(result)).toBe(true)
    expect(finalizeStartupStoragePublication(method, invocation, result)).toEqual(available)
    expect(h.effect).not.toHaveBeenCalled()
  })
  it.each(['missing-context', 'copied-context', 'wrong-method', 'extra-request', 'request-proxy', 'request-accessor'] as const)('rejects %s before delegating and without diagnostic/getter access', async kind => {
    const event = origin(), exact = createIpcInvocationContext(method, event), hook = vi.fn(() => { throw new Error('must not observe') })
    const payload = kind === 'extra-request' ? { path: '/private' } : kind === 'request-proxy' ? new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook }) : kind === 'request-accessor' ? { get actor() { return hook() } } : {}
    const invocation = kind === 'missing-context' ? undefined : kind === 'copied-context' ? { ...exact } : kind === 'wrong-method' ? createIpcInvocationContext('svcMagicAgentPlatform.readInstalledCatalog', event) : exact
    const delegate = vi.fn(async () => available)
    expect(await readService(makeService(delegate), payload, invocation)).toBe(unavailable)
    expect(delegate).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled(); expect(h.effect).not.toHaveBeenCalled()
  })
  it.each(['unavailable', 'expanded', 'throw', 'proxy'] as const)('folds delegate %s into a fixed DTO and consumes a registered capsule', async kind => {
    const invocation = createIpcInvocationContext(method, origin()), cancel = vi.fn(), complete = vi.fn(() => true), hook = vi.fn(() => { throw new Error('diagnostic trap') }), observed = vi.fn()
    const delegate: StartupStorageReadDelegate = async () => {
      observed(); registerStartupStoragePublication(invocation, { complete, cancel })
      if (kind === 'throw') throw new Proxy({}, { get: hook, getPrototypeOf: hook })
      if (kind === 'proxy') return new Proxy(available, { getPrototypeOf: hook, ownKeys: hook })
      if (kind === 'expanded') return { ...available, path: '/private' }
      return unavailable
    }
    expect(await readService(makeService(delegate), {}, invocation)).toBe(unavailable)
    expect(observed).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled()
    expect(finalizeStartupStoragePublication(method, invocation, available)).toBe(unavailable)
    expect(hook).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled(); expect(h.effect).not.toHaveBeenCalled()
  })
  it('canonical shared method is raw unary with the EXACT two synchronous parser identities', () => {
    const definition = (stateSvcDef as unknown as Record<string, { type?: unknown; request?: unknown; response?: unknown }>).readStartupStorageMetadata
    expect(definition).toBeDefined(); expect(definition.type).toBe('unary')
    expect(Object.hasOwn(definition, 'ipcResult')).toBe(false)
    expect(definition.request).toBe(parseStartupStorageMetadataRequest); expect(definition.response).toBe(parseStartupStorageMetadataResponse)
    expect(h.effect).not.toHaveBeenCalled()
  })
  it.each(['success', 'owner-after-return', 'navigation', 'config-ABA'] as const)('actual IPC callback + canonical StateSvc + real host has private final fence for %s', async kind => {
    const event = origin(), window = Object.assign(new EventEmitter(), { webContents: event.sender, isDestroyed: () => false }), getMainWindow = () => window
    const owner = createStartupStorageSnapshot(); owner.publish({ source: 'env', legacyLayout: false })
    const listeners = new Set<() => void>(), capture = vi.fn(() => owner.capture()), policy = vi.fn(evaluateStartupStorageReadPolicy)
    const host = createStartupStorageReadHost({ getReadState: () => 'ready', onConfigCommitted: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, capture, evaluatePolicy: policy, newRequestId: () => 'startup-storage-read:integrated', now: () => 10, wallNow: () => 1000 }); hosts.push(host)
    host.install(window, base, getMainWindow)
    const delegate: StartupStorageReadDelegate = async (payload, invocation) => {
      const response = await host.read(payload, invocation, getMainWindow)
      if (kind === 'owner-after-return') owner.invalidate()
      if (kind === 'navigation') event.sender.emit('did-start-navigation', { isMainFrame: true }, url, false, true)
      if (kind === 'config-ABA') { for (const listener of [...listeners]) listener(); for (const listener of [...listeners]) listener() }
      return response
    }
    registerIpcServer({ svcState: stateSvcDef }, { svcState: makeService(delegate) })
    const callback = h.handle.mock.calls.find(([name]) => name === method)?.[1]
    expect(callback).toBeTypeOf('function')
    expect(await callback(event, {})).toEqual(kind === 'success' ? available : unavailable)
    expect(capture).toHaveBeenCalledOnce(); expect(policy).toHaveBeenCalled(); expect(h.effect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0); expect(console.error).not.toHaveBeenCalled()
    host.dispose(); expect(listeners.size).toBe(0)
  })
})
