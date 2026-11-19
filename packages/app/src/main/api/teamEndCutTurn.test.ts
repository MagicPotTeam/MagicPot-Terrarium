import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), launch: vi.fn(), script: vi.fn(), assertActive: vi.fn(), disposals: [] as unknown[] }))
// Pass-through: records how each turn disposes its canvas tools (true, false or 'ended').
vi.mock(import('./canvasAgentTools'), async original => {
  const actual = await original()
  const prepare = ((...input: Parameters<typeof actual.prepareCanvasAgentTools>) => {
    const prepared = actual.prepareCanvasAgentTools(...input)
    return prepared.dispose ? { ...prepared, dispose: (outcome?: boolean | 'ended') => { mocks.disposals.push(outcome); prepared.dispose!(outcome) } } : prepared
  }) as typeof actual.prepareCanvasAgentTools
  return { ...actual, prepareCanvasAgentTools: prepare }
})
vi.mock('electron', () => ({ net: {}, webContents: { fromId: mocks.fromId }, BrowserWindow: { fromWebContents: mocks.parent } }))
vi.mock('./agentThreadHtmlRuntime', () => ({ getAgentThreadHtmlRuntime: async () => ({ launch: mocks.launch, assertReady: () => undefined }) }))
vi.mock('./agentThreadHtmlProcess', () => ({ openHtmlProcess: mocks.launch }))
// The OS process host is replaced: python.background starts an inert in-memory process.
vi.mock('./agentThreadScriptHost', () => ({ executeAgentThreadScript: mocks.script }))
vi.mock('./teamEndStore', () => ({ getTeamEndStore: () => ({ assertActive: mocks.assertActive }), assertTeamRequestActive: (req: { teamMember?: unknown }) => { if (Object.hasOwn(req, 'teamMember')) mocks.assertActive(req.teamMember) } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: mocks.listTools, callTool: mocks.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import type { LLMChatParams } from '@shared/llm/types'
import { getConfig } from '../config/config'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
import type { CommandJobRecord } from '../magicAgentPlatform2/toolHost'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { agentThreadHtmlApps } from './agentThreadHtmlApps'
import { agentThreadJobs } from './agentThreadJobs'
import { approveAgentNoteMutation } from './agentThreadNotes'
import { closeAgentThreadNotesStore, getAgentThreadNotesStore } from './agentThreadNotesStore'
import { agentThreadProcesses } from './agentThreadProcesses'
import type { ThreadScriptInvocation } from './agentThreadScriptTools'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

// Real local chat loop, canvas tools, background jobs, processes and HTML apps; model, OS host and End store stubbed.
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'end-cut-project', threadId: 'pane' } as const
const scope = { route, conversationId: 'member-chat' }, url = 'file:///D:/owned/app/index.html#/canvas?id=end-cut-project'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 93, frameUrl: url, senderUrl: url, isMainFrame: true })
const teamMember = { scope: 'team-scope', thread: 'pane', lead: 'lead-chat', member: 'member-chat' }
const ended = () => { throw new Error('Team has ended.') }
let sender: EventEmitter
beforeEach(() => {
  vi.clearAllMocks(); mocks.assertActive.mockReset(); mocks.script.mockReset(); mocks.disposals.length = 0
  sender = Object.assign(new EventEmitter(), { id: 93, isDestroyed: () => false, getURL: () => url })
  registerMagicAgentTrustedRouteBinding(93, route, { trustedUrl: url, trustedWebContents: sender as never })
  mocks.fromId.mockReturnValue(sender); mocks.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  const config = structuredClone(DEFAULT_CONFIG)
  config.project_trace_config.enable_agent_html_apps = true
  config.project_trace_config.enable_agent_python_notebook = true
  config.llm_config.api_profiles = [{ id: 'member-profile', provider: 'openai', deployment: 'local', call_type: 'api', model_use: 'chat', api_mode: 'chat-completions', model_name: 'Member Model', base_url: 'https://example.invalid/v1', api_key: 'not-used' }]
  vi.mocked(getConfig).mockReturnValue(config); mocks.listTools.mockReturnValue([])
  // Like the real runtime, an explicit /tool call gets its own run identity when the caller has none.
  mocks.callTool.mockImplementation((r, name, args, options) => options.toolProvider.callTool(name, args, { route: r, runId: options.runId ?? 'explicit-run', toolCallId: options.toolCallId ?? 'explicit-call', signal: options.signal, workspaceRootDir: process.cwd() }))
  mocks.launch.mockImplementation(async (_doc, options) => ({ closed: false, update: vi.fn(), close: vi.fn(async () => { options.onClosed(true); return { confirmed: true } }) }))
})
afterEach(async () => {
  agentThreadJobs.dispose(); await agentThreadProcesses.dispose(); await agentThreadHtmlApps.dispose()
  await closeAgentThreadNotesStore(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks()
})

type Step = (params: LLMChatParams) => Promise<unknown>
/** The fake model: sub-agent children answer with a report, the parent follows the given steps. */
function model(parentSteps: Step[], report = 'Background report: the plan holds.') {
  const parent = vi.fn<Step>()
  const chat = vi.fn(async (params: LLMChatParams) => String(params.conversationId).startsWith('subagent-') ? { content: report } : parent(params))
  for (const step of parentSteps) parent.mockImplementationOnce(step)
  vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true, supportsIsolatedReadOnlyTurns: true } as never)
  return { chat, parent }
}
const toolCall = (params: LLMChatParams, name: string, args: Record<string, unknown>, id: string) => {
  const index = (params.tools || []).findIndex(tool => tool.name === name)
  expect(index).toBeGreaterThanOrEqual(0)
  return { content: '', toolCalls: [{ id, name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(args) }] }
}
const jobs = () => agentThreadJobs.list(scope, invoke('listAgentJobs'))
const report = (jobId: string) => agentThreadJobs.read({ ...scope, jobId }, invoke('readAgentJob'))
const request = (extra: Record<string, unknown> = {}) => ({ ...scope, profileId: 'member-profile', messages: [{ role: 'user' as const, content: 'Review the plan in the background' }], teamMember, ...extra })

