import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '../../shared/api/apiUtils/serviceInvocation'
import { clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'

const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
const url = 'file:///D:/app/index.html#/canvas?id=project'
const scope = () => ({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }, conversationId: 'conversation' })
const invoke = (method: string, senderId = 71): ServiceInvocationContext => ({ methodName: `svcLLMProxy.${method}`, senderId, frameUrl: url, senderUrl: url, isMainFrame: true })
type Surface = {
  managedFirstRunPaneRevision(input: ReturnType<typeof scope>, invocation?: ServiceInvocationContext): { revision: number }
  setManagedFirstRunPaneScope(request: ReturnType<typeof scope> & { active: boolean; lifecycleRevision: number }, invocation?: ServiceInvocationContext): { documentToken?: string }
  captureManagedFirstRunPane(input: ReturnType<typeof scope> & { documentToken: string }, invocation: ServiceInvocationContext | undefined, method: string): Readonly<{ signal: AbortSignal; document: { senderId: number; conversationId: string; revision: number }; actor: { kind: 'user'; id: string }; assertLive(): void }>
}
let api: Surface, sender: EventEmitter, other: EventEmitter
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks()
  const make = (id: number) => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, getURL: () => url })
  sender = make(71); other = make(72)
  h.fromId.mockImplementation(id => id === 71 ? sender : id === 72 ? other : undefined)
  h.parent.mockImplementation(value => ({ isDestroyed: () => false, webContents: value }))
  const trust = await import('../magicAgentRuntime/trustedRouteBinding')
  for (const value of [sender, other]) trust.registerMagicAgentTrustedRouteBinding((value as typeof value & { id: number }).id, scope().route, { trustedUrl: url, trustedWebContents: value as never })
  const modulePath = './agentThreadManagedFirstRunScope'
  api = await import(/* @vite-ignore */ modulePath) as Surface
})
afterEach(async () => {
  sender?.emit('destroyed'); other?.emit('destroyed')
  const trust = await import('../magicAgentRuntime/trustedRouteBinding'); trust.clearMagicAgentTrustedRouteBindingsForTest()
  clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks()
})
const bind = (revision = 1) => ({ ...scope(), documentToken: api.setManagedFirstRunPaneScope({ ...scope(), active: true, lifecycleRevision: revision }, invoke('setManagedFirstRunPaneScope')).documentToken! })
const capture = (value = bind()) => api.captureManagedFirstRunPane(value, invoke('startManagedFirstRun'), 'startManagedFirstRun')

