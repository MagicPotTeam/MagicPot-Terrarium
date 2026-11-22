import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { prepareCanvasAgentTools, isCanvasApprovalToolInvocation, CANVAS_WORKSPACE_READ_TOOL_NAMES, CANVAS_WRITE_TOOL_NAMES } from './canvasAgentTools'
import { CANVAS_CREATIVE_TOOL_NAMES } from './canvasCreativeTools'
import {
  registerMagicAgentTrustedRouteBinding,
  clearMagicAgentTrustedRouteBindingsForTest
} from '../magicAgentRuntime/trustedRouteBinding'
import { authorizeMagicPotMcpToolInvocation } from '../mcp/platform/runtime'
vi.mock('electron', () => ({ webContents: { fromId: () => undefined }, BrowserWindow: { fromWebContents: () => undefined } }))
vi.mock('../config/config', () => ({ getConfig: () => ({}) }))
vi.mock('../mcp/platform/managedHttpBridge', () => ({
  handleManagedMagicPotMcpHttpBridgeRequest: vi.fn()
}))
const url = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=owned-project'
const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'owned-project',
  threadId: 'pane-a'
} as const
const invocation = () => ({
  methodName: 'svcLLMProxy.chatStream',
  senderId: 83,
  frameUrl: url,
  senderUrl: url,
  isMainFrame: true
})
const request = (): LLMChatReq => ({
  route,
  conversationId: 'owned-chat',
  messages: [{ role: 'user', content: 'Write a file' }]
})
const settings = { local: true, terminalEnabled: true }
function trust() {
  registerMagicAgentTrustedRouteBinding(83, route, {
    trustedUrl: url,
    trustedWebContents: { id: 83, isDestroyed: () => false }
  })
}
const decision = (tool = 'files.write', r: typeof route = route) =>
  authorizeMagicPotMcpToolInvocation({
    actor: 'assistant:owned',
    action: 'tool.invoke',
    target: 'chat.tool.' + tool,
    metadata: { route: r }
  })
