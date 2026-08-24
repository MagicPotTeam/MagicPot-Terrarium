import { canonicalPolicyJson, sha256PolicyText } from '../../shared/magicAgentPlatform2/policy'
import type {
  ComfyInstanceCapabilities,
  ComfyInstanceHealth,
  ComfyInstanceHealthStatus,
  ComfyInstanceKind,
  ComfyInstanceState
} from '@shared/comfy/dispatch'
import { COMFY_INSTANCE_RESOURCE_KIND } from '@shared/comfy/dispatch'
import type {
  MagicAgentEventStore,
  StoredResource
} from '../magicAgentPlatform2/persistence/eventStore'
import { isIP } from 'node:net'
import { isUnsafeComfyAddress } from './networkPolicy'

export const COMFY_INSTANCE_KIND = COMFY_INSTANCE_RESOURCE_KIND

export type CreateComfyInstanceInput = Readonly<{
  id: string
  name: string
  origin: string
  kind?: ComfyInstanceKind
  enabled?: boolean
  maxConcurrency?: number
  tags?: readonly string[]
  capabilities?: Partial<ComfyInstanceCapabilities>
  createdAt: number
  idempotencyKey: string
}>
type MutableFields = Pick<
  ComfyInstanceState,
  'name' | 'origin' | 'kind' | 'enabled' | 'maxConcurrency' | 'tags' | 'capabilities'
