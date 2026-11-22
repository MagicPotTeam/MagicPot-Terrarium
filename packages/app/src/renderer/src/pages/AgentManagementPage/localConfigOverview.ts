import type { Config } from '@shared/config/config'

export type LocalConfigOverview = {
  profiles: Array<{ id: string; modelName: string; provider?: string; callType?: string }>
  sources: Array<{
    id: string
    source: 'directory' | 'manifest'
    enabled: boolean
    projectId?: string
  }>
}

/** A detached allowlist, not a serialized config, account identity or installed catalog. */
export function projectLocalConfigOverview(config: Config): LocalConfigOverview {
  return {
    profiles: config.llm_config.api_profiles.map(({ id, model_name, provider, call_type }) => ({
      id,
      modelName: model_name,
      ...(provider !== undefined ? { provider } : {}),
      ...(call_type !== undefined ? { callType: call_type } : {})
    })),
    sources: (config.llm_config.proceduralSkillPackages ?? []).map(
      ({ id, source, enabled, projectId }) => ({
        id,
        source: source ?? 'directory',
        enabled,
        ...(projectId !== undefined ? { projectId } : {})
      })
    )
  }
}
