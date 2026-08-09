import { canonicalPolicyJson, sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentConfigContent } from '../../../shared/magicAgentPlatform2/agentConfig'
import { MagicAgentEventStore, type StoredResource } from '../persistence/eventStore'

export const MAGIC_AGENT_CONFIG_RESOURCE_KIND = 'magic-agent-config'

const validate = (config: MagicAgentConfigContent) => {
  if (!config.version.trim() || !config.definitionId.trim())
    throw new Error('Agent config identity is required.')
  if (config.createdAt < 0 || !Number.isFinite(config.createdAt))
    throw new Error('Agent config createdAt is invalid.')
  const digest = sha256PolicyText(canonicalPolicyJson({ ...config, contentDigest: '' } as never))
  if (config.contentDigest !== digest) throw new Error('Agent config content digest mismatch.')
}

export class PersistentAgentConfigStore {
  constructor(private readonly events: MagicAgentEventStore) {}

  get(version: string) {
    return this.events.getResource(MAGIC_AGENT_CONFIG_RESOURCE_KIND, version) as
      | StoredResource<MagicAgentConfigContent>
      | undefined
  }

  list() {
    return this.events.listResources({
      kind: MAGIC_AGENT_CONFIG_RESOURCE_KIND
    }) as readonly StoredResource<MagicAgentConfigContent>[]
  }

  getCreateReplay(input: { config: MagicAgentConfigContent; idempotencyKey: string }) {
    const key = `agent-config:${input.config.version}:create:${input.idempotencyKey}`
    const replay = this.events
      .listResourceMutations(MAGIC_AGENT_CONFIG_RESOURCE_KIND, input.config.version, 1_000)
      .find((item) => item.idempotencyKey === key)
    if (!replay) return undefined
    const committed = replay.resource as StoredResource<MagicAgentConfigContent>
    if (committed.state.contentDigest !== input.config.contentDigest)
      throw new Error('Agent config create idempotency conflict.')
    return committed
  }

  create(input: { config: MagicAgentConfigContent; idempotencyKey: string }) {
    validate(input.config)
    if (!input.idempotencyKey.trim()) throw new Error('Agent config idempotency key is required.')
    const replay = this.getCreateReplay(input)
    if (replay) return replay
    const key = `agent-config:${input.config.version}:create:${input.idempotencyKey}`
    if (this.get(input.config.version)) throw new Error('Agent config version already exists.')
    return this.events.mutateResource<MagicAgentConfigContent>({
      operation: 'create',
      kind: MAGIC_AGENT_CONFIG_RESOURCE_KIND,
      id: input.config.version,
      state: input.config,
      createdAt: input.config.createdAt,
      idempotencyKey: key,
      event: {
        protocolVersion: '2.0.0',
        id: `agent-config:${input.config.version}:created:${input.idempotencyKey}`,
        type: 'agent-config.created',
        createdAt: input.config.createdAt,
        payload: {
          version: input.config.version,
          definitionId: input.config.definitionId,
          contentDigest: input.config.contentDigest,
          createdBy: input.config.createdBy
        },
        envelopeKind: 'event',
        streamId: `agent-config:${input.config.version}:stream`,
        sequence: 0
      }
    }).resource
  }
}

export const createMagicAgentConfigContent = (
  input: Omit<MagicAgentConfigContent, 'contentDigest'>
): MagicAgentConfigContent => {
  const contentDigest = sha256PolicyText(
    canonicalPolicyJson({ ...input, contentDigest: '' } as never)
  )
  return { ...input, contentDigest }
}
