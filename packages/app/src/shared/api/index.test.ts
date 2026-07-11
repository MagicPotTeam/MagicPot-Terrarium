import { describe, expect, it } from 'vitest'
import { apiDef } from './index'
import {
  ServiceValidationError,
  type ServiceValidator,
  validateServiceValue
} from './apiUtils/serviceValidation'

describe('apiDef', () => {
  it('exposes the project canvas thumbnail service contract', () => {
    expect(apiDef.svcCanvasThumbnail).toBeDefined()
    expect(apiDef.svcCanvasThumbnail.getSourceFileMetadata.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.getThumbnailCacheRoot.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.readThumbnailManifest.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.writeThumbnailSet.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.generateThumbnailSet.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.createNativeThumbnail.type).toBe('unary')
  })

  it('exposes the app update service contract', () => {
    expect(apiDef.svcAppUpdate).toBeDefined()
    expect(apiDef.svcAppUpdate.getStatus.type).toBe('unary')
    expect(apiDef.svcAppUpdate.checkForUpdates.type).toBe('unary')
    expect(apiDef.svcAppUpdate.downloadUpdate.type).toBe('unary')
    expect(apiDef.svcAppUpdate.installUpdate.type).toBe('unary')
    expect(apiDef.svcAppUpdate.watchStatus.type).toBe('serverStreaming')
  })

  it('exposes the MagicAgent Platform v1 service contract', () => {
    expect(apiDef.svcMagicAgentPlatform).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.getStatus.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.listTools.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.callTool.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.runAgent.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.listGraphs.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.runGraph.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.watchGraphRun.type).toBe('serverStreaming')
    expect(apiDef.svcMagicAgentPlatform.validatePackageManifest.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.installPackage.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.callTool.request).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.runAgent.request).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.watchGraphRun.request).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.installPackage.request).toBeDefined()
  })

  it('validates MagicAgent Platform renderer requests at the API boundary', () => {
    expect(() =>
      validateServiceValue({ name: 123 }, apiDef.svcMagicAgentPlatform.callTool.request)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ text: '' }, apiDef.svcMagicAgentPlatform.runAgent.request)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { name: 'creative.echo', source: 'creative' },
        apiDef.svcMagicAgentPlatform.callTool.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ text: 'hello' }, apiDef.svcMagicAgentPlatform.runAgent.request)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { text: 'hello', route: { channel: 'generic', scopeType: 'bad', scopeId: 'demo' } },
        apiDef.svcMagicAgentPlatform.runAgent.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          text: 'hello',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
          allowedToolNames: ['']
        },
        apiDef.svcMagicAgentPlatform.runAgent.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          text: 'hello',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
          timeoutMs: 0
        },
        apiDef.svcMagicAgentPlatform.runAgent.request
      )
    ).toThrow(ServiceValidationError)
    expect(
      validateServiceValue(
        {
          name: 'creative.echo',
          args: { prompt: 'hi' },
          source: 'creative',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
        },
        apiDef.svcMagicAgentPlatform.callTool.request
      )
    ).toMatchObject({
      name: 'creative.echo',
      args: { prompt: 'hi' },
      source: 'creative',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
    })
  })

  it('requires route binding for mutating and run-scoped MagicAgent graph requests', () => {
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'graph-demo' }
    const graph = {
      graphId: 'graph.demo',
      name: 'Demo Graph',
      description: 'Demo graph.',
      version: '1.0.0',
      tags: [],
      nodes: [
        {
          nodeId: 'input',
          kind: 'input',
          name: 'Input',
          description: 'Receives the graph input.'
        },
        {
          nodeId: 'final',
          kind: 'output',
          name: 'Final',
          description: 'Produces the final output.'
        }
      ],
      channels: [
        {
          channelId: 'input-to-final',
          from: 'input',
          to: 'final',
          kind: 'artifact'
        }
      ],
      outputs: [
        {
          outputId: 'final-doc',
          name: 'Final Document',
          description: 'Final document output.',
          sourceNodeId: 'final',
          channelId: 'input-to-final'
        }
      ],
      entryNodeIds: ['input']
    }

    const routeRequiredCases: Array<[unknown, ServiceValidator<unknown> | undefined]> = [
      [{ graph }, apiDef.svcMagicAgentPlatform.createGraph.request as ServiceValidator<unknown>],
      [
        { graphId: 'graph.demo', input: 'hello' },
        apiDef.svcMagicAgentPlatform.runGraph.request as ServiceValidator<unknown>
      ],
      [
        { graphId: 'graph.demo' },
        apiDef.svcMagicAgentPlatform.listGraphRuns.request as ServiceValidator<unknown>
      ],
      [
        { runId: 'run-1' },
        apiDef.svcMagicAgentPlatform.getGraphRun.request as ServiceValidator<unknown>
      ],
      [
        { runId: 'run-1' },
        apiDef.svcMagicAgentPlatform.watchGraphRun.request as ServiceValidator<unknown>
      ],
      [
        { runId: 'run-1' },
        apiDef.svcMagicAgentPlatform.cancelGraphRun.request as ServiceValidator<unknown>
      ]
    ]

    for (const [request, validator] of routeRequiredCases) {
      expect(() => validateServiceValue(request, validator)).toThrow(ServiceValidationError)
    }

    expect(() =>
      validateServiceValue(
        { graph: { ...graph, nodes: [] }, route },
        apiDef.svcMagicAgentPlatform.createGraph.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          graph: {
            ...graph,
            nodes: [{ ...graph.nodes[0], kind: 'unsupported' }]
          },
          route
        },
        apiDef.svcMagicAgentPlatform.createGraph.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          graph: {
            ...graph,
            outputs: [{ ...graph.outputs[0], channelId: 'missing-channel' }]
          },
          route
        },
        apiDef.svcMagicAgentPlatform.createGraph.request
      )
    ).toThrow(ServiceValidationError)

    expect(
      validateServiceValue(
        { graph, route, replace: true },
        apiDef.svcMagicAgentPlatform.createGraph.request
      )
    ).toMatchObject({ graph: { graphId: 'graph.demo' }, route, replace: true })
    expect(
      validateServiceValue(
        { graphId: 'graph.demo', input: 'hello', route },
        apiDef.svcMagicAgentPlatform.runGraph.request
      )
    ).toMatchObject({ graphId: 'graph.demo', input: 'hello', route })
    expect(
      validateServiceValue(
        { graphId: 'graph.demo', route, limit: 50 },
        apiDef.svcMagicAgentPlatform.listGraphRuns.request
      )
    ).toMatchObject({ graphId: 'graph.demo', route, limit: 50 })
    expect(() =>
      validateServiceValue(
        { graphId: 'graph.demo', route, limit: 0 },
        apiDef.svcMagicAgentPlatform.listGraphRuns.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { graphId: 'graph.demo', route, limit: 1.5 },
        apiDef.svcMagicAgentPlatform.listGraphRuns.request
      )
    ).toThrow(ServiceValidationError)
    expect(
      validateServiceValue(
        { runId: 'run-1', route },
        apiDef.svcMagicAgentPlatform.getGraphRun.request
      )
    ).toMatchObject({ runId: 'run-1', route })
    expect(
      validateServiceValue(
        { runId: 'run-1', route },
        apiDef.svcMagicAgentPlatform.watchGraphRun.request
      )
    ).toMatchObject({ runId: 'run-1', route })
    expect(
      validateServiceValue(
        { runId: 'run-1', route, reason: 'stop' },
        apiDef.svcMagicAgentPlatform.cancelGraphRun.request
      )
    ).toMatchObject({ runId: 'run-1', route, reason: 'stop' })
  })
})
