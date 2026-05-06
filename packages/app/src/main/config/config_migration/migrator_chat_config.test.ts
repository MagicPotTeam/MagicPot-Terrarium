import { describe, expect, it } from 'vitest'
import { migratorChatConfig } from './migrator_chat_config'

describe('migratorChatConfig', () => {
  it('normalizes chat_config against defaults', () => {
    const migrated = migratorChatConfig.migrate({
      chat_config: {
        enable: true,
        profile_id: 'legacy-profile',
        system_prompt: 'legacy prompt',
        webhook_secret: 'legacy-secret',
        max_history_messages: 24
      }
    })

    expect(migrated.chat_config).toEqual({
      enable: true,
      profile_id: 'legacy-profile',
      system_prompt: 'legacy prompt',
      webhook_secret: 'legacy-secret',
      max_history_messages: 24
    })
  })

  it('fills missing chat_config values from defaults', () => {
    const migrated = migratorChatConfig.migrate({
      chat_config: {
        enable: true,
        profile_id: 'new-profile',
        max_history_messages: 16
      }
    })

    expect(migrated.chat_config).toMatchObject({
      enable: true,
      profile_id: 'new-profile',
      system_prompt: '',
      webhook_secret: '',
      max_history_messages: 16
    })
  })
})
