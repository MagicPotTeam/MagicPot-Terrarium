import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MagicAgentGraphDefinition,
  MagicAgentGraphRunPublicEvent,
  MagicAgentGraphRunStreamEvent
} from '@shared/magicAgent'
import {
  GRAPH_V2_FIRST_PARTY_NODE_REGISTRY,
  convertGraphDefinitionV1ToV2Draft
} from '@shared/magicAgentPlatform2'
import { AgentKernel } from '../agentKernel'
import {
  closeAssistantTerminalPolicyRuntime,
  getAssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
const agentLifecycle = vi.hoisted(() => ({ active: undefined as unknown }))
const channelLifecycle = vi.hoisted(() => ({ active: undefined as unknown }))
const triggerLifecycle = vi.hoisted(() => ({ active: undefined as unknown }))
const driveLifecycle = vi.hoisted(() => ({ active: undefined as unknown }))
vi.mock('../magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner', () => ({
  getProductionAgentInstanceLifecycle: () => agentLifecycle.active
}))
vi.mock('../magicAgentPlatform2/channels/productionRuntimeChannelLifecycle', () => ({
  getProductionRuntimeChannelLifecycle: () => channelLifecycle.active
}))
vi.mock('../magicAgentPlatform2/drives/productionDriveLifecycle', () => ({
  getProductionDriveLifecycle: () => driveLifecycle.active
}))
vi.mock('../magicAgentPlatform2/triggers/productionTriggerLifecycle', () => ({
  getProductionTriggerLifecycle: () => triggerLifecycle.active
}))

import { MagicAgentGraphRuntime } from '../magicAgentRuntime/graph'
import { compileGraphDefinitionV2ForRuntime } from '../magicAgentRuntime/graph/graphDefinitionV2Runtime'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/magicpot-test-user-data')
  }
}))

const originalMagicAgentPlatformFlag = process.env['MAGICPOT_MAGICAGENT_PLATFORM']

const runtimeChannelResourceDtoForTest = (resource: {
  id: string
  revision: number
  state: import('@shared/magicAgentPlatform2').RuntimeChannelState
  createdAt: number
  updatedAt: number
}) => ({
  id: resource.id,
  revision: resource.revision,
  state: {
    id: resource.state.id,
    name: resource.state.name,
    mode: resource.state.mode,
    capacity: resource.state.capacity,
    members: resource.state.members.map((member) => ({
      memberId: member.memberId,
      ...(member.agentInstanceId ? { agentInstanceId: member.agentInstanceId } : {}),
      ...(member.graphTargetId ? { graphTargetId: member.graphTargetId } : {}),
      ...(member.graphWakeRequest
        ? {
            graphWakeRequest: {
              graphId: member.graphWakeRequest.graphId,
              route: member.graphWakeRequest.route
            }
          }
        : {}),
      role: member.role,
      joinedAt: member.joinedAt
    }))
  },
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt
})

const triggerResourceDtoForTest = (resource: {
  id: string
  revision: number
  state: unknown
  createdAt: number
  updatedAt: number
}) => ({
  id: resource.id,
  revision: resource.revision,
  state: resource.state,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt
})

