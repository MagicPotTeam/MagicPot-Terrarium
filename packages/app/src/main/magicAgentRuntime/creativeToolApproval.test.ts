import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionKey, type AgentRouteLike } from '@shared/agent'
import { createGraphToolPolicyRequest } from '@shared/magicAgentPlatform2'
import {
  closeAssistantTerminalPolicyRuntime,
  getAssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
import { createMagicAgentCreativeToolRegistry } from './tools/registry'
import { invokeApprovedGraphTool, requestCreativeToolApproval } from './creativeToolApproval'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'studio-approval-test' } as const
const waitForApproval = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()[0]
    if (pending) return pending
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Expected a pending creative approval.')
}
const decide = (approval: Awaited<ReturnType<typeof waitForApproval>>, approved: boolean) =>
  getAssistantTerminalPolicyRuntime().resolvePendingTerminalApproval({
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    approved
  })

const harness = (signal?: AbortSignal, invocationRoute: AgentRouteLike = route) => {
  const imageCreate = vi.fn(async (_args: Record<string, unknown>) => ({
    status: 'submitted',
    taskId: 'task-1'
  }))
  const registry = createMagicAgentCreativeToolRegistry()
  return {
    imageCreate,
    invoke: (args: Record<string, unknown> = { workflow: { node: 'test' } }) =>
      registry.dispatch('image.create', args, {
        route: invocationRoute,
        signal,
        dependencies: { imageCreate },
        authorizeMutation: (request) =>
          requestCreativeToolApproval({ ...request, route: invocationRoute, signal })
      })
  }
}

afterEach(() => closeAssistantTerminalPolicyRuntime())

