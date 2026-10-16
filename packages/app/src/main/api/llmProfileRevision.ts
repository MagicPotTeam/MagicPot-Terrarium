import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from '@shared/config/config'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const changed = () =>
  new ServiceError('Model configuration changed; review and confirm again.', {
    code: 'PROFILE_CONFIGURATION_CHANGED'
  })

/** Opaque per-process revision: no configuration, keys or unkeyed credential hash leaves main. */
export class LlmProfileRevision {
  private readonly key = randomBytes(32)

  create(config: Config, profileId: string): string {
    const identity = {
      profileId,
      profiles: config.llm_config.api_profiles,
      pluginProfiles: config.plugin_config?.api_profiles,
      remote: config.use_remote_llm,
      remoteConfig: config.remote_llm_server_config
    }
    return createHmac('sha256', this.key).update(canonical(identity)).digest('hex')
  }

  verify(
    config: Config,
    profileId: unknown,
    revision: unknown,
    receivingLocalComparison = false
  ): void {
    if (
      (config.use_remote_llm && !receivingLocalComparison) ||
      typeof profileId !== 'string' ||
      !profileId.trim() ||
      profileId.length > 512 ||
      typeof revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(revision)
    )
      throw changed()
    const expected = Buffer.from(this.create(config, profileId), 'hex')
    if (!timingSafeEqual(expected, Buffer.from(revision, 'hex'))) throw changed()
  }
}
