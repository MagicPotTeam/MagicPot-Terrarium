import { describe, expect, it, vi } from 'vitest'
import type { MagicAgentGraphDefinition } from '@shared/magicAgent'
import { graphV1Fixture, graphV1FixtureSource } from './fixtures/graphV1Fixture'
import {
  GRAPH_SCHEMA_VERSION,
  createGraphV1MigrationPlan,
  createPackageV1PreservationPlan,
  createSessionMigrationPlan,
  parseMigrationPlan,
  validateGraphDefinitionV2Draft,
  validateMigrationPlan
} from './index'

const hash = `sha256:${'a'.repeat(64)}`
const readFixture = async (): Promise<MagicAgentGraphDefinition> =>
  JSON.parse(JSON.stringify(graphV1Fixture)) as MagicAgentGraphDefinition
const graphPlan = async () =>
  createGraphV1MigrationPlan({
    migrationId: 'migration-1',
    sourceHash: hash,
    createdAt: 123,
    graph: await readFixture()
  })
const codes = (input: unknown): string[] =>
  validateMigrationPlan(input).issues.map((entry) => entry.code)

const deepFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return true
  seen.add(value)
  if (!Object.isFrozen(value)) return false
  return Reflect.ownKeys(value).every((key) =>
    deepFrozen(Reflect.getOwnPropertyDescriptor(value, key)?.value, seen)
  )
}