describe('production creative tool approval', () => {
  it('waits for a trusted decision and executes exactly once with approved arguments', async () => {
    const { imageCreate, invoke } = harness()
    const result = invoke({ prompt: { text: 'garden' }, token: 'secret-value', confirm: true })
    const pending = await waitForApproval()
    expect(imageCreate).not.toHaveBeenCalled()
    expect(pending.request.request.target.id).toBe('image.create')
    expect(pending.request.request.input).toMatchObject({ token: '[REDACTED]' })
    decide(pending, true)
    await expect(result).resolves.toMatchObject({ ok: true, data: { taskId: 'task-1' } })
    expect(imageCreate).toHaveBeenCalledTimes(1)
    expect(imageCreate.mock.calls[0][0]).toMatchObject({ prompt: { text: 'garden' } })
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toHaveLength(0)
  })

  it('does not execute when the user refuses', async () => {
    const { imageCreate, invoke } = harness()
    const result = invoke()
    decide(await waitForApproval(), false)
    await expect(result).resolves.toMatchObject({ ok: false, permissionDenied: true })
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it('removes the pending approval and does not execute after cancellation', async () => {
    const controller = new AbortController()
    const { imageCreate, invoke } = harness(controller.signal)
    const result = invoke()
    await waitForApproval()
    controller.abort()
    await expect(result).resolves.toMatchObject({ ok: false, permissionDenied: true })
    expect(imageCreate).not.toHaveBeenCalled()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toHaveLength(0)
  })

  it('reuses a consumed Graph approval only for the same tool, route and arguments', async () => {
    const args = { workflow: { node: 'test' } }
    const request = createGraphToolPolicyRequest({
      requestId: 'graph-creative-approval',
      actor: { kind: 'graph', id: 'graph-run' },
      target: { kind: 'tool', id: 'image.create' },
      route,
      sessionId: 'graph-run',
      toolInput: args
    })
    const decision = getAssistantTerminalPolicyRuntime().requestTerminalApproval(request)
    decide(await waitForApproval(), true)
    const reference = await decision
    const { imageCreate, invoke } = harness()
    await expect(
      invokeApprovedGraphTool({ request, reference, invoke: () => invoke(args) })
    ).resolves.toMatchObject({ ok: true })
    expect(imageCreate).toHaveBeenCalledTimes(1)
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toHaveLength(0)
    await expect(
      invokeApprovedGraphTool({ request, reference, invoke: () => invoke(args) })
    ).rejects.toThrow()
    expect(imageCreate).toHaveBeenCalledTimes(1)
    const second = invoke(args)
    const newPending = await waitForApproval()
    expect(imageCreate).toHaveBeenCalledTimes(1)
    decide(newPending, false)
    await expect(second).resolves.toMatchObject({ permissionDenied: true })
  })

  it('requires a fresh decision if the arguments differ from the Graph grant', async () => {
    const request = createGraphToolPolicyRequest({
      requestId: 'graph-creative-mismatch',
      actor: { kind: 'graph', id: 'graph-run' },
      target: { kind: 'tool', id: 'image.create' },
      route,
      sessionId: 'graph-run',
      toolInput: { prompt: 'approved' }
    })
    const decision = getAssistantTerminalPolicyRuntime().requestTerminalApproval(request)
    decide(await waitForApproval(), true)
    const reference = await decision
    const { imageCreate, invoke } = harness()
    const result = invokeApprovedGraphTool({
      request,
      reference,
      invoke: () => invoke({ prompt: 'changed' })
    })
    decide(await waitForApproval(), false)
    await expect(result).resolves.toMatchObject({ permissionDenied: true })
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it('requires a fresh decision for a different sender in the same conversation', async () => {
    const approvedRoute = { ...route, senderId: 'approved-sender' }
    const changedRoute = { ...route, senderId: 'different-sender' }
    expect(getAgentSessionKey(changedRoute)).toBe(getAgentSessionKey(approvedRoute))
    const args = { workflow: { node: 'test' } }
    const request = createGraphToolPolicyRequest({
      requestId: 'graph-creative-sender-mismatch',
      actor: { kind: 'graph', id: 'graph-run' },
      target: { kind: 'tool', id: 'image.create' },
      route: approvedRoute,
      sessionId: 'graph-run',
      toolInput: args
    })
    const decision = getAssistantTerminalPolicyRuntime().requestTerminalApproval(request)
    decide(await waitForApproval(), true)
    const reference = await decision
    const { imageCreate, invoke } = harness(undefined, changedRoute)
    const result = invokeApprovedGraphTool({ request, reference, invoke: () => invoke(args) })
    const freshApproval = await waitForApproval()
    expect(freshApproval.request.request.action).toBe('creative.invoke')
    expect(imageCreate).not.toHaveBeenCalled()
    decide(freshApproval, false)
    await expect(result).resolves.toMatchObject({ ok: false, permissionDenied: true })
    expect(imageCreate).not.toHaveBeenCalled()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toHaveLength(0)
  })

  it('reuses the Graph approval only once within the same async invocation scope', async () => {
    const args = { workflow: { node: 'test' } }
    const request = createGraphToolPolicyRequest({
      requestId: 'graph-creative-one-use-in-scope',
      actor: { kind: 'graph', id: 'graph-run' },
      target: { kind: 'tool', id: 'image.create' },
      route,
      sessionId: 'graph-run',
      toolInput: args
    })
    const decision = getAssistantTerminalPolicyRuntime().requestTerminalApproval(request)
    decide(await waitForApproval(), true)
    const reference = await decision
    const { imageCreate, invoke } = harness()
    const result = invokeApprovedGraphTool({
      request,
      reference,
      invoke: async () => {
        const first = await invoke(args)
        expect(first.ok).toBe(true)
        expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toHaveLength(0)
        return { first, second: await invoke(args) }
      }
    })
    const freshApproval = await waitForApproval()
    expect(freshApproval.request.request.action).toBe('creative.invoke')
    expect(imageCreate).toHaveBeenCalledTimes(1)
    decide(freshApproval, false)
    await expect(result).resolves.toMatchObject({
      first: { ok: true },
      second: { ok: false, permissionDenied: true }
    })
    expect(imageCreate).toHaveBeenCalledTimes(1)
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toHaveLength(0)
  })
})
