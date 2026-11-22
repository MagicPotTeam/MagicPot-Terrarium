import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ root: '', fromId: vi.fn(), parent: vi.fn(), sync: vi.fn(), audit: vi.fn(), permission: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { getPath: () => h.root, getAppPath: () => process.cwd(), isReady: () => true }, utilityProcess: { fork: () => { throw new Error('Passive text only') } }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.root } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock('../mcp/runtime', async (original) => ({ ...(await original()), syncMcpClientManager: h.sync }))
vi.mock('../mcp/platform/runtime', () => ({ refreshMagicPotMcpPlatformRuntime: vi.fn(), appendMagicPotMcpAudit: h.audit, authorizeMagicPotMcpToolInvocation: h.permission }))
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { getConfig } from '../config/config'
import { createScopedCanvasPathReadHandler } from './canvasPathReadApproval'
import { runSideReadAdmission } from './canvasAgentTools'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { closeAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'private-read-project', threadId: 'pane' } as const
const scope = { route, conversationId: 'chat' }, url = 'file:///D:/app/index.html#/canvas?id=private-read-project'
const invocation = { methodName: 'svcLLMProxy.startAgentSide', senderId: 72, isMainFrame: true, frameUrl: url, senderUrl: url }
let store: AssistantSessionStore
beforeEach(async () => {
  h.root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'private-read-')))
  const sender = Object.assign(new EventEmitter(), { id: 72, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender }); registerMagicAgentTrustedRouteBinding(72, route, { trustedUrl: url, trustedWebContents: sender })
  vi.mocked(getConfig).mockReturnValue(structuredClone(DEFAULT_CONFIG)); h.permission.mockReturnValue({ allowed: true, policyId: 'owned-test-policy' })
  store = new AssistantSessionStore(path.join(h.root, 'parent-sessions.json'))
})
afterEach(async () => { await store.flush(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); await fs.rm(h.root, { recursive: true, force: true }); vi.clearAllMocks() })
describe('private side real runtime read gateway', () => {
  it('uses actual bounded file reader without parent action journal or MCP transport sync', async () => {
    const runtime = new AssistantRuntime({ sessionStore: store, configProvider: getConfig, chatService: { chat: vi.fn() } })
    const file = path.join(h.root, 'private-name.txt'); await fs.writeFile(file, 'PRIVATE_READ_EVIDENCE')
    const reader = createScopedCanvasPathReadHandler(scope, invocation)!, signal = new AbortController().signal
    const result = await runSideReadAdmission(scope, invocation, 'files.read', signal, () => undefined, () => runtime.callPrivateSideRead(route, 'files.read', { path: file }, { signal, readExternalFile: reader }))
    expect(result.content).toContain('PRIVATE_READ_EVIDENCE'); expect(h.sync).not.toHaveBeenCalled()
    expect(h.permission).toHaveBeenCalledWith(expect.objectContaining({ target: 'chat.tool.files.read' }))
    expect(JSON.stringify(h.audit.mock.calls)).not.toMatch(/PRIVATE_READ_EVIDENCE|private-name/)
    expect((await store.getSession(route))?.eventLog || []).toEqual([])
    await store.flush()
    const parent = await fs.readFile(path.join(h.root, 'parent-sessions.json'), 'utf8').catch(() => '')
    expect(parent).not.toMatch(/PRIVATE_READ_EVIDENCE|private-name|tool.result/)
  })
  it('still refuses explicit platform denial and missing admission before invoking a reader', async () => {
    const runtime = new AssistantRuntime({ sessionStore: store, configProvider: getConfig, chatService: { chat: vi.fn() } }), reader = vi.fn(), signal = new AbortController().signal
    await expect(runtime.callPrivateSideRead(route, 'files.read', { path: 'x' }, { signal, readExternalFile: reader })).rejects.toThrow('admission')
    h.permission.mockReturnValue({ allowed: false, policyId: 'deny' })
    await expect(runSideReadAdmission(scope, invocation, 'files.read', signal, () => undefined, () => runtime.callPrivateSideRead(route, 'files.read', { path: 'x' }, { signal, readExternalFile: reader }))).rejects.toThrow('denied')
    await expect(runtime.callPrivateSideRead(route, 'files.write', {}, { signal, readExternalFile: reader })).rejects.toThrow('cannot invoke')
    expect(reader).not.toHaveBeenCalled(); expect(h.sync).not.toHaveBeenCalled()
  })
})
