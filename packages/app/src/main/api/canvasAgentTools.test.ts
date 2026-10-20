import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { prepareCanvasAgentTools, isCanvasApprovalToolInvocation } from './canvasAgentTools'
import {
  registerMagicAgentTrustedRouteBinding,
  clearMagicAgentTrustedRouteBindingsForTest
} from '../magicAgentRuntime/trustedRouteBinding'
import { authorizeMagicPotMcpToolInvocation } from '../mcp/platform/runtime'
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
        'agent.terminal.run'
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
    'image',
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
    if (kind === 'image') req.imageGenerationOptions = { enabled: true }
    if (kind === 'comparison') req.comparisonRouting = 'configured'
    expect(
      prepareCanvasAgentTools(req, kind === 'missing-sender' ? undefined : ctx, opts).admission
    ).toBeUndefined()
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
  it('checks renderer liveness again at execution time', async () => {
    trust()
    const p = prepareCanvasAgentTools(request(), invocation(), settings)
    clearMagicAgentTrustedRouteBindingsForTest()
    const fn = vi.fn(async () => 1)
    await expect(p.admission!.run('files.write', undefined, fn)).rejects.toThrow('not trusted')
    expect(fn).not.toHaveBeenCalled()
  })
})