/** Step 1 starts a background critic; step 2 waits for its report, then `cut` decides how the turn ends. */
async function runWithCompletedJob(method: 'chat' | 'chatStream', cut: (params: LLMChatParams) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const { chat } = model([
    async params => toolCall(params, 'critic', { task: 'Review the plan', run_in_background: true }, 'start-job'),
    async params => {
      await vi.waitFor(() => expect(jobs()[0]?.status).toBe('completed'))
      return cut(params)
    }
  ])
  const service = new LLMProxySvcImpl(), onData = vi.fn()
  const outcome = method === 'chat'
    ? await service.chat(request(extra), invoke('chat')).then(() => 'resolved', (error: Error) => error.message)
    : await service.chatStream(request(extra), { onData }, invoke('chatStream')).then(() => onData.mock.calls.map(([frame]) => frame).find(frame => frame.type === 'error')?.error ?? 'no error frame')
  return { outcome, chat, jobId: jobs()[0]?.id }
}

describe('a member turn cut by End keeps what it already started or finished', () => {
  it.each(['chat', 'chatStream'] as const)('keeps a completed background report when End cuts the turn before its next tool call (%s)', async method => {
    const { outcome, chat, jobId } = await runWithCompletedJob(method, async params => {
      mocks.assertActive.mockImplementation(ended) // End is recorded while step 2 is in flight
      return toolCall(params, 'critic', { task: 'Second look' }, 'after-end')
    })
    expect(outcome).toBe('Team has ended.')
    expect(chat.mock.calls.filter(([params]) => params.conversationId === scope.conversationId)).toHaveLength(2)
    expect(report(jobId!)).toMatchObject({ job: { status: 'completed' }, text: expect.stringContaining('Background report: the plan holds.') })
  })
  it.each(['chat', 'chatStream'] as const)('keeps a completed background report when a helper of the turn is the one that meets End (%s)', async method => {
    const dispatch = mocks.callTool.getMockImplementation()!
    mocks.callTool.mockImplementation((r, name, args, options) => {
      // End is recorded after the parent admitted the foreground sub-agent call, before its first step.
      if (name === 'explore') mocks.assertActive.mockImplementation(ended)
      return dispatch(r, name, args, options)
    })
    const { outcome, chat, jobId } = await runWithCompletedJob(method, async params => toolCall(params, 'explore', { task: 'Look closer' }, 'foreground'))
    expect(outcome).toBe('Team has ended.')
    expect(chat.mock.calls.filter(([params]) => String(params.conversationId).startsWith('subagent-'))).toHaveLength(1) // only the job's step
    expect(report(jobId!)).toMatchObject({ job: { status: 'completed' }, text: expect.stringContaining('Background report: the plan holds.') })
  })
  it('keeps a completed background report when End refuses the capacity retry of the next step', async () => {
    const { outcome, jobId } = await runWithCompletedJob('chat', async params => {
      mocks.assertActive.mockImplementation(ended)
      params.onDelta?.({ type: 'retry', retry: { attempt: 1, delayMs: 2000, nextRetryAt: 1, reason: 'rate-limited' } })
      return 'not reached'
    })
    expect(outcome).toBe('Team has ended.')
    expect(report(jobId!)).toMatchObject({ job: { status: 'completed' }, text: expect.stringContaining('Background report: the plan holds.') })
  })
  it.each(['chat', 'chatStream'] as const)('keeps a completed background report when send_message meets End in its own check (%s)', async method => {
    const dispatch = mocks.callTool.getMockImplementation()!
    mocks.callTool.mockImplementation((r, name, args, options) => {
      // End is recorded after the batch check admitted send_message, before the tool's own End check.
      if (name === 'send_message') mocks.assertActive.mockImplementation(ended)
      return dispatch(r, name, args, options)
    })
    const { outcome, jobId } = await runWithCompletedJob(method, async params => toolCall(params, 'send_message', { recipient: 'member-x', text: 'hi' }, 'message'))
    expect(outcome).toBe('Team has ended.')
    expect(mocks.disposals).toEqual(['ended'])
    expect(report(jobId!)).toMatchObject({ job: { status: 'completed' }, text: expect.stringContaining('Background report: the plan holds.') })
  })
  it('still revokes the completed report when the turn fails with a provider error carrying the same text', async () => {
    const { outcome, jobId } = await runWithCompletedJob('chat', async () => { throw new Error('Team has ended.') })
    expect(mocks.assertActive.mock.results.every(result => result.type === 'return')).toBe(true) // the store never refused
    expect(outcome).toBe('Team has ended.')
    expect(report(jobId!)).toMatchObject({ job: { status: 'cancelled' }, text: '' })
  })
  it('disposes a turn the user stops as failed (not as an End cut), even when End is recorded too', async () => {
    const service = new LLMProxySvcImpl(), controller = new AbortController()
    model([
      async params => toolCall(params, 'critic', { task: 'Review the plan', run_in_background: true }, 'start-job'),
      async params => {
        await vi.waitFor(() => expect(jobs()[0]?.status).toBe('completed'))
        controller.abort(new DOMException('Stopped by the user.', 'AbortError'))
        mocks.assertActive.mockImplementation(ended)
        return toolCall(params, 'critic', { task: 'Second look' }, 'after-stop')
      }
    ])
    await expect(service.chat(request(), { ...invoke('chat'), signal: controller.signal })).rejects.toThrow()
    // Stop's parent-abort listener revokes the job by itself; only the disposal shows how the turn was classified.
    expect(mocks.disposals).toEqual([false])
    expect(report(jobs()[0].id)).toMatchObject({ job: { status: 'cancelled' }, text: '' })
  })

  function inertProcess() {
    let record: CommandJobRecord = { jobId: 'inert-process', routeKey: JSON.stringify(route), sessionId: scope.conversationId, command: 'python', args: [], cwd: process.cwd(), createdAt: 1, state: 'running', outcome: 'unknown', stdoutBytes: 0, stderrBytes: 0, logsTruncated: false }
    const signals: AbortSignal[] = []
    mocks.script.mockImplementation(async (call: ThreadScriptInvocation) => {
      signals.push(call.signal)
      const control = { jobId: record.jobId, status: () => ({ ...record }), read: () => ({ data: '', nextCursor: 0, eof: false, truncated: false }), stop: async () => { record = { ...record, state: 'stopped', outcome: 'known' }; return record } }
      call.onOwned?.(control); call.onStarted?.(control)
      await new Promise(resolve => call.signal.addEventListener('abort', resolve, { once: true }))
      await control.stop()
      return {}
    })
    return signals
  }
  it.each([
    ['End before the next tool call', 'batch'],
    ['End while the tool runs, before the next step', 'step'],
    ['provider failure', 'provider']
  ] as const)('a background process started by the turn survives only an End cut (%s)', async (_label, cut) => {
    const signals = inertProcess()
    const endCut = cut !== 'provider'
    if (cut === 'step') {
      const dispatch = mocks.callTool.getMockImplementation()!
      mocks.callTool.mockImplementation(async (r, name, args, options) => {
        const result = await dispatch(r, name, args, options)
        mocks.assertActive.mockImplementation(ended)
        return result
      })
    }
    model([
      async params => toolCall(params, 'python.background', { code: 'print(1)' }, 'start-process'),
      async params => {
        if (!endCut) throw new Error('provider failed')
        mocks.assertActive.mockImplementation(ended)
        return toolCall(params, 'process.list', {}, 'after-end')
      }
    ])
    await expect(new LLMProxySvcImpl().chat(request(), invoke('chat'))).rejects.toThrow(endCut ? 'Team has ended.' : 'provider failed')
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(!endCut)
    const [job] = agentThreadProcesses.list(scope, invoke('listAgentProcesses'), 'listAgentProcesses')
    expect(job.status).toBe(endCut ? 'running' : 'stopped')
  })
  it.each([
    ['End cut', true],
    ['provider failure', false]
  ] as const)('an HTML app prepared by the turn stays ready only after an End cut (%s)', async (_label, endCut) => {
    model([
      async params => toolCall(params, 'show_app', { title: 'Plan', html: '<p>plan</p>' }, 'prepare-app'),
      async params => {
        if (!endCut) throw new Error('provider failed')
        mocks.assertActive.mockImplementation(ended)
        return toolCall(params, 'info', {}, 'after-end')
      }
    ])
    const service = new LLMProxySvcImpl()
    await expect(service.chat(request(), invoke('chat'))).rejects.toThrow(endCut ? 'Team has ended.' : 'provider failed')
    const items = await service.listAgentHtmlApps(scope, invoke('listAgentHtmlApps'))
    expect(items.apps).toHaveLength(1)
    expect(items.apps[0].status).toBe(endCut ? 'ready' : 'closed')
  })
})

