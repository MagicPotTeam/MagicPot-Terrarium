import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '../../shared/api/apiUtils/serviceInvocation'
import type { AgentThreadInteractionScope } from '../../shared/api/agentThreadInteraction'
import type { ManagedFirstRunPaneScopeReq } from '../../shared/api/agentThreadManagedFirstRun'
import { llmProxySvcDef } from '../../shared/api/svcLLMProxy'
import { registerIpcServer } from '../../shared/api/createServer/registerIpcServer'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { captureManagedFirstRunPane } from './agentThreadManagedFirstRunScope'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'

const h = vi.hoisted(() => ({ handle: vi.fn(), fromId: vi.fn(), parent: vi.fn(), fetch: vi.fn(), request: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: h.handle, on: vi.fn() }, MessagePortMain: class {}, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent }, net: { fetch: h.fetch, request: h.request }, app: { getPath: () => '.' } }))
vi.mock('@main/aiClients/visionClient', () => ({ createVisionChatClient: vi.fn() }))
const url = 'file:///D:/app/index.html#/canvas?id=project'
const scope = (): AgentThreadInteractionScope => ({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }, conversationId: 'conversation' })
type DataSurface = {
  managedFirstRunPaneRevision(input: AgentThreadInteractionScope, invocation?: ServiceInvocationContext): Promise<{ revision: number }>
  setManagedFirstRunPaneScope(input: ManagedFirstRunPaneScopeReq, invocation?: ServiceInvocationContext): Promise<{ documentToken?: string }>
}
let sender: EventEmitter, service: DataSurface
beforeEach(() => {
  vi.clearAllMocks()
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockImplementation(id => id === 71 ? sender : undefined)
  h.parent.mockImplementation(value => ({ isDestroyed: () => false, webContents: value }))
  registerMagicAgentTrustedRouteBinding(71, scope().route, { trustedUrl: url, trustedWebContents: sender as never })
  service = new LLMProxySvcImpl() as unknown as DataSurface
})
afterEach(() => { sender.emit('destroyed'); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
const invoke = (method: string): ServiceInvocationContext => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, frameUrl: url, senderUrl: url, isMainFrame: true })
const event = () => ({ sender, senderFrame: { url, parent: null } })
const dataDefinitions = () => {
  const definitions = llmProxySvcDef as typeof llmProxySvcDef & Record<keyof DataSurface, { type: 'unary' }>
  return { managedFirstRunPaneRevision: definitions.managedFirstRunPaneRevision, setManagedFirstRunPaneScope: definitions.setManagedFirstRunPaneScope }
}
describe('original-pane identity DATA through the existing service and IPC, execution still disabled', () => {
  it('registers only dedicated identity endpoints, not managed execution/stop/status routes', () => {
    expect(dataDefinitions()).toEqual({ managedFirstRunPaneRevision: { type: 'unary' }, setManagedFirstRunPaneScope: { type: 'unary' } })
    for (const method of ['startManagedFirstRun', 'stopManagedFirstRun', 'managedFirstRunStatus', 'startManagedTextFirstRun', 'prepareManagedTextFirstRunStop']) expect(llmProxySvcDef).not.toHaveProperty(method)
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled()
  })
  it('uses IPC-built invocation context for the actual MAIN binder and retires its exact token', async () => {
    registerIpcServer({ svcLLMProxy: dataDefinitions() }, { svcLLMProxy: service })
    const handlers = new Map(h.handle.mock.calls.map(([name, handler]) => [name, handler]))
    const revision = handlers.get('svcLLMProxy.managedFirstRunPaneRevision')!, bind = handlers.get('svcLLMProxy.setManagedFirstRunPaneScope')!
    await expect(revision(event(), scope())).resolves.toEqual({ revision: 0 })
    const { documentToken } = await bind(event(), { ...scope(), active: true, lifecycleRevision: 1 })
    const captured = captureManagedFirstRunPane({ ...scope(), documentToken }, invoke('startManagedFirstRun'), 'startManagedFirstRun')
    expect(captured.actor).toEqual({ kind: 'user', id: 'magicpot-desktop-user' })
    await expect(bind(event(), { ...scope(), active: false, lifecycleRevision: 1 })).resolves.toEqual({})
    expect(captured.signal.aborted).toBe(true)
    await expect(bind(event(), { ...scope(), active: true, lifecycleRevision: 1 })).rejects.toThrow()
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled()
  })
  it('rejects absent/SDK/forged-frame context and renderer authority fields on the actual service', async () => {
    for (const invocation of [undefined, { methodName: 'svcLLMProxy.setManagedFirstRunPaneScope', authenticatedActor: { kind: 'user' as const, id: 'sdk' } }, { ...invoke('setManagedFirstRunPaneScope'), isMainFrame: false }]) {
      await expect(service.setManagedFirstRunPaneScope({ ...scope(), active: true, lifecycleRevision: 1 }, invocation)).rejects.toThrow()
    }
    for (const extra of [{ actor: 'desktop' }, { config: {} }, { callback: () => undefined }]) await expect(service.setManagedFirstRunPaneScope({ ...scope(), active: true, lifecycleRevision: 1, ...extra }, invoke('setManagedFirstRunPaneScope'))).rejects.toThrow()
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled()
  })
})
