import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

import type { MagicAgentGraphDefinition, MagicAgentGraphRunPublicEvent } from '@shared/magicAgent'
import { AgentKernel } from '../agentKernel'
import {
  MagicAgentGraphRunEventStore,
  MagicAgentGraphRunStore,
  MagicAgentGraphRuntime
} from '../magicAgentRuntime/graph'
import {
  registerMagicAgentTrustedRouteBinding,
  clearMagicAgentTrustedRouteBindingsForTest
} from '../magicAgentRuntime/trustedRouteBinding'
import type { MagicAgentPlatformAdapter } from '../magicAgentRuntime/platformAdapter'
import {
  closeAssistantTerminalPolicyRuntime,
  getAssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
import {
  MagicAgentPlatformSvcImpl,
  requestProductionGraphToolApproval
} from './svcMagicAgentPlatformImpl'

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'm7-tool-approval' } as const
const sessionKey = 'generic:dm:m7-tool-approval'
const toolArgs = { secret: 'never-public', value: 7 }
const artifacts: string[] = []
let eventStore: MagicAgentGraphRunEventStore | undefined

const graph: MagicAgentGraphDefinition = {
  graphId: 'test.m7-production-tool-approval',
  name: 'M7 production tool approval',
  description: 'A production approval-gated tool call.',
  version: '1.0.0',
  tags: ['test', 'm7', 'approval'],
  entryNodeIds: ['approved-tool'],
  nodes: [
    {
      nodeId: 'approved-tool',
      kind: 'tool',
      name: 'Approved tool',
      description: 'Approval-gated deterministic tool.',
      toolName: 'test.approved',
      config: { args: toolArgs }
    },
    { nodeId: 'final', kind: 'output', name: 'Final', description: 'Final output.' }
  ],
  channels: [
    {
      channelId: 'tool-to-final',
      from: 'approved-tool',
      to: 'final',
      kind: 'artifact',
      required: true
    }
  ],
  outputs: [
    {
      outputId: 'result',
      name: 'Result',
      description: 'Approved result.',
      sourceNodeId: 'final',
      channelId: 'tool-to-final',
      mimeType: 'text/plain'
    }
  ]
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for approval E2E state.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const makeHarness = (name: string) => {
  process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = '1'
  const root = path.join(process.cwd(), `.tmp-m7-tool-approval-${name}-${Date.now()}`)
  const databasePath = `${root}.sqlite3`
  mkdirSync(root, { recursive: true })
  artifacts.push(root, databasePath)
  const runStore = new MagicAgentGraphRunStore(root)
  eventStore = new MagicAgentGraphRunEventStore(databasePath)
  const callTool = vi.fn(async (request) => ({
    ok: true as const,
    toolName: request.name,
    source: 'creative' as const,
    status: 'ok' as const,
    content: `called:${JSON.stringify(request.args)}`
  }))
  const adapter = {
    listAgents: () => [],
    listTools: () => [],
    callTool
  } as unknown as MagicAgentPlatformAdapter
  const runtime = new MagicAgentGraphRuntime([], {
    runStore,
    runEventStore: eventStore,
    callTool: (request, options) => adapter.callTool(request, options),
    requestToolApproval: requestProductionGraphToolApproval
  })
  runtime.create({ graph, route })
  const service = new MagicAgentPlatformSvcImpl({
    adapter,
    graphRuntime: runtime,
    runStore,
    runEventStore: eventStore,
    agentKernel: new AgentKernel(),
    routeAuthorizer: (requestedRoute) => requestedRoute
  })
  return { runtime, service, callTool, runStore }
}

const eventsFor = (runId: string): MagicAgentGraphRunPublicEvent[] =>
  eventStore!.listAfter(runId) as MagicAgentGraphRunPublicEvent[]

const approvalInvocation = (methodName: string) => {
  registerMagicAgentTrustedRouteBinding(1, route, {
    trustedUrl: 'file:///app/index.html',
    trustedWebContents: { id: 1, isDestroyed: () => false }
  })
  return {
    methodName,
    senderId: 1,
    senderUrl: 'file:///app/index.html',
    frameUrl: 'file:///app/index.html',
    isMainFrame: true
  } as never
}

const listApproval = async (service: MagicAgentPlatformSvcImpl) => {
  const listed = await service.listPendingApprovals(
    {},
    approvalInvocation('svcMagicAgentPlatform.listPendingApprovals')
  )
  expect(listed.approvals).toHaveLength(1)
  return listed.approvals[0]!
}

afterEach(() => {
  eventStore?.close()
  eventStore = undefined
  closeAssistantTerminalPolicyRuntime()
  clearMagicAgentTrustedRouteBindingsForTest()
  delete process.env['MAGICPOT_MAGICAGENT_PLATFORM']
  for (const artifact of artifacts.splice(0)) rmSync(artifact, { recursive: true, force: true })
})

describe('M7 production Graph tool approval', () => {
  it('keeps the adapter behind the real approval gate, approves once, attaches ordered events, and completes', async () => {
    const { runtime, service, callTool } = makeHarness('approve')
    const runId = 'run-m7-approval-approved'
    const runPromise = service.runGraph({
      graphId: graph.graphId,
      runId,
      input: 'start',
      route,
      allowedToolNames: ['test.approved']
    })

    await waitFor(() => eventsFor(runId).some((event) => event.kind === 'approval.pending'))
    expect(callTool).not.toHaveBeenCalled()
    const approval = await listApproval(service)
    expect(approval.graphContext).toEqual({
      runId,
      nodeId: 'approved-tool',
      toolName: 'test.approved',
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(JSON.stringify(approval)).not.toContain('never-public')
    expect(approval).not.toHaveProperty('args')

    const attached: MagicAgentGraphRunPublicEvent[] = []
    let abortAttach: (() => void) | undefined
    const attachPromise = service.attachGraphRun(
      { runId, route },
      {
        onData: (event) => {
          attached.push(event)
          if (event.kind === 'graph.completed') abortAttach?.()
        },
        abortReceiver: { isAborted: () => false, onAbort: (handler) => (abortAttach = handler) }
      }
    )
    await service.resolvePendingApproval(
      { approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true },
      approvalInvocation('svcMagicAgentPlatform.resolvePendingApproval')
    )

    await expect(runPromise).resolves.toMatchObject({ runId, status: 'completed' })
    await attachPromise
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(callTool.mock.calls[0]?.[0]).toMatchObject({ name: 'test.approved', args: toolArgs })
    const kinds = attached.map((event) => event.kind)
    expect(kinds.indexOf('approval.pending')).toBeLessThan(kinds.indexOf('approval.approved'))
    expect(kinds.indexOf('approval.approved')).toBeLessThan(kinds.indexOf('tool.invoked'))
    expect(runtime.getRun(runId, sessionKey)?.status).toBe('completed')
  })

  it('denies through the production service, never calls the adapter, emits denial, and fails the run', async () => {
    const { runtime, service, callTool } = makeHarness('deny')
    const runId = 'run-m7-approval-denied'
    const runPromise = service.runGraph({
      graphId: graph.graphId,
      runId,
      input: 'start',
      route,
      allowedToolNames: ['test.approved']
    })
    await waitFor(() => eventsFor(runId).some((event) => event.kind === 'approval.pending'))
    const approval = await listApproval(service)
    expect(callTool).not.toHaveBeenCalled()

    await service.resolvePendingApproval(
      { approvalId: approval.approvalId, expectedRevision: approval.revision, approved: false },
      approvalInvocation('svcMagicAgentPlatform.resolvePendingApproval')
    )
    await expect(runPromise).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/denied by the user/)
    })
    expect(callTool).not.toHaveBeenCalled()
    expect(eventsFor(runId).map((event) => event.kind)).toContain('approval.denied')
    expect(runtime.getRun(runId, sessionKey)?.status).toBe('failed')
  })

  it('interrupts an awaiting approval on production policy runtime restart', async () => {
    const { service, callTool } = makeHarness('restart')
    const runId = 'run-m7-approval-restart'
    const runPromise = service.runGraph({
      graphId: graph.graphId,
      runId,
      input: 'start',
      route,
      allowedToolNames: ['test.approved']
    })
    await waitFor(
      () => getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals().length === 1
    )
    closeAssistantTerminalPolicyRuntime()
    await expect(runPromise).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/shutting down/)
    })
    expect(callTool).not.toHaveBeenCalled()
    expect(eventsFor(runId).map((event) => event.kind)).toContain('approval.denied')
  })
})