describe('a member tool that waits for approval when End is recorded', () => {
  const policy = () => getAssistantTerminalPolicyRuntime()
  async function approveWhenPending(beforeApproval: () => void) {
    await vi.waitFor(() => expect(policy().listPendingTerminalApprovals()).toHaveLength(1))
    beforeApproval()
    const item = policy().listPendingTerminalApprovals()[0]
    policy().resolvePendingTerminalApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true })
  }
  const note = { action: 'set', key: 'plan', value: 'APPROVED_NOTE', expectedRevision: 0 }
  it('does not start the tool the user approves after End, and keeps the turn\'s finished job report', async () => {
    model([
      async params => toolCall(params, 'critic', { task: 'Review the plan', run_in_background: true }, 'start-job'),
      async params => {
        await vi.waitFor(() => expect(jobs()[0]?.status).toBe('completed'))
        return toolCall(params, 'scratchpad', note, 'write-note')
      },
      async () => 'not reached'
    ])
    const turn = new LLMProxySvcImpl().chat(request(), invoke('chat')).then(() => 'resolved', (error: Error) => error.message)
    await approveWhenPending(() => mocks.assertActive.mockImplementation(ended))
    expect(await turn).toBe('Team has ended.')
    expect((await getAgentThreadNotesStore()).get(scope)).toEqual({ revision: 0, notes: [] })
    expect(report(jobs()[0].id)).toMatchObject({ job: { status: 'completed' }, text: expect.stringContaining('Background report: the plan holds.') })
  })
  it('does not start an explicit /tool command the user approves after End', async () => {
    const { chat } = model([])
    const command = request({ messages: [{ role: 'user' as const, content: `/tool scratchpad ${JSON.stringify(note)}` }] })
    const turn = new LLMProxySvcImpl().chat(command, invoke('chat')).then(() => 'resolved', (error: Error) => error.message)
    await approveWhenPending(() => mocks.assertActive.mockImplementation(ended))
    expect(await turn).toBe('Team has ended.')
    expect((await getAgentThreadNotesStore()).get(scope)).toEqual({ revision: 0, notes: [] })
    expect(chat).not.toHaveBeenCalled()
  })
  it.each([
    ['an active team', true],
    ['a request without teamMember (the End store is never read)', false]
  ] as const)('honours the approval exactly as before for %s', async (_label, member) => {
    const { parent } = model([
      async params => toolCall(params, 'scratchpad', note, 'write-note'),
      async () => 'Noted.'
    ])
    const { teamMember: _team, ...ordinary } = request()
    const turn = new LLMProxySvcImpl().chat(member ? request() : ordinary, invoke('chat'))
    await approveWhenPending(() => { if (!member) mocks.assertActive.mockImplementation(ended) })
    expect((await turn).content).toBe('Noted.')
    expect((await getAgentThreadNotesStore()).get(scope)).toMatchObject({ revision: 1, notes: [{ key: 'plan', value: 'APPROVED_NOTE' }] })
    expect(parent).toHaveBeenCalledTimes(2)
    if (!member) expect(mocks.assertActive).not.toHaveBeenCalled()
  })
})

