import { Config } from '@shared/config/config'
import { DeepPartial } from '@shared/utils/utilTypes'
import { migratorChatConfig } from './migrator_chat_config'
import { migrator1_0_53 } from './migrator_1.0.53'
import { migratorLegacyLLM } from './migrator_legacy_llm'
import { migratorQAppImageInterrogationPrompt } from './migrator_qapp_image_interrogation_prompt'
import { migratorWorkflowDir } from './migrator_workflow_dir'

const migrators = [
  migratorChatConfig,
  migrator1_0_53,
  migratorLegacyLLM,
  migratorQAppImageInterrogationPrompt,
  migratorWorkflowDir
]

export function migrateConfig(config: unknown): DeepPartial<Config> {
  for (const migrator of migrators) {
    config = migrator.migrate(config)
  }
  return config as DeepPartial<Config>
}