describe('disabled first-run original-pane provenance, not an execution permit', () => {
  it('derives the desktop actor only after exact live pane authentication and returns immutable data', () => {
    const lease = capture()
    expect(lease.document).toEqual({ senderId: 71, conversationId: 'conversation', revision: 1 })
    expect(lease.actor).toEqual({ kind: 'user', id: 'magicpot-desktop-user' })
    expect(Object.isFrozen(lease)).toBe(true); expect(Object.isFrozen(lease.document)).toBe(true)
    expect(lease.signal.aborted).toBe(false); lease.assertLive()
  })
  it.each(['conversation', 'inactive', 'navigation', 'renderer-loss', 'destroyed'] as const)('synchronously revokes the original captured lease on %s', event => {
    const value = bind(), lease = capture(value), revoked = vi.fn(); lease.signal.addEventListener('abort', revoked)
    if (event === 'conversation') api.setManagedFirstRunPaneScope({ ...scope(), conversationId: 'different', active: true, lifecycleRevision: 2 }, invoke('setManagedFirstRunPaneScope'))
    else if (event === 'inactive') api.setManagedFirstRunPaneScope({ ...scope(), active: false, lifecycleRevision: 1 }, invoke('setManagedFirstRunPaneScope'))
    else sender.emit(event === 'navigation' ? 'did-start-navigation' : event === 'renderer-loss' ? 'render-process-gone' : 'destroyed')
    expect(lease.signal.aborted).toBe(true); expect(revoked).toHaveBeenCalledOnce()
    expect(() => lease.assertLive()).toThrow()
    expect(() => capture(value)).toThrow()
  })
  it('preserves retirement high water across retire-before-activate and same-URL navigation', () => {
    api.setManagedFirstRunPaneScope({ ...scope(), active: false, lifecycleRevision: 5 }, invoke('setManagedFirstRunPaneScope'))
    for (const revision of [4, 5]) expect(() => bind(revision)).toThrow()
    bind(6); sender.emit('did-start-navigation')
    expect(api.managedFirstRunPaneRevision(scope(), invoke('managedFirstRunPaneRevision'))).toEqual({ revision: 6 })
    expect(() => bind(6)).toThrow(); expect(bind(7).documentToken).toBeTruthy()
  })
  it('does not lose a new binding when disposing the old lease synchronously aborts it', () => {
    const first = bind(), original = capture(first)
    const next = bind(2), current = capture(next)
    expect(original.signal.aborted).toBe(true); expect(current.signal.aborted).toBe(false)
    expect(api.setManagedFirstRunPaneScope({ ...scope(), active: true, lifecycleRevision: 2 }, invoke('setManagedFirstRunPaneScope')).documentToken).toBe(next.documentToken)
  })
  it('does not let old disposal reentrancy erase or authorize a higher-revision pane', () => {
    const first = bind(), original = capture(first)
    let reentrant: ReturnType<typeof bind> | undefined
    original.signal.addEventListener('abort', () => { reentrant = bind(3) }, { once: true })
    expect(() => bind(2)).toThrow()
    expect(reentrant).toBeTruthy()
    expect(capture(reentrant!).signal.aborted).toBe(false)
    expect(api.managedFirstRunPaneRevision(scope(), invoke('managedFirstRunPaneRevision'))).toEqual({ revision: 3 })
  })
  it('does not resurrect an activation retired at the same revision during original-lease disposal', () => {
    const original = capture(bind())
    let retired = false
    original.signal.addEventListener('abort', () => {
      api.setManagedFirstRunPaneScope({ ...scope(), active: false, lifecycleRevision: 2 }, invoke('setManagedFirstRunPaneScope'))
      retired = true
    }, { once: true })
    expect(() => bind(2)).toThrow()
    expect(retired).toBe(true)
    expect(api.managedFirstRunPaneRevision(scope(), invoke('managedFirstRunPaneRevision'))).toEqual({ revision: 2 })
    expect(() => bind(2)).toThrow()
    expect(capture(bind(3)).signal.aborted).toBe(false)
  })
  it('rejects cross-sender/conversation/thread/canvas token use, forged frame and SDK actor contexts', () => {
    const value = bind()
    for (const input of [{ ...value, conversationId: 'other' }, { ...value, route: { ...value.route, threadId: 'other' } }, { ...value, route: { ...value.route, scopeId: 'other' } }, { ...value, documentToken: 'forged' }]) expect(() => capture(input)).toThrow()
    for (const invocation of [undefined, invoke('chat'), invoke('startManagedFirstRun', 72), { ...invoke('startManagedFirstRun'), isMainFrame: false }, { ...invoke('startManagedFirstRun'), authenticatedActor: { kind: 'user' as const, id: 'sdk-user' } }]) expect(() => api.captureManagedFirstRunPane(value, invocation, 'startManagedFirstRun')).toThrow()
    expect(() => api.setManagedFirstRunPaneScope({ ...scope(), active: true, lifecycleRevision: 1, actor: 'user' } as never, invoke('setManagedFirstRunPaneScope'))).toThrow()
  })
  it('rejects overflowing revisions and scope accessors before executing them', () => {
    const getter = vi.fn(() => scope().route), request = { conversationId: 'conversation', active: true, lifecycleRevision: 1 }
    Object.defineProperty(request, 'route', { enumerable: true, get: getter })
    expect(() => api.setManagedFirstRunPaneScope(request as never, invoke('setManagedFirstRunPaneScope'))).toThrow(); expect(getter).not.toHaveBeenCalled()
    for (const lifecycleRevision of [0, NaN, Number.MAX_SAFE_INTEGER, Infinity]) expect(() => api.setManagedFirstRunPaneScope({ ...scope(), active: true, lifecycleRevision }, invoke('setManagedFirstRunPaneScope'))).toThrow()
  })
})
