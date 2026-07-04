import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MagicAgentGraphDefinition } from '@shared/magicAgent'
import { AgentKernel } from '../agentKernel'
import { MagicAgentGraphRuntime } from '../magicAgentRuntime/graph'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/magicpot-test-user-data')
  }
}))

const originalMagicAgentPlatformFlag = process.env['MAGICPOT_MAGICAGENT_PLATFORM']

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
  if (originalMagicAgentPlatformFlag === undefined) {
    delete process.env['MAGICPOT_MAGICAGENT_PLATFORM']
  } else {
    process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = originalMagicAgentPlatformFlag
  }
})

describe('MagicAgentPlatformSvcImpl', () => {
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
            toolNames: ['session.status'],
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
      text: 'hello with tools',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-test' },
      allowedToolNames: ['session.status', 'artifact.create']
    })
    expect(runAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowedToolNames: ['session.status']
      })
    )
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
})