afterEach(clearMagicAgentTrustedRouteBindingsForTest)
describe('main-owned canvas approval admission', () => {
  it('exposes approval-backed tools only on an eligible local canvas request without mutating its input', () => {
    trust()
    const original = request()
    const before = JSON.stringify(original)
    const prepared = prepareCanvasAgentTools(original, invocation(), settings)
    expect(prepared.request.skillRuntime?.bindings?.[0]?.toolNames).toEqual(
      expect.arrayContaining([
        'files.read',
        'files.write',
        'files.edit',
        'files.json.write',
        'agent.terminal.run',
        'web_search',
        'web_fetch'
      ])
    )
    expect(prepared.request.systemPrompt).toContain('fresh user approval')
    expect(JSON.stringify(original)).toBe(before)
    expect(decision().allowed).toBe(false)
  })
  it.each([
    'remote',
    'missing-sender',
    'foreign-project',
    'iframe',
    'explicit-skill',
    'ordinary-chat',
    'external-agent',
    'image',
    'video',
    'comparison'
  ])('does not issue admission for %s', (kind) => {
    trust()
    const req = request()
    const ctx = invocation()
    const opts = { ...settings }
    if (kind === 'remote') opts.local = false
    if (kind === 'foreign-project') ctx.frameUrl = url.replace('owned-project', 'other-project')
    if (kind === 'iframe') ctx.isMainFrame = false
    if (kind === 'explicit-skill')
      req.skillRuntime = { bindings: [{ appId: 'restricted', toolNames: [] }] }
    if (kind === 'ordinary-chat') req.route = { ...route, channel: 'generic' }
    if (kind === 'external-agent') req.skillRuntime = { skillId: 'external-agent' }
    if (kind === 'image') req.imageGenerationOptions = { enabled: true }
    if (kind === 'video') req.videoGenerationOptions = {}
    if (kind === 'comparison') req.comparisonRouting = 'configured'
    const prepared = prepareCanvasAgentTools(req, kind === 'missing-sender' ? undefined : ctx, opts)
    expect(prepared.admission).toBeUndefined()
    expect(prepared.toolProvider).toBeUndefined()
  })
  it('keeps terminal disabled when the main-owned feature setting is off', async () => {
    trust()
    const p = prepareCanvasAgentTools(request(), invocation(), {
      ...settings,
      terminalEnabled: false
    })
    expect(p.request.skillRuntime?.bindings?.[0]?.toolNames).not.toContain('agent.terminal.run')
    await p.admission!.run('agent.terminal.run', undefined, async () => {
      expect(decision('agent.terminal.run').allowed).toBe(false)
    })
  })
  it('admits only the exact live invocation and thread, not a cloned request flag', async () => {
    trust()
    const p = prepareCanvasAgentTools(request(), invocation(), settings)
    const cloned = structuredClone(p.request) as LLMChatReq & { canvasToolAdmission?: unknown }
    cloned.canvasToolAdmission = { approved: true }
    expect(prepareCanvasAgentTools(cloned, undefined, settings).admission).toBeUndefined()
    await p.admission!.run('files.write', undefined, async () => {
      await Promise.resolve()
      expect(decision()).toEqual({
        allowed: true,
        policyId: 'magicpot-assistant-canvas-approval-required'
      })
      expect(decision('agent.terminal.run').allowed).toBe(false)
      expect(isCanvasApprovalToolInvocation({ ...route, threadId: 'pane-b' }, 'files.write')).toBe(
        false
      )
      expect(decision('workspace.attach').allowed).toBe(false)
    })
    expect(decision().allowed).toBe(false)
  })
  it('revokes scope on cancellation and completion, including inherited late async callbacks', async () => {
    trust()
    const p = prepareCanvasAgentTools(request(), invocation(), settings)
    const c = new AbortController()
    let release!: () => void
    let late!: Promise<boolean>
    await p.admission!.run('files.write', c.signal, async () => {
      late = new Promise<void>((r) => {
        release = r
      }).then(() => decision().allowed)
      expect(decision().allowed).toBe(true)
      c.abort()
      expect(decision().allowed).toBe(false)
    })
    release()
    expect(await late).toBe(false)
    const fn = vi.fn(async () => true)
    await expect(p.admission!.run('files.write', c.signal, fn)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(fn).not.toHaveBeenCalled()
  })
  it('isolates overlapping thread invocations and restores the outer context', async () => {
    trust()
    const a = prepareCanvasAgentTools(request(), invocation(), settings)
    const b = prepareCanvasAgentTools(
      { ...request(), route: { ...route, threadId: 'pane-b' } },
      invocation(),
      settings
    )
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const task = a.admission!.run('files.write', undefined, async () => {
      await gate
      expect(isCanvasApprovalToolInvocation(route, 'files.write')).toBe(true)
      expect(isCanvasApprovalToolInvocation({ ...route, threadId: 'pane-b' }, 'files.write')).toBe(
        false
      )
    })
    await b.admission!.run('files.edit', undefined, async () => {
      expect(isCanvasApprovalToolInvocation(route, 'files.write')).toBe(false)
      expect(isCanvasApprovalToolInvocation({ ...route, threadId: 'pane-b' }, 'files.edit')).toBe(
        true
      )
      release()
      await task
    })
    expect(decision().allowed).toBe(false)
  })
  it.each([...CANVAS_WORKSPACE_READ_TOOL_NAMES, ...CANVAS_WRITE_TOOL_NAMES])(
    'admits %s only in this trusted request and keeps the default policy closed', async (tool) => {
      trust()
      const p = prepareCanvasAgentTools(request(), invocation(), settings)
      expect(p.request.skillRuntime?.bindings?.[0]?.toolNames).toContain(tool)
      expect(decision(tool).allowed).toBe(false)
      await p.admission!.run(tool, undefined, async () => {
        expect(decision(tool).allowed).toBe(true)
        expect(isCanvasApprovalToolInvocation({ ...route, threadId: 'foreign' }, tool)).toBe(false)
      })
      expect(decision(tool).allowed).toBe(false)
    }
  )
  it('exposes a per-request business provider but no arbitrary terminal or MCP tool', async () => {
    trust()
    const p = prepareCanvasAgentTools(request(), invocation(), settings)
    const names = p.toolProvider!.listTools().map((tool) => tool.name)
    expect(names).toEqual([...CANVAS_CREATIVE_TOOL_NAMES])
    expect(names).not.toContain('terminal.run')
    expect(names).not.toContain('mcp.tool.call')
    const call = () => p.toolProvider!.callTool('comfyui.status', {}, { route, runId: 'run' })
    await expect(call()).rejects.toThrow('live Agent thread invocation')
    p.dispose!()
    await expect(p.admission!.run('comfyui.status', undefined, call)).rejects.toThrow('request has ended')
  })
  it('does not borrow admission from another request in the same thread', async () => {
    trust()
    const first = prepareCanvasAgentTools(request(), invocation(), settings)
    const second = prepareCanvasAgentTools(request(), invocation(), settings)
    await second.admission!.run('comfyui.status', undefined, async () => {
      await expect(first.toolProvider!.callTool('comfyui.status', {}, { route, runId: 'wrong-owner' })).rejects.toThrow('live Agent thread invocation')
    })
  })
  it('checks renderer liveness again at execution time', async () => {
    trust()
    const p = prepareCanvasAgentTools(request(), invocation(), settings)
    clearMagicAgentTrustedRouteBindingsForTest()
    const fn = vi.fn(async () => 1)
    await expect(p.admission!.run('files.write', undefined, fn)).rejects.toThrow('not trusted')
    expect(fn).not.toHaveBeenCalled()
  })
})
