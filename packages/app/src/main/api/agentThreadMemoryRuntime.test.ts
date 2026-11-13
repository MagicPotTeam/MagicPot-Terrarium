import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { vol } from 'memfs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { AssistantToolRegistry } from '../assistantRuntime/toolRegistry'
import { McpClientManager } from '../mcp/clientManager'
import { closeAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { syncMcpClientManager } from '../mcp/runtime'
import { agentThreadArchive } from './agentThreadArchive'
import { prepareCanvasAgentTools } from './canvasAgentTools'
import { searchAgentSessionArchive } from '../../renderer/src/pages/ChatPage/agentArchiveSearch'

vi.mock('fs/promises', async () => { const { fs } = await import('memfs'); return { ...fs.promises, default: fs.promises } })
vi.mock('fs', async () => { const { fs } = await import('memfs'); return { ...fs, default: fs } })
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => '/mock' }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/memory-runtime-fixture', root: '/mock-root' } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(() => structuredClone(DEFAULT_CONFIG)), onConfigCommitted: vi.fn(), saveConfig: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined), getMcpClientManager: () => { throw Error('No MCP probe from local history search') } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'originals', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=originals'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 96, isMainFrame: true, senderUrl: url, frameUrl: url })
const original: ChatMessage[] = [
  { role: 'system', content: 'SYSTEM_NOT_SEARCHABLE' },
  { role: 'user', content: 'ORIGINAL_OUTSIDE_REQUEST 🌱', hiddenContext: 'HIDDEN_NOT_SEARCHABLE' }
]
let store: AssistantSessionStore, runtime: AssistantRuntime, prepared: ReturnType<typeof prepareCanvasAgentTools>, sender: EventEmitter
beforeEach(() => {
  vi.clearAllMocks(); vol.reset()
  const config = structuredClone(DEFAULT_CONFIG)
  store = new AssistantSessionStore('/memory-runtime-fixture/session.json')
  runtime = new AssistantRuntime({ sessionStore: store, toolRegistry: new AssistantToolRegistry(new McpClientManager()), configProvider: () => config, chatService: { chat: vi.fn(async () => { throw Error('No model in runtime-owned tool fixture') }) } })
  sender = Object.assign(new EventEmitter(), { id: 96, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(96, route, { trustedUrl: url, trustedWebContents: sender as never })
  prepared = prepareCanvasAgentTools({ ...scope, messages: [{ role: 'user', content: 'Compressed summary only; source omitted.' }] }, invoke('chat'), { local: true, terminalEnabled: false })
})
afterEach(async () => { prepared.dispose?.(); await store.flush(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
const args = { query: 'ORIGINAL_OUTSIDE_REQUEST', mode: 'literal' }
const options = () => ({ allowedToolNames: prepared.request.skillRuntime!.bindings![0].toolNames, runId: 'runtime-search-run', toolCallId: 'runtime-search-call', toolProvider: prepared.toolProvider })
const call = () => prepared.admission!.run('search_memory', undefined, () => runtime.callTool(route, 'search_memory', args, options()))
const answer = async () => {
  await vi.waitFor(() => expect(agentThreadArchive.list(scope, invoke('listAgentArchiveQueries'))).toHaveLength(1))
  const [query] = agentThreadArchive.list(scope, invoke('listAgentArchiveQueries'))
  const result = await searchAgentSessionArchive(original, query.search, undefined, query.expiresAt)
  agentThreadArchive.resolve({ ...scope, queryId: query.id, result }, invoke('resolveAgentArchiveQuery'))
}

describe('restored history through real Canvas admission + AssistantRuntime + durable adapter (memfs/Electron stubbed)', () => {
  it('journals only the bounded result and replays without a second scan/dispatch or global MCP sync', async () => {
    const search = vi.spyOn(agentThreadArchive, 'search')
    const pending = call(); await answer(); const first = await pending
    expect(JSON.parse(first.content)).toMatchObject({ source: 'session_archive', status: 'available', matches: [{ messageIndex: 1, role: 'user', excerpt: original[1].content }], grantsPermission: false, untrustedData: true })
    expect(await call()).toEqual(first)
    expect(search).toHaveBeenCalledOnce(); expect(syncMcpClientManager).not.toHaveBeenCalled()
    expect(agentThreadArchive.list(scope, invoke('listAgentArchiveQueries'))).toEqual([])
    const saved = await store.getSession(route)
    const actions = saved?.eventLog.map(event => event.metadata?.agentAction)
    expect(actions).toHaveLength(2)
    expect(actions).toEqual([expect.objectContaining({ type: 'tool.invoke' }), expect.objectContaining({ type: 'tool.result', payload: expect.objectContaining({ ok: true, content: first.content }) })])
    expect(JSON.stringify(saved)).not.toContain('SYSTEM_NOT_SEARCHABLE'); expect(JSON.stringify(saved)).not.toContain('HIDDEN_NOT_SEARCHABLE')
    expect(prepared.request.messages).toEqual([{ role: 'user', content: 'Compressed summary only; source omitted.' }])
    await store.flush()
    expect(await fs.readFile(path.join('/memory-runtime-fixture', 'session.json'), 'utf8')).toContain('ORIGINAL_OUTSIDE_REQUEST')
  })
  it('keeps original per-provider admission ownership; a direct dispatcher call cannot borrow another turn', async () => {
    const other = prepareCanvasAgentTools({ ...scope, messages: [] }, invoke('chat'), { local: true, terminalEnabled: false })
    try {
      await expect(prepared.toolProvider!.callTool('search_memory', args, { route, runId: 'unadmitted' })).rejects.toThrow('live Agent thread invocation')
      await expect(prepared.admission!.run('search_memory', undefined, () => other.toolProvider!.callTool('search_memory', args, { route, runId: 'borrowed' }))).rejects.toThrow('live Agent thread invocation')
      expect(agentThreadArchive.list(scope, invoke('listAgentArchiveQueries'))).toEqual([])
    } finally { other.dispose?.() }
  })
})
