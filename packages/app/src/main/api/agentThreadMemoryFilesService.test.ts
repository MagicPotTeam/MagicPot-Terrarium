import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import type { LLMCli, LLMChatParams, LLMChatResult } from '@shared/llm/types'
import { getConfig } from '../config/config'
import { getAssistantWorkspaceState } from '../assistantRuntime/workspace'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { createMemoryFileSession } from './agentThreadMemoryFileHost'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ sender: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), data: '' }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => h.data }, webContents: { fromId: h.sender }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data, root: h.data } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-files-service', threadId: 'pane' } as const
const scope = { route, conversationId: 'current-memory' }, url = 'file:///D:/app/index.html#/canvas?id=memory-files-service'
const invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 171, isMainFrame: true, senderUrl: url, frameUrl: url })
const before = 'EXISTING_MEMORY_FILE_原始🌱', after = '<script>EXACT_APPROVED_MEMORY</script>\nretained information'
let root: string, namespace: string, service: LLMProxySvcImpl, sender: EventEmitter
beforeEach(async () => {
  vi.clearAllMocks(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-memory-service-fixture-')); h.data = fs.realpathSync.native(root)
  const config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'memory-profile', model_name: 'Fixture', base_url: 'https://model.example/v1', api_key: 'fixture-never-sent' }]
  vi.mocked(getConfig).mockReturnValue(config)
  sender = Object.assign(new EventEmitter(), { id: 171, isDestroyed: () => false, getURL: () => url })
  h.sender.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(171, route, { trustedUrl: url, trustedWebContents: sender as never })
  h.listTools.mockReturnValue([])
  h.callTool.mockImplementation(async (r, name, args, options) => options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal }))
  const seed = createMemoryFileSession({ route, conversationId: scope.conversationId, writable: true, childRunId: 'seed-child', parentRunId: 'seed-parent', parentToolCallId: 'seed-call', signal: new AbortController().signal, assertLive: () => undefined, approve: async () => () => undefined, durable: (provider, args, context) => provider.callTool('memory.files.write', args, context) })
  await seed.callTool('memory.files.read', { path: './memory/facts.md' }, { route, runId: 'seed-child', toolCallId: 'seed-read', modelStep: 1 })
  await seed.callTool('memory.files.write', { path: './memory/facts.md', content: before, create: true }, { route, runId: 'seed-child', toolCallId: 'seed-write', modelStep: 2 })
  seed.close()
  const workspace = getAssistantWorkspaceState(route)
  namespace = path.join(workspace.memoryDir, '.agent-memory-v1')
  fs.writeFileSync(workspace.memoryFile, 'DAILY_LOG_NOT_IN_MEMORY_NAMESPACE')
  service = new LLMProxySvcImpl()
})
afterEach(async () => { await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation')); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
function toolResult(input: LLMChatParams, native: boolean, name: string, args: Record<string, unknown>, id: string): LLMChatResult {
  if (!native) return { content: JSON.stringify({ toolName: name, args }) }
  const index = input.tools!.findIndex(tool => tool.name === name)
  expect(index).toBeGreaterThanOrEqual(0)
  return { content: '', toolCalls: [{ id, name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
}
function clients(native: boolean, writable: boolean) {
  const parent = vi.fn<LLMCli['chat']>(async input => {
    if (parent.mock.calls.length === 1) {
      expect(JSON.stringify(input)).not.toContain(before); expect(JSON.stringify(input)).not.toContain('DAILY_LOG_NOT_IN_MEMORY_NAMESPACE')
      return toolResult(input, native, writable ? 'memory_write' : 'memory_read', { task: 'Process only ./memory/facts.md for the assigned task.' }, 'parent-helper')
    }
    const transcript = JSON.stringify(native ? input.toolTurns : input.messages)
    expect(transcript).toContain(writable ? 'memory_write' : 'memory_read'); expect(transcript).toContain('untrustedData')
    return { content: writable ? 'Completed the approved memory-file helper.' : 'Read the persistent memory file through the helper.' }
  })
  const child = vi.fn<LLMCli['chat']>(async input => {
    expect(input).toMatchObject({ disableProviderTools: true, retryCapacity: false, imageGenerationOptions: { enabled: false }, maxOutputTokens: 2048 })
    expect(JSON.stringify(input)).not.toContain('PARENT_ONLY_PRIVATE_CONTEXT')
    expect(JSON.stringify(input)).not.toContain('DAILY_LOG_NOT_IN_MEMORY_NAMESPACE')
    if (child.mock.calls.length === 1) return toolResult(input, native, 'memory.files.read', { path: './memory/facts.md' }, 'child-read')
    expect(JSON.stringify(native ? input.toolTurns : input.messages)).toContain(before)
    if (writable && child.mock.calls.length === 2) return toolResult(input, native, 'memory.files.write', { path: './memory/facts.md', content: after, create: false }, 'child-write')
    return { content: writable ? 'Approved exact persistent file update settled.' : 'Observed ' + before }
  })
  vi.mocked(cliFromProfile).mockReturnValueOnce({ chat: parent, supportsNativeTools: native }).mockReturnValue({ chat: child, supportsNativeTools: native, supportsIsolatedMainToolTurns: true })
  return { parent, child }
}
const modes = ['chat', 'chatStream'].flatMap(method => [false, true].map(native => ({ method, native })))
describe('memory helper actual service/native+JSON/chat+stream + isolated real files + formal approval renderer path', () => {
  it.each(modes)('reads only persistent file memory, never daily logs or parent context, through $method native=$native', async ({ method, native }) => {
    const model = clients(native, false), onData = vi.fn(), request = { ...scope, profileId: 'memory-profile', messages: [{ role: 'user' as const, content: 'Read memory. PARENT_ONLY_PRIVATE_CONTEXT' }] }
    if (method === 'chat') expect(await service.chat(request, invoke(method))).toMatchObject({ content: 'Read the persistent memory file through the helper.' })
    else { await service.chatStream(request, { onData }, invoke(method)); expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Read the persistent memory file through the helper.' })) }
    expect(model.child).toHaveBeenCalledTimes(2); expect(model.parent).toHaveBeenCalledTimes(2); expect(h.callTool).toHaveBeenCalledOnce()
    expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe(before)
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
  it.each(modes.flatMap(mode => ['approve', 'deny', 'cancel', 'navigation'].map(decision => ({ ...mode, decision }))))('requires exact approval for file update through $method native=$native decision=$decision', async ({ method, native, decision }) => {
    const { MagicAgentPlatformSvcImpl } = await import('./svcMagicAgentPlatformImpl')
    const approvals = new MagicAgentPlatformSvcImpl(), policy = getAssistantTerminalPolicyRuntime(), model = clients(native, true), onData = vi.fn()
    const request = { ...scope, profileId: 'memory-profile', messages: [{ role: 'user' as const, content: 'Update memory after approval. PARENT_ONLY_PRIVATE_CONTEXT' }] }
    const pending = (method === 'chat' ? service.chat(request, invoke(method)) : service.chatStream(request, { onData }, invoke(method))).then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }))
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe(before)
    const approvalInvocation = (method: string) => ({ ...invoke(method), methodName: `svcMagicAgentPlatform.${method}` })
    const listed = await approvals.listPendingApprovals({}, approvalInvocation('listPendingApprovals')), item = listed.approvals[0]
    expect(item.request).toMatchObject({ request: { action: 'memory.file.write', target: { id: 'memory_write' }, input: { path: './memory/facts.md', namespace, namespaceCreation: false, create: false, content: after, conversationId: scope.conversationId } } })
    await expect(approvals.resolvePendingApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true }, { ...approvalInvocation('resolvePendingApproval'), isMainFrame: false })).rejects.toThrow('MagicAgent approval access is not trusted for this renderer.')
    if (decision === 'cancel') await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation'))
    else if (decision === 'navigation') sender.emit('did-start-navigation', { isMainFrame: true })
    else await approvals.resolvePendingApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: decision === 'approve' }, approvalInvocation('resolvePendingApproval'))
    const outcome = await pending
    if (decision === 'approve') {
      expect(outcome.status).toBe('fulfilled')
      if (method === 'chat') expect(outcome).toMatchObject({ value: { content: 'Completed the approved memory-file helper.' } })
      else expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Completed the approved memory-file helper.' }))
      expect(model.child).toHaveBeenCalledTimes(3); expect(model.parent).toHaveBeenCalledTimes(2)
    } else {
      expect(model.child).toHaveBeenCalledTimes(2); expect(model.parent).toHaveBeenCalledOnce()
      if (method === 'chat') expect(outcome.status).toBe('rejected')
      else if (decision === 'navigation') expect(onData.mock.calls.filter(([event]) => event.type === 'done' || event.type === 'error')).toEqual([])
      else expect(onData.mock.calls.filter(([event]) => event.type === 'done')).toEqual([[expect.objectContaining({ finishReason: decision === 'cancel' ? 'cancelled' : 'error' })]])
    }
    expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe(decision === 'approve' ? after : before)
    expect(fs.readFileSync(getAssistantWorkspaceState(route).memoryFile, 'utf8')).toBe('DAILY_LOG_NOT_IN_MEMORY_NAMESPACE')
    expect(fs.existsSync(path.join(namespace, '.writer-lock'))).toBe(false)
    expect(policy.listPendingTerminalApprovals()).toEqual([])
    await expect(approvals.resolvePendingApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true }, approvalInvocation('resolvePendingApproval'))).rejects.toThrow('not found or has changed')
    expect(h.callTool).toHaveBeenCalledTimes(2); expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
})