const createRegistryInvocation = (senderId: number) => {
  const route = { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' } as const
  registerMagicAgentTrustedRouteBinding(senderId, route, {
    trustedUrl: 'file:///app/index.html',
    trustedWebContents: { id: senderId, isDestroyed: () => false }
  })
  return {
    methodName: 'svcMagicAgentPlatform.listGraphV2NodeRegistry',
    senderId,
    senderUrl: 'file:///app/index.html#/agent-studio',
    frameUrl: 'file:///app/index.html#/agent-studio',
    isMainFrame: true
  }
}

const createSvcTestGraph = (graphId = 'graph.service.partition'): MagicAgentGraphDefinition => ({
  graphId,
  name: 'Service Partition Graph',
  description: 'Graph used by service partition tests.',
  version: '1.0.0',
  tags: ['test'],
  entryNodeIds: ['planner'],
  nodes: [
    {
      nodeId: 'planner',
      kind: 'agent',
      name: 'Planner',
      description: 'Plans the answer.',
      instruction: 'Plan the answer.'
    },
    {
      nodeId: 'final',
      kind: 'output',
      name: 'Final',
      description: 'Final output node.'
    }
  ],
  channels: [
    {
      channelId: 'planner-to-final',
      from: 'planner',
      to: 'final',
      kind: 'artifact'
    }
  ],
  outputs: [
    {
      outputId: 'final-doc',
      name: 'Final Document',
      description: 'Final generated document.',
      sourceNodeId: 'final',
      channelId: 'planner-to-final',
      mimeType: 'text/markdown'
    }
  ]
})

beforeEach(() => {
  process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = '1'
})

afterEach(() => {
  agentLifecycle.active = undefined
  channelLifecycle.active = undefined
  triggerLifecycle.active = undefined
  driveLifecycle.active = undefined
  clearMagicAgentTrustedRouteBindingsForTest()
  if (originalMagicAgentPlatformFlag === undefined) {
    delete process.env['MAGICPOT_MAGICAGENT_PLATFORM']
  } else {
    process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = originalMagicAgentPlatformFlag
  }
})

describe('MagicAgentPlatformSvcImpl', () => {
  it('reports environment/config availability without advertising false executable paths', async () => {
    const service = new MagicAgentPlatformSvcImpl({
      ensureMcpRuntimeAvailable: async () => {
        throw new Error('No MCP client configuration is loaded.')
      },
      adapter: {
        listTools: () => []
      } as never
    })
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' } as const
    const invocation = {
      methodName: 'svcMagicAgentPlatform.listGraphV2NodeRegistry',
      senderId: 50,
      senderUrl: 'file:///app/index.html#/agent-studio',
      frameUrl: 'file:///app/index.html#/agent-studio',
      isMainFrame: true
    }
    registerMagicAgentTrustedRouteBinding(50, route, {
      trustedUrl: 'file:///app/index.html',
      trustedWebContents: { id: 50, isDestroyed: () => false }
    })

    const { descriptors } = await service.listGraphV2NodeRegistry({}, invocation)
    expect(descriptors.find((item) => item.kind === 'input')).toMatchObject({ executable: true })
    expect(descriptors.find((item) => item.kind === 'channel-message')).toMatchObject({
      executable: false,
      disabledReason: 'Communication family is unconfigured in this environment.'
    })
    expect(descriptors.find((item) => item.kind === 'automation-trigger')).toMatchObject({
      executable: false,
      disabledReason: 'Automation Trigger service is unconfigured in this environment.'
    })
    expect(descriptors.find((item) => item.kind === 'mcp-tool')).toMatchObject({
      executable: false,
      disabledReason:
        'MCP client configuration is unavailable: No MCP client configuration is loaded.'
    })
    expect(descriptors.find((item) => item.kind === 'comfyui-workflow')).toMatchObject({
      executable: false,
      disabledReason: 'ComfyUI creative tool is unavailable.'
    })
  })

  it('distinguishes environment availability from node configuration preflight', async () => {
    channelLifecycle.active = {}
    triggerLifecycle.active = {}
    const service = new MagicAgentPlatformSvcImpl({
      ensureMcpRuntimeAvailable: async () => undefined,
      assistantRuntime: { listTools: () => [{ name: 'coding.run' }] } as never,
      semanticMemory: { providers: { listRegistrations: () => [{ id: 'local' }] } } as never,
      adapter: {
        listTools: () => [
          { name: 'comfyui.workflow.submit', source: 'creative', description: 'ComfyUI' }
        ]
      } as never
    })

    const { descriptors } = await service.listGraphV2NodeRegistry({}, createRegistryInvocation(51))
    for (const kind of [
      'channel-message',
      'automation-trigger',
      'llm',
      'tool',
      'mcp-tool',
      'memory-search',
      'coding-task',
      'comfyui-workflow',
      'subgraph'
    ]) {
      expect(descriptors.find((item) => item.kind === kind)).toMatchObject({ executable: true })
    }
    expect(descriptors.find((item) => item.kind === 'subgraph')).toMatchObject({
      configurationNeeded: 'Configure required fields after adding: graphId, version.'
    })

    const base = convertGraphDefinitionV1ToV2Draft(createSvcTestGraph('registry-config'))
    const tool = GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.find((item) => item.kind === 'tool')!
    const configurable = {
      ...base,
      nodes: [
        {
          ...base.nodes[0],
          kind: tool.kind,
          inputs: tool.defaultInputs,
          outputs: tool.defaultOutputs,
          config: tool.defaultConfig
        }
      ],
      edges: [],
      entryNodeIds: [base.nodes[0].nodeId],
      outputs: [],
      legacySnapshot: {
        ...base.legacySnapshot,
        nodes: [{ ...base.legacySnapshot.nodes[0], kind: 'tool' as const }],
        channels: [],
        entryNodeIds: [base.nodes[0].nodeId],
        outputs: [
          {
            outputId: 'result',
            name: 'Result',
            description: 'Result',
            sourceNodeId: base.nodes[0].nodeId
          }
        ]
      }
    }
    expect(() => compileGraphDefinitionV2ForRuntime(configurable)).toThrow(
      'Required tool config field is unconfigured: toolName.'
    )
    expect(() =>
      compileGraphDefinitionV2ForRuntime({
        ...configurable,
        nodes: configurable.nodes.map((node) => ({ ...node, config: { toolName: 'coding.run' } }))
      })
    ).not.toThrow()
  })

  it('lists, watches, and resolves pending approvals through the production policy runtime', async () => {
    const service = new MagicAgentPlatformSvcImpl()
    const runtime = getAssistantTerminalPolicyRuntime()
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' } as const
    const invocation = {
      methodName: 'svcMagicAgentPlatform.listPendingApprovals',
      senderId: 51,
      senderUrl: 'file:///app/index.html#/agent-studio',
      frameUrl: 'file:///app/index.html#/agent-studio',
      isMainFrame: true
    }
    registerMagicAgentTrustedRouteBinding(51, route, {
      trustedUrl: 'file:///app/index.html',
      trustedWebContents: { id: 51, isDestroyed: () => false }
    })

    const request = runtime.createRequest({
      route,
      sessionId: 'generic:dm:agent-studio',
      command: process.execPath,
      args: ['-e', "process.stdout.write('approved')"],
      cwd: process.cwd(),
      allowedRoots: [process.cwd()]
    })
    const approvalPromise = runtime.requestTerminalApproval(request)

    try {
      const listed = await service.listPendingApprovals({}, invocation)
      expect(listed.approvals).toHaveLength(1)
      expect(listed.approvals[0]).toMatchObject({ revision: 0 })

      let abortWatch: (() => void) | undefined
      const onData = vi.fn(() => abortWatch?.())
      const watchPromise = service.watchPendingApprovals(
        {},
        {
          onData,
          abortReceiver: {
            isAborted: () => false,
            onAbort: (handler) => {
              abortWatch = handler
            }
          }
        },
        { ...invocation, methodName: 'svcMagicAgentPlatform.watchPendingApprovals' }
      )
      await expect(watchPromise).resolves.toBeUndefined()
      expect(onData).toHaveBeenCalledWith({ type: 'snapshot', approvals: listed.approvals })

      const approval = listed.approvals[0]!
      await expect(
        service.resolvePendingApproval(
          {
            approvalId: approval.approvalId,
            expectedRevision: approval.revision,
            approved: true
          },
          { ...invocation, methodName: 'svcMagicAgentPlatform.resolvePendingApproval' }
        )
      ).resolves.toMatchObject({
        approval: {
          approvalId: approval.approvalId,
          revision: approval.revision + 1,
          status: 'approved'
        }
      })
      await expect(approvalPromise).resolves.toMatchObject({ authorizationId: approval.approvalId })
      await expect(service.listPendingApprovals({}, invocation)).resolves.toEqual({ approvals: [] })
    } finally {
      closeAssistantTerminalPolicyRuntime()
    }
  })

  it('rejects pending approval IPC APIs from an untrusted renderer', async () => {
    const service = new MagicAgentPlatformSvcImpl()
    const untrustedInvocation = {
      methodName: 'svcMagicAgentPlatform.listPendingApprovals',
      senderId: 52,
      senderUrl: 'https://evil.invalid/#/agent-studio',
      frameUrl: 'https://evil.invalid/#/agent-studio',
      isMainFrame: true
    }

    await expect(service.listPendingApprovals({}, untrustedInvocation)).rejects.toThrow(
      /not trusted/
    )
    await expect(
      service.watchPendingApprovals(
        {},
        { onData: vi.fn() },
        { ...untrustedInvocation, methodName: 'svcMagicAgentPlatform.watchPendingApprovals' }
      )
    ).rejects.toThrow(/not trusted/)
    await expect(
      service.resolvePendingApproval(
        { approvalId: 'approval-untrusted', expectedRevision: 0, approved: false },
        { ...untrustedInvocation, methodName: 'svcMagicAgentPlatform.resolvePendingApproval' }
      )
    ).rejects.toThrow(/not trusted/)
  })

  it('aggregates status without requiring package-store availability', async () => {
    const service = new MagicAgentPlatformSvcImpl({
      adapter: {
        listTools: () => [
          {
            name: 'assistant.echo',
            description: 'Assistant tool.',
            inputSchema: { type: 'object' },
            source: 'assistantRuntime' as const
          },
          {
            name: 'creative.echo',
            description: 'Creative tool.',
            inputSchema: { type: 'object' },
            source: 'creative' as const
          }
        ],
        listAgents: () => [{ id: 'agent.one', name: 'Agent One' }]
      } as never,
      graphRuntime: {
        list: () => [{ graphId: 'graph.one' }]
      } as never,
      packageStore: {
        list: vi.fn(async () => {
          throw new Error('store unavailable')
        }),
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed'
      } as never
    })

    await expect(service.getStatus({})).resolves.toMatchObject({
      enabled: true,
      featureFlag: 'MAGICPOT_MAGICAGENT_PLATFORM',
      platformVersion: 1,
      assistantRuntimeCompatible: true,
      agentCount: 1,
      toolCount: 2,
      assistantToolCount: 1,
      creativeToolCount: 1,
      graphCount: 1
    })
  })

  it('reports disabled status and gates platform operations without initializing platform deps when the feature flag is off', async () => {
    process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = '0'
    const listTools = vi.fn(() => [])
    const listAgents = vi.fn(() => [])
    const listGraphs = vi.fn(() => [])
    const listPackages = vi.fn(async () => [])
    const service = new MagicAgentPlatformSvcImpl({
      adapter: {
        listTools,
        listAgents
      } as never,
      graphRuntime: {
        list: listGraphs
      } as never,
      packageStore: {
        list: listPackages,
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed'
      } as never
    })

    await expect(service.getStatus({})).resolves.toMatchObject({
      enabled: false,
      featureFlag: 'MAGICPOT_MAGICAGENT_PLATFORM',
      agentCount: 0,
      toolCount: 0,
      graphCount: 0
    })
    expect(listTools).not.toHaveBeenCalled()
    expect(listAgents).not.toHaveBeenCalled()
    expect(listGraphs).not.toHaveBeenCalled()
    expect(listPackages).not.toHaveBeenCalled()
    await expect(service.listAgents({})).rejects.toThrow(/MAGICPOT_MAGICAGENT_PLATFORM=1/)
  })

  it('fails closed for Agent Studio graph and package operations when the feature flag is off', async () => {
    process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = '0'
    const listTools = vi.fn(() => [])
    const listAgents = vi.fn(() => [])
    const listGraphs = vi.fn(() => [])
    const createGraph = vi.fn()
    const runGraph = vi.fn()
    const listGraphRuns = vi.fn()
    const getGraphRun = vi.fn()
    const subscribeToRun = vi.fn()
    const cancelGraphRun = vi.fn()
    const listPackages = vi.fn(async () => [])
    const scanLocalDirectory = vi.fn()
    const install = vi.fn()
    const inspect = vi.fn()
    const uninstall = vi.fn()
    const registerSession = vi.fn()
    const service = new MagicAgentPlatformSvcImpl({
      agentKernel: { registerSession } as never,
      adapter: {
        listTools,
        listAgents
      } as never,
      graphRuntime: {
        list: listGraphs,
        create: createGraph,
        run: runGraph,
        listRuns: listGraphRuns,
        getRun: getGraphRun,
        subscribeToRun,
        cancel: cancelGraphRun
      } as never,
      packageStore: {
        list: listPackages,
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed',
        scanLocalDirectory,
        install,
        inspect,
        uninstall
      } as never
    })
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' } as const
    const rejectedOperations: Array<() => Promise<unknown>> = [
      () => service.listAgents({}),
      () => service.listTools({}),
      () => service.listGraphs({}),
      () => service.createGraph({ graph: createSvcTestGraph(), route }),
      () => service.runGraph({ graphId: 'graph.service.partition', input: 'hello', route }),
      () => service.listGraphRuns({ route, graphId: 'graph.service.partition' }),
      () => service.getGraphRun({ route, runId: 'run-1' }),
      () => service.watchGraphRun({ route, runId: 'run-1' }, { onData: vi.fn() }),
      () => service.cancelGraphRun({ route, runId: 'run-1', reason: 'Stop requested.' }),
      () => service.validatePackageManifest({ manifest: { manifestVersion: 1 } }),
      () => service.listPackages({}),
      () => service.scanPackage({ packageDir: '/packages/candidate' }),
      () => service.installPackage({ packageDir: '/packages/candidate' }),
      () => service.inspectPackage({ packageIdOrDir: 'demo.package' }),
      () => service.uninstallPackage({ packageId: 'demo.package' })
    ]

    for (const operation of rejectedOperations) {
      await expect(operation()).rejects.toThrow(/MAGICPOT_MAGICAGENT_PLATFORM=1/)
    }
    expect(registerSession).not.toHaveBeenCalled()
    for (const dependencyCall of [
      listTools,
      listAgents,
      listGraphs,
      createGraph,
      runGraph,
      listGraphRuns,
      getGraphRun,
      subscribeToRun,
      cancelGraphRun,
      listPackages,
      scanLocalDirectory,
      install,
      inspect,
      uninstall
    ]) {
      expect(dependencyCall).not.toHaveBeenCalled()
    }
  })

  it('exposes installed package agents, applies safe package defaults, and narrows explicit tool allowlists', async () => {
    const runAgent = vi.fn(async (req) => ({
      runId: 'run-package-agent',
      agentId: req.agentId,
      status: 'completed' as const,
      content: 'ok',
      messages: [],
      toolCalls: [],
      events: [],
      startedAt: 1,
      finishedAt: 2
    }))
    const service = new MagicAgentPlatformSvcImpl({
      adapter: {
        listTools: () => [],
        listAgents: () => [{ id: 'magicpot.default.chat', name: 'Default Agent' }],
        runAgent
      } as never,
      graphRuntime: {
        list: () => []
      } as never,
      packageStore: {
        list: vi.fn(async () => []),
        listAgents: vi.fn(async () => [
          {
            id: 'package.demo.package.assistant',
            name: 'Package Assistant',
            description: 'Installed package agent.',
            systemPrompt: 'Package prompt.',
            toolNames: [' Session.Status ', ' Agent.Terminal.Run '],
            maxToolIterations: 1,
            profileId: 'package-profile',
            sourcePackageId: 'demo.package',
            sourcePackageName: 'Demo Package',
            sourcePackageVersion: '1.0.0',
            contributionId: 'assistant'
          }
        ]),
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed'
      } as never
    })

    await expect(service.listAgents({})).resolves.toMatchObject({
      agents: [
        { id: 'magicpot.default.chat', name: 'Default Agent' },
        { id: 'package.demo.package.assistant', name: 'Package Assistant' }
      ]
    })

    await service.runAgent({
      agentId: 'package.demo.package.assistant',
      text: 'hello',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-test' }
    })
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'package.demo.package.assistant',
        systemPrompt: 'Package prompt.',
        profileId: 'package-profile',
        maxToolIterations: 1
      })
    )
    expect(runAgent.mock.calls[0]?.[0]).not.toHaveProperty('allowedToolNames')

    await service.runAgent({
      agentId: 'package.demo.package.assistant',
      text: 'hello with an addendum',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-test' },
      systemPrompt: '  Request addendum.  '
    })
    expect(runAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        systemPrompt: 'Package prompt.\n\nRequest addendum.',
        profileId: 'package-profile',
        maxToolIterations: 1
      })
    )

    await service.runAgent({
      agentId: 'package.demo.package.assistant',
      text: 'hello with the same prompt',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-test' },
      systemPrompt: '  Package prompt.  '
    })
    expect(runAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ systemPrompt: 'Package prompt.' })
    )

    await service.runAgent({
      agentId: 'package.demo.package.assistant',
      text: 'hello with tools',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-test' },
      allowedToolNames: [' Session.Status ', 'artifact.create', ' Agent.Terminal.Run ']
    })
    expect(runAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowedToolNames: ['session.status', 'agent.terminal.run']
      })
    )
    const signal = new AbortController().signal
    await service.runAgent(
      {
        agentId: 'package.demo.package.assistant',
        text: 'cancel me',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-test' }
      },
      undefined,
      { signal }
    )
    expect(runAgent).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'cancel me' }), {
      signal
    })
  })

  it('keeps status tolerant but fails closed for package agent load errors', async () => {
    const runAgent = vi.fn()
    const service = new MagicAgentPlatformSvcImpl({
      adapter: {
        listTools: () => [],
        listAgents: () => [{ id: 'agent.one', name: 'Runtime Agent' }],
        runAgent
      } as never,
      graphRuntime: {
        list: () => []
      } as never,
      packageStore: {
        list: vi.fn(async () => []),
        listAgents: vi.fn(async () => {
          throw new Error('bad package agent metadata')
        }),
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed'
      } as never
    })

    await expect(service.getStatus({})).resolves.toMatchObject({ agentCount: 1 })
    await expect(service.listAgents({})).rejects.toThrow(/bad package agent metadata/)
    await expect(
      service.runAgent({
        agentId: 'package.bad.agent',
        text: 'hello',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-test' }
      })
    ).rejects.toThrow(/bad package agent metadata/)
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('rejects duplicate runtime and package agent ids for list and run paths', async () => {
    const runAgent = vi.fn()
    const service = new MagicAgentPlatformSvcImpl({
      adapter: {
        listTools: () => [],
        listAgents: () => [{ id: 'package.demo.package.assistant', name: 'Runtime Agent' }],
        runAgent
      } as never,
      graphRuntime: {
        list: () => []
      } as never,
      packageStore: {
        list: vi.fn(async () => []),
        listAgents: vi.fn(async () => [
          {
            id: 'package.demo.package.assistant',
            name: 'Package Assistant',
            sourcePackageId: 'demo.package',
            sourcePackageName: 'Demo Package',
            sourcePackageVersion: '1.0.0',
            contributionId: 'assistant'
          }
        ]),
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed'
      } as never
    })

    await expect(service.getStatus({})).resolves.toMatchObject({ agentCount: 1 })
    await expect(service.listAgents({})).rejects.toThrow(/Duplicate MagicAgent id/)
    await expect(
      service.runAgent({
        agentId: 'package.demo.package.assistant',
        text: 'hello',
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-test' }
      })
    ).rejects.toThrow(/Duplicate MagicAgent id/)
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('validates package manifests through the v1 service', async () => {
    const service = new MagicAgentPlatformSvcImpl({
      adapter: {
        listTools: () => [],
        listAgents: () => []
      } as never,
      graphRuntime: {
        list: () => []
      } as never,
      packageStore: {
        list: vi.fn(async () => []),
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed'
      } as never
    })

    await expect(
      service.validatePackageManifest({
        manifest: {
          manifestVersion: 1,
          id: 'demo.package',
          name: 'Demo Package',
          version: '1.0.0'
        }
      })
    ).resolves.toMatchObject({
      validation: {
        ok: true,
        manifest: { id: 'demo.package', version: '1.0.0' }
      }
    })

    await expect(
      service.validatePackageManifest({
        manifest: { manifestVersion: 1, id: '../bad', name: '', version: 'latest' }
      })
    ).resolves.toMatchObject({
      validation: {
        ok: false
      }
    })
  })

  it('records cancelled graph run outcomes without collapsing them into graph.failed events', async () => {
    const graphRunRecord = {
      runId: 'run-cancelled',
      graphId: 'graph.cancelled',
      status: 'cancelled' as const,
      input: 'hello',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'graph-test' },
      sessionKey: 'generic:dm:graph-test',
      createdAt: 1,
      updatedAt: 2,
      channels: [],
      outputs: [],
      events: [
        {
          eventId: 'event-cancelled',
          runId: 'run-cancelled',
          graphId: 'graph.cancelled',
          type: 'graph.cancelled' as const,
          message: 'cancelled',
          createdAt: 2
        }
      ]
    }
    const agentKernel = new AgentKernel()
    const service = new MagicAgentPlatformSvcImpl({
      agentKernel,
      adapter: {
        listTools: () => [],
        listAgents: () => []
      } as never,
      graphRuntime: {
        run: vi.fn(async () => graphRunRecord)
      } as never
    })
    const graphRoute = { channel: 'generic', scopeType: 'dm', scopeId: 'graph-test' } as const

    await expect(
      service.runGraph({ graphId: 'graph.cancelled', input: 'hello', route: graphRoute })
    ).resolves.toMatchObject({ status: 'cancelled' })

    const events = agentKernel.listEvents('generic:dm:graph-test')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'run.updated',
          metadata: expect.objectContaining({ graphEventType: 'graph.cancelled' })
        })
      ])
    )
    expect(
      events.some(
        (event) => event.type === 'run.failed' && event.metadata?.graphEventType === 'graph.failed'
      )
    ).toBe(false)
  })

  it('delegates graph and package operations through the v1 service', async () => {
    const graphRunRecord = {
      runId: 'run-1',
      graphId: 'graph.one',
      status: 'completed' as const,
      input: 'hello',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'graph-test' },
      sessionKey: 'generic:dm:graph-test',
      createdAt: 1,
      updatedAt: 2,
      channels: [],
      outputs: []
    }
    const runGraph = vi.fn(async (req) => ({
      ...graphRunRecord,
      graphId: req.graphId,
      input: req.input,
      route: req.route,
      metadata: req.metadata
    }))
    const listGraphRuns = vi.fn((_sessionKey: string, _graphId?: string, _limit?: number) => [
      graphRunRecord
    ])
    const getGraphRun = vi.fn((_runId: string, _sessionKey: string) => graphRunRecord)
    const cancelGraphRun = vi.fn((_runId: string, _sessionKey: string, _reason?: string) => ({
      runId: 'run-1',
      cancelled: true,
      status: 'cancelled' as const
    }))
    const subscribeToRun = vi.fn(
      (
        _runId: string,
        _sessionKey: string,
        handler: (event: MagicAgentGraphRunStreamEvent) => void
      ) => {
        handler({
          type: 'snapshot',
          sequence: 0,
          runId: graphRunRecord.runId,
          graphId: graphRunRecord.graphId,
          status: graphRunRecord.status,
          createdAt: graphRunRecord.updatedAt,
          run: graphRunRecord
        })
        handler({
          type: 'closed',
          sequence: 1,
          runId: graphRunRecord.runId,
          graphId: graphRunRecord.graphId,
          status: graphRunRecord.status,
          createdAt: graphRunRecord.updatedAt,
          run: graphRunRecord
        })
        return vi.fn()
      }
    )
    const installedPackage = {
      id: 'demo.package',
      name: 'Demo Package',
      version: '1.0.0',
      installedAt: '2025-01-01T00:00:00.000Z',
      sourcePath: '/packages/candidate',
      packagePath: '/store/demo.package',
      manifest: {
        manifestVersion: 1,
        id: 'demo.package',
        name: 'Demo Package',
        version: '1.0.0'
      }
    }
    const scanLocalDirectory = vi.fn(async (packageDir: string) => ({
      manifestPath: `${packageDir}/magicpot-package.json`,
      packagePath: packageDir,
      validation: { ok: true, manifest: installedPackage.manifest, warnings: [] },
      installed: installedPackage
    }))
    const install = vi.fn(async (_packageDir: string) => ({
      replaced: false,
      installed: installedPackage
    }))
    const listPackages = vi.fn(async () => [installedPackage])
    const inspect = vi.fn(async (_packageIdOrDir: string) => ({
      manifestPath: '/store/demo.package/package/magicpot-package.json',
      packagePath: '/store/demo.package/package',
      validation: { ok: true, manifest: installedPackage.manifest, warnings: [] },
      installed: installedPackage
    }))
    const agentKernel = new AgentKernel()
    const service = new MagicAgentPlatformSvcImpl({
      agentKernel,
      adapter: {
        listTools: () => [],
        listAgents: () => []
      } as never,
      graphRuntime: {
        list: () => [],
        run: runGraph,
        listRuns: listGraphRuns,
        getRun: getGraphRun,
        subscribeToRun,
        cancel: cancelGraphRun
      } as never,
      packageStore: {
        list: listPackages,
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed',
        scanLocalDirectory,
        install,
        inspect
      } as never
    })

    const graphRoute = { channel: 'generic', scopeType: 'dm', scopeId: 'graph-test' } as const
    await expect(
      service.runGraph({ graphId: 'graph.one', input: 'hello', route: graphRoute })
    ).resolves.toMatchObject({
      runId: 'run-1',
      graphId: 'graph.one',
      status: 'completed',
      sessionKey: 'generic:dm:graph-test'
    })
    expect(runGraph).toHaveBeenCalledWith({
      graphId: 'graph.one',
      input: 'hello',
      route: graphRoute,
      metadata: expect.objectContaining({
        kernelRunId: expect.any(String),
        sessionKey: 'generic:dm:graph-test'
      })
    })
    expect(agentKernel.listRuns('generic:dm:graph-test')).toHaveLength(1)
    expect(
      agentKernel
        .listEvents('generic:dm:graph-test')
        .some((event) => event.metadata?.graphEventType === 'graph.completed')
    ).toBe(true)

    await expect(
      service.listGraphRuns({ route: graphRoute, graphId: 'graph.one', limit: 50 })
    ).resolves.toMatchObject({ runs: [{ runId: 'run-1', sessionKey: 'generic:dm:graph-test' }] })
    expect(listGraphRuns).toHaveBeenCalledWith('generic:dm:graph-test', 'graph.one', 50)

    await expect(service.getGraphRun({ route: graphRoute, runId: 'run-1' })).resolves.toMatchObject(
      {
        run: { runId: 'run-1', sessionKey: 'generic:dm:graph-test' }
      }
    )
    expect(getGraphRun).toHaveBeenCalledWith('run-1', 'generic:dm:graph-test')

    const streamEvents: MagicAgentGraphRunStreamEvent[] = []
    await expect(
      service.watchGraphRun(
        { route: graphRoute, runId: 'run-1' },
        { onData: (event) => streamEvents.push(event) }
      )
    ).resolves.toBeUndefined()
    expect(subscribeToRun).toHaveBeenCalledWith(
      'run-1',
      'generic:dm:graph-test',
      expect.any(Function)
    )
    expect(streamEvents.map((event) => event.type)).toEqual(['snapshot', 'closed'])

    await expect(
      service.cancelGraphRun({ route: graphRoute, runId: 'run-1', reason: 'Stop requested.' })
    ).resolves.toMatchObject({ runId: 'run-1', cancelled: true, status: 'cancelled' })
    expect(cancelGraphRun).toHaveBeenCalledWith('run-1', 'generic:dm:graph-test', 'Stop requested.')

    await expect(service.scanPackage({ packageDir: '/outside/candidate' })).rejects.toThrow(
      /package root/
    )
    await expect(service.installPackage({ packageDir: '/outside/candidate' })).rejects.toThrow(
      /package root/
    )
    await expect(service.inspectPackage({ packageIdOrDir: '/outside/candidate' })).rejects.toThrow(
      /package root/
    )

    const scanned = await service.scanPackage({ packageDir: '/packages/candidate' })
    expect(scanned).toMatchObject({ validation: { ok: true }, installed: { id: 'demo.package' } })
    expect(scanned).not.toHaveProperty('manifestPath')
    expect(scanned).not.toHaveProperty('packagePath')
    expect(scanned.installed).not.toHaveProperty('sourcePath')
    expect(scanned.installed).not.toHaveProperty('packagePath')

    const installed = await service.installPackage({ packageDir: '/packages/candidate' })
    expect(installed).toMatchObject({ replaced: false, installed: { id: 'demo.package' } })
    expect(installed.installed).not.toHaveProperty('sourcePath')
    expect(installed.installed).not.toHaveProperty('packagePath')
    expect(install).toHaveBeenCalledWith(path.resolve('/packages/candidate'))

    const listed = await service.listPackages({})
    expect(listed.packages[0]).toMatchObject({ id: 'demo.package' })
    expect(listed.packages[0]).not.toHaveProperty('sourcePath')
    expect(listed.packages[0]).not.toHaveProperty('packagePath')

    const inspected = await service.inspectPackage({ packageIdOrDir: 'demo.package' })
    expect(inspected).toMatchObject({ validation: { ok: true }, installed: { id: 'demo.package' } })
    expect(inspected).not.toHaveProperty('manifestPath')
    expect(inspected).not.toHaveProperty('packagePath')
    expect(inspected.installed).not.toHaveProperty('sourcePath')
    expect(inspected.installed).not.toHaveProperty('packagePath')
  })

  it('merges replay before an earlier-observed live attach event without duplicates', async () => {
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'attach-order' } as const
    const event = (
      sequence: number,
      kind: MagicAgentGraphRunPublicEvent['kind'] = 'node.completed'
    ): MagicAgentGraphRunPublicEvent => ({
      eventId: `event-${sequence}`,
      runId: 'run-attach-order',
      sequence,
      kind,
      timestamp: sequence,
      payload: {}
    })
    let listener: ((value: MagicAgentGraphRunPublicEvent) => void) | undefined
    const unsubscribe = vi.fn()
    const runEventStore = {
      appendMany: vi.fn(),
      subscribe: vi.fn((_runId, next) => {
        listener = next
        return unsubscribe
      }),
      listAfter: vi.fn(() => {
        listener?.(event(7, 'graph.completed'))
        return [event(4), event(5), event(6), event(7, 'graph.completed')]
      })
    }
    const service = new MagicAgentPlatformSvcImpl({
      graphRuntime: {
        getRunByRoute: vi.fn(async () => ({
          runId: 'run-attach-order',
          graphId: 'graph.attach-order',
          status: 'running',
          input: '',
          route,
          sessionKey: 'generic:dm:attach-order',
          createdAt: 1,
          updatedAt: 1,
          channels: [],
          outputs: [],
          events: []
        }))
      } as never,
      runEventStore: runEventStore as never
    })
    const delivered: MagicAgentGraphRunPublicEvent[] = []

    await expect(
      service.attachGraphRun(
        { route, runId: 'run-attach-order' },
        { onData: (value) => delivered.push(value) }
      )
    ).resolves.toBeUndefined()

    expect(delivered.map((value) => value.sequence)).toEqual([4, 5, 6, 7])
    expect(delivered.map((value) => value.eventId)).toEqual([
      'event-4',
      'event-5',
      'event-6',
      'event-7'
    ])
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('cleans up graph run watch subscriptions when the renderer aborts', async () => {
    const unsubscribe = vi.fn()
    const subscribeToRun = vi.fn(() => unsubscribe)
    const service = new MagicAgentPlatformSvcImpl({
      agentKernel: new AgentKernel(),
      adapter: { listTools: () => [], listAgents: () => [] } as never,
      graphRuntime: { subscribeToRun } as never
    })
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' } as const
    let abortHandler: (() => void) | undefined
    const watchPromise = service.watchGraphRun(
      { route, runId: 'run-abort' },
      {
        onData: vi.fn(),
        abortReceiver: {
          isAborted: () => false,
          onAbort: (handler) => {
            abortHandler = handler
          }
        }
      }
    )

    await Promise.resolve()
    expect(subscribeToRun).toHaveBeenCalledWith(
      'run-abort',
      'generic:dm:agent-studio',
      expect.any(Function)
    )
    abortHandler?.()
    await expect(watchPromise).resolves.toBeUndefined()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('partitions graph run service operations by route session key with the real graph runtime', async () => {
    const graphId = 'graph.service.partition'
    const graphRuntime = new MagicAgentGraphRuntime([createSvcTestGraph(graphId)])
    const service = new MagicAgentPlatformSvcImpl({
      agentKernel: new AgentKernel(),
      adapter: {
        listTools: () => [],
        listAgents: () => []
      } as never,
      graphRuntime
    })
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' } as const
    const otherRoute = {
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'other-agent-studio'
    } as const

    await expect(
      service.runGraph({ graphId, input: 'Route A prompt', route, runId: 'run-route-a' })
    ).resolves.toMatchObject({
      runId: 'run-route-a',
      graphId,
      sessionKey: 'generic:dm:agent-studio'
    })
    await expect(service.listGraphRuns({ route, graphId })).resolves.toMatchObject({
      runs: [{ runId: 'run-route-a', sessionKey: 'generic:dm:agent-studio' }]
    })
    await expect(service.listGraphRuns({ route: otherRoute, graphId })).resolves.toEqual({
      runs: []
    })
    await expect(service.getGraphRun({ route, runId: 'run-route-a' })).resolves.toMatchObject({
      run: { runId: 'run-route-a', sessionKey: 'generic:dm:agent-studio' }
    })
    await expect(service.getGraphRun({ route: otherRoute, runId: 'run-route-a' })).resolves.toEqual(
      {}
    )
    const topology = await service.getRuntimeGraphTopology({ route, runId: 'run-route-a' })
    expect(topology).toMatchObject({
      runId: 'run-route-a',
      graphId,
      status: 'completed',
      resources: expect.arrayContaining([
        expect.objectContaining({ kind: 'node', sourceNodeId: 'planner' }),
        expect.objectContaining({ kind: 'channel', sourceChannelId: 'planner-to-final' }),
        expect.objectContaining({ kind: 'wire', sourceChannelId: 'planner-to-final' })
      ])
    })
    expect(topology).not.toHaveProperty('route')
    expect(topology).not.toHaveProperty('sessionKey')
    expect(topology).not.toHaveProperty('graphSnapshot')
    expect(topology).not.toHaveProperty('events')
    await expect(
      service.getRuntimeGraphTopology({ route: otherRoute, runId: 'run-route-a' })
    ).rejects.toThrow(/not found for this route/)

    await expect(
      service.cancelGraphRun({ route: otherRoute, runId: 'run-route-a', reason: 'Wrong route.' })
    ).resolves.toEqual({
      runId: 'run-route-a',
      cancelled: false,
      error: 'Run not found.'
    })
    await expect(
      service.cancelGraphRun({
        route,
        runId: 'run-route-a',
        reason: 'Completed runs do not cancel.'
      })
    ).resolves.toEqual({ runId: 'run-route-a', cancelled: false, status: 'completed' })
  })

  it('rejects renderer route spoofing and non-Agent-Studio frames for trusted IPC operations', async () => {
    const graphId = 'graph.service.trusted-route'
    const graphRuntime = new MagicAgentGraphRuntime([createSvcTestGraph(graphId)])
    const runAgent = vi.fn(async (req) => ({
      runId: 'trusted-agent-run',
      agentId: req.agentId || 'magicpot.default.chat',
      status: 'completed' as const,
      content: 'trusted agent ok',
      messages: [],
      toolCalls: [],
      events: [],
      startedAt: 1,
      finishedAt: 2
    }))
    const callTool = vi.fn(async (req) => ({
      ok: true,
      toolName: req.name,
      source: 'creative' as const,
      status: 'ok' as const,
      content: 'trusted tool ok'
    }))
    const service = new MagicAgentPlatformSvcImpl({
      agentKernel: new AgentKernel(),
      adapter: {
        listTools: () => [],
        listAgents: () => [],
        runAgent,
        callTool
      } as never,
      graphRuntime,
      packageStore: {
        listAgents: vi.fn(async () => []),
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed'
      } as never
    })
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' } as const
    const spoofedRoute = {
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'other-agent-studio'
    } as const
    const trustedInvocation = {
      methodName: 'svcMagicAgentPlatform.runGraph',
      senderId: 42,
      senderUrl: 'file:///app/index.html#/agent-studio',
      frameUrl: 'file:///app/index.html#/agent-studio',
      isMainFrame: true
    }
    const nonStudioFrameInvocation = {
      ...trustedInvocation,
      methodName: 'svcMagicAgentPlatform.runAgent',
      senderUrl: 'file:///app/index.html#/chat',
      frameUrl: 'file:///app/index.html#/chat'
    }
    const subframeInvocation = {
      ...trustedInvocation,
      methodName: 'svcMagicAgentPlatform.callTool',
      frameUrl: 'https://example.invalid/embed.html#/agent-studio',
      isMainFrame: false
    }
    const foreignOriginInvocation = {
      ...trustedInvocation,
      methodName: 'svcMagicAgentPlatform.runGraph',
      senderUrl: 'https://evil.invalid/#/agent-studio',
      frameUrl: 'https://evil.invalid/#/agent-studio'
    }
    const unregisteredSenderInvocation = {
      ...trustedInvocation,
      methodName: 'svcMagicAgentPlatform.runGraph',
      senderId: 43
    }
    registerMagicAgentTrustedRouteBinding(42, route, { trustedUrl: 'file:///app/index.html' })

    await expect(
      service.runGraph(
        { graphId, input: 'trusted prompt', route, runId: 'run-trusted-route' },
        trustedInvocation
      )
    ).resolves.toMatchObject({
      runId: 'run-trusted-route',
      sessionKey: 'generic:dm:agent-studio'
    })
    await expect(
      service.runAgent(
        { agentId: 'magicpot.default.chat', text: 'trusted agent', route },
        trustedInvocation
      )
    ).resolves.toMatchObject({ runId: 'trusted-agent-run', status: 'completed' })
    await expect(
      service.callTool({ name: 'creative.echo', args: {}, route }, trustedInvocation)
    ).resolves.toMatchObject({ ok: true, content: 'trusted tool ok' })

    await expect(
      service.createGraph(
        { graph: createSvcTestGraph('graph.service.spoofed-create'), route: spoofedRoute },
        trustedInvocation
      )
    ).rejects.toThrow(/not trusted/)
    await expect(
      service.runGraph({ graphId, input: 'spoofed prompt', route: spoofedRoute }, trustedInvocation)
    ).rejects.toThrow(/not trusted/)
    await expect(
      service.listGraphRuns({ route: spoofedRoute, graphId }, trustedInvocation)
    ).rejects.toThrow(/not trusted/)
    await expect(
      service.getGraphRun({ route: spoofedRoute, runId: 'run-trusted-route' }, trustedInvocation)
    ).rejects.toThrow(/not trusted/)
    await expect(
      service.cancelGraphRun(
        { route: spoofedRoute, runId: 'run-trusted-route', reason: 'Spoofed cancel.' },
        trustedInvocation
      )
    ).rejects.toThrow(/not trusted/)
    await expect(
      service.runAgent(
        { agentId: 'magicpot.default.chat', text: 'spoofed agent', route: spoofedRoute },
        trustedInvocation
      )
    ).rejects.toThrow(/not trusted/)
    await expect(
      service.callTool({ name: 'creative.echo', args: {}, route: spoofedRoute }, trustedInvocation)
    ).rejects.toThrow(/not trusted/)

    for (const blockedInvocation of [
      nonStudioFrameInvocation,
      subframeInvocation,
      foreignOriginInvocation,
      unregisteredSenderInvocation
    ]) {
      await expect(service.getStatus({}, blockedInvocation)).rejects.toThrow(/not trusted/)
      await expect(service.listAgents({}, blockedInvocation)).rejects.toThrow(/not trusted/)
      await expect(service.listTools({}, blockedInvocation)).rejects.toThrow(/not trusted/)
      await expect(service.listGraphs({}, blockedInvocation)).rejects.toThrow(/not trusted/)
      await expect(
        service.validatePackageManifest(
          { manifest: { manifestVersion: 1, id: 'demo.package', name: 'Demo', version: '1.0.0' } },
          blockedInvocation
        )
      ).rejects.toThrow(/not trusted/)
      await expect(
        service.createGraph(
          { graph: createSvcTestGraph('graph.service.blocked-create'), route },
          blockedInvocation
        )
      ).rejects.toThrow(/not trusted/)
      await expect(
        service.runGraph({ graphId, input: 'blocked frame', route }, blockedInvocation)
      ).rejects.toThrow(/not trusted/)
      await expect(
        service.runAgent(
          { agentId: 'magicpot.default.chat', text: 'blocked frame', route },
          blockedInvocation
        )
      ).rejects.toThrow(/not trusted/)
      await expect(
        service.callTool({ name: 'creative.echo', args: {}, route }, blockedInvocation)
      ).rejects.toThrow(/not trusted/)
    }

    await expect(
      service.getGraphRun({ route, runId: 'run-trusted-route' }, trustedInvocation)
    ).resolves.toMatchObject({
      run: { runId: 'run-trusted-route', sessionKey: 'generic:dm:agent-studio' }
    })
  })

  it('binds create/remove ownership to the authenticated principal', async () => {
    const resource = {
      id: 'child',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      state: {
        id: 'child',
        name: 'Child',
        definitionId: 'agent',
        configVersion: 'v1',
        status: 'created' as const,
        depth: 1,
        parentInstanceId: 'parent',
        limits: {
          maxChildren: 1,
          maxDepth: 2,
          maxConcurrency: 1,
          maxRuntimeMs: 100,
          allowedToolNames: [],
          workspaceRoots: []
        }
      }
    }
    const createRoot = vi.fn(() => resource)
    const createChild = vi.fn(() => resource)
    const remove = vi.fn(() => ({
      ...resource,
      revision: 1,
      state: { ...resource.state, status: 'removed' }
    }))
    agentLifecycle.active = { commands: { createRoot, createChild, remove } }
    const service = new MagicAgentPlatformSvcImpl()
    const root = {
      instance: { ...resource.state, depth: 0, parentInstanceId: undefined },
      createdAt: 1,
      idempotencyKey: 'root'
    }
    await expect(service.createRootAgentInstance(root)).rejects.toThrow(/authenticated user/)
    await expect(
      service.createRootAgentInstance(root, {
        methodName: 'root',
        authenticatedActor: { kind: 'agent', id: 'parent' }
      })
    ).rejects.toThrow(/authenticated user/)
    await service.createRootAgentInstance(root, {
      methodName: 'root',
      authenticatedActor: { kind: 'user', id: 'admin' }
    })
    const child = {
      parentInstanceId: 'parent',
      parentExpectedRevision: 0,
      instance: resource.state,
      createdAt: 1,
      idempotencyKey: 'child'
    }
    await expect(
      service.createChildAgentInstance(child, {
        methodName: 'child',
        authenticatedActor: { kind: 'agent', id: 'other' }
      })
    ).rejects.toThrow(/direct child/)
    await service.createChildAgentInstance(child, {
      methodName: 'child',
      authenticatedActor: { kind: 'agent', id: 'parent' }
    })
    const removal = {
      instanceId: 'child',
      expectedRevision: 0,
      removedAt: 2,
      idempotencyKey: 'remove'
    }
    await expect(
      service.removeAgentInstance(removal, {
        methodName: 'remove',
        authenticatedActor: { kind: 'agent', id: 'other' }
      })
    ).rejects.toThrow(/itself/)
    await service.removeAgentInstance(removal, {
      methodName: 'remove',
      authenticatedActor: { kind: 'user', id: 'admin' }
    })
    expect(createRoot).toHaveBeenCalledOnce()
    expect(createChild).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('enforces Agent self pause/resume while allowing authenticated user administration', async () => {
    const resource = {
      id: 'instance',
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
      state: {
        id: 'instance',
        definitionId: 'agent',
        configVersion: 'v1',
        status: 'paused',
        depth: 0,
        limits: {
          maxChildren: 1,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 100,
          allowedToolNames: [],
          workspaceRoots: []
        }
      }
    }
    const pause = vi.fn(async () => resource)
    const resume = vi.fn(() => ({ ...resource, state: { ...resource.state, status: 'running' } }))
    agentLifecycle.active = { commands: { pause, resume } }
    const service = new MagicAgentPlatformSvcImpl()
    const request = { instanceId: 'instance', expectedRevision: 1, idempotencyKey: 'pause' }
    await expect(service.pauseAgentInstance(request)).rejects.toThrow(/authenticated actor/)
    await expect(
      service.pauseAgentInstance(request, {
        methodName: 'pause',
        authenticatedActor: { kind: 'agent', id: 'other' }
      })
    ).rejects.toThrow(/itself/)
    await service.pauseAgentInstance(request, {
      methodName: 'pause',
      authenticatedActor: { kind: 'agent', id: 'instance' }
    })
    await service.resumeAgentInstance(
      { ...request, expectedRevision: 2, idempotencyKey: 'resume' },
      { methodName: 'resume', authenticatedActor: { kind: 'user', id: 'admin' } }
    )
    expect(pause).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
  })

  it('binds Agent Team creation and lifecycle to the authenticated Agent principal', async () => {
    const create = vi.fn((input) => ({
      id: input.team.id,
      revision: 0,
      state: input.team,
      createdAt: 1,
      updatedAt: 1
    }))
    const start = vi.fn(async () => ({ state: { status: 'completed', outcomes: [] } }))
    agentLifecycle.active = { teams: { create, start } }
    const service = new MagicAgentPlatformSvcImpl()
    const createReq = {
      team: { id: 'team', name: 'Team', createdAt: 1 },
      idempotencyKey: 'create-agent'
    }
    await service.createTeam(createReq, {
      methodName: 'createTeam',
      authenticatedActor: { kind: 'agent', id: 'coordinator' }
    })
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: { kind: 'agent', id: 'coordinator' },
        team: expect.objectContaining({
          ownerId: 'coordinator',
          createdBy: { kind: 'agent', id: 'coordinator' }
        })
      })
    )
    await service.startTeam(
      {
        teamId: 'team',
        expectedRevision: 1,
        request: { text: 'start', route: { channel: 'test', scopeType: 'team', scopeId: 'team' } },
        idempotencyKey: 'start'
      },
      { methodName: 'startTeam', authenticatedActor: { kind: 'agent', id: 'coordinator' } }
    )
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'agent', id: 'coordinator' },
        teamId: 'team'
      })
    )
  })

  it('binds Team ownership and membership provenance to authenticated actors', async () => {
    const create = vi.fn((input) => ({
      id: input.team.id,
      revision: 0,
      state: input.team,
      createdAt: 1,
      updatedAt: 1
    }))
    const addMember = vi.fn((input) => ({
      id: input.teamId,
      revision: 1,
      state: { id: input.teamId, members: [input.member] },
      createdAt: 1,
      updatedAt: 2
    }))
    const remove = vi.fn((input) => ({
      id: input.teamId,
      revision: 2,
      state: { id: input.teamId, status: 'removed' },
      createdAt: 1,
      updatedAt: input.removedAt
    }))
    agentLifecycle.active = { teams: { create, addMember, removeMember: vi.fn(), remove } }
    const service = new MagicAgentPlatformSvcImpl()
    const createReq = { team: { id: 'team', name: 'Team', createdAt: 1 }, idempotencyKey: 'create' }
    await expect(service.createTeam(createReq)).rejects.toThrow(/authentication/)
    await service.createTeam(createReq, {
      methodName: 'createTeam',
      authenticatedActor: { kind: 'user', id: 'owner' }
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'user', id: 'owner' },
        team: expect.objectContaining({
          ownerId: 'owner',
          createdBy: { kind: 'user', id: 'owner' },
          members: []
        })
      })
    )
    const addReq = {
      teamId: 'team',
      expectedRevision: 0,
      member: {
        memberId: 'member',
        agentInstanceId: 'agent',
        role: 'leader' as const,
        joinedAt: 2
      },
      idempotencyKey: 'add'
    }
    await service.addTeamMember(addReq, {
      methodName: 'addTeamMember',
      authenticatedActor: { kind: 'user', id: 'owner' }
    })
    expect(addMember).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'user', id: 'owner' },
        member: expect.objectContaining({ addedBy: { kind: 'user', id: 'owner' } })
      })
    )
    await service.removeTeam(
      { teamId: 'team', expectedRevision: 1, removedAt: 3, idempotencyKey: 'remove' },
      { methodName: 'removeTeam', authenticatedActor: { kind: 'user', id: 'owner' } }
    )
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: 'user', id: 'owner' }, teamId: 'team' })
    )
  })

  it('binds immutable config creation to the authenticated actor and redacts content', async () => {
    const createConfigVersion = vi.fn((input) => ({ state: { ...input.config } }))
    agentLifecycle.active = { commands: { createConfigVersion } }
    const service = new MagicAgentPlatformSvcImpl()
    const request = {
      config: {
        version: 'v2',
        definitionId: 'agent',
        model: { profileId: 'model' },
        systemPrompt: 'secret prompt',
        inference: {},
        tools: { allowedToolNames: ['read'] },
        memory: { allowHistory: false, contextMessageLimit: 10, scope: 'instance' as const },
        policy: { policyIds: ['base'], workspaceRoots: ['/workspace'] },
        channels: { channelIds: [] },
        budgets: { maxRuntimeMs: 100 },
        createdAt: 1
      },
      idempotencyKey: 'create'
    }
    await expect(service.createAgentConfigVersion(request)).rejects.toThrow(/authenticated/)
    const response = await service.createAgentConfigVersion(request, {
      methodName: 'createAgentConfigVersion',
      authenticatedActor: { kind: 'agent', id: 'instance' }
    })
    expect(createConfigVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'create',
        config: expect.objectContaining({
          createdBy: { kind: 'agent', id: 'instance' },
          contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      })
    )
    expect(response).toEqual({
      version: 'v2',
      definitionId: 'agent',
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      createdAt: 1
    })
    expect(JSON.stringify(response)).not.toContain('secret prompt')
  })

  it('binds Agent replacement to the authenticated principal', async () => {
    const replace = vi.fn((input) => ({
      id: input.instanceId,
      revision: 1,
      state: {
        id: input.instanceId,
        definitionId: input.definitionId,
        name: input.name,
        configVersion: input.configVersion
      },
      createdAt: 1,
      updatedAt: input.replacedAt
    }))
    agentLifecycle.active = { commands: { replace } }
    const service = new MagicAgentPlatformSvcImpl()
    const request = {
      instanceId: 'instance',
      expectedRevision: 0,
      definitionId: 'new',
      name: 'New',
      configVersion: 'v2',
      replacedAt: 2,
      idempotencyKey: 'replace'
    }
    await expect(service.replaceAgentInstance(request)).rejects.toThrow(/authentication/)
    await service.replaceAgentInstance(request, {
      methodName: 'replaceAgentInstance',
      authenticatedActor: { kind: 'agent', id: 'instance' }
    })
    expect(replace).toHaveBeenCalledWith({ ...request, actor: { kind: 'agent', id: 'instance' } })
  })

  it('enforces Agent self config mutation while allowing authenticated user administration', async () => {
    const resource = {
      id: 'instance',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      state: {
        id: 'instance',
        definitionId: 'agent',
        configVersion: 'v2',
        status: 'stopped',
        depth: 0,
        limits: {
          maxChildren: 1,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 100,
          allowedToolNames: [],
          workspaceRoots: []
        }
      }
    }
    const stageConfig = vi.fn(() => resource)
    const activateStagedConfig = vi.fn(() => resource)
    const rollbackConfig = vi.fn(() => resource)
    agentLifecycle.active = { commands: { stageConfig, activateStagedConfig, rollbackConfig } }
    const service = new MagicAgentPlatformSvcImpl()
    const stage = {
      instanceId: 'instance',
      expectedRevision: 0,
      configVersion: 'v2',
      stagedAt: 1,
      idempotencyKey: 'stage'
    }
    await expect(service.stageAgentConfig(stage)).rejects.toThrow(/authenticated actor/)
    await expect(
      service.stageAgentConfig(stage, {
        methodName: 'stage',
        authenticatedActor: { kind: 'agent', id: 'other' }
      })
    ).rejects.toThrow(/own/)
    await service.stageAgentConfig(stage, {
      methodName: 'stage',
      authenticatedActor: { kind: 'agent', id: 'instance' }
    })
    await service.activateAgentConfig(
      { instanceId: 'instance', expectedRevision: 1, activatedAt: 2, idempotencyKey: 'activate' },
      { methodName: 'activate', authenticatedActor: { kind: 'user', id: 'admin' } }
    )
    expect(stageConfig).toHaveBeenCalledTimes(1)
    expect(activateStagedConfig).toHaveBeenCalledTimes(1)
  })

  it('publishes through the authenticated actor and redacts payload from response', async () => {
    const publish = vi.fn(() => ({
      id: 'message',
      revision: 1,
      createdAt: 2,
      updatedAt: 2,
      state: {
        id: 'message',
        channelId: 'channel',
        publisherMemberId: 'producer',
        payload: { secret: 'value' },
        priority: 1,
        publishedAt: 2,
        status: 'published'
      }
    }))
    channelLifecycle.active = { commands: { publish } }
    const service = new MagicAgentPlatformSvcImpl()
    const request = {
      message: {
        id: 'message',
        channelId: 'channel',
        publisherMemberId: 'producer',
        payload: { secret: 'value' },
        priority: 1,
        publishedAt: 2
      },
      expectedChannelRevision: 1,
      idempotencyKey: 'publish'
    }
    await expect(service.publishRuntimeChannelMessage(request)).rejects.toThrow(
      /authenticated actor/
    )
    const response = await service.publishRuntimeChannelMessage(request, {
      methodName: 'publish',
      authenticatedActor: { kind: 'agent', id: 'agent-1' }
    })
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: 'agent', id: 'agent-1' } })
    )
    expect(response).toEqual({
      messageId: 'message',
      revision: 1,
      channelId: 'channel',
      status: 'published'
    })
    expect(JSON.stringify(response)).not.toContain('secret')
  })

  it('allows only authenticated users to create Runtime Channels', async () => {
    const create = vi.fn(() => ({
      id: 'channel',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      state: {
        id: 'channel',
        name: 'Channel',
        mode: 'queue',
        capacity: 5,
        members: [],
        createdAt: 1
      }
    }))
    channelLifecycle.active = { commands: { create } }
    const service = new MagicAgentPlatformSvcImpl()
    const request = {
      channel: { id: 'channel', name: 'Channel', mode: 'queue' as const, capacity: 5 },
      createdAt: 1,
      idempotencyKey: 'create'
    }
    await expect(service.createRuntimeChannel(request)).rejects.toThrow(/authenticated user/)
    await expect(
      service.createRuntimeChannel(request, {
        methodName: 'create',
        authenticatedActor: { kind: 'agent', id: 'agent' }
      })
    ).rejects.toThrow(/authenticated user/)
    await service.createRuntimeChannel(request, {
      methodName: 'create',
      authenticatedActor: { kind: 'user', id: 'admin' }
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'user', id: 'admin' },
        channel: expect.objectContaining({ members: [] })
      })
    )
  })

  it('enforces Agent self-membership while allowing authenticated user administration', async () => {
    const member = {
      memberId: 'member',
      agentInstanceId: 'agent-1',
      role: 'consumer' as const,
      joinedAt: 1
    }
    const resource = {
      id: 'channel',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      state: {
        id: 'channel',
        name: 'Channel',
        mode: 'queue' as const,
        capacity: 2,
        members: [member]
      }
    }
    const join = vi.fn(() => resource)
    const leave = vi.fn(() => ({
      ...resource,
      revision: 1,
      state: { ...resource.state, members: [] }
    }))
    channelLifecycle.active = {
      store: { getChannel: vi.fn(() => resource), listChannels: vi.fn() },
      commands: { join, leave }
    }
    const service = new MagicAgentPlatformSvcImpl()
    const joinReq = {
      channelId: 'channel',
      expectedRevision: 0,
      member,
      joinedAt: 1,
      idempotencyKey: 'join'
    }
    await expect(
      service.joinRuntimeChannel(joinReq, {
        methodName: 'join',
        authenticatedActor: { kind: 'agent', id: 'other' }
      })
    ).rejects.toThrow(/own/)
    await service.joinRuntimeChannel(joinReq, {
      methodName: 'join',
      authenticatedActor: { kind: 'agent', id: 'agent-1' }
    })
    await service.joinRuntimeChannel(joinReq, {
      methodName: 'join',
      authenticatedActor: { kind: 'user', id: 'admin' }
    })
    const leaveReq = {
      channelId: 'channel',
      expectedRevision: 0,
      memberId: 'member',
      leftAt: 2,
      idempotencyKey: 'leave'
    }
    await expect(
      service.leaveRuntimeChannel(leaveReq, {
        methodName: 'leave',
        authenticatedActor: { kind: 'agent', id: 'other' }
      })
    ).rejects.toThrow(/own/)
    await service.leaveRuntimeChannel(leaveReq, {
      methodName: 'leave',
      authenticatedActor: { kind: 'agent', id: 'agent-1' }
    })
    expect(join).toHaveBeenCalledTimes(2)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('requires trusted actor and routes Wire mutations through lifecycle commands', async () => {
    const wire = {
      id: 'wire',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      state: {
        id: 'wire',
        sourceChannelId: 'source',
        targetChannelId: 'target',
        targetPublisherMemberId: 'publisher',
        enabled: true,
        createdAt: 1,
        maxHops: 4
      }
    }
    const wired = vi.fn(() => wire)
    const unwired = vi.fn(() => ({
      ...wire,
      revision: 1,
      state: { ...wire.state, enabled: false }
    }))
    channelLifecycle.active = {
      store: { listChannels: vi.fn(), getChannel: vi.fn() },
      wires: { list: vi.fn(), get: vi.fn() },
      wireCommands: { wire: wired, unwire: unwired }
    }
    const service = new MagicAgentPlatformSvcImpl()
    const wireReq = { wire: wire.state, idempotencyKey: 'wire' }
    await expect(service.wireRuntimeChannel(wireReq)).rejects.toThrow(/authenticated actor/)
    await service.wireRuntimeChannel(wireReq, {
      methodName: 'wire',
      authenticatedActor: { kind: 'user', id: 'owner' }
    })
    expect(wired).toHaveBeenCalledWith({ ...wireReq, actor: { kind: 'user', id: 'owner' } })
    const unwireReq = {
      wireId: 'wire',
      expectedRevision: 0,
      removedAt: 2,
      idempotencyKey: 'unwire'
    }
    await service.unwireRuntimeChannel(unwireReq, {
      methodName: 'unwire',
      authenticatedActor: { kind: 'user', id: 'owner' }
    })
    expect(unwired).toHaveBeenCalledWith({ ...unwireReq, actor: { kind: 'user', id: 'owner' } })
  })

  it('reads Runtime Channel wires from the lifecycle-owned topology store', async () => {
    const wire = {
      id: 'wire',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      state: {
        id: 'wire',
        sourceChannelId: 'source',
        targetChannelId: 'target',
        targetPublisherMemberId: 'publisher',
        enabled: true,
        createdAt: 1,
        maxHops: 4
      }
    }
    const getWire = vi.fn(() => wire)
    channelLifecycle.active = {
      store: { listChannels: vi.fn(), getChannel: vi.fn() },
      wires: { list: vi.fn(() => [wire]), get: getWire }
    }
    const service = new MagicAgentPlatformSvcImpl()
    await expect(service.listRuntimeChannelWires()).resolves.toEqual({ wires: [wire] })
    await expect(service.getRuntimeChannelWire({ wireId: 'wire' })).resolves.toEqual({ wire })
    expect(getWire).toHaveBeenCalledWith('wire')
  })

  it('requires trusted actor for delivery and omits claim token from ack response', async () => {
    const claimed = {
      id: 'message',
      revision: 1,
      state: { channelId: 'channel', queueClaim: { token: 'claim-secret', expiresAt: 100 } }
    }
    const acknowledged = {
      id: 'message',
      revision: 2,
      state: { channelId: 'channel', acknowledgedAt: 20 }
    }
    const claim = vi.fn(() => claimed)
    const acknowledge = vi.fn(() => acknowledged)
    channelLifecycle.active = {
      store: { listChannels: vi.fn(), getChannel: vi.fn() },
      commands: { claim, acknowledge }
    }
    const service = new MagicAgentPlatformSvcImpl()
    const claimReq = {
      messageId: 'message',
      expectedRevision: 0,
      consumerMemberId: 'consumer',
      claimedAt: 10,
      leaseMs: 100,
      idempotencyKey: 'claim'
    }
    await expect(service.claimRuntimeChannelMessage(claimReq)).rejects.toThrow(
      /authenticated actor/
    )
    await expect(
      service.claimRuntimeChannelMessage(claimReq, {
        methodName: 'claim',
        authenticatedActor: { kind: 'agent', id: 'agent-1' }
      })
    ).resolves.toEqual({
      messageId: 'message',
      revision: 1,
      channelId: 'channel',
      consumerMemberId: 'consumer',
      claimToken: 'claim-secret',
      leaseExpiresAt: 100
    })
    expect(claim).toHaveBeenCalledWith({ ...claimReq, actor: { kind: 'agent', id: 'agent-1' } })
    const ackReq = {
      messageId: 'message',
      expectedRevision: 1,
      consumerMemberId: 'consumer',
      acknowledgedAt: 20,
      token: 'claim-secret',
      idempotencyKey: 'ack'
    }
    const response = await service.acknowledgeRuntimeChannelMessage(ackReq, {
      methodName: 'ack',
      authenticatedActor: { kind: 'agent', id: 'agent-1' }
    })
    expect(response).toEqual({
      messageId: 'message',
      revision: 2,
      channelId: 'channel',
      consumerMemberId: 'consumer',
      acknowledgedAt: 20
    })
    expect(JSON.stringify(response)).not.toContain('claim-secret')
  })

  it('redacts configured Graph wake input from Runtime Channel service projections', async () => {
    const resource = {
      id: 'channel',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      state: {
        id: 'channel',
        name: 'Channel',
        mode: 'queue' as const,
        capacity: 2,
        members: [
          {
            memberId: 'graph-member',
            graphTargetId: 'target',
            graphWakeRequest: {
              graphId: 'graph',
              route: { channel: 'wake', scopeType: 'dm', scopeId: 'target' },
              input: { secret: 'must-not-leak' }
            },
            role: 'consumer' as const,
            joinedAt: 2
          }
        ]
      }
    }
    channelLifecycle.active = {
      store: { listChannels: vi.fn(() => [resource]), getChannel: vi.fn(() => resource) }
    }
    const service = new MagicAgentPlatformSvcImpl()
    const expected = runtimeChannelResourceDtoForTest(resource)
    expect(await service.listRuntimeChannels({})).toEqual({ channels: [expected] })
    expect(await service.getRuntimeChannel({ channelId: 'channel' })).toEqual({ channel: expected })
    expect(JSON.stringify(await service.getRuntimeChannel({ channelId: 'channel' }))).not.toContain(
      'must-not-leak'
    )
  })

  it('does not inspect cwd-relative bare package ids as local paths and redacts nested package validation paths', async () => {
    const inspect = vi.fn(async (_packageId: string) => ({
      manifestPath: '',
      packagePath: '',
      validation: {
        ok: false as const,
        errors: [{ path: 'packageId', message: 'MagicAgent package is not installed.' }],
        warnings: []
      }
    }))
    const scanLocalDirectory = vi.fn(async (_packageDir: string) => ({
      manifestPath: '/packages/candidate/magicpot-package.json',
      packagePath: '/packages/candidate',
      validation: {
        ok: false as const,
        errors: [
          {
            path: '.',
            message:
              'Package contains unsupported symbolic link: /packages/My Package/secret link.txt and C:\\Users\\Jane Doe\\secret file.txt'
          }
        ],
        warnings: []
      }
    }))
    const install = vi.fn(async (_packageDir: string) => {
      throw new Error(
        'Invalid package at C:\\Users\\Jane Doe\\secret file.txt, then /packages/My Package/secret link.txt'
      )
    })
    const service = new MagicAgentPlatformSvcImpl({
      adapter: {
        listTools: () => [],
        listAgents: () => []
      } as never,
      graphRuntime: {
        list: () => []
      } as never,
      packageStore: {
        list: vi.fn(async () => []),
        getPackageRoot: () => '/packages',
        getStoreDir: () => '/packages/installed',
        scanLocalDirectory,
        install,
        inspect
      } as never
    })

    await expect(
      service.inspectPackage({ packageIdOrDir: 'cwd-relative-package' })
    ).resolves.toMatchObject({
      validation: { ok: false }
    })
    expect(inspect).toHaveBeenCalledWith('cwd-relative-package')
    expect(scanLocalDirectory).not.toHaveBeenCalled()

    const inspectedPath = await service.inspectPackage({ packageIdOrDir: '/packages/candidate' })
    expect(scanLocalDirectory).toHaveBeenCalledWith(path.resolve('/packages/candidate'))
    expect(inspectedPath).not.toHaveProperty('manifestPath')
    expect(inspectedPath).not.toHaveProperty('packagePath')
    expect(inspectedPath.validation.ok).toBe(false)
    if (!inspectedPath.validation.ok) {
      expect(inspectedPath.validation.errors[0].message).not.toContain('/packages/My')
      expect(inspectedPath.validation.errors[0].message).not.toContain('My Package')
      expect(inspectedPath.validation.errors[0].message).not.toContain('secret link.txt')
      expect(inspectedPath.validation.errors[0].message).not.toContain('C:\\Users')
      expect(inspectedPath.validation.errors[0].message).not.toContain('Jane Doe')
      expect(inspectedPath.validation.errors[0].message).not.toContain('secret file.txt')
      expect(inspectedPath.validation.errors[0].message).toContain('[redacted path]')
    }

    await expect(service.installPackage({ packageDir: '/packages/candidate' })).rejects.toThrow(
      /\[redacted path\]/
    )
    await expect(service.installPackage({ packageDir: '/packages/candidate' })).rejects.not.toThrow(
      /\/packages\/My|My Package|secret link\.txt|C:\\Users|Jane Doe|secret file\.txt/
    )
  })

  it('uses lifecycle-owned Drive commands and fails closed when unavailable', async () => {
    const resource = {
      id: 'drive-1',
      revision: 0,
      state: { status: 'active' },
      createdAt: 1,
      updatedAt: 1
    }
    const commands = {
      listDrives: vi.fn(() => [resource]),
      getDrive: vi.fn(() => resource),
      create: vi.fn(() => resource),
      transition: vi.fn(() => ({ ...resource, revision: 1 })),
      reportProgress: vi.fn(() => ({ ...resource, revision: 1 }))
    }
    driveLifecycle.active = { commands }
    const svc = new MagicAgentPlatformSvcImpl()
    await expect(svc.listDrives({})).resolves.toEqual({ drives: [resource] })
    await expect(svc.getDrive({ driveId: 'drive-1' })).resolves.toEqual({ drive: resource })
    await expect(
      svc.createDrive({ drive: resource.state, createdAt: 1, idempotencyKey: 'create' })
    ).resolves.toEqual({ drive: resource })
    driveLifecycle.active = undefined
    await expect(svc.listDrives({})).rejects.toThrow(/runtime is unavailable/i)
  })

  it('lists and gets triggers from the active lifecycle-owned runtime', async () => {
    const resource = {
      kind: 'trigger',
      id: 'trigger-public',
      revision: 4,
      state: { id: 'trigger-public', enabled: true },
      createdAt: 10,
      updatedAt: 20
    }
    const store = {
      list: vi.fn(() => [resource]),
      get: vi.fn((id: string) => (id === resource.id ? resource : undefined))
    }
    triggerLifecycle.active = { runtime: { store } }
    const service = new MagicAgentPlatformSvcImpl()

    await expect(service.listTriggers({})).resolves.toEqual({
      triggers: [
        {
          id: resource.id,
          revision: resource.revision,
          state: resource.state,
          createdAt: resource.createdAt,
          updatedAt: resource.updatedAt
        }
      ]
    })
    await expect(service.getTrigger({ triggerId: resource.id })).resolves.toEqual({
      trigger: {
        id: resource.id,
        revision: resource.revision,
        state: resource.state,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt
      }
    })
    await expect(service.getTrigger({ triggerId: 'missing' })).resolves.toEqual({})
    expect(store.list).toHaveBeenCalledOnce()
    expect(store.get).toHaveBeenCalledWith(resource.id)
  })

  it('creates a trigger through the lifecycle-owned command service', async () => {
    const created = {
      kind: 'trigger',
      id: 'created-public',
      revision: 0,
      state: {
        id: 'created-public',
        type: 'schedule',
        title: 'Created public',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100 },
        nextFireAt: 200,
        paused: false
      },
      createdAt: 100,
      updatedAt: 100
    }
    const store = { create: vi.fn(() => created) }
    triggerLifecycle.active = { runtime: { store } }
    const service = new MagicAgentPlatformSvcImpl()
    const req = {
      trigger: {
        id: 'created-public',
        type: 'schedule',
        title: 'Created public',
        enabled: true
      },
      schedule: { type: 'interval', intervalMs: 100 },
      nextFireAt: 200,
      createdAt: 100,
      idempotencyKey: 'public-create'
    }

    await expect(service.createTrigger(req)).resolves.toEqual({
      trigger: {
        id: created.id,
        revision: created.revision,
        state: created.state,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt
      }
    })
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ...req.trigger,
        schedule: req.schedule,
        nextFireAt: req.nextFireAt,
        paused: false
      }),
      req.createdAt,
      req.idempotencyKey
    )
  })

  it('maps update, control, and manual-fire commands through the lifecycle runtime', async () => {
    const trigger = {
      kind: 'trigger',
      id: 'controlled-public',
      revision: 5,
      state: { id: 'controlled-public', enabled: true, paused: false },
      createdAt: 10,
      updatedAt: 50
    }
    const occurrence = {
      kind: 'trigger-occurrence',
      id: 'occurrence-public',
      revision: 0,
      state: { occurrenceId: 'occurrence-public', triggerId: trigger.id, status: 'pending' },
      createdAt: 60,
      updatedAt: 60
    }
    const store = {
      update: vi.fn(() => trigger),
      setEnabled: vi.fn(() => trigger),
      setPaused: vi.fn(() => trigger),
      retry: vi.fn(() => trigger),
      get: vi.fn(() => trigger)
    }
    const occurrences = { enqueueManual: vi.fn(() => occurrence) }
    triggerLifecycle.active = { runtime: { store, occurrences } }
    const service = new MagicAgentPlatformSvcImpl()
    const control = {
      triggerId: trigger.id,
      expectedTriggerRevision: 5,
      idempotencyKey: 'public-control',
      requestedAt: 50
    }

    await service.updateTrigger({ ...control, patch: { title: 'Updated' } })
    await service.enableTrigger(control)
    await service.disableTrigger(control)
    await service.pauseTrigger(control)
    await service.resumeTrigger(control)
    await service.retryTrigger(control)
    await expect(
      service.manualFireTrigger({
        ...control,
        occurrenceId: occurrence.id,
        scheduledAt: 55,
        payloadDigest: 'a'.repeat(64)
      })
    ).resolves.toEqual({ occurrence: triggerResourceDtoForTest(occurrence) })

    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { title: 'Updated' }, expectedRevision: 5 })
    )
    expect(store.setEnabled).toHaveBeenNthCalledWith(1, expect.objectContaining({ enabled: true }))
    expect(store.setEnabled).toHaveBeenNthCalledWith(2, expect.objectContaining({ enabled: false }))
    expect(store.setPaused).toHaveBeenNthCalledWith(1, expect.objectContaining({ paused: true }))
    expect(store.setPaused).toHaveBeenNthCalledWith(2, expect.objectContaining({ paused: false }))
    expect(store.retry).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 5 }))
    expect(occurrences.enqueueManual).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceId: occurrence.id, scheduledAt: 55 })
    )
  })

  it('fails closed when the production trigger runtime is unavailable', async () => {
    const service = new MagicAgentPlatformSvcImpl()
    await expect(service.listTriggers({})).rejects.toThrow(
      'Production trigger runtime is unavailable.'
    )
    await expect(
      service.createTrigger({
        trigger: {},
        schedule: {},
        nextFireAt: 1,
        createdAt: 1,
        idempotencyKey: 'missing-runtime'
      })
    ).rejects.toThrow('Production trigger runtime is unavailable.')
    await expect(service.getTrigger({ triggerId: 'missing' })).rejects.toThrow(
      'Production trigger runtime is unavailable.'
    )
  })
})
