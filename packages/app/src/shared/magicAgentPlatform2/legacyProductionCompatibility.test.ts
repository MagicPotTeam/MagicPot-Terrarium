import { createHash } from 'node:crypto'
import path from 'node:path'
import { vol } from 'memfs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => {
  const { fs } = await vi.importActual<typeof import('memfs')>('memfs')
  return { ...fs, default: fs }
})
vi.mock('node:fs/promises', async () => {
  const { fs } = await vi.importActual<typeof import('memfs')>('memfs')
  return { ...fs.promises, default: fs.promises }
})
vi.mock('fs/promises', async () => {
  const { fs } = await vi.importActual<typeof import('memfs')>('memfs')
  return { ...fs.promises, default: fs.promises }
})
vi.mock('proper-lockfile', () => ({ lock: vi.fn(async () => async () => undefined) }))
vi.mock('../../main/config/buildEnv', () => ({
  getBuildEnv: () => ({ pathMap: { data: '/data' } })
}))

import { AssistantSessionStore } from '../../main/assistantRuntime/sessionStore'
import { MagicAgentGraphRuntime } from '../../main/magicAgentRuntime/graph/MagicAgentGraphRuntime'
import { MagicAgentPackageStore } from '../../main/magicAgentRuntime/package/store'
import type { MagicAgentPlatformRunReq } from '../api/svcMagicAgentPlatform'
import type { MagicAgentGraphDefinition } from '../magicAgent/graphTypes'

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const fixtureDir = path.resolve(
  process.cwd(),
  'packages/app/src/shared/magicAgentPlatform2/fixtures'
)
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'legacy-production' }

beforeEach(() => {
  vol.reset()
  vi.clearAllMocks()
})

async function frozen(name: string): Promise<Buffer> {
  return realFs.readFile(path.join(fixtureDir, name))
}

