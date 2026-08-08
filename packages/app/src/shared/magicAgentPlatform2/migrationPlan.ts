import type { MagicAgentGraphDefinition } from '@shared/magicAgent'
import {
  convertGraphDefinitionV1ToV2Draft,
  validateGraphDefinitionV2Draft,
  type GraphDefinitionV2Draft,
  type GraphJsonValue
} from './graphDefinitionV2Draft'
import { GRAPH_SCHEMA_VERSION } from './versions'

export const MIGRATION_PLAN_KIND = 'magic-agent.migration-plan.v1' as const
export const MIGRATION_PLAN_MODE = 'preview-only' as const
export const GRAPH_V2_DRAFT_MIGRATION_VERSION = GRAPH_SCHEMA_VERSION.value

export type MigrationSourceKind =
  | 'graph-v1'
  | 'session-v1'
  | 'session-v2'
  | 'session-v3'
  | 'package-manifest-v1'
export type MigrationTargetKind =
  | 'graph-v2-draft'
  | 'event-store-v1'
  | 'package-manifest-v1-preserved'

export type MigrationEndpoint = Readonly<{
  kind: MigrationSourceKind | MigrationTargetKind
  version: string
  resourceId?: string
}>
export type MigrationPlan = Readonly<{
  kind: typeof MIGRATION_PLAN_KIND
  mode: typeof MIGRATION_PLAN_MODE
  migrationId: string
  source: Readonly<{ kind: MigrationSourceKind; version: string; resourceId?: string }>
  target: Readonly<{ kind: MigrationTargetKind; version: string; resourceId?: string }>
  sourceHash: string
  createdAt: number
  preconditions: readonly string[]
  steps: readonly string[]
  warnings: readonly string[]
  rollback: readonly string[]
  artifacts?: readonly Readonly<{ kind: string; value: GraphJsonValue }>[]
  readonly [key: string]: GraphJsonValue | undefined
}>
export type MigrationPlanIssue = Readonly<{ code: string; path: string; message: string }>
export type MigrationPlanValidationResult = Readonly<{
  valid: boolean
  issues: readonly MigrationPlanIssue[]
}>
export type MigrationPlanParseResult =
  | Readonly<{ ok: true; value: MigrationPlan; issues: readonly [] }>
  | Readonly<{ ok: false; issues: readonly MigrationPlanIssue[] }>

const sourceKinds = new Set<MigrationSourceKind>([
  'graph-v1',
  'session-v1',
  'session-v2',
  'session-v3',
  'package-manifest-v1'
])
const targetKinds = new Set<MigrationTargetKind>([
  'graph-v2-draft',
  'event-store-v1',
  'package-manifest-v1-preserved'
])
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor'])
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const inspectJson = (
  value: unknown,
  path: string,
  issues: MigrationPlanIssue[],
  ancestors: Set<object>
): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return true
    issues.push({ code: 'not-json-safe', path, message: 'JSON numbers must be finite.' })
    return false
  }
  if (typeof value !== 'object') {
    issues.push({ code: 'not-json-safe', path, message: 'Expected a JSON-safe value.' })
    return false
  }
  if (ancestors.has(value)) {
    issues.push({ code: 'cyclic-value', path, message: 'JSON values must not contain cycles.' })
    return false
  }
  try {
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      (!array && prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== 'string')
    ) {
      issues.push({
        code: 'not-json-safe',
        path,
        message: 'Expected arrays or plain records with string keys.'
      })
      return false
    }
    ancestors.add(value)
    let valid = true
    if (array) {
      const length = descriptors.length?.value
      if (typeof length !== 'number') valid = false
      else {
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)]
          if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
            issues.push({
              code: 'unsafe-property',
              path: `${path}[${index}]`,
              message: 'Sparse arrays and accessors are forbidden.'
            })
            valid = false
          } else if (!inspectJson(descriptor.value, `${path}[${index}]`, issues, ancestors))
            valid = false
        }
        for (const key of keys) {
          if (
            key === 'length' ||
            (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length)
          )
            continue
          issues.push({
            code: 'unsafe-property',
            path: `${path}.${String(key)}`,
            message: 'Array properties are forbidden.'
          })
          valid = false
        }
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string') {
          valid = false
          continue
        }
        const descriptor = descriptors[key]
        const childPath = `${path}.${key}`
        if (
          dangerousKeys.has(key) ||
          !descriptor ||
          descriptor.enumerable !== true ||
          !('value' in descriptor)
        ) {
          issues.push({
            code: 'unsafe-property',
            path: childPath,
            message: 'Accessors, hidden properties, and dangerous keys are forbidden.'
          })
          valid = false
        } else if (!inspectJson(descriptor.value, childPath, issues, ancestors)) valid = false
      }
    }
    ancestors.delete(value)
    return valid
  } catch {
    issues.push({ code: 'unsafe-access', path, message: 'Value could not be inspected safely.' })
    return false
  }
}

