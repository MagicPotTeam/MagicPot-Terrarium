import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMCli } from '@shared/llm/types'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { AssistantToolRegistry } from '../assistantRuntime/toolRegistry'
import { McpClientManager } from '../mcp/clientManager'
import { syncMcpClientManager } from '../mcp/runtime'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { prepareCanvasAgentTools } from './canvasAgentTools'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ sender: vi.fn(), parent: vi.fn(), data: '' }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => h.data }, webContents: { fromId: h.sender }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data, root: h.data } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(() => structuredClone(DEFAULT_CONFIG)), onConfigCommitted: vi.fn(), saveConfig: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-runtime', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }, url = 'file:///D:/app/index.html#/canvas?id=memory-runtime'
const invocation = { methodName: 'svcLLMProxy.chat', senderId: 169, isMainFrame: true, senderUrl: url, frameUrl: url }
let root: string, store: AssistantSessionStore, runtime: AssistantRuntime, prepared: ReturnType<typeof prepareCanvasAgentTools>
const chat = vi.fn<LLMCli['chat']>()
const options = { runId: 'memory-outer-run', toolCallId: 'memory-outer-call' }
const args = { task: 'Remember the fixture fact in ./memory/facts.md after reading it.' }
const call = () => prepared.admission!.run('memory_write', undefined, () => runtime.callTool(route, 'memory_write', args, { ...options, allowedToolNames: prepared.request.skillRuntime!.bindings![0].toolNames, toolProvider: prepared.toolProvider }))
const actionType = (value: unknown) => value && typeof value === 'object' && 'type' in value ? value.type : undefined
beforeEach(() => {
  vi.clearAllMocks(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-memory-runtime-fixture-')); h.data = fs.realpathSync.native(root)
  store = new AssistantSessionStore(path.join(root, 'sessions.json'))
  runtime = new AssistantRuntime({ sessionStore: store, toolRegistry: new AssistantToolRegistry(new McpClientManager()), configProvider: () => structuredClone(DEFAULT_CONFIG), chatService: { chat: vi.fn(async () => { throw Error('No actual model in fixture') }) } })
  const sender = Object.assign(new EventEmitter(), { id: 169, isDestroyed: () => false, getURL: () => url })
  h.sender.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(169, route, { trustedUrl: url, trustedWebContents: sender as never })
  chat.mockImplementation(async () => {
    const count = chat.mock.calls.length
    if (count === 1) return { content: '{"toolName":"memory.files.read","args":{"path":"./memory/facts.md"}}' }
    if (count === 2) return { content: '{"toolName":"memory.files.write","args":{"path":"./memory/facts.md","content":"ACTUAL_FILE_MEMORY_原始🌱","create":true}}' }
    return { content: 'Completed the formally approved persistent memory-file update.' }
  })
  prepared = prepareCanvasAgentTools({ ...scope, messages: [] }, invocation, { local: true, terminalEnabled: false,
    createMemoryClient: async () => ({ chat, supportsIsolatedMainToolTurns: true }),
    commitMemoryFile: (provider, input, child) => runtime.callTool(route, 'memory.files.write', input, { allowedToolNames: ['memory.files.write'], toolProvider: provider, runId: child.runId, toolCallId: child.toolCallId, signal: child.signal }) })
})
afterEach(async () => { prepared.dispose?.(); await store.flush(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
describe('actual memory helper + Canvas + runtime/nested durable adapter + exact formal policy (isolated OS fixture files)', () => {
  it('journals nested writes, settles once and replays without model/approval/file redispatch/MCP sync', async () => {
    const pending = call(), policy = getAssistantTerminalPolicyRuntime()
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    const item = policy.listPendingTerminalApprovals()[0]
    expect(item.request.request.target.id).toBe('memory_write')
    expect(item.request.request.input).toMatchObject({ content: 'ACTUAL_FILE_MEMORY_原始🌱', path: './memory/facts.md', preimage: null, create: true, namespaceCreation: true })
    policy.resolvePendingTerminalApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true })
    const first = await pending
    expect(JSON.parse(first.content)).toMatchObject({ kind: 'memory_write', status: 'completed', toolCalls: 2 })
    expect(await call()).toEqual(first); expect(chat).toHaveBeenCalledTimes(3)
    expect(policy.listPendingTerminalApprovals()).toEqual([]); expect(syncMcpClientManager).not.toHaveBeenCalled()
    const actions = (await store.getSession(route))?.eventLog.map(event => event.metadata?.agentAction)
    expect(actions).toEqual([expect.objectContaining({ type: 'tool.invoke', payload: expect.objectContaining({ toolName: 'memory_write' }) }), expect.objectContaining({ type: 'tool.invoke', payload: expect.objectContaining({ toolName: 'memory.files.write' }) }), expect.objectContaining({ type: 'tool.result', payload: expect.objectContaining({ toolName: 'memory.files.write', ok: true }) }), expect.objectContaining({ type: 'tool.result', payload: expect.objectContaining({ toolName: 'memory_write', ok: true }) })])
  })
  it('postcommit nested-result publication failure retains review lock and reopening never starts the helper or approves again', async () => {
    const append = store.appendEvents.bind(store)
    const broken = vi.spyOn(store, 'appendEvents').mockImplementation(async (...input) => {
      if (input[1].some(event => actionType(event.metadata?.agentAction) === 'tool.result')) throw new Error('Synthetic memory result publication interrupted')
      return append(...input)
    })
    const pending = call().catch(error => error), policy = getAssistantTerminalPolicyRuntime()
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    const item = policy.listPendingTerminalApprovals()[0]
    policy.resolvePendingTerminalApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true })
    expect(await pending).toMatchObject({ message: 'Synthetic memory result publication interrupted' })
    expect(chat).toHaveBeenCalledTimes(2)
    const input = item.request.request.input as Record<string, unknown>, namespace = String(input.namespace)
    expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe('ACTUAL_FILE_MEMORY_原始🌱')
    expect(fs.existsSync(path.join(namespace, '.writer-lock'))).toBe(true)
    broken.mockRestore(); await store.flush()
    const reopened = new AssistantSessionStore(path.join(root, 'sessions.json'))
    runtime = new AssistantRuntime({ sessionStore: reopened, toolRegistry: new AssistantToolRegistry(new McpClientManager()), configProvider: () => structuredClone(DEFAULT_CONFIG), chatService: { chat: vi.fn() } })
    await expect(call()).rejects.toMatchObject({ code: 'TOOL_REPLAY_REQUIRES_REVIEW' })
    expect(chat).toHaveBeenCalledTimes(2); expect(policy.listPendingTerminalApprovals()).toEqual([]); await reopened.flush()
  })
  it('cannot bypass the original owner admission or give the parent the internal mutation provider', async () => {
    await expect(prepared.toolProvider!.callTool('memory_write', args, { route, ...options })).rejects.toThrow('live Agent thread invocation')
    expect(prepared.toolProvider!.listTools().map(tool => tool.name)).not.toContain('memory.files.write')
    expect(chat).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual([])
  })
})
