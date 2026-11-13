import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')
const mocks = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), utilityFork: vi.fn(() => { throw new Error('No utility parser launch in plain-file fixtures') }), data: '' }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => mocks.data, getAppPath: () => process.cwd(), isReady: () => true }, utilityProcess: { fork: mocks.utilityFork }, webContents: { fromId: mocks.fromId }, BrowserWindow: { fromWebContents: mocks.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: mocks.data } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: mocks.listTools, callTool: mocks.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { AGENT_LOCAL_FILE_LIMITS } from '@shared/api/svcAgentLocalFiles'
import { cliFromProfile } from '@shared/llm'
import { getConfig } from '../config/config'
import { AssistantToolRegistry } from '../assistantRuntime/toolRegistry'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { getAssistantSessionKey } from '../assistantRuntime/types'
import { McpClientManager } from '../mcp/clientManager'
import { closeAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { FilesToolHost } from '../magicAgentPlatform2/toolHost/files'
import { LocalFileReadGrants } from '../agentLocalFiles/readGrants'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { describeThreadFileRead } from './agentThreadFileReadCatalog'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'read-info-project', threadId: 'pane' } as const
const url = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=read-info-project'
const scope = { route, conversationId: 'read-info-chat' }
const invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 92, frameUrl: url, senderUrl: url, isMainFrame: true })
let root = '', registry: AssistantToolRegistry, store: AssistantSessionStore, sender: EventEmitter, config: typeof DEFAULT_CONFIG
const payload = 'LOCAL_READ_PAYLOAD 🌱\r\n'
const actualRead = { content: '' }
beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'files-read-info-')))
  mocks.data = root
  await fs.writeFile(path.join(root, 'fixture.txt'), payload)
  config = structuredClone(DEFAULT_CONFIG)
  config.workflow_dir = path.join(root, 'workflows'); config.output_dir = path.join(root, 'output'); config.download_dir = path.join(root, 'downloads')
  config.llm_config.api_profiles = [{ id: 'read-profile', model_name: 'Fixture Model', base_url: 'https://model.example/v1', api_key: 'fixture-not-sent' }]
  vi.mocked(getConfig).mockReturnValue(config)
  sender = Object.assign(new EventEmitter(), { id: 92, isDestroyed: () => false, getURL: () => url })
  registerMagicAgentTrustedRouteBinding(92, route, { trustedUrl: url, trustedWebContents: sender as never })
  mocks.fromId.mockReturnValue(sender); mocks.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  // Real registry with an inert, unsynced manager: listToolsSnapshot does not connect.
  registry = new AssistantToolRegistry(new McpClientManager())
  store = new AssistantSessionStore(path.join(root, 'sessions.json'))
  mocks.listTools.mockImplementation((allowed?: string[]) => registry.listTools().filter(tool => !allowed || allowed.includes(tool.name)))
  actualRead.content = ''
  mocks.callTool.mockImplementation(async (r, name, args, options) => {
    if (name !== 'files.read') return options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal })
    const result = await registry.callTool(name, args, { config, route: r, sessionStore: store, workspaceRootDir: root, signal: options.signal,
      readExternalFile: options.readExternalFile, taskState: { sessionKey: getAssistantSessionKey(r), running: true, queuedCount: 0, updatedAt: 1 } })
    actualRead.content = result.content
    return result
  })
})
afterEach(async () => {
  await store?.flush()
  closeAssistantTerminalPolicyRuntime()
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('files.read manual composed with real registry and local read backends (model/Electron stubbed)', () => {
  it('recognizes the actual registry schema without making it a new tool export or backend probe', () => {
    const actual = registry.listTools().find(tool => tool.name === 'files.read')!
    expect(actual.inputSchema).toEqual({ type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: AGENT_LOCAL_FILE_LIMITS.documentBytes },
      maxStringLength: { type: 'integer', minimum: 1, maximum: 1048576 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
    } })
    expect(describeThreadFileRead('files.read', [actual])?.authority).toMatchObject({ checksRuntimeReadiness: false, selectsBackend: false })
    expect(mocks.callTool).not.toHaveBeenCalled(); expect(mocks.utilityFork).not.toHaveBeenCalled()
  })
  it.each(['chat', 'chatStream'].flatMap(method => [false, true].flatMap(native => [false, true].flatMap(withInfo => ['workspace', 'desktop'].map(backend => ({ method, native, withInfo, backend }))))))(
    'keeps separate explicit read through $method native=$native withInfo=$withInfo backend=$backend', async ({ method, native, withInfo, backend }) => {
      const read = vi.spyOn(registry, 'callTool'), host = vi.spyOn(FilesToolHost.prototype, 'read'), grants = vi.spyOn(LocalFileReadGrants.prototype, 'authorize')
      const args = { path: backend === 'desktop' ? path.join(root, 'fixture.txt') : 'fixture.txt', maxBytes: 128, maxStringLength: 128, timeoutMs: 5000 }
      const chat = vi.fn(async input => {
        const call = (name: string, values: Record<string, unknown>, id: string) => {
          if (!native) return JSON.stringify({ toolName: name, args: values })
          const index = input.tools.findIndex((tool: { name: string }) => tool.name === name)
          expect(index).toBeGreaterThanOrEqual(0)
          return { content: '', toolCalls: [{ id, name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(values) }] }
        }
        if (withInfo && chat.mock.calls.length === 1) return call('info', { name: 'files.read' }, 'read-manual')
        const transcript = JSON.stringify(native ? input.toolTurns : input.messages)
        if (chat.mock.calls.length === (withInfo ? 3 : 2)) {
          expect(transcript).toContain('LOCAL_READ_PAYLOAD')
          expect(read).toHaveBeenCalledOnce()
          return 'Read the intended local fixture.'
        }
        if (withInfo) {
          for (const text of ['magicpot-local-file-read-manual/v1', '64 KiB', 'not inferred', 'not atomic', 'grantsPermission']) expect(transcript).toContain(text)
          expect(read).not.toHaveBeenCalled(); expect(host).not.toHaveBeenCalled(); expect(grants).not.toHaveBeenCalled()
          expect(actualRead.content).toBe(''); expect(mocks.utilityFork).not.toHaveBeenCalled()
        }
        return call('files.read', args, 'explicit-file-read')
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const service = new LLMProxySvcImpl(), request = { ...scope, profileId: 'read-profile', messages: [{ role: 'user' as const, content: 'Read the intended local fixture.' }] }, onData = vi.fn()
      if (method === 'chat') expect(await service.chat(request, invoke(method))).toMatchObject({ content: 'Read the intended local fixture.' })
      else {
        await service.chatStream(request, { onData }, invoke(method))
        expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Read the intended local fixture.' }))
      }
      expect(chat).toHaveBeenCalledTimes(withInfo ? 3 : 2)
      expect(read).toHaveBeenCalledExactlyOnceWith('files.read', args, expect.objectContaining({ workspaceRootDir: root, readExternalFile: expect.any(Function), signal: expect.any(AbortSignal) }))
      const result = JSON.parse(actualRead.content)
      expect(result).toMatchObject({ content: payload, returnedBytes: Buffer.byteLength(payload), truncated: false })
      if (backend === 'workspace') {
        expect(host).toHaveBeenCalledOnce(); expect(grants).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'text', sha256: createHash('sha256').update(payload).digest('hex') })
      } else {
        expect(host).not.toHaveBeenCalled(); expect(grants).toHaveBeenCalledOnce()
        expect(result).toMatchObject({ encoding: 'utf-8', sizeBytes: Buffer.byteLength(payload) })
        expect(result).not.toHaveProperty('sha256')
      }
      expect(mocks.utilityFork).not.toHaveBeenCalled()
      expect(request.messages).toEqual([{ role: 'user', content: 'Read the intended local fixture.' }])
    }
  )
})