describe('legacy production compatibility', () => {
  it('runs the frozen V1 graph through the real agent/tool path without V2 shape leakage', async () => {
    const before = await frozen('graph-v1.json')
    const graph = JSON.parse(before.toString('utf8')) as MagicAgentGraphDefinition
    const runAgent = vi.fn(async (request: MagicAgentPlatformRunReq) => ({
      runId: `agent-${request.agentId ?? 'assistant'}`,
      agentId: request.agentId ?? 'assistant',
      status: 'completed' as const,
      content: `agent:${request.text}`,
      messages: [{ role: 'assistant' as const, content: 'planned' }],
      toolCalls: [],
      events: [],
      startedAt: 1,
      finishedAt: 2
    }))
    const callTool = vi.fn(async (request: { name: string }) => ({
      ok: true,
      toolName: request.name,
      source: 'magicAgentRuntime' as const,
      status: 'ok' as const,
      content: `tool:${request.name}`
    }))
    const runtime = new MagicAgentGraphRuntime([graph], { runAgent, callTool })
    const run = await runtime.run({
      graphId: graph.graphId,
      input: 'compatibility',
      route,
      runId: 'compat-run',
      allowedToolNames: ['knowledge.search']
    })

    expect(run.status, run.error).toBe('completed')
    expect(run.graphSnapshot).toMatchObject({ graphId: graph.graphId, version: graph.version })
    expect(run.graphSnapshot && Object.hasOwn(run.graphSnapshot, 'kind')).toBe(false)
    expect(run.graphSnapshot && Object.hasOwn(run.graphSnapshot, 'schemaVersion')).toBe(false)
    expect(runAgent).toHaveBeenCalled()
    expect(callTool).toHaveBeenCalled()
    expect(await frozen('graph-v1.json')).toEqual(before)
  })

  it.each([1, 2, 3] as const)(
    'normalizes and atomically migrates frozen session-v%s through the real store',
    async (version) => {
      const before = await frozen(`session-v${version}.json`)
      const file = `/sessions/v${version}/chat-sessions.json`
      await vol.promises.mkdir(path.posix.dirname(file), { recursive: true })
      await vol.promises.writeFile(file, before)
      const sessionRoute = {
        channel: 'generic',
        scopeType: 'dm' as const,
        scopeId: `legacy-v${version}`
      }
      const session = await new AssistantSessionStore(file).getSession(sessionRoute)

      expect(session).toMatchObject({ route: sessionRoute })
      if (!session) throw new Error(`Missing normalized session v${version}.`)
      if (version === 1) {
        expect(session).toMatchObject({ runs: [], artifacts: [], eventLog: [] })
      } else if (version === 2) {
        expect(session.runs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runId: 'run-v2',
              workspaceId: 'workspace-v2',
              requestText: 'compatibility request',
              responseText: 'compatibility response'
            })
          ])
        )
        expect(session.artifacts).toEqual([])
        expect(session.eventLog).toEqual([])
      } else {
        expect(session.runs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runId: 'run-v3',
              workspaceId: 'workspace-v3',
              taskGroup: expect.objectContaining({
                taskGroupId: 'fixture-group',
                status: 'approved',
                rootRunId: 'run-v3'
              })
            })
          ])
        )
      }
      const migrated = JSON.parse(String(await vol.promises.readFile(file))) as { version: number }
      expect(migrated.version).toBe(4)
      expect(Buffer.from(await vol.promises.readFile(`${file}.v${version}.bak`))).toEqual(before)
      expect(await frozen(`session-v${version}.json`)).toEqual(before)
    }
  )

  it('continues writing the current session format as v4', async () => {
    const file = '/new-sessions/chat-sessions.json'
    const store = new AssistantSessionStore(file)
    await store.appendTurn(route, [{ role: 'user', content: 'still v4' }], 10)
    await store.flush()
    const raw = JSON.parse(String(await vol.promises.readFile(file))) as {
      version: number
      sessions: Array<{ messages: Array<{ content: string }> }>
      workflows: unknown[]
    }
    expect(raw.version).toBe(4)
    expect(raw.sessions).toHaveLength(1)
    expect(raw.sessions[0].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'still v4' })])
    )
    expect(raw.workflows).toEqual([])
  })

  it('installs, lists, and inspects a frozen V1 package while preserving raw V1 data', async () => {
    const manifest = await frozen('magicpot-package-v1.json')
    const graph = await frozen('graph-v1.json')
    const source = '/packages/compat'
    await vol.promises.mkdir(`${source}/graphs`, { recursive: true })
    await vol.promises.writeFile(`${source}/magicpot-package.json`, manifest)
    await vol.promises.writeFile(`${source}/graphs/legacy.json`, graph)
    const store = new MagicAgentPackageStore('/packages', '/store')
    const installed = await store.install(source)

    expect(installed.installed).toMatchObject({ id: 'compat.fixture' })
    expect(installed.installed?.manifest.manifestVersion).toBe(1)
    expect(installed.installed?.manifest.version).toBe('1.0.0')
    expect(await store.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'compat.fixture',
          manifest: expect.objectContaining({ manifestVersion: 1 })
        })
      ])
    )
    expect((await store.list())[0]?.manifest.version).toBe('1.0.0')
    const inspection = await store.inspect('compat.fixture')
    expect(inspection.validation.ok).toBe(true)
    const installedManifest = Buffer.from(
      await vol.promises.readFile('/store/compat.fixture/package/magicpot-package.json')
    )
    const installedGraph = Buffer.from(
      await vol.promises.readFile('/store/compat.fixture/package/graphs/legacy.json')
    )
    expect(Buffer.from(await vol.promises.readFile(`${source}/magicpot-package.json`))).toEqual(
      manifest
    )
    expect(installedManifest).toEqual(manifest)
    expect(JSON.parse(installedManifest.toString('utf8'))).toMatchObject({
      manifestVersion: 1,
      id: 'compat.fixture',
      version: '1.0.0'
    })
    expect(installedGraph).toEqual(graph)
    const installedGraphJson = JSON.parse(installedGraph.toString('utf8')) as Record<
      string,
      unknown
    >
    expect(Object.hasOwn(installedGraphJson, 'kind')).toBe(false)
    expect(Object.hasOwn(installedGraphJson, 'schemaVersion')).toBe(false)
    expect(digest(await frozen('magicpot-package-v1.json'))).toBe(digest(manifest))
    expect(digest(await frozen('graph-v1.json'))).toBe(digest(graph))
  })
})