>
function assertTrimmed(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim())
    throw new Error(`${field} must be a trimmed non-empty string.`)
}
const assertTime = (value: number, field: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative.`)
}
const assertRevision = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid expected revision.')
}
const uniqueStrings = (values: readonly string[] | undefined, field: string): string[] => {
  if (values !== undefined && !Array.isArray(values)) throw new Error(`${field} must be an array.`)
  const result = values ? [...values] : []
  result.forEach((value) => assertTrimmed(value, field))
  if (new Set(result).size !== result.length) throw new Error(`${field} values must be unique.`)
  return result
}
export const normalizeComfyInstanceOrigin = (
  value: string,
  kind: ComfyInstanceKind = 'remote'
): string => {
  assertTrimmed(value, 'ComfyUI origin')
  if (!/^https?:\/\/[^/?#\\]+\/?$/iu.test(value)) throw new Error('Invalid ComfyUI origin.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid ComfyUI origin.')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid ComfyUI origin.')
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const family = isIP(hostname)
  if (kind === 'remote' && family !== 0 && isUnsafeComfyAddress(hostname)) {
    throw new Error(
      'Unsafe ComfyUI literal IP destination. Use a public endpoint or the managed local instance.'
    )
  }
  return url.href
}
const normalizeCapabilities = (
  capabilities: Partial<ComfyInstanceCapabilities> | undefined,
  fallbackTags: readonly string[]
): ComfyInstanceCapabilities => {
  if (
    capabilities !== undefined &&
    (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities))
  ) {
    throw new Error('Capabilities must be an object.')
  }
  return {
    tags: uniqueStrings(capabilities?.tags ?? fallbackTags, 'Capability tag'),
    models: uniqueStrings(capabilities?.models, 'Capability model'),
    customNodes: uniqueStrings(capabilities?.customNodes, 'Capability custom node'),
    ...(capabilities?.comfyVersion === undefined
      ? {}
      : { comfyVersion: capabilities.comfyVersion }),
    ...(capabilities?.objectInfoDigest === undefined
      ? {}
      : { objectInfoDigest: capabilities.objectInfoDigest })
  }
}
const validateHealth = (health: ComfyInstanceHealth): void => {
  if (!['unknown', 'online', 'degraded', 'offline', 'draining'].includes(health.status))
    throw new Error('Invalid ComfyUI health status.')
  if (health.lastCheckedAt !== undefined) assertTime(health.lastCheckedAt, 'Health timestamp')
  if (health.lastError !== undefined) assertTrimmed(health.lastError, 'Health error')
}
const validateState = (state: ComfyInstanceState): void => {
  assertTrimmed(state.id, 'ComfyUI instance id')
  assertTrimmed(state.name, 'ComfyUI instance name')
  if (typeof state.enabled !== 'boolean') throw new Error('Instance enabled must be a boolean.')
  normalizeComfyInstanceOrigin(state.origin, state.kind)
  if (state.kind !== 'local' && state.kind !== 'remote') throw new Error('Invalid instance kind.')
  if (state.maxConcurrency !== 1) throw new Error('maxConcurrency is fixed at 1.')
  uniqueStrings(state.tags, 'Instance tag')
  normalizeCapabilities(state.capabilities, state.tags)
  validateHealth(state.health)
}
const digest = (value: unknown): string => sha256PolicyText(canonicalPolicyJson(value as never))
const makeEvent = (
  id: string,
  type: string,
  at: number,
  revision: number,
  payload: Record<string, unknown>
) => ({
  protocolVersion: '2.0.0',
  id: `comfy-instance:${id}:${type}:${at}:${revision}`,
  type,
  createdAt: at,
  payload: { ...payload, resourceKind: COMFY_INSTANCE_RESOURCE_KIND, resourceId: id, revision },
  envelopeKind: 'event' as const,
  streamId: `comfy-instance:${id}:stream`,
  sequence: revision
})

export class ComfyInstanceRegistry {
  constructor(private readonly eventStore: MagicAgentEventStore) {}
  list(): readonly StoredResource<ComfyInstanceState>[] {
    return this.eventStore.listResources({
      kind: COMFY_INSTANCE_RESOURCE_KIND,
      limit: 1_000
    }) as readonly StoredResource<ComfyInstanceState>[]
  }
  get(id: string): StoredResource<ComfyInstanceState> | undefined {
    assertTrimmed(id, 'ComfyUI instance id')
    return this.eventStore.getResource(COMFY_INSTANCE_RESOURCE_KIND, id) as
      StoredResource<ComfyInstanceState> | undefined
  }
  create(input: CreateComfyInstanceInput): StoredResource<ComfyInstanceState> {
    assertTrimmed(input.id, 'ComfyUI instance id')
    assertTrimmed(input.name, 'ComfyUI instance name')
    assertTrimmed(input.idempotencyKey, 'Instance idempotency key')
    assertTime(input.createdAt, 'Instance createdAt')
    const state: ComfyInstanceState = {
      id: input.id,
      name: input.name,
      origin: normalizeComfyInstanceOrigin(input.origin, input.kind ?? 'remote'),
      kind: input.kind ?? 'remote',
      enabled: input.enabled ?? true,
      maxConcurrency: input.maxConcurrency ?? 1,
      tags: uniqueStrings(input.tags, 'Instance tag'),
      capabilities: normalizeCapabilities(input.capabilities, input.tags ?? []),
      health: { status: 'unknown' }
    }
    validateState(state)
    const key = `comfy-instance:${state.id}:create:${input.idempotencyKey}`
    const commandDigest = digest({ createdAt: input.createdAt, state })
    const replay = this.findMutation(state.id, key)
    if (replay) {
      this.assertReplay(replay, 'comfy-instance.created', commandDigest)
      return replay.resource as StoredResource<ComfyInstanceState>
    }
    if (this.get(state.id)) throw new Error('ComfyUI instance already exists.')
    return this.eventStore.mutateResource<ComfyInstanceState>({
      operation: 'create',
      kind: COMFY_INSTANCE_RESOURCE_KIND,
      id: state.id,
      state,
      createdAt: input.createdAt,
      idempotencyKey: key,
      event: makeEvent(state.id, 'comfy-instance.created', input.createdAt, 0, { commandDigest })
    }).resource
  }
  update(
    input: Readonly<{
      id: string
      expectedRevision: number
      updatedAt: number
      idempotencyKey: string
      patch: Partial<MutableFields>
    }>
  ): StoredResource<ComfyInstanceState> {
    assertTrimmed(input.id, 'ComfyUI instance id')
    assertTrimmed(input.idempotencyKey, 'Instance idempotency key')
    assertRevision(input.expectedRevision)
    assertTime(input.updatedAt, 'Instance updatedAt')
    const key = `comfy-instance:${input.id}:update:${input.idempotencyKey}`
    const patchDigest = digest({
      expectedRevision: input.expectedRevision,
      updatedAt: input.updatedAt,
      patch: input.patch
    })
    const replay = this.findMutation(input.id, key)
    if (replay) {
      this.assertReplay(replay, 'comfy-instance.updated', patchDigest)
      return replay.resource as StoredResource<ComfyInstanceState>
    }
    const current = this.get(input.id)
    if (!current) throw new Error('ComfyUI instance not found.')
    if (current.revision !== input.expectedRevision)
      throw new Error('ComfyUI instance revision conflict.')
    const patch = input.patch
    const state: ComfyInstanceState = {
      ...current.state,
      ...patch,
      ...(patch.origin === undefined
        ? {}
        : { origin: normalizeComfyInstanceOrigin(patch.origin, patch.kind ?? current.state.kind) }),
      ...(patch.tags === undefined ? {} : { tags: uniqueStrings(patch.tags, 'Instance tag') }),
      ...(patch.capabilities === undefined
        ? {}
        : {
            capabilities: normalizeCapabilities(
              patch.capabilities,
              patch.tags ?? current.state.tags
            )
          })
    }
    validateState(state)
    return this.eventStore.mutateResource<ComfyInstanceState>({
      operation: 'update',
      kind: COMFY_INSTANCE_RESOURCE_KIND,
      id: input.id,
      expectedRevision: input.expectedRevision,
      state,
      createdAt: input.updatedAt,
      idempotencyKey: key,
      event: makeEvent(
        input.id,
        'comfy-instance.updated',
        input.updatedAt,
        input.expectedRevision + 1,
        { patchDigest }
      )
    }).resource
  }
  updateHealth(
    input: Readonly<{
      id: string
      expectedRevision: number
      status: ComfyInstanceHealthStatus
      checkedAt: number
      error?: string
      idempotencyKey: string
    }>
  ): StoredResource<ComfyInstanceState> {
    assertTrimmed(input.id, 'ComfyUI instance id')
    assertTrimmed(input.idempotencyKey, 'Health idempotency key')
    assertRevision(input.expectedRevision)
    assertTime(input.checkedAt, 'Health checkedAt')
    if (input.error !== undefined) assertTrimmed(input.error, 'Health error')
    const health: ComfyInstanceHealth = {
      status: input.status,
      lastCheckedAt: input.checkedAt,
      ...(input.error === undefined ? {} : { lastError: input.error })
    }
    validateHealth(health)
    const key = `comfy-instance:${input.id}:health:${input.idempotencyKey}`
    const healthDigest = digest({
      expectedRevision: input.expectedRevision,
      checkedAt: input.checkedAt,
      health
    })
    const replay = this.findMutation(input.id, key)
    if (replay) {
      this.assertReplay(replay, 'comfy-instance.health-updated', healthDigest)
      return replay.resource as StoredResource<ComfyInstanceState>
    }
    const current = this.get(input.id)
    if (!current) throw new Error('ComfyUI instance not found.')
    if (current.revision !== input.expectedRevision)
      throw new Error('ComfyUI instance revision conflict.')
    return this.eventStore.mutateResource<ComfyInstanceState>({
      operation: 'update',
      kind: COMFY_INSTANCE_RESOURCE_KIND,
      id: input.id,
      expectedRevision: input.expectedRevision,
      state: { ...current.state, health },
      createdAt: input.checkedAt,
      idempotencyKey: key,
      event: makeEvent(
        input.id,
        'comfy-instance.health-updated',
        input.checkedAt,
        input.expectedRevision + 1,
        { healthDigest }
      )
    }).resource
  }
  remove(
    input: Readonly<{
      id: string
      expectedRevision: number
      removedAt: number
      idempotencyKey: string
    }>
  ): StoredResource<ComfyInstanceState> {
    assertTrimmed(input.id, 'ComfyUI instance id')
    assertTrimmed(input.idempotencyKey, 'Remove idempotency key')
    assertRevision(input.expectedRevision)
    assertTime(input.removedAt, 'Instance removedAt')
    const key = `comfy-instance:${input.id}:remove:${input.idempotencyKey}`
    const commandDigest = digest({
      expectedRevision: input.expectedRevision,
      removedAt: input.removedAt
    })
    const replay = this.findMutation(input.id, key)
    if (replay) {
      this.assertReplay(replay, 'comfy-instance.removed', commandDigest)
      return replay.resource as StoredResource<ComfyInstanceState>
    }
    const current = this.get(input.id)
    if (!current) throw new Error('ComfyUI instance not found.')
    if (current.revision !== input.expectedRevision)
      throw new Error('ComfyUI instance revision conflict.')
    return this.eventStore.mutateResource<ComfyInstanceState>({
      operation: 'delete',
      kind: COMFY_INSTANCE_RESOURCE_KIND,
      id: input.id,
      expectedRevision: input.expectedRevision,
      createdAt: input.removedAt,
      idempotencyKey: key,
      event: makeEvent(
        input.id,
        'comfy-instance.removed',
        input.removedAt,
        input.expectedRevision + 1,
        { commandDigest }
      )
    }).resource
  }
  private findMutation(id: string, idempotencyKey: string) {
    return this.eventStore
      .listResourceMutations(COMFY_INSTANCE_RESOURCE_KIND, id, 1_000)
      .find((mutation) => mutation.idempotencyKey === idempotencyKey)
  }
  private assertReplay(
    mutation: ReturnType<ComfyInstanceRegistry['findMutation']>,
    type: string,
    expectedDigest: string
  ): void {
    const committed = mutation && this.eventStore.getEvent(mutation.eventId)
    const payload = committed?.payload as
      | {
          commandDigest?: string
          stateDigest?: string
          patchDigest?: string
          healthDigest?: string
        }
      | undefined
    const actualDigest =
      payload?.commandDigest ??
      payload?.stateDigest ??
      payload?.patchDigest ??
      payload?.healthDigest
    if (committed?.type !== type || actualDigest !== expectedDigest)
      throw new Error('ComfyUI instance idempotency conflict.')
  }
}
