import { describe, expect, it } from 'vitest'
import { migratorLegacyLLM } from './migrator_legacy_llm'

describe('migratorLegacyLLM', () => {
  it('seeds quick app api profiles from legacy agent profiles when the quick app field is absent', () => {
    const migrated = migratorLegacyLLM.migrate({
      use_remote_llm: true,
      llm_config: {
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      }
    })

    expect(migrated.plugin_config?.api_profiles).toEqual([
      {
        id: 'agent-profile',
        model_name: 'Agent Model',
        base_url: 'https://agent.example/v1',
        api_key: 'agent-key'
      }
    ])
    expect(migrated.llm_config?.api_profiles).toEqual([
      {
        id: 'agent-profile',
        model_name: 'Agent Model',
        base_url: 'https://agent.example/v1',
        api_key: 'agent-key'
      }
    ])
  })

  it('respects an explicitly empty quick app api profile list', () => {
    const migrated = migratorLegacyLLM.migrate({
      use_remote_llm: true,
      llm_config: {
        api_profiles: [
          {
            id: 'agent-profile',
            model_name: 'Agent Model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        api_profiles: []
      }
    })

    expect(migrated.plugin_config?.api_profiles).toEqual([])
  })
})
