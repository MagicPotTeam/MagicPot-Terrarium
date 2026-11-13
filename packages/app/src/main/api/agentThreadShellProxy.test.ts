import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const mocks = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn() }))
vi.mock('electron', () => ({ net: {}, webContents: { fromId: mocks.fromId }, BrowserWindow: { fromWebContents: mocks.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock(import('../config/config'), () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async (original) => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: mocks.listTools, callTool: mocks.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { getAssistantTerminalPolicyRuntime, closeAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import { agentThreadProcesses } from './agentThreadProcesses'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
afterEach(async () => { await agentThreadProcesses.dispose(); vi.restoreAllMocks(); vi.clearAllMocks(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest() })
describe('real filesystem shell proxy integration', () => {
  it.skipIf(!process.env.MAGICPOT_TEST_SHELL || !process.env.MAGICPOT_TEST_PYTHON).each([
    ['python', 'chat', false, 'success'], ['python', 'chat', true, 'success'], ['python', 'chatStream', false, 'success'], ['python', 'chatStream', true, 'success'],
    ['shell', 'chat', false, 'success'], ['shell', 'chat', true, 'success'], ['shell', 'chatStream', false, 'success'], ['shell', 'chatStream', true, 'success'],
    ['python', 'chat', false, 'truncated'], ['shell', 'chatStream', true, 'truncated'],
    ['python', 'chatStream', true, 'error'], ['shell', 'chat', false, 'error'],
    ['python', 'chat', true, 'stop'], ['shell', 'chatStream', false, 'stop'],
    ['python', 'chatStream', false, 'disable'], ['shell', 'chat', true, 'disable']
  ] as const)('starts an approved %s background process via %s (native=%s, ending=%s) with owned lifecycle', async (kind, method, native, ending) => {
    const root = await createNodeTestArtifactDir('proxy-background')
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'background-project', threadId: 'pane' } as const
    const scope = { route, conversationId: 'background-chat' }, url = 'file:///D:/owned/app/index.html#/canvas?id=background-project'
    const sender = Object.assign(new EventEmitter(), { id: 89, isDestroyed: () => false, getURL: () => url })
    registerMagicAgentTrustedRouteBinding(89, route, { trustedUrl: url, trustedWebContents: sender })
    mocks.fromId.mockReturnValue(sender); mocks.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
    const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 89, frameUrl: url, senderUrl: url, isMainFrame: true })
    const service = new LLMProxySvcImpl()
    try {
      const config = structuredClone(DEFAULT_CONFIG)
      config.llm_config.api_profiles = [{ id: 'agent-profile', model_name: 'Agent Model', base_url: 'https://model.example/v1', api_key: 'not-used' }]
      config.local_comfyui_config.python_cmd = process.env.MAGICPOT_TEST_PYTHON!
      config.project_trace_config = { ...config.project_trace_config, enable_agent_python_notebook: true, enable_agent_shell: true, agent_shell_executable: process.env.MAGICPOT_TEST_SHELL!, agent_shell_kind: process.env.MAGICPOT_TEST_SHELL_KIND === 'bash' ? 'bash' : 'powershell' }
      vi.mocked(getConfig).mockReturnValue(config); mocks.listTools.mockReturnValue([])
      let processError: unknown, jobId = ''
      mocks.callTool.mockImplementation(async (r, name, args, options) => {
        try {
          const output = await options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal, workspaceRootDir: root })
          if (name.endsWith('.background')) jobId = JSON.parse(output.content).job.id
          return output
        } catch (error) { processError = error; throw error }
      })
      const seconds = ending === 'success' ? 0.8 : 8
      const code = kind === 'python' ? `import time;time.sleep(${seconds});print("BACKGROUND_ACTUAL_RESULT")` : process.env.MAGICPOT_TEST_SHELL_KIND === 'bash' ? `sleep ${seconds}; printf "BACKGROUND_ACTUAL_RESULT\\n"` : `Start-Sleep -Milliseconds ${seconds * 1000}; [Console]::WriteLine("BACKGROUND_ACTUAL_RESULT")`
      const chat = vi.fn().mockImplementation(async (input) => {
        if (chat.mock.calls.length === 2) {
          expect(JSON.stringify(native ? input.toolTurns : input.messages)).toContain('submittedOnly')
          if (ending === 'truncated') return { content: 'Partial reply', finishReason: 'length' }
          if (ending === 'error') throw new Error('Test parent failed after process start')
          return 'Approved process started; completion still pending.'
        }
        const name = `${kind}.background`, args = { code, timeoutMs: 10000 }
        if (!native) return JSON.stringify({ toolName: name, args })
        const index = input.tools.findIndex((tool: { name: string }) => tool.name === name)
        expect(index).toBeGreaterThanOrEqual(0)
        return { content: '', toolCalls: [{ id: 'background-native', name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
      })
      vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
      const req = { ...scope, cancellationId: 'owned-parent', profileId: 'agent-profile', messages: [{ role: 'user' as const, content: 'Start the reviewed background check' }] }, onData = vi.fn()
      const pending = (method === 'chat' ? service.chat(req, invoke(method)) : service.chatStream(req, { onData }, invoke(method))).catch((error) => error)
      const policy = getAssistantTerminalPolicyRuntime()
      await vi.waitFor(() => { if (processError) throw processError; expect(policy.listPendingTerminalApprovals()).toHaveLength(1) })
      expect(jobId).toBe('')
      expect((await service.listAgentProcesses(scope, invoke('listAgentProcesses'))).jobs[0].status).toBe('preparing')
      const approval = policy.listPendingTerminalApprovals()[0]
      expect(approval.request.request.input).toMatchObject({ code, background: true, survivesSuccessfulParentOnly: true })
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
      const response = await pending
      if (ending === 'success' || ending === 'stop' || ending === 'disable') {
        if (method === 'chat') expect(response).toMatchObject({ content: expect.stringContaining('started') })
        else expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: expect.stringContaining('started') }))
      } else if (ending === 'truncated' && method === 'chat') expect(response).toMatchObject({ content: 'Partial reply' })
      else if (ending === 'error' && method === 'chat') expect(response).toBeInstanceOf(Error)
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/)
      if (ending === 'success' || ending === 'stop' || ending === 'disable') {
        expect((await service.listAgentProcesses(scope, invoke('listAgentProcesses'))).jobs[0].operationSettled).toBe(false)
        expect(sender.listenerCount('did-start-navigation')).toBe(1)
      }
      if (ending === 'stop') {
        const stopped = await service.stopAgentProcess({ ...scope, jobId }, invoke('stopAgentProcess'))
        expect(stopped.job, JSON.stringify(stopped.job)).toMatchObject({ status: 'stopped', outcome: 'known', operationSettled: true })
      }
      if (ending === 'disable') {
        config.project_trace_config.enable_agent_python_notebook = false
        config.project_trace_config.enable_agent_shell = false
      }
      await vi.waitFor(async () => {
        const current = (await service.listAgentProcesses(scope, invoke('listAgentProcesses'))).jobs[0]
        expect(current, JSON.stringify(current)).toMatchObject({ status: ending === 'success' ? 'completed' : 'stopped', operationSettled: true, outcome: 'known' })
      }, { timeout: 10000 })
      const logs = await service.readAgentProcess({ ...scope, jobId, stream: 'stdout' }, invoke('readAgentProcess'))
      if (ending === 'success') expect(logs.data).toContain('BACKGROUND_ACTUAL_RESULT')
      else expect(logs.data).not.toContain('BACKGROUND_ACTUAL_RESULT')
      expect(chat).toHaveBeenCalledTimes(2)
      sender.emit('did-start-navigation'); expect((await service.listAgentProcesses(scope, invoke('listAgentProcesses'))).jobs).toEqual([])
    } finally { await agentThreadProcesses.dispose(); await service.cancelConversation({ conversationId: scope.conversationId }, invoke('cancelConversation')); await fs.rm(root, { recursive: true, force: true }) }
  }, 30000)

  it.skipIf(!process.env.MAGICPOT_TEST_SHELL).each([['chat', false], ['chat', true], ['chatStream', false], ['chatStream', true]] as const)(
    'runs an approved real shell via %s (native=%s) without implicitly granting Python or MCP', async (method, native) => {
      const root = await createNodeTestArtifactDir('proxy-shell')
      const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'shell-project', threadId: 'pane' } as const
      const url = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=shell-project'
      const sender = Object.assign(new EventEmitter(), { id: 88, isDestroyed: () => false, getURL: () => url })
      registerMagicAgentTrustedRouteBinding(88, route, { trustedUrl: url, trustedWebContents: sender })
      mocks.fromId.mockReturnValue(sender); mocks.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
      const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 88, frameUrl: url, senderUrl: url, isMainFrame: true })
      const service = new LLMProxySvcImpl()
      try {
        const config = structuredClone(DEFAULT_CONFIG)
        config.llm_config.api_profiles = [{ id: 'agent-profile', model_name: 'Agent Model', base_url: 'https://model.example/v1', api_key: 'not-used' }]
        config.project_trace_config = { ...DEFAULT_CONFIG.project_trace_config, enable_agent_shell: true, agent_shell_executable: process.env.MAGICPOT_TEST_SHELL!, agent_shell_kind: process.env.MAGICPOT_TEST_SHELL_KIND === 'bash' ? 'bash' : 'powershell' }
        vi.mocked(getConfig).mockReturnValue(config); mocks.listTools.mockReturnValue([])
        let shellError: unknown
        mocks.callTool.mockImplementation(async (r, name, args, options) => {
          try { return await options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal, workspaceRootDir: root }) }
          catch (error) { shellError = error; throw error }
        })
        const code = process.env.MAGICPOT_TEST_SHELL_KIND === 'bash' ? 'printf "APPROVED_SHELL_PROXY_RESULT\\n"' : '[Console]::WriteLine("APPROVED_SHELL_PROXY_RESULT")'
        const chat = vi.fn().mockImplementation(async (input) => {
          if (chat.mock.calls.length === 2) {
            expect(JSON.stringify(native ? input.toolTurns : input.messages)).toContain('APPROVED_SHELL_PROXY_RESULT')
            expect(JSON.stringify(native ? input.toolTurns : input.messages)).toContain('businessTaskVerified')
            return 'The approved process returned zero and produced the expected marker.'
          }
          const name = 'shell.execute', args = { code, timeoutMs: 10000 }
          if (!native) return JSON.stringify({ toolName: name, args })
          expect(input.tools.some((tool: { name: string }) => tool.name === 'python.execute' || tool.name === 'mcp_connect')).toBe(false)
          const index = input.tools.findIndex((tool: { name: string }) => tool.name === name)
          expect(index).toBeGreaterThanOrEqual(0)
          return { content: '', toolCalls: [{ id: 'shell-native', name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
        })
        vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
        const req = { route, conversationId: 'shell-chat', profileId: 'agent-profile', messages: [{ role: 'user' as const, content: 'Run the reviewed shell check.' }] }, onData = vi.fn()
        const pending = (method === 'chat' ? service.chat(req, invoke(method)) : service.chatStream(req, { onData }, invoke(method))).catch((error) => error)
        const policy = getAssistantTerminalPolicyRuntime()
        await vi.waitFor(() => { if (shellError) throw shellError; expect(policy.listPendingTerminalApprovals()).toHaveLength(1) })
        expect(chat).toHaveBeenCalledOnce()
        const approval = policy.listPendingTerminalApprovals()[0]
        expect(approval.request.request.input).toMatchObject({ code, explicitShell: true, filesystemNetworkSandbox: false })
        policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
        const result = await pending
        if (method === 'chat') expect(result).toMatchObject({ content: expect.stringContaining('approved process') })
        else expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: expect.stringContaining('approved process') }))
        expect(chat).toHaveBeenCalledTimes(2)
        expect(sender.listenerCount('did-start-navigation')).toBe(0)
      } finally { await service.cancelConversation({ conversationId: 'shell-chat' }, invoke('cancelConversation')); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); await fs.rm(root, { recursive: true, force: true }) }
    }, 30000
  )
})