const nonEmptyTrimmed = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim()
const issue = (issues: MigrationPlanIssue[], code: string, path: string, message: string): void => {
  issues.push({ code, path, message })
}

export const validateMigrationPlan = (input: unknown): MigrationPlanValidationResult => {
  const issues: MigrationPlanIssue[] = []
  try {
    if (
      !inspectJson(input, '$', issues, new Set()) ||
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input)
    )
      return { valid: false, issues }
    const plan = input as Record<string, unknown>
    const checkString = (key: string): void => {
      if (!nonEmptyTrimmed(plan[key]))
        issue(issues, 'invalid-string', `$.${key}`, 'Expected a trim-non-empty string.')
    }
    if (plan.kind !== MIGRATION_PLAN_KIND)
      issue(issues, 'invalid-discriminator', '$.kind', `Expected ${MIGRATION_PLAN_KIND}.`)
    if (plan.mode !== MIGRATION_PLAN_MODE)
      issue(issues, 'invalid-mode', '$.mode', `Expected ${MIGRATION_PLAN_MODE}.`)
    checkString('migrationId')
    if (typeof plan.sourceHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(plan.sourceHash))
      issue(
        issues,
        'invalid-source-hash',
        '$.sourceHash',
        'Expected sha256 followed by 64 lowercase hex characters.'
      )
    if (typeof plan.createdAt !== 'number' || !Number.isFinite(plan.createdAt))
      issue(issues, 'invalid-created-at', '$.createdAt', 'Expected a finite number.')

    let source: Record<string, unknown> | undefined
    let target: Record<string, unknown> | undefined
    for (const endpointName of ['source', 'target'] as const) {
      const endpoint = plan[endpointName]
      if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) {
        issue(issues, 'invalid-endpoint', `$.${endpointName}`, 'Expected an endpoint record.')
        continue
      }
      const record = endpoint as Record<string, unknown>
      if (endpointName === 'source') source = record
      else target = record
      const validKind =
        endpointName === 'source'
          ? sourceKinds.has(record.kind as MigrationSourceKind)
          : targetKinds.has(record.kind as MigrationTargetKind)
      if (!validKind)
        issue(issues, 'invalid-kind', `$.${endpointName}.kind`, `Unsupported ${endpointName} kind.`)
      if (!nonEmptyTrimmed(record.version))
        issue(
          issues,
          'invalid-version',
          `$.${endpointName}.version`,
          'Expected a trim-non-empty version string.'
        )
      if (hasOwn(record, 'resourceId') && !nonEmptyTrimmed(record.resourceId))
        issue(
          issues,
          'invalid-string',
          `$.${endpointName}.resourceId`,
          'Expected a trim-non-empty resource id.'
        )
    }

    if (
      source &&
      target &&
      sourceKinds.has(source.kind as MigrationSourceKind) &&
      targetKinds.has(target.kind as MigrationTargetKind)
    ) {
      const expectedTarget =
        source.kind === 'graph-v1'
          ? 'graph-v2-draft'
          : typeof source.kind === 'string' && /^session-v[123]$/.test(source.kind)
            ? 'event-store-v1'
            : source.kind === 'package-manifest-v1'
              ? 'package-manifest-v1-preserved'
              : undefined
      if (target.kind !== expectedTarget)
        issue(
          issues,
          'invalid-migration-pair',
          '$.target.kind',
          'Target kind is not valid for the source kind.'
        )
      const expectedSourceVersion =
        typeof source.kind === 'string' && /^session-v([123])$/.exec(source.kind)?.[1]
      if (expectedSourceVersion && source.version !== expectedSourceVersion)
        issue(
          issues,
          'version-mismatch',
          '$.source.version',
          'Session source version must match its source kind.'
        )
      if (source.kind === 'package-manifest-v1' && source.version !== '1')
        issue(
          issues,
          'version-mismatch',
          '$.source.version',
          'Package manifest V1 uses schema version 1.'
        )
      const expectedTargetVersion =
        source.kind === 'graph-v1' ? GRAPH_V2_DRAFT_MIGRATION_VERSION : '1'
      if (target.version !== expectedTargetVersion)
        issue(
          issues,
          'version-mismatch',
          '$.target.version',
          `Expected target version ${expectedTargetVersion}.`
        )
      if (source.kind === 'package-manifest-v1' && source.version !== target.version)
        issue(
          issues,
          'version-mismatch',
          '$.target.version',
          'Package preservation versions must match.'
        )
    }

    for (const key of ['preconditions', 'steps', 'warnings', 'rollback'] as const) {
      const value = plan[key]
      if (!Array.isArray(value) || value.length === 0)
        issue(issues, 'empty-array', `$.${key}`, 'Expected a non-empty array.')
      else
        value.forEach((item, index) => {
          if (!nonEmptyTrimmed(item))
            issue(
              issues,
              'invalid-string',
              `$.${key}[${index}]`,
              'Expected a trim-non-empty string.'
            )
        })
    }

    if (source?.kind === 'graph-v1') {
      if (!Array.isArray(plan.artifacts) || plan.artifacts.length !== 1) {
        issue(
          issues,
          'invalid-artifacts',
          '$.artifacts',
          'Graph migration requires exactly one preview artifact.'
        )
      } else {
        const artifact = plan.artifacts[0]
        if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
          issue(issues, 'invalid-artifact', '$.artifacts[0]', 'Expected a plain artifact record.')
        } else {
          const record = artifact as Record<string, unknown>
          if (
            Reflect.ownKeys(record).length !== 2 ||
            !hasOwn(record, 'kind') ||
            !hasOwn(record, 'value')
          )
            issue(
              issues,
              'invalid-artifact',
              '$.artifacts[0]',
              'Artifact must contain exactly kind and value.'
            )
          if (record.kind !== 'graph-v2-draft-preview')
            issue(
              issues,
              'invalid-artifact',
              '$.artifacts[0].kind',
              'Expected graph-v2-draft-preview.'
            )
          const graphResult = validateGraphDefinitionV2Draft(record.value)
          if (!graphResult.valid)
            issue(
              issues,
              'invalid-artifact',
              '$.artifacts[0].value',
              'Expected a valid Graph V2 draft.'
            )
          if (
            nonEmptyTrimmed(source.resourceId) &&
            typeof record.value === 'object' &&
            record.value !== null &&
            (record.value as Record<string, unknown>).graphId !== source.resourceId
          )
            issue(
              issues,
              'version-mismatch',
              '$.artifacts[0].value.graphId',
              'Artifact graphId must match source resourceId.'
            )
        }
      }
    } else if (hasOwn(plan, 'artifacts')) {
      issue(
        issues,
        'invalid-artifacts',
        '$.artifacts',
        'This migration kind must not contain artifacts.'
      )
    }
  } catch {
    issue(issues, 'unsafe-access', '$', 'Value could not be inspected safely.')
  }
  return { valid: issues.length === 0, issues }
}

