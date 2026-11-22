import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { llmProxySvcDef } from '@shared/api/svcLLMProxy'
import { getConfig } from '../config/config'
import { getAgentThreadNotesStore, closeAgentThreadNotesStore } from './agentThreadNotesStore'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => '/scratchpad-fixture' }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/scratchpad-fixture', root: '/mock-root' } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'scratchpad-restored', threadId: 'pane' } as const
const scope = { route, conversationId: 'current-notes' }, url = 'file:///D:/app/index.html#/canvas?id=scratchpad-restored'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 97, isMainFrame: true, senderUrl: url, frameUrl: url })
let service: LLMProxySvcImpl, sender: EventEmitter
beforeEach(async () => {
  vi.clearAllMocks(); await closeAgentThreadNotesStore()
  const config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'scratchpad-profile', model_name: 'Fixture', base_url: 'https://model.example/v1', api_key: 'fixture-not-sent' }]
  vi.mocked(getConfig).mockReturnValue(config)
  sender = Object.assign(new EventEmitter(), { id: 97, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(97, route, { trustedUrl: url, trustedWebContents: sender as never })
  const store = await getAgentThreadNotesStore()
  store.mutate({ ...scope, action: 'set', key: 'preference', value: 'CURRENT_NOTES_RETAINED_原始🌱', expectedRevision: 0, operationId: 'seed-current' })
  store.mutate({ ...scope, conversationId: 'sibling-notes', action: 'set', key: 'preference', value: 'SIBLING_NOTES_PRIVATE', expectedRevision: 0, operationId: 'seed-sibling' })
  h.listTools.mockReturnValue([]); service = new LLMProxySvcImpl()
})
afterEach(async () => { await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation')); await closeAgentThreadNotesStore(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })

describe('restored scratchpad real service/provider path with synthetic in-memory canonical notes', () => {
  it('restores only the read-only notes IPC, not mutation/counter routes', async () => {
    expect(llmProxySvcDef).toHaveProperty('getAgentNotes', { type: 'unary' })
    for (const name of ['mutateAgentNote', 'listAgentGoalDispatches']) expect(llmProxySvcDef).not.toHaveProperty(name)
    const notes: unknown = await service.getAgentNotes(scope, invoke('getAgentNotes'))
    expect(notes).toMatchObject({ revision: 1, notes: [{ key: 'preference', value: 'CURRENT_NOTES_RETAINED_原始🌱' }] })
    await expect(service.getAgentNotes(scope)).rejects.toThrow()
    await expect(service.getAgentNotes(scope, { ...invoke('getAgentNotes'), isMainFrame: false })).rejects.toThrow()
    await expect(service.getAgentNotes({ ...scope, route: { ...route, scopeId: 'different-project' } }, invoke('getAgentNotes'))).rejects.toThrow()
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
  it('captures the authorized owner before lazy storage await instead of reading a mutated sibling scope', async () => {
    const input = { ...scope }
    const pending = service.getAgentNotes(input, invoke('getAgentNotes'))
    input.conversationId = 'sibling-notes'
    expect(await pending).toMatchObject({ revision: 1, notes: [{ value: 'CURRENT_NOTES_RETAINED_原始🌱' }] })
  })
  it.each(['chat', 'chatStream'].flatMap(method => [false, true].flatMap(native => ['approve', 'deny', 'cancel', 'navigation'].map(decision => ({ method, native, decision })))))(
    'requires formal service approval for retained notes through $method native=$native decision=$decision', async ({ method, native, decision }) => {
      const { MagicAgentPlatformSvcImpl } = await import('./svcMagicAgentPlatformImpl')
      const approvals = new MagicAgentPlatformSvcImpl(), policy = getAssistantTerminalPolicyRuntime(), store = await getAgentThreadNotesStore()
      h.callTool.mockImplementation(async (r, name, args, options) => options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal }))
      const args = { action: 'set', key: 'preference', value: 'EXACT_APPROVED_WORKING_NOTE', expectedRevision: 1 }
      const chat = vi.fn(async input => {
        if (chat.mock.calls.length > 1) {
          const transcript = JSON.stringify(native ? input.toolTurns : input.messages)
          expect(transcript).toContain('conversation_scratchpad'); expect(transcript).toContain('current-state-not-replay-authority')
          return 'Saved the working note after formal approval.'
        }
        if (!native) return JSON.stringify({ toolName: 'scratchpad', args })
        const index = input.tools.findIndex((tool: { name: string }) => tool.name === 'scratchpad')
        return { content: '', toolCalls: [{ id: 'write-working-note', name: 'scratchpad', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const request = { ...scope, profileId: 'scratchpad-profile', messages: [{ role: 'user' as const, content: 'Save a working note, but only with formal approval.' }] }, onData = vi.fn()
      const pending = (method === 'chat' ? service.chat(request, invoke(method)) : service.chatStream(request, { onData }, invoke(method))).then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }))
      await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
      expect(store.get(scope).notes[0].value).toBe('CURRENT_NOTES_RETAINED_原始🌱')
      const listed = await approvals.listPendingApprovals({}, { ...invoke('listPendingApprovals'), methodName: 'svcMagicAgentPlatform.listPendingApprovals' })
      expect(listed.approvals).toHaveLength(1)
      const item = listed.approvals[0]
      expect(item.request).toMatchObject({ request: { action: 'memory.note.write', target: { id: 'scratchpad' }, input: { conversationId: scope.conversationId, ...args } } })
      await expect(approvals.resolvePendingApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true }, { ...invoke('resolvePendingApproval'), isMainFrame: false })).rejects.toThrow('MagicAgent approval access is not trusted for this renderer.')
      if (decision === 'cancel') await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation'))
      else if (decision === 'navigation') sender.emit('did-start-navigation', { isMainFrame: true })
      else await approvals.resolvePendingApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: decision === 'approve' }, { ...invoke('resolvePendingApproval'), methodName: 'svcMagicAgentPlatform.resolvePendingApproval' })
      const outcome = await pending
      if (decision === 'approve') {
        expect(outcome.status).toBe('fulfilled')
        if (method === 'chat') expect(outcome).toMatchObject({ value: { content: 'Saved the working note after formal approval.' } })
        else expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Saved the working note after formal approval.' }))
        expect(chat).toHaveBeenCalledTimes(2)
      } else {
        expect(chat).toHaveBeenCalledOnce()
        if (method === 'chat') expect(outcome.status).toBe('rejected')
        else if (decision === 'navigation') expect(onData.mock.calls.filter(([event]) => event.type === 'done' || event.type === 'error')).toEqual([])
        else expect(onData.mock.calls.filter(([event]) => event.type === 'done')).toEqual([[expect.objectContaining({ finishReason: decision === 'cancel' ? 'cancelled' : 'error' })]])
      }
      expect(store.get(scope)).toMatchObject({ revision: decision === 'approve' ? 2 : 1, notes: [{ key: 'preference', value: decision === 'approve' ? 'EXACT_APPROVED_WORKING_NOTE' : 'CURRENT_NOTES_RETAINED_原始🌱' }] })
      expect(store.get({ ...scope, conversationId: 'sibling-notes' })).toMatchObject({ revision: 1, notes: [{ value: 'SIBLING_NOTES_PRIVATE' }] })
      expect(policy.listPendingTerminalApprovals()).toEqual([])
      await expect(approvals.resolvePendingApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true }, invoke('resolvePendingApproval'))).rejects.toThrow('not found or has changed')
      expect(h.callTool).toHaveBeenCalledOnce(); expect(sender.listenerCount('did-start-navigation')).toBe(0)
    }
  )
  it.each(['chat', 'chatStream'].flatMap(method => [false, true].map(native => ({ method, native }))))('reads only its retained current-conversation key via $method native=$native, not automatic prompt injection', async ({ method, native }) => {
    h.callTool.mockImplementation(async (r, name, args, options) => {
      expect(name).toBe('scratchpad')
      return options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal })
    })
    const chat = vi.fn(async input => {
      expect(JSON.stringify(input)).not.toContain('SIBLING_NOTES_PRIVATE')
      if (chat.mock.calls.length > 1) {
        const transcript = JSON.stringify(native ? input.toolTurns : input.messages)
        expect(transcript).toContain('CURRENT_NOTES_RETAINED_原始🌱'); expect(transcript).toContain('untrustedData'); expect(transcript).toContain('grantsPermission')
        return 'Read the current conversation working note.'
      }
      expect(JSON.stringify(input)).not.toContain('CURRENT_NOTES_RETAINED_原始🌱')
      if (native) expect(input.tools.map((tool: { name: string }) => tool.name)).toContain('scratchpad')
      else expect(input.systemPrompt).toContain('scratchpad')
      const args = { key: 'preference' }
      if (!native) return JSON.stringify({ toolName: 'scratchpad', args })
      const index = input.tools.findIndex((tool: { name: string }) => tool.name === 'scratchpad')
      return { content: '', toolCalls: [{ id: 'read-working-note', name: 'scratchpad', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
    const request = { ...scope, profileId: 'scratchpad-profile', messages: [{ role: 'user' as const, content: 'Read the working preference explicitly.' }] }
    const onData = vi.fn()
    if (method === 'chat') expect(await service.chat(request, invoke(method))).toMatchObject({ content: 'Read the current conversation working note.' })
    else { await service.chatStream(request, { onData }, invoke(method)); expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Read the current conversation working note.' })) }
    expect(chat).toHaveBeenCalledTimes(2); expect(h.callTool).toHaveBeenCalledOnce()
    expect((await getAgentThreadNotesStore()).get(scope)).toMatchObject({ revision: 1, notes: [{ key: 'preference', value: 'CURRENT_NOTES_RETAINED_原始🌱' }] })
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
})
