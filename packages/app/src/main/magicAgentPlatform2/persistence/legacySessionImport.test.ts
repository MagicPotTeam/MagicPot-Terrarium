import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)
vi.mock('../../config/buildEnv', () => ({
  getBuildEnv: () => ({ pathMap: { data: process.cwd() } })
}))
import { MagicAgentEventStore } from './eventStore'
import {
  createLegacySessionImportPlan,
  executeLegacySessionImportPlan,
  LegacySessionImportFileTooLargeError,
  LegacySessionImportSourceChangedError,
  LegacySessionImportValidationError,
  MAX_LEGACY_SESSION_IMPORT_BYTES,
  parseLegacySessionImportPlan
} from './legacySessionImport'

let directory: string
let sourcePath: string
let store: MagicAgentEventStore | undefined

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'legacy' }
const session = (overrides: Record<string, unknown> = {}) => ({
  route,
  messages: [{ role: 'user', content: 'hello' }],
  createdAt: 10,
  updatedAt: 20,
  runs: [],
  artifacts: [],
  eventLog: [],
  unknown: { retained: true },
  ...overrides
})

async function writeSource(value: unknown): Promise<void> {
  await fs.writeFile(sourcePath, JSON.stringify(value))
}

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'legacy-session-import-test-'))
  sourcePath = join(directory, 'chat-sessions.json')
})
afterEach(async () => {
  store?.close()
  store = undefined
  await fs.rm(directory, { recursive: true, force: true })
})

