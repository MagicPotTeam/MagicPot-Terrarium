import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => '/unused-memory-restore-fixture' }, webContents: { fromId: mocks.fromId }, BrowserWindow: { fromWebContents: mocks.parent } }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: mocks.listTools, callTool: mocks.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { llmProxySvcDef } from '@shared/api/svcLLMProxy'
import { getConfig } from '../config/config'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { agentThreadArchive } from './agentThreadArchive'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { searchAgentSessionArchive } from '../../renderer/src/pages/ChatPage/agentArchiveSearch'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'restored-memory', threadId: 'pane' } as const
const scope = { route, conversationId: 'restored-chat' }
const url = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=restored-memory'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 93, frameUrl: url, senderUrl: url, isMainFrame: true })
const original: ChatMessage[] = [
  { role: 'system', content: 'NEVER_SYSTEM_PRIVATE' },
  { role: 'user', content: 'Launch detail: ARCHIVE_ONLY_VALUE_blue_原始🌱', hiddenContext: 'NEVER_HIDDEN_PRIVATE', attachments: [{ type: 'file', url: 'NEVER_ATTACHMENT_PRIVATE' }] },
  { role: 'assistant', content: 'Acknowledged the launch detail.', toolHistory: [{ runId: 'old-run', toolCallId: 'old-call', toolName: 'files.read', args: { path: 'NEVER_TOOL_ARGS_PRIVATE' }, status: 'completed', content: 'NEVER_TOOL_OUTPUT_DEFAULT' }] }
]
let sender: EventEmitter, service: LLMProxySvcImpl
beforeEach(() => {
  vi.clearAllMocks()
  const config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'memory-profile', model_name: 'Fixture Model', base_url: 'https://model.example/v1', api_key: 'fixture-not-sent' }]
  vi.mocked(getConfig).mockReturnValue(config)
  sender = Object.assign(new EventEmitter(), { id: 93, isDestroyed: () => false, getURL: () => url })
  registerMagicAgentTrustedRouteBinding(93, route, { trustedUrl: url, trustedWebContents: sender as never })
  mocks.fromId.mockReturnValue(sender); mocks.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  mocks.listTools.mockReturnValue([])
  service = new LLMProxySvcImpl()
})
afterEach(async () => {
  await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation'))
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.restoreAllMocks()
})

describe('restored current-conversation original archive retrieval, not request-window recall', () => {
  it('registers archive rendezvous and separately restored readonly notes, not retired mutation/counter routes', () => {
    for (const name of ['listAgentArchiveQueries', 'resolveAgentArchiveQuery', 'getAgentNotes']) expect(llmProxySvcDef).toHaveProperty(name, { type: 'unary' })
    for (const name of ['listAgentGoalDispatches', 'mutateAgentNote']) expect(llmProxySvcDef).not.toHaveProperty(name)
  })
  it.each(['chat', 'chatStream'].flatMap(method => [false, true].map(native => ({ method, native }))))('recalls a compressed-out original message via $method native=$native without copying the archive into the request', async ({ method, native }) => {
    const rawBefore = structuredClone(original)
    const resolve = vi.spyOn(agentThreadArchive, 'resolve')
    mocks.callTool.mockImplementation(async (r, name, args, options) => {
      expect(name).toBe('search_memory')
      const pending = options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal })
      let queries: ReturnType<typeof agentThreadArchive.list> = []
      await vi.waitFor(async () => {
        // Existing method is intentionally a removed stub in test-only red. Read
        // via the stable archive return type without casting or importing new code.
        const response: unknown = await service.listAgentArchiveQueries(scope, invoke('listAgentArchiveQueries'))
        expect(response).toMatchObject({ queries: expect.any(Array) })
        queries = agentThreadArchive.list(scope, invoke('listAgentArchiveQueries'))
        expect(queries).toHaveLength(1)
      })
      const query = queries[0]
      expect(query.search).toMatchObject({ query: 'ARCHIVE_ONLY_VALUE', mode: 'literal' })
      expect(agentThreadArchive.list({ ...scope, conversationId: 'sibling' }, invoke('listAgentArchiveQueries'))).toEqual([])
      const result = await searchAgentSessionArchive(original, query.search, options.signal, query.expiresAt)
      expect(result.matches).toEqual([{ messageIndex: 1, role: 'user', excerpt: original[1].content }])
      await service.resolveAgentArchiveQuery({ ...scope, queryId: query.id, result }, invoke('resolveAgentArchiveQuery'))
      return pending
    })
    const chat = vi.fn(async input => {
      const transcript = JSON.stringify(native ? input.toolTurns : input.messages)
      for (const secret of ['NEVER_SYSTEM_PRIVATE', 'NEVER_HIDDEN_PRIVATE', 'NEVER_ATTACHMENT_PRIVATE', 'NEVER_TOOL_ARGS_PRIVATE', 'NEVER_TOOL_OUTPUT_DEFAULT', 'SIBLING_ARCHIVE_SECRET']) expect(JSON.stringify(input)).not.toContain(secret)
      if (chat.mock.calls.length > 1) {
        expect(transcript).toContain('ARCHIVE_ONLY_VALUE_blue_原始🌱')
        expect(transcript).toContain('session_archive')
        expect(transcript).toContain('untrustedData')
        return 'Recovered the original current-conversation launch detail.'
      }
      expect(transcript).not.toContain('ARCHIVE_ONLY_VALUE_blue_原始🌱')
      const tools = input.tools || []
      if (native) expect(tools.map((tool: { name: string }) => tool.name)).toContain('search_memory')
      else expect(input.systemPrompt).toContain('search_memory')
      if (native) expect(tools.map((tool: { name: string }) => tool.name)).toContain('scratchpad')
      const args = { query: 'ARCHIVE_ONLY_VALUE', mode: 'literal', limit: 5 }
      if (!native) return JSON.stringify({ toolName: 'search_memory', args })
      const index = tools.findIndex((tool: { name: string }) => tool.name === 'search_memory')
      return { content: '', toolCalls: [{ id: 'recall-original', name: 'search_memory', wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
    const request = { ...scope, profileId: 'memory-profile', messages: [{ role: 'user' as const, content: 'Recall the earlier launch detail omitted by compression.' }] }
    const onData = vi.fn()
    if (method === 'chat') expect(await service.chat(request, invoke(method))).toMatchObject({ content: 'Recovered the original current-conversation launch detail.' })
    else { await service.chatStream(request, { onData }, invoke(method)); expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Recovered the original current-conversation launch detail.' })) }
    expect(chat).toHaveBeenCalledTimes(2); expect(mocks.callTool).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledOnce()
    expect(original).toEqual(rawBefore)
    expect(agentThreadArchive.list(scope, invoke('listAgentArchiveQueries'))).toEqual([])
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
})
