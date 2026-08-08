import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  HttpAgentTransport,
  MagicAgentClient,
  type GraphDefinitionV2
} from '../../../../agent-sdk-typescript/src/index'
import { MagicAgentGraphRuntime } from '../magicAgentRuntime/graph/MagicAgentGraphRuntime'
import { MagicAgentUserGraphStore } from '../magicAgentRuntime/graph/userGraphStore'
import {
  closeAssistantTerminalPolicyRuntime,
  getAssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
import { MagicAgentSdkGateway } from './magicAgentSdkGateway'
import {
  startMagicAgentSdkHttpServer,
  type MagicAgentSdkHttpServer
} from './magicAgentSdkHttpServer'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => process.cwd() } }))

let MagicAgentPlatformSvcImpl: typeof import('./svcMagicAgentPlatformImpl').MagicAgentPlatformSvcImpl
let server: MagicAgentSdkHttpServer | undefined
const roots: string[] = []

beforeAll(async () => {
  process.env.MAGICPOT_MAGICAGENT_PLATFORM = '1'
  ;({ MagicAgentPlatformSvcImpl } = await import('./svcMagicAgentPlatformImpl'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  closeAssistantTerminalPolicyRuntime()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const route = { channel: 'sdk', scopeType: 'dm', scopeId: 'graph-v2-production-e2e' } as const

const graph: GraphDefinitionV2 = {
  kind: 'magic-agent.graph-definition.v2-draft',
  graphMode: 'design',
  schemaVersion: '2.0.0',
  graphId: 'sdk.production.graph-v2',
  name: 'Production Graph V2 SDK Round Trip',
  description: 'Exercises public SDK persistence with lossless editor data.',
  version: '2.4.1',
  tags: ['sdk', 'production-boundary', 'lossless'],
  entryNodeIds: ['agent'],
  nodes: [
    {
      nodeId: 'agent',
      kind: 'agent',
      name: 'Planner Agent',
      description: 'Plans a typed request.',
      position: { x: 40, y: 80 },
      inputs: [],
      outputs: [
        {
          portId: 'plan',
          name: 'Plan',
          direction: 'output',
          role: 'message',
          valueType: { kind: 'object', schemaRef: '#/$defs/plan', mediaType: 'application/json' },
          required: true
        }
      ],
      config: {
        agentId: 'magicpot.default.chat',
        instruction: 'Return a structured plan.',
        policy: { allowedModels: ['test-model'], maxTurns: 3 }
      },
      metadata: { editor: { color: '#5577ff', collapsed: false }, policyBoundary: 'agent.run' }
    },
    {
      nodeId: 'tool',
      kind: 'tool',
      name: 'Lookup Tool',
      description: 'Looks up supporting data.',
      position: { x: 320, y: 20 },
      inputs: [
        {
          portId: 'query',
          name: 'Query',
          direction: 'input',
          role: 'message',
          valueType: { kind: 'object', schemaRef: '#/$defs/plan' },
          required: true
        }
      ],
      outputs: [
        {
          portId: 'facts',
          name: 'Facts',
          direction: 'output',
          role: 'data',
          valueType: { kind: 'array', schemaRef: '#/$defs/facts' },
          multiple: true,
          defaultValue: []
        }
      ],
      config: {
        toolName: 'files.grep',
        inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
        policy: { approval: 'required', readOnly: true }
      },
      metadata: { editor: { icon: 'search', width: 260 }, auditLabel: 'lookup' }
    },
    {
      nodeId: 'condition',
      kind: 'condition',
      name: 'Has Facts?',
      description: 'Routes populated results.',
      position: { x: 620, y: 20 },
      inputs: [
        {
          portId: 'facts-in',
          name: 'Facts',
          direction: 'input',
          role: 'data',
          valueType: { kind: 'array', schemaRef: '#/$defs/facts' },
          required: true
        }
      ],
      outputs: [
        {
          portId: 'yes',
          name: 'Yes',
          direction: 'output',
          role: 'control',
          valueType: { kind: 'control' }
        },
        {
          portId: 'no',
          name: 'No',
          direction: 'output',
          role: 'control',
          valueType: { kind: 'control' }
        }
      ],
      config: { expression: '$.facts.length > 0', policy: { onError: 'fail-closed' } },
      metadata: { editor: { branchLabels: ['facts', 'empty'] } }
    },
    {
      nodeId: 'merge',
      kind: 'merge',
      name: 'Merge Branches',
      description: 'Joins both condition paths.',
      position: { x: 900, y: 100 },
      inputs: [
        {
          portId: 'success',
          name: 'Success',
          direction: 'input',
          role: 'control',
          valueType: { kind: 'control' },
          multiple: true
        },
        {
          portId: 'fallback',
          name: 'Fallback',
          direction: 'input',
          role: 'control',
          valueType: { kind: 'control' },
          multiple: true
        }
      ],
      outputs: [
        {
          portId: 'merged',
          name: 'Merged',
          direction: 'output',
          role: 'data',
          valueType: { kind: 'object', schemaRef: '#/$defs/result' },
          required: true
        }
      ],
      config: { strategy: 'first-completed', policy: { deterministic: true } },
      metadata: { editor: { zIndex: 4 } }
    },
    {
      nodeId: 'output',
      kind: 'output',
      name: 'Final Output',
      description: 'Publishes the canonical result.',
      position: { x: 1190, y: 100 },
      inputs: [
        {
          portId: 'result-in',
          name: 'Result',
          direction: 'input',
          role: 'data',
          valueType: { kind: 'object', schemaRef: '#/$defs/result', mediaType: 'application/json' },
          required: true
        }
      ],
      outputs: [
        {
          portId: 'published-result',
          name: 'Published Result',
          direction: 'output',
          role: 'data',
          valueType: { kind: 'object', schemaRef: '#/$defs/result', mediaType: 'application/json' },
          required: true
        }
      ],
      config: { outputId: 'result', schema: { $ref: '#/$defs/result' } },
      metadata: { editor: { pinned: true } }
    }
  ],
  edges: [
    {
      edgeId: 'agent-tool',
      kind: 'message',
      source: { nodeId: 'agent', portId: 'plan' },
      target: { nodeId: 'tool', portId: 'query' },
      label: 'planned query',
      metadata: { editor: { curve: 'smooth' } }
    },
    {
      edgeId: 'tool-condition',
      kind: 'data',
      source: { nodeId: 'tool', portId: 'facts' },
      target: { nodeId: 'condition', portId: 'facts-in' },
      metadata: { schema: '#/$defs/facts' }
    },
    {
      edgeId: 'condition-yes',
      kind: 'control',
      source: { nodeId: 'condition', portId: 'yes' },
      target: { nodeId: 'merge', portId: 'success' },
      label: 'facts found'
    },
    {
      edgeId: 'condition-no',
      kind: 'control',
      source: { nodeId: 'condition', portId: 'no' },
      target: { nodeId: 'merge', portId: 'fallback' },
      label: 'fallback'
    },
    {
      edgeId: 'merge-output',
      kind: 'data',
      source: { nodeId: 'merge', portId: 'merged' },
      target: { nodeId: 'output', portId: 'result-in' },
      metadata: { required: true }
    }
  ],
  variables: [
    {
      variableId: 'query',
      name: 'Query',
      scope: 'input',
      valueType: { kind: 'string', schemaRef: '#/$defs/query' },
      required: true,
      description: 'User query.'
    },
    {
      variableId: 'api-token',
      name: 'API token',
      scope: 'secret',
      valueType: { kind: 'string' },
      sensitive: true
    }
  ],
  outputs: [
    {
      outputId: 'result',
      name: 'Result',
      description: 'Typed final result.',
      source: { nodeId: 'output', portId: 'published-result' },
      metadata: { schemaRef: '#/$defs/result', editor: { preview: 'json' } }
    }
  ],
  metadata: {
    editor: {
      viewport: { x: -20, y: 15, zoom: 0.85 },
      selection: ['condition'],
      grid: { size: 16, snap: true }
    },
    policy: { saveBoundary: 'graph.save', trustedTestApproval: true },
    schemas: {
      $defs: {
        query: { type: 'string', minLength: 1 },
        plan: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
        facts: { type: 'array', items: { type: 'string' } },
        result: {
          type: 'object',
          required: ['summary'],
          properties: { summary: { type: 'string' } }
        }
      }
    }
  },
  legacySnapshot: {
    graphId: 'sdk.production.graph-v2',
    name: 'Production Graph V2 SDK Round Trip',
    description: 'Exercises public SDK persistence with lossless editor data.',
    version: '2.4.1',
    tags: ['sdk', 'production-boundary', 'lossless'],
    entryNodeIds: ['agent'],
    nodes: [
      {
        nodeId: 'agent',
        kind: 'agent',
        name: 'Planner Agent',
        description: 'Plans a typed request.',
        agentId: 'magicpot.default.chat'
      },
      {
        nodeId: 'tool',
        kind: 'tool',
        name: 'Lookup Tool',
        description: 'Looks up supporting data.',
        toolName: 'files.grep'
      },
      {
        nodeId: 'condition',
        kind: 'condition',
        name: 'Has Facts?',
        description: 'Routes populated results.',
        condition: { sourceNodeId: 'tool', operator: 'truthy' }
      },
      {
        nodeId: 'merge',
        kind: 'merge',
        name: 'Merge Branches',
        description: 'Joins both condition paths.'
      },
      {
        nodeId: 'output',
        kind: 'output',
        name: 'Final Output',
        description: 'Publishes the canonical result.'
      }
    ],
    channels: [
      { channelId: 'agent-tool', from: 'agent', to: 'tool', kind: 'message', required: true },
      {
        channelId: 'tool-condition',
        from: 'tool',
        to: 'condition',
        kind: 'artifact',
        required: true
      },
      {
        channelId: 'condition-yes',
        from: 'condition',
        to: 'merge',
        kind: 'control',
        condition: { sourceNodeId: 'condition', operator: 'truthy' }
      },
      {
        channelId: 'condition-no',
        from: 'condition',
        to: 'merge',
        kind: 'control',
        condition: { sourceNodeId: 'condition', operator: 'falsy' }
      },
      { channelId: 'merge-output', from: 'merge', to: 'output', kind: 'artifact', required: true }
    ],
    outputs: [
      {
        outputId: 'result',
        name: 'Result',
        description: 'Typed final result.',
        sourceNodeId: 'output',
        channelId: 'merge-output',
        mimeType: 'application/json'
      }
    ],
    metadata: { policy: { saveBoundary: 'graph.save' } }
  }
}

describe('Graph V2 TypeScript SDK strict production E2E', () => {
  it('round-trips canonically across authenticated HTTP and a reopened real store', async () => {
    const tempRoot = path.join(process.cwd(), '.tmp-tests')
    await mkdir(tempRoot, { recursive: true })
    const root = await mkdtemp(path.join(tempRoot, 'magic-agent-sdk-graph-v2-'))
    roots.push(root)
    const policyRuntime = getAssistantTerminalPolicyRuntime()
    const authorize = vi.spyOn(policyRuntime, 'authorizeAssistantMutation')
    const createService = () =>
      new MagicAgentPlatformSvcImpl({
        userGraphStore: new MagicAgentUserGraphStore(root),
        graphRuntime: new MagicAgentGraphRuntime(),
        adapter: { listTools: () => [], listAgents: () => [] } as never,
        routeAuthorizer: (requestedRoute) => requestedRoute as never
      })
    const start = async (service: InstanceType<typeof MagicAgentPlatformSvcImpl>) => {
      server = await startMagicAgentSdkHttpServer({
        token: 'graph-v2-production-token',
        authenticatedActor: { kind: 'user', id: 'graph-owner' },
        gateway: new MagicAgentSdkGateway(service, 'graph-v2-production-token', {
          kind: 'user',
          id: 'graph-owner'
        })
      })
      const runningServer = server
      if (!runningServer) throw new Error('SDK HTTP server failed to start.')
      return new MagicAgentClient(
        new HttpAgentTransport({
          baseUrl: runningServer.baseUrl,
          token: 'graph-v2-production-token'
        })
      )
    }

    let client = await start(createService())
    const saved = await client.saveGraphV2({ graph, route, replace: true })
    expect(saved.definitionV2).toEqual(graph)
    await expect(client.getGraphV2({ graphId: graph.graphId, route })).resolves.toEqual({
      definitionV2: graph
    })
    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledWith({
      route,
      sessionId: 'sdk:dm:graph-v2-production-e2e',
      toolName: 'graph.save',
      toolInput: { graphId: graph.graphId, version: 'v2', replace: true }
    })
    const auditResources = policyRuntime.authorization.listAuditResources({ limit: 20 })
    expect(auditResources.length).toBeGreaterThan(0)
    expect(
      auditResources.some((resource) => {
        const state = resource.state as { status?: string }
        return state.status === 'authorized'
      })
    ).toBe(true)
    expect(JSON.stringify(auditResources)).not.toContain(graph.variables[1].variableId)

    const activeServer = server
    if (!activeServer) throw new Error('SDK HTTP server was not started.')
    await activeServer.close()
    server = undefined
    client = await start(createService())
    const reopened = await client.getGraphV2({ graphId: graph.graphId, route })
    expect(reopened.definitionV2).toEqual(graph)
  })
})