describe('legacySessionImport', () => {
  for (const version of [1, 2, 3] as const) {
    it(`creates a frozen raw and normalized v${version} plan`, async () => {
      const raw = { version, topUnknown: { retained: version }, sessions: [session()] }
      await writeSource(raw)
      const before = await fs.readFile(sourcePath)
      const plan = await createLegacySessionImportPlan({ sourcePath, createdAt: 100 })
      expect(plan.source.storageVersion).toBe(version)
      expect(plan.rawFile).toEqual(raw)
      expect(plan.entries[0].raw).toEqual(raw.sessions[0])
      expect(plan.entries[0].normalized).toMatchObject({ createdAt: 10, updatedAt: 20 })
      expect(plan.counts).toEqual({ sessions: 1, runs: 0, artifacts: 0, resources: 2 })
      expect(plan.contentDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(Object.isFrozen(plan.entries[0].normalized)).toBe(true)
      expect(await fs.readFile(sourcePath)).toEqual(before)
    })
  }

  it('makes content deterministic across plan creation timestamps', async () => {
    await writeSource({ version: 3, sessions: [session()] })
    const first = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    const second = await createLegacySessionImportPlan({ sourcePath, createdAt: 2 })
    expect(second.contentDigest).toBe(first.contentDigest)
    expect(second.entries).toEqual(first.entries)
    expect(second.createdAt).not.toBe(first.createdAt)
  })

  it('sanitizes invalid and store-fallback timestamps to zero deterministically', async () => {
    await writeSource({
      version: 3,
      sessions: [session({ createdAt: 'bad', updatedAt: -1 })]
    })
    const first = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    const second = await createLegacySessionImportPlan({ sourcePath, createdAt: 2 })
    expect(first.entries[0].normalized).toMatchObject({ createdAt: 0, updatedAt: 0 })
    expect(second.entries).toEqual(first.entries)
  })

  it('strictly parses a detached frozen plan and rejects forged digest/count/raw data', async () => {
    await writeSource({ version: 3, sessions: [session()] })
    const plan = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    const parsed = parseLegacySessionImportPlan(JSON.parse(JSON.stringify(plan)))
    expect(parsed).not.toBe(plan)
    expect(Object.isFrozen(parsed.rawFile)).toBe(true)
    for (const patch of [
      { contentDigest: '0'.repeat(64) },
      { counts: { ...plan.counts, sessions: 2 } },
      { rawFile: { version: 3, sessions: [] } },
      { importId: 'forged' }
    ])
      expect(() => parseLegacySessionImportPlan({ ...plan, ...patch })).toThrow(
        LegacySessionImportValidationError
      )
  })

  it('rejects duplicate normalized session keys without writing', async () => {
    await writeSource({ version: 3, sessions: [session(), session({ unknown: 2 })] })
    await expect(createLegacySessionImportPlan({ sourcePath, createdAt: 1 })).rejects.toThrow(
      LegacySessionImportValidationError
    )
  })

  it('executes atomically, persists only normalized records, and replays exactly', async () => {
    const rawArtifact = {
      artifactId: 'artifact-a',
      runId: 'run-a',
      kind: 'text',
      createdAt: 13,
      source: 'tool',
      content: 'secret bytes',
      path: 'C:\\secret\\local.txt',
      custom: 'retained'
    }
    await writeSource({
      version: 3,
      topUnknown: true,
      sessions: [
        session({
          runs: [
            {
              runId: 'run-a',
              status: 'completed',
              runOrigin: 'user',
              rootRunId: 'run-a',
              createdAt: 11,
              updatedAt: 12,
              artifactIds: ['artifact-a']
            }
          ],
          artifacts: [rawArtifact]
        })
      ]
    })
    const plan = await createLegacySessionImportPlan({ sourcePath, createdAt: 999 })
    store = new MagicAgentEventStore(join(directory, 'events.sqlite'))
    const first = await executeLegacySessionImportPlan(store, plan)
    expect(first).toMatchObject({ imported: 4, replayed: 0, authoritySwitched: false })
    const resources = store.listResources({ limit: 20 })
    const sessionResource = resources.find((item) => item.kind === 'session')!
    expect(sessionResource.state).toHaveProperty('normalizedRecord.createdAt', 10)
    expect(sessionResource.state).not.toHaveProperty('normalizedRecord.unknown')
    const runResource = resources.find((item) => item.kind === 'run')!
    expect(runResource.state).toHaveProperty('normalizedRecord.runId', 'run-a')
    const artifact = resources.find((item) => item.kind === 'artifact')!
    expect(JSON.stringify(artifact.state)).not.toContain('secret bytes')
    expect(JSON.stringify(artifact.state)).not.toContain('C:\\\\secret')
    expect(artifact.state).toMatchObject({
      artifactId: 'artifact-a',
      legacyRef: {
        normalizedDescriptor: { custom: 'retained' },
        omittedFields: ['content', 'path']
      }
    })
    expect(Object.keys((artifact.state as { legacyRef: object }).legacyRef).sort()).toEqual([
      'normalizedDescriptor',
      'omittedFields'
    ])
    expect((await executeLegacySessionImportPlan(store, plan)).replayed).toBe(4)
    expect(store.countEvents()).toBe(4)
  })

  it('recreated plans replay because mutations do not depend on plan createdAt', async () => {
    await writeSource({ version: 3, sessions: [session()] })
    const first = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    const second = await createLegacySessionImportPlan({ sourcePath, createdAt: 999 })
    store = new MagicAgentEventStore(join(directory, 'events.sqlite'))
    expect((await executeLegacySessionImportPlan(store, first)).imported).toBe(2)
    expect((await executeLegacySessionImportPlan(store, second)).replayed).toBe(2)
  })

  it('rejects a changed source before database writes', async () => {
    await writeSource({ version: 3, sessions: [session()] })
    const plan = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    await writeSource({ version: 3, sessions: [session({ updatedAt: 21 })] })
    store = new MagicAgentEventStore(join(directory, 'events.sqlite'))
    await expect(executeLegacySessionImportPlan(store, plan)).rejects.toThrow(
      LegacySessionImportSourceChangedError
    )
    expect(store.countResources()).toBe(0)
    expect(store.countEvents()).toBe(0)
  })

  it('rejects an oversized sparse source before allocating it', async () => {
    await fs.writeFile(sourcePath, '')
    await fs.truncate(sourcePath, MAX_LEGACY_SESSION_IMPORT_BYTES + 1)
    await expect(createLegacySessionImportPlan({ sourcePath, createdAt: 1 })).rejects.toThrow(
      LegacySessionImportFileTooLargeError
    )
  })

  it('omits store-derived workspace paths and sanitizes explicit workspace paths', async () => {
    await writeSource({ version: 3, sessions: [session()] })
    const derived = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    expect(derived.entries[0].normalized).not.toHaveProperty('workspace')

    await writeSource({
      version: 3,
      sessions: [
        session({
          workspace: { workspaceId: 'safe', rootDir: 'C:\\secret', memoryFile: '/secret' }
        })
      ]
    })
    const explicit = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    expect(explicit.entries[0].normalized).toMatchObject({ workspace: { workspaceId: 'safe' } })
    expect(JSON.stringify(explicit.entries[0].normalized)).not.toContain('secret')
  })

  it('includes the manifest in its binary-sorted resource id list', async () => {
    await writeSource({ version: 3, sessions: [session()] })
    const plan = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    store = new MagicAgentEventStore(join(directory, 'events.sqlite'))
    await executeLegacySessionImportPlan(store, plan)
    const resources = store.listResources({ limit: 20 })
    const manifest = resources.find((item) => item.kind === 'legacy-session-import')!
    const ids = resources.map((item) => item.id).sort()
    expect((manifest.state as { resourceIds: string[] }).resourceIds).toEqual(ids)
    expect(ids).toHaveLength(plan.counts.resources)
  })

  it('removes nested artifact and attachment secrets from every persisted resource', async () => {
    const artifact = {
      artifactId: 'artifact-a',
      runId: 'run-a',
      kind: 'text',
      createdAt: 13,
      source: 'tool',
      content: 'artifact-secret',
      metadata: { storagePath: '/artifact-secret-path', nested: { buffer: 'bytes-secret' } }
    }
    await writeSource({
      version: 3,
      sessions: [
        session({
          messages: [
            {
              role: 'user',
              content: 'message retained',
              attachments: [
                { url: 'https://safe', path: '/attachment-secret', data: 'data-secret' }
              ]
            }
          ],
          runs: [
            {
              runId: 'run-a',
              status: 'completed',
              runOrigin: 'user',
              rootRunId: 'run-a',
              createdAt: 11,
              updatedAt: 12,
              artifactIds: ['artifact-a'],
              taskGroup: { taskGroupId: 'g' }
            }
          ],
          artifacts: [artifact]
        })
      ]
    })
    const plan = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    expect(JSON.stringify(plan.rawFile)).toContain('artifact-secret')
    store = new MagicAgentEventStore(join(directory, 'events.sqlite'))
    await executeLegacySessionImportPlan(store, plan)
    const persisted = JSON.stringify(store.listResources({ limit: 20 }))
    expect(persisted).toContain('message retained')
    expect(persisted).toContain('taskGroupId')
    for (const key of ['rawRecord', 'rawDescriptor', 'rawFile'])
      expect(persisted).not.toContain(key)
    for (const secret of ['artifact-secret', 'bytes-secret', 'attachment-secret', 'data-secret'])
      expect(persisted).not.toContain(secret)
  })

  it('waits for every isolated session cleanup when one session is invalid', async () => {
    const before = new Set(
      (await fs.readdir(tmpdir())).filter((name) => name.startsWith('magicpot-legacy-import-'))
    )
    await writeSource({
      version: 3,
      sessions: [session({ route: undefined }), session({ route: { ...route, scopeId: 'valid' } })]
    })
    await expect(createLegacySessionImportPlan({ sourcePath, createdAt: 1 })).rejects.toThrow()
    const after = (await fs.readdir(tmpdir())).filter(
      (name) => name.startsWith('magicpot-legacy-import-') && !before.has(name)
    )
    expect(after).toEqual([])
  })

  it('sanitizes manifest source metadata without changing plan rawFile', async () => {
    const sourceMetadata = {
      path: '/private/source',
      blob: 'private-blob',
      nested: { cacheDir: '/private/cache', data: 'private-data', retained: true }
    }
    await writeSource({ version: 3, sourceMetadata, sessions: [session()] })
    const plan = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    expect(plan.rawFile).toMatchObject({ sourceMetadata })
    store = new MagicAgentEventStore(join(directory, 'events.sqlite'))
    await executeLegacySessionImportPlan(store, plan)
    const manifest = store
      .listResources({ limit: 20 })
      .find((resource) => resource.kind === 'legacy-session-import')!
    expect(manifest.state).toMatchObject({
      sourceMetadata: { sourceMetadata: { nested: { retained: true } } }
    })
    expect(JSON.stringify(manifest.state)).not.toContain('private-')
  })

  it.each([
    'workspaceRootDir',
    'memoryFile',
    'contextFile',
    'outputDir',
    'cacheDir',
    'tempDir',
    'downloadPath',
    'localFile',
    'absolutePath',
    'storagePath'
  ])('removes protected nested artifact field %s', async (sensitiveKey) => {
    const artifact = {
      artifactId: 'artifact-a',
      runId: 'run-a',
      kind: 'text',
      createdAt: 13,
      source: 'tool',
      metadata: { nested: { [sensitiveKey]: 'private-value', retained: true } }
    }
    await writeSource({
      version: 3,
      sessions: [
        session({
          runs: [
            {
              runId: 'run-a',
              status: 'completed',
              runOrigin: 'user',
              rootRunId: 'run-a',
              createdAt: 11,
              updatedAt: 12,
              artifactIds: ['artifact-a']
            }
          ],
          artifacts: [artifact]
        })
      ]
    })
    const plan = await createLegacySessionImportPlan({ sourcePath, createdAt: 1 })
    store = new MagicAgentEventStore(join(directory, 'events.sqlite'))
    await executeLegacySessionImportPlan(store, plan)
    const artifactState = store
      .listResources({ limit: 20 })
      .find((resource) => resource.kind === 'artifact')!.state
    expect(JSON.stringify(artifactState)).not.toContain('private-value')
    expect(artifactState).toMatchObject({
      legacyRef: { normalizedDescriptor: { metadata: { nested: { retained: true } } } }
    })
  })

  it('rejects corrupt and unsupported files consistently', async () => {
    await fs.writeFile(sourcePath, '{')
    await expect(createLegacySessionImportPlan({ sourcePath, createdAt: 1 })).rejects.toThrow(
      LegacySessionImportValidationError
    )
    await writeSource({ version: 4, sessions: [] })
    await expect(createLegacySessionImportPlan({ sourcePath, createdAt: 1 })).rejects.toThrow(
      LegacySessionImportValidationError
    )
  })
})
