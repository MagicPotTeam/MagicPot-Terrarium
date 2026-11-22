import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), store: undefined as unknown, root: '' }))
vi.mock('electron', () => ({ net: {}, app: { getPath: () => h.root, getAppPath: () => process.cwd(), isReady: () => true }, utilityProcess: { fork: () => { throw new Error('Not used for passive text') } }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.root } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async (original) => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callPrivateSideRead: h.callTool }) }))
vi.mock('./agentThreadSideStore', async (original) => ({ ...(await original()), getAgentThreadSideStore: async () => h.store }))
import { AgentThreadSideStore } from './agentThreadSideStore'
import { agentThreadSides } from './agentThreadSides'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { cliFromProfile } from '@shared/llm'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { isCanvasApprovalToolInvocation } from './canvasAgentTools'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const url = 'file:///D:/app/index.html#/canvas?id=project', invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let store: AgentThreadSideStore, sender: EventEmitter & { id: number; isDestroyed(): boolean; getURL(): string }
beforeEach(async () => {
  vi.mocked(cliFromProfile).mockReset()
  h.root = await fs.realpath(mkdtempSync(path.join(tmpdir(), 'side-proxy-'))); store = new AgentThreadSideStore(sideTestCodec(), path.join(h.root, 'side.sqlite')); h.store = store
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url }); h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, scope.route, { trustedUrl: url, trustedWebContents: sender })
  const config = structuredClone(DEFAULT_CONFIG); config.llm_config.api_profiles = [{ id: 'profile', model_name: 'model', base_url: 'https://model.example/v1', api_key: 'TEST_KEY_NOT_SENT' }]; vi.mocked(getConfig).mockReturnValue(config)
  h.listTools.mockReturnValue([{ name: 'files.read', description: 'read', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } }])
})
afterEach(async () => { await agentThreadSides.dispose(); store.close(); rmSync(h.root, { recursive: true, force: true }); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); vi.clearAllMocks() })
describe('actual side service/reader/storage wiring', () => {
  it.each([false, true])('keeps side questions out of parent chat and reads actual files via trusted readonly admission (native=%s)', async (native) => {
    const file = path.join(h.root, 'evidence.txt'); writeFileSync(file, 'ACTUAL_SIDE_FILE_EVIDENCE')
    expect(await fs.realpath(file)).toBe(file)
    const service = new LLMProxySvcImpl(), parentChat = vi.spyOn(service, 'chat')
    let readError: unknown
    h.callTool.mockImplementation(async (route, name, args, options) => {
      try {
      expect(route).toMatchObject(scope.route); expect(name).toBe('files.read')
      expect(options).not.toHaveProperty('toolProvider')
      expect(isCanvasApprovalToolInvocation(scope.route, name)).toBe(true)
      expect(isCanvasApprovalToolInvocation(scope.route, 'files.write')).toBe(false)
      return await options.readExternalFile(args.path, options.signal)
      } catch (error) { readError = error; throw error }
    })
    const first = vi.fn().mockResolvedValueOnce(native ? { content: '', toolCalls: [{ id: 'file', name: 'files.read', wireName: 'mp_tool_0', arguments: JSON.stringify({ path: file }) }] } : { content: JSON.stringify({ toolName: 'files.read', args: { path: file } }) }).mockResolvedValueOnce({ content: 'PRIVATE_FIRST_ANSWER' })
    const second = vi.fn().mockResolvedValue({ content: 'PRIVATE_FOLLOWUP_ANSWER' })
    vi.mocked(cliFromProfile).mockReturnValueOnce({ chat: first, supportsIsolatedReadOnlyTurns: true, supportsNativeTools: native }).mockReturnValueOnce({ chat: second, supportsIsolatedReadOnlyTurns: true, supportsNativeTools: native })
    const req = { ...scope, branchId: randomUUID(), operationId: randomUUID(), question: 'PRIVATE_QUESTION', profileId: 'profile', snapshot: [{ role: 'user' as const, content: 'ORIGINAL_PARENT' }] }
    await service.startAgentSide(req, invoke('startAgentSide'))
    await vi.waitFor(async () => { if (readError) throw readError; expect((await service.listAgentSides(scope, invoke('listAgentSides'))).branches[0]).toMatchObject({ busy: false, status: 'completed' }) })
    const opened = await service.openAgentSide(req, invoke('openAgentSide'))
    expect(JSON.stringify(first.mock.calls[1][0])).toContain('ACTUAL_SIDE_FILE_EVIDENCE')
    expect(JSON.stringify(opened)).not.toContain('ORIGINAL_PARENT')
    await service.continueAgentSide({ ...scope, branchId: req.branchId, operationId: randomUUID(), expectedRevision: opened.branch.revision, question: 'FOLLOWUP' }, invoke('continueAgentSide'))
    await vi.waitFor(async () => expect((await service.listAgentSides(scope, invoke('listAgentSides'))).branches[0]).toMatchObject({ busy: false, turns: 2 }))
    expect(JSON.stringify(second.mock.calls[0][0].messages)).toContain('ACTUAL_SIDE_FILE_EVIDENCE')
    expect(JSON.stringify(second.mock.calls[0][0].messages)).toContain('PRIVATE_FIRST_ANSWER')
    expect(parentChat).not.toHaveBeenCalled(); expect(h.callTool).toHaveBeenCalledOnce()
    expect(readFileSync(path.join(h.root, 'side.sqlite')).toString('latin1')).not.toMatch(/PRIVATE_QUESTION|ORIGINAL_PARENT|ACTUAL_SIDE_FILE_EVIDENCE|TEST_KEY_NOT_SENT/)
  })
  it('refuses remote and unsupported OAuth profiles without launching parent or side model calls', async () => {
    const service = new LLMProxySvcImpl(), req = { ...scope, branchId: randomUUID(), operationId: randomUUID(), question: 'private', profileId: 'profile', snapshot: [] }
    vi.mocked(getConfig)().use_remote_llm = true
    await expect(service.startAgentSide(req, invoke('startAgentSide'))).rejects.toThrow('local desktop')
    vi.mocked(getConfig)().use_remote_llm = false
    vi.mocked(getConfig)().llm_config.api_profiles[0].auth_mode = 'codex_oauth'
    await expect(service.startAgentSide(req, invoke('startAgentSide'))).rejects.toThrow('does not support')
    expect(cliFromProfile).not.toHaveBeenCalled()
  })
})
