import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\MagicPot-Terrarium-Tests' }
}))

import { HttpAgentTransport, MagicAgentClient } from '../../../../agent-sdk-typescript/src/index'
import type { MagicAgentGraphDefinition, MagicAgentGraphRunPublicEvent } from '@shared/magicAgent'
import { AgentKernel } from '../agentKernel'
import {
  MagicAgentGraphRunEventStore,
  MagicAgentGraphRunStore,
  MagicAgentGraphRuntime
} from '../magicAgentRuntime/graph'
import type { MagicAgentPlatformAdapter } from '../magicAgentRuntime/platformAdapter'
import { MagicAgentSdkGateway } from './magicAgentSdkGateway'
import {
  startMagicAgentSdkHttpServer,
  type MagicAgentSdkHttpServer
} from './magicAgentSdkHttpServer'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'm7-production-boundary' } as const
const originalFeatureFlag = process.env['MAGICPOT_MAGICAGENT_PLATFORM']
const artifacts: string[] = []
let server: MagicAgentSdkHttpServer | undefined
let eventStore: MagicAgentGraphRunEventStore | undefined

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for M7 E2E condition.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const graph: MagicAgentGraphDefinition = {
  graphId: 'test.m7-production-boundary',
  name: 'M7 production boundary',
  description: 'Blocking tool followed by an output boundary.',
  version: '1.0.0',
  tags: ['test', 'm7'],
  entryNodeIds: ['blocking-tool'],
  nodes: [
    {
      nodeId: 'blocking-tool',
      kind: 'tool',
      name: 'Blocking tool',
      description: 'Deterministic external adapter boundary.',
      toolName: 'test.blocking',
      config: { args: { secret: 'raw-tool-secret' } }
    },
    {
      nodeId: 'final',
      kind: 'output',
      name: 'Final output',
      description: 'Produces the final artifact.'
    }
  ],
  channels: [
    {
      channelId: 'tool-to-final',
      from: 'blocking-tool',
      to: 'final',
      kind: 'artifact',
      required: true
    }
  ],
  outputs: [
    {
      outputId: 'final-result',
      name: 'Final result',
      description: 'The deterministic tool result.',
      sourceNodeId: 'final',
      channelId: 'tool-to-final',
      mimeType: 'text/plain'
    }
  ]
}

afterEach(async () => {
  await server?.close()
  server = undefined
  eventStore?.close()
  eventStore = undefined
  for (const artifact of artifacts.splice(0)) {
    try {
      rmSync(artifact, { recursive: true, force: true })
    } catch {
      /* Windows SQLite handles may close asynchronously. */
    }
  }
  if (originalFeatureFlag === undefined) delete process.env['MAGICPOT_MAGICAGENT_PLATFORM']
  else process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = originalFeatureFlag
})