describe('migration plans', () => {
  it('creates a deterministic, frozen graph preview without mutating its source', async () => {
    const graph = await readFixture()
    const before = JSON.stringify(graph)
    const input = { migrationId: 'migration-1', sourceHash: hash, createdAt: 123, graph }
    const first = createGraphV1MigrationPlan(input)
    const second = createGraphV1MigrationPlan(input)

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(JSON.stringify(graph)).toBe(before)
    expect(first.source).toEqual({
      kind: 'graph-v1',
      version: graph.version,
      resourceId: graph.graphId
    })
    expect(first.target.version).toBe(GRAPH_SCHEMA_VERSION.value)
    expect(first.artifacts).toHaveLength(1)
    expect(validateGraphDefinitionV2Draft(first.artifacts?.[0]?.value).valid).toBe(true)
    expect(deepFrozen(first)).toBe(true)
  })

  it.each([1, 2, 3] as const)('maps session storage v%s without an artifact', (storageVersion) => {
    const plan = createSessionMigrationPlan({
      migrationId: `session-${storageVersion}`,
      sourceHash: hash,
      createdAt: 1,
      storageVersion
    })
    expect(plan.source).toEqual({
      kind: `session-v${storageVersion}`,
      version: String(storageVersion)
    })
    expect(plan.target).toEqual({ kind: 'event-store-v1', version: '1' })
    expect(plan.artifacts).toBeUndefined()
    expect(deepFrozen(plan)).toBe(true)
  })

  it('preserves package manifest schema V1 rather than the package business version', () => {
    const plan = createPackageV1PreservationPlan({
      migrationId: 'package-1',
      sourceHash: hash,
      createdAt: 1
    })
    expect(plan.source.version).toBe('1')
    expect(plan.target).toEqual({ kind: 'package-manifest-v1-preserved', version: '1' })
    expect(plan.artifacts).toBeUndefined()
  })

  it('returns a detached readonly clone and retains cloned JSON-safe extensions', async () => {
    const shared = { retained: true }
    const plan = { ...(await graphPlan()), extension: { sharedA: shared, sharedB: shared } }
    const parsed = parseMigrationPlan(plan)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value).not.toBe(plan)
    expect(parsed.value.extension).toEqual({
      sharedA: { retained: true },
      sharedB: { retained: true }
    })
    const extension = parsed.value.extension as Readonly<{
      sharedA: Readonly<{ retained: boolean }>
      sharedB: object
    }>
    expect(extension.sharedA).toBe(extension.sharedB)
    expect(deepFrozen(parsed.value)).toBe(true)
    shared.retained = false
    plan.preconditions = ['tampered']
    expect(extension.sharedA.retained).toBe(true)
    expect(parsed.value.preconditions).not.toEqual(['tampered'])
  })

  it('rejects invalid migration pairs and endpoint versions with stable issue codes', async () => {
    const graph = await graphPlan()
    expect(codes({ ...graph, target: { kind: 'event-store-v1', version: '1' } })).toContain(
      'invalid-migration-pair'
    )
    expect(codes({ ...graph, target: { ...graph.target, version: 'draft-1' } })).toContain(
      'version-mismatch'
    )
    const session = createSessionMigrationPlan({
      migrationId: 'session',
      sourceHash: hash,
      createdAt: 1,
      storageVersion: 2
    })
    expect(codes({ ...session, source: { ...session.source, version: '3' } })).toContain(
      'version-mismatch'
    )
    const pkg = createPackageV1PreservationPlan({
      migrationId: 'package',
      sourceHash: hash,
      createdAt: 1
    })
    expect(
      codes({
        ...pkg,
        source: { ...pkg.source, version: '1.0.0' },
        target: { ...pkg.target, version: '1.0.0' }
      })
    ).toContain('version-mismatch')
  })

  it('fully validates graph artifacts and rejects artifacts for session/package plans', async () => {
    const graph = await graphPlan()
    expect(codes({ ...graph, artifacts: [] })).toContain('invalid-artifacts')
    expect(
      codes({ ...graph, artifacts: [{ kind: 'wrong', value: graph.artifacts?.[0]?.value }] })
    ).toContain('invalid-artifact')
    const draft = graph.artifacts?.[0]?.value as Record<string, unknown>
    expect(
      codes({
        ...graph,
        artifacts: [{ kind: 'graph-v2-draft-preview', value: { ...draft, graphId: 'tampered' } }]
      })
    ).toContain('version-mismatch')
    expect(
      codes({
        ...graph,
        artifacts: [{ kind: 'graph-v2-draft-preview', value: { ...draft, nodes: [] }, extra: true }]
      })
    ).toContain('invalid-artifact')
    const session = createSessionMigrationPlan({
      migrationId: 'session',
      sourceHash: hash,
      createdAt: 1,
      storageVersion: 1
    })
    const pkg = createPackageV1PreservationPlan({
      migrationId: 'package',
      sourceHash: hash,
      createdAt: 1
    })
    expect(codes({ ...session, artifacts: graph.artifacts })).toContain('invalid-artifacts')
    expect(codes({ ...pkg, artifacts: [] })).toContain('invalid-artifacts')
  })

  it('rejects invalid required fields and endpoint resource ids', async () => {
    const plan = await graphPlan()
    for (const patch of [
      { sourceHash: 'SHA256:bad' },
      { mode: 'apply' },
      { steps: [] },
      { createdAt: Number.NaN },
      { migrationId: ' padded ' },
      { source: { ...plan.source, resourceId: ' ' } }
    ])
      expect(validateMigrationPlan({ ...plan, ...patch }).valid).toBe(false)
  })

  it('never throws for getters, proxies, cycles, sparse arrays, or unsafe JSON', async () => {
    const plan = await graphPlan()
    const getter = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get: () => {
        throw new Error('boom')
      }
    })
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom')
        }
      }
    )
    const cyclic: Record<string, unknown> = { ...plan }
    cyclic.self = cyclic
    const sparse = [...plan.steps]
    delete sparse[0]
    for (const value of [
      getter,
      proxy,
      cyclic,
      { ...plan, extension: Infinity },
      { ...plan, steps: sparse }
    ]) {
      expect(() => validateMigrationPlan(value)).not.toThrow()
      expect(validateMigrationPlan(value).valid).toBe(false)
      expect(parseMigrationPlan(value).ok).toBe(false)
    }
  })

  it('has no node filesystem or crypto imports and does not change fixture bytes', async () => {
    const moduleSource = await import('./migrationPlan.ts?raw').then((module) => module.default)
    const before = graphV1FixtureSource
    await graphPlan()
    expect(moduleSource).not.toMatch(/from ['"](?:node:)?(?:fs|crypto)/)
    expect(graphV1FixtureSource).toBe(before)
  })
})