describe('an approval refused by End inside a wrapped tool still counts as an End cut', () => {
  const policy = () => getAssistantTerminalPolicyRuntime()
  /** An inert in-memory process that runs until its signal aborts. */
  const inertStart = (signals: AbortSignal[]) => async (call: ThreadScriptInvocation) => {
    signals.push(call.signal)
    let record: CommandJobRecord = { jobId: 'inert-' + signals.length, routeKey: JSON.stringify(route), sessionId: scope.conversationId, command: 'python', args: [], cwd: process.cwd(), createdAt: 1, state: 'running', outcome: 'unknown', stdoutBytes: 0, stderrBytes: 0, logsTruncated: false }
    const control = { jobId: record.jobId, status: () => ({ ...record }), read: () => ({ data: '', nextCursor: 0, eof: false, truncated: false }), stop: async () => { record = { ...record, state: 'stopped', outcome: 'known' }; return record } }
    call.onOwned?.(control); call.onStarted?.(control)
    await new Promise(resolve => call.signal.addEventListener('abort', resolve, { once: true }))
    await control.stop()
    return {}
  }
  it.each([
    ['python.background', { code: 'print(2)' }],
    ['asset.import', { path: 'x.png' }],
    ['comfyui.workflow.submit', { workflow: { '1': { class_type: 'SaveImage', inputs: {} } } }]
  ] as const)('%s approved after End: not started, the turn ends with "Team has ended." and keeps its work', async (tool, args) => {
    const signals: AbortSignal[] = []
    let refusedStart = false
    const earlierProcess = tool !== 'python.background' // one background process per conversation at a time
    if (earlierProcess) mocks.script.mockImplementationOnce(inertStart(signals))
    else mocks.script.mockImplementationOnce(async (call: ThreadScriptInvocation) => {
      // Like the real script host: formal approval first, then the OS start.
      await approveAgentNoteMutation({ route, conversationId: scope.conversationId, action: 'set', key: 'process', value: 'start', expectedRevision: 0, operationId: 'process-start' }, call.signal)
      refusedStart = true
      return inertStart(signals)(call)
    })
    model([
      async params => toolCall(params, 'critic', { task: 'Review the plan', run_in_background: true }, 'start-job'),
      async params => toolCall(params, 'show_app', { title: 'Plan', html: '<p>plan</p>' }, 'prepare-app'),
      ...(earlierProcess ? [async (params: LLMChatParams) => toolCall(params, 'python.background', { code: 'print(1)' }, 'earlier-process')] : []),
      async params => {
        await vi.waitFor(() => expect(jobs()[0]?.status).toBe('completed'))
        return toolCall(params, tool, args, 'needs-approval')
      },
      async () => 'not reached'
    ])
    const service = new LLMProxySvcImpl()
    const turn = service.chat(request(), invoke('chat')).then(() => 'resolved', (error: Error) => error.message)
    await vi.waitFor(() => expect(policy().listPendingTerminalApprovals()).toHaveLength(1), { timeout: 8000 })
    mocks.assertActive.mockImplementation(ended) // End is recorded while the approval card is open
    const item = policy().listPendingTerminalApprovals()[0]
    policy().resolvePendingTerminalApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved: true })
    expect(await turn).toBe('Team has ended.')
    expect(refusedStart).toBe(false)
    expect(report(jobs()[0].id)).toMatchObject({ job: { status: 'completed' }, text: expect.stringContaining('Background report: the plan holds.') })
    expect((await service.listAgentHtmlApps(scope, invoke('listAgentHtmlApps'))).apps.map(app => app.status)).toEqual(['ready'])
    if (earlierProcess) {
      expect(signals).toHaveLength(1)
      expect(signals[0].aborted).toBe(false)
      expect(agentThreadProcesses.list(scope, invoke('listAgentProcesses'), 'listAgentProcesses').map(job => job.status)).toEqual(['running'])
    } else expect(signals).toHaveLength(0)
  })
  it.each(['chat', 'chatStream'] as const)('does not count a background job\'s End refusal as a cut of a turn that fails for another reason (%s)', async method => {
    const signals: AbortSignal[] = []
    mocks.script.mockImplementationOnce(inertStart(signals))
    // The background child gets one read tool, so its next read passes its own End check first.
    const readTool = { name: 'files.read', description: 'Read text', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } }
    mocks.listTools.mockImplementation((names?: string[]) => names?.includes('files.read') ? [readTool] : [])
    let releaseChild!: (value: unknown) => void
    const childStep = new Promise(resolve => { releaseChild = resolve })
    const parent = vi.fn<Step>()
    parent.mockImplementationOnce(async params => toolCall(params, 'python.background', { code: 'print(1)' }, 'earlier-process'))
      .mockImplementationOnce(async params => toolCall(params, 'explore', { task: 'Investigate', run_in_background: true }, 'start-job'))
      .mockImplementationOnce(async () => {
        // End is recorded; the background job meets it at its next read and fails; then this step fails on its own.
        mocks.assertActive.mockImplementation(ended)
        releaseChild({ content: '', toolCalls: [{ id: 'child-read', name: 'files.read', wireName: 'mp_tool_0', arguments: JSON.stringify({ path: 'readme.md' }) }] })
        await vi.waitFor(() => expect(jobs()[0]?.status).toBe('failed'))
        throw new Error('provider failed')
      })
    const chat = vi.fn(async (params: LLMChatParams) => String(params.conversationId).startsWith('subagent-') ? childStep : parent(params))
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true, supportsIsolatedReadOnlyTurns: true } as never)
    const onData = vi.fn()
    if (method === 'chat') await expect(new LLMProxySvcImpl().chat(request(), invoke('chat'))).rejects.toThrow('provider failed')
    else {
      await new LLMProxySvcImpl().chatStream(request(), { onData }, invoke('chatStream'))
      expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', error: 'provider failed' }))
    }
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true) // disposed as a failed turn: its process is stopped, as before
  })
})
