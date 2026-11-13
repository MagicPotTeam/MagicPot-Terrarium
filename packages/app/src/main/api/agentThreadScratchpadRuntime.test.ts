import { EventEmitter } from 'node:events'
import { vol } from 'memfs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { AssistantToolRegistry } from '../assistantRuntime/toolRegistry'
import { McpClientManager } from '../mcp/clientManager'
import { syncMcpClientManager } from '../mcp/runtime'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { prepareCanvasAgentTools } from './canvasAgentTools'
import { closeAgentThreadNotesStore, getAgentThreadNotesStore } from './agentThreadNotesStore'
vi.mock('fs/promises', async () => { const { fs } = await import('memfs'); return { ...fs.promises, default: fs.promises } })
vi.mock('fs', async () => { const { fs } = await import('memfs'); return { ...fs, default: fs } })
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => '/mock' }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/scratchpad-runtime-fixture', root: '/mock-root' } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(() => structuredClone(DEFAULT_CONFIG)), onConfigCommitted: vi.fn(), saveConfig: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined), getMcpClientManager: () => { throw Error('No global MCP probe from working notes') } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'notes-runtime', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }, url = 'file:///D:/app/index.html#/canvas?id=notes-runtime'
const invocation = { methodName: 'svcLLMProxy.chat', senderId: 99, isMainFrame: true, senderUrl: url, frameUrl: url }
let store: AssistantSessionStore, runtime: AssistantRuntime, prepared: ReturnType<typeof prepareCanvasAgentTools>
beforeEach(async () => {
  vi.clearAllMocks(); vol.reset(); await closeAgentThreadNotesStore()
  store = new AssistantSessionStore('/scratchpad-runtime-fixture/session.json')
  runtime = new AssistantRuntime({ sessionStore: store, toolRegistry: new AssistantToolRegistry(new McpClientManager()), configProvider: () => structuredClone(DEFAULT_CONFIG), chatService: { chat: vi.fn(async () => { throw Error('No model in runtime fixture') }) } })
  const sender = Object.assign(new EventEmitter(), { id: 99, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(99, route, { trustedUrl: url, trustedWebContents: sender as never })
  prepared = prepareCanvasAgentTools({ ...scope, messages: [] }, invocation, { local: true, terminalEnabled: false })
})
afterEach(async () => { prepared.dispose?.(); await store.flush(); await closeAgentThreadNotesStore(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
const actionType = (value: unknown) => value && typeof value === 'object' && 'type' in value ? value.type : undefined
const options = { runId: 'notes-owned-run', toolCallId: 'notes-owned-call' }
const call = (args: Record<string, unknown>) => prepared.admission!.run('scratchpad', undefined, () => runtime.callTool(route, 'scratchpad', args, { ...options, allowedToolNames: prepared.request.skillRuntime!.bindings![0].toolNames, toolProvider: prepared.toolProvider }))
describe('real Canvas + runtime + durable adapter + scratchpad (memfs/Electron stubs)', () => {
  it('keeps approved writes behind policy, journals success once and replays without approval/redispatch/MCP sync', async () => {
    const notes = await getAgentThreadNotesStore(), mutate = vi.spyOn(notes, 'mutate')
    const args = { action: 'set', key: 'retained', value: 'REAL_ADAPTER_APPROVED_VALUE', expectedRevision: 0 }
    const pending = call(args), policy = getAssistantTerminalPolicyRuntime()
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    expect(notes.get(scope)).toEqual({ revision: 0, notes: [] }); expect(mutate).not.toHaveBeenCalled()
    const item = policy.listPendingTerminalApprovals()[0]
    policy.resolvePendingTerminalApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true })
    const first = await pending
    expect(JSON.parse(first.content)).toMatchObject({ revision: 1, keys: ['retained'], untrustedData: true, grantsPermission: false })
    expect(await call(args)).toEqual(first); expect(mutate).toHaveBeenCalledOnce()
    expect(policy.listPendingTerminalApprovals()).toEqual([]); expect(syncMcpClientManager).not.toHaveBeenCalled()
    const actions = (await store.getSession(route))?.eventLog.map(event => event.metadata?.agentAction)
    expect(actions).toEqual([expect.objectContaining({ type: 'tool.invoke' }), expect.objectContaining({ type: 'tool.result', payload: expect.objectContaining({ ok: true, content: first.content }) })])
    await expect(call({ ...args, value: 'FORGED_CONFLICT' })).rejects.toMatchObject({ code: 'TOOL_REPLAY_CONFLICT' })
    expect(notes.get(scope).notes[0].value).toBe('REAL_ADAPTER_APPROVED_VALUE'); expect(mutate).toHaveBeenCalledOnce()
  })
  it('does not redispatch or reapprove after mutation committed but durable result publication failed', async () => {
    const notes = await getAgentThreadNotesStore(), mutate = vi.spyOn(notes, 'mutate'), append = store.appendEvents.bind(store)
    const failure = vi.spyOn(store, 'appendEvents').mockImplementation(async (...input) => {
      if (input[1].some(event => actionType(event.metadata?.agentAction) === 'tool.result')) throw new Error('Synthetic result publication interruption')
      return append(...input)
    })
    const args = { action: 'set', key: 'retained', value: 'COMMITTED_WITH_UNPUBLISHED_RESULT', expectedRevision: 0 }
    const pending = call(args).catch(error => error), policy = getAssistantTerminalPolicyRuntime()
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    const item = policy.listPendingTerminalApprovals()[0]
    policy.resolvePendingTerminalApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true })
    expect(await pending).toMatchObject({ message: 'Synthetic result publication interruption' })
    expect(notes.get(scope)).toMatchObject({ revision: 1, notes: [{ value: 'COMMITTED_WITH_UNPUBLISHED_RESULT' }] })
    expect(mutate).toHaveBeenCalledOnce(); failure.mockRestore(); await store.flush()
    const reopened = new AssistantSessionStore('/scratchpad-runtime-fixture/session.json')
    const recovered = new AssistantRuntime({ sessionStore: reopened, toolRegistry: new AssistantToolRegistry(new McpClientManager()), configProvider: () => structuredClone(DEFAULT_CONFIG), chatService: { chat: vi.fn() } })
    await expect(prepared.admission!.run('scratchpad', undefined, () => recovered.callTool(route, 'scratchpad', args, { ...options, allowedToolNames: prepared.request.skillRuntime!.bindings![0].toolNames, toolProvider: prepared.toolProvider }))).rejects.toMatchObject({ code: 'TOOL_REPLAY_REQUIRES_REVIEW' })
    expect(policy.listPendingTerminalApprovals()).toEqual([]); expect(mutate).toHaveBeenCalledOnce()
    expect((await reopened.getSession(route))?.eventLog.map(event => actionType(event.metadata?.agentAction))).toEqual(['tool.invoke'])
    await reopened.flush()
  })
  it('cannot borrow another provider owner or bypass original Canvas admission for reads or writes', async () => {
    const other = prepareCanvasAgentTools({ ...scope, messages: [] }, invocation, { local: true, terminalEnabled: false })
    try {
      await expect(prepared.toolProvider!.callTool('scratchpad', { action: 'list' }, { route, runId: 'unadmitted' })).rejects.toThrow('live Agent thread invocation')
      await expect(prepared.admission!.run('scratchpad', undefined, () => other.toolProvider!.callTool('scratchpad', { action: 'clear', expectedRevision: 0 }, { route, runId: 'borrowed', toolCallId: 'borrowed' }))).rejects.toThrow('live Agent thread invocation')
      expect((await getAgentThreadNotesStore()).get(scope)).toEqual({ revision: 0, notes: [] }); expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    } finally { other.dispose?.() }
  })
})