describe('M7 consolidated production boundary', () => {
  it('attaches, cursor re-attaches, pauses at a node boundary, resumes, and reopens SQLite', async () => {
    process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = '1'
    const databasePath = path.join(
      'C:\\MagicPot-Terrarium-Tests',
      `magic-agent-sdk-m7-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`
    )
    const artifactRoot = `${databasePath}.runs`
    mkdirSync(artifactRoot, { recursive: true })
    artifacts.push(artifactRoot, databasePath)

    const runStore = new MagicAgentGraphRunStore(artifactRoot)
    eventStore = new MagicAgentGraphRunEventStore(databasePath)
    const toolEntered = deferred<void>()
    const releaseTool = deferred<void>()
    const adapter = {
      listAgents: () => [],
      listTools: () => [
        {
          name: 'test.blocking',
          description: 'Deterministic blocking test tool.',
          source: 'creative',
          inputSchema: { type: 'object' }
        }
      ],
      callTool: vi.fn(async () => {
        toolEntered.resolve()
        await releaseTool.promise
        return {
          ok: true,
          toolName: 'test.blocking',
          source: 'creative',
          status: 'ok',
          content: 'raw-tool-result-secret'
        }
      })
    } as unknown as MagicAgentPlatformAdapter
    const runtime = new MagicAgentGraphRuntime([], {
      runStore,
      runEventStore: eventStore,
      callTool: (request, options) => adapter.callTool(request, options)
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
    server = await startMagicAgentSdkHttpServer({
      token: 'm7-production-token',
      gateway: new MagicAgentSdkGateway(service, 'm7-production-token')
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'm7-production-token' })
    )
    const runId = 'run-m7-production-boundary'
    const runPromise = service.runGraph({
      graphId: graph.graphId,
      runId,
      input: 'raw-run-input-secret',
      route,
      allowedToolNames: ['test.blocking']
    })

    const firstAbort = new AbortController()
    const firstEvents: MagicAgentGraphRunPublicEvent[] = []
    const firstAttach = (async () => {
      try {
        for await (const event of client.attachGraphRun({ runId, route }, firstAbort.signal)) {
          firstEvents.push(event as MagicAgentGraphRunPublicEvent)
          if (event.kind === 'tool.invoked') firstAbort.abort()
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    })()
    await toolEntered.promise
    await waitFor(() => firstEvents.some((event) => event.kind === 'tool.invoked'))
    const cursor = firstEvents.at(-1)?.eventId
    expect(cursor).toBeTruthy()
    firstAbort.abort()
    await firstAttach

    let pauseSettled = false
    const pausePromise = client.pauseGraphRun({ runId, route }).finally(() => {
      pauseSettled = true
    })
    await waitFor(
      () => runtime.getRun(runId, 'generic:dm:m7-production-boundary')?.status === 'pausing'
    )
    expect(pauseSettled).toBe(false)

    const secondAbort = new AbortController()
    const secondEvents: MagicAgentGraphRunPublicEvent[] = []
    const secondAttach = (async () => {
      try {
        for await (const event of client.attachGraphRun(
          { runId, route, afterEventId: cursor },
          secondAbort.signal
        )) {
          secondEvents.push(event as MagicAgentGraphRunPublicEvent)
          if (event.kind === 'graph.completed') secondAbort.abort()
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
      }
    })()

    releaseTool.resolve()
    await expect(pausePromise).resolves.toMatchObject({ paused: true, status: 'paused' })
    expect(runtime.getRun(runId, 'generic:dm:m7-production-boundary')?.outputs).toEqual([])
    await expect(client.resumeGraphRun({ runId, route })).resolves.toMatchObject({
      resumed: true,
      status: 'running'
    })
    await expect(runPromise).resolves.toMatchObject({ status: 'completed', runId })
    await secondAttach

    const events = [...firstEvents, ...secondEvents]
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length)
    expect(events.map((event) => event.sequence)).toEqual(
      [...events.map((event) => event.sequence)].sort((left, right) => left - right)
    )
    const kinds = events.map((event) => event.kind)
    expect(kinds.indexOf('tool.invoked')).toBeLessThan(kinds.indexOf('channel.message'))
    expect(kinds.indexOf('channel.message')).toBeLessThan(kinds.indexOf('output.created'))
    expect(kinds.indexOf('graph.pause.requested')).toBeLessThan(kinds.indexOf('graph.paused'))
    expect(kinds.indexOf('graph.paused')).toBeLessThan(kinds.indexOf('graph.resumed'))
    expect(kinds.indexOf('graph.resumed')).toBeLessThan(kinds.indexOf('graph.completed'))
    expect(JSON.stringify(events)).not.toMatch(
      /raw-tool-secret|raw-tool-result-secret|raw-run-input-secret/
    )

    eventStore.close()
    eventStore = undefined
    const reopened = new MagicAgentGraphRunEventStore(databasePath)
    expect(reopened.listAfter(runId)).toEqual(events)
    reopened.close()
  }, 20_000)
})