const cloneAndFreezeJson = (input: unknown): GraphJsonValue => {
  const ancestors = new Set<object>()
  const clones = new Map<object, GraphJsonValue>()
  const clone = (value: unknown): GraphJsonValue => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    )
      return value
    if (typeof value !== 'object') throw new Error('Expected JSON-safe value.')
    if (ancestors.has(value)) throw new Error('Cyclic JSON value.')
    const previous = clones.get(value)
    if (previous !== undefined) return previous
    ancestors.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Array.isArray(value)) {
      const result: GraphJsonValue[] = []
      clones.set(value, result)
      const length = descriptors.length?.value as number
      for (let index = 0; index < length; index += 1)
        result.push(clone(descriptors[String(index)].value))
      ancestors.delete(value)
      return Object.freeze(result)
    }
    const result: Record<string, GraphJsonValue> = {}
    clones.set(value, result)
    for (const key of Object.keys(descriptors)) result[key] = clone(descriptors[key].value)
    ancestors.delete(value)
    return Object.freeze(result)
  }
  return clone(input)
}

export const parseMigrationPlan = (input: unknown): MigrationPlanParseResult => {
  const result = validateMigrationPlan(input)
  return result.valid
    ? { ok: true, value: cloneAndFreezeJson(input) as MigrationPlan, issues: [] }
    : { ok: false, issues: result.issues }
}

const base = (migrationId: string, sourceHash: string, createdAt: number) => ({
  kind: MIGRATION_PLAN_KIND,
  mode: MIGRATION_PLAN_MODE,
  migrationId,
  sourceHash,
  createdAt
})
const assertPlan = (plan: unknown): MigrationPlan => {
  const result = parseMigrationPlan(plan)
  if (!result.ok)
    throw new Error(result.issues.map((entry) => `${entry.path}: ${entry.message}`).join('; '))
  return result.value
}

export const createGraphV1MigrationPlan = (
  input: Readonly<{
    migrationId: string
    sourceHash: string
    createdAt: number
    graph: MagicAgentGraphDefinition
  }>
): MigrationPlan =>
  assertPlan({
    ...base(input.migrationId, input.sourceHash, input.createdAt),
    source: { kind: 'graph-v1', version: input.graph.version, resourceId: input.graph.graphId },
    target: { kind: 'graph-v2-draft', version: GRAPH_V2_DRAFT_MIGRATION_VERSION },
    preconditions: [
      'Source is a valid JSON-persistable Graph V1.',
      'Caller-provided source hash matches the current source bytes.',
      'Current Graph V1 remains untouched.'
    ],
    steps: [
      'Validate the Graph V1 source.',
      'After explicit approval, create a separate Graph V2 draft.',
      'After explicit approval, store the new draft separately.'
    ],
    warnings: ['External side effects are unaffected by this preview plan.'],
    rollback: ['Delete only the newly created target.', 'Leave the Graph V1 source untouched.'],
    artifacts: [
      {
        kind: 'graph-v2-draft-preview',
        value: convertGraphDefinitionV1ToV2Draft(input.graph) as unknown as GraphJsonValue
      }
    ]
  })

export const createSessionMigrationPlan = (
  input: Readonly<{
    migrationId: string
    sourceHash: string
    createdAt: number
    storageVersion: 1 | 2 | 3
  }>
): MigrationPlan =>
  assertPlan({
    ...base(input.migrationId, input.sourceHash, input.createdAt),
    source: {
      kind: `session-v${input.storageVersion}` as const,
      version: String(input.storageVersion)
    },
    target: { kind: 'event-store-v1', version: '1' },
    preconditions: [
      'Source session JSON is readable.',
      'Caller-provided source hash matches the current source bytes.',
      'Current session source remains untouched.'
    ],
    steps: [
      'Read the current session source.',
      'Validate the source without importing it.',
      'After explicit approval, create a separate event-store-v1 target.',
      'Verify the separate target.',
      'Explicitly switch authority only after verification.'
    ],
    warnings: ['Current source remains authoritative until an explicit switch.'],
    rollback: [
      'Delete only the new event-store target.',
      'Leave the current session source untouched.'
    ]
  })

export const createPackageV1PreservationPlan = (
  input: Readonly<{
    migrationId: string
    sourceHash: string
    createdAt: number
  }>
): MigrationPlan =>
  assertPlan({
    ...base(input.migrationId, input.sourceHash, input.createdAt),
    source: { kind: 'package-manifest-v1', version: '1' },
    target: { kind: 'package-manifest-v1-preserved', version: '1' },
    preconditions: [
      'Package manifest is valid V1 JSON.',
      'Caller-provided source hash matches the current source bytes.',
      'Current package remains untouched.'
    ],
    steps: [
      'Validate the current V1 manifest.',
      'Continue using the current package store.',
      'Do not rewrite the manifest.'
    ],
    warnings: ['No V2 contribution semantics are inferred.'],
    rollback: ['No-op: no target rewrite or source mutation is planned.']
  })
