import { Config, DEFAULT_WORKFLOW_DIR } from '@shared/config/config'
import { DeepPartial } from '@shared/utils/utilTypes'
import { Migrator } from './migrator'

const LEGACY_DEFAULT_WORKFLOW_DIR = 'user/default/workflows'

export const migratorWorkflowDir: Migrator<DeepPartial<Config>> = {
  migrate: (config: unknown): DeepPartial<Config> => {
    if (!config || typeof config !== 'object') {
      return {}
    }

    const nextConfig = config as Record<string, unknown>
    const workflowDir = nextConfig.workflow_dir

    if (workflowDir === LEGACY_DEFAULT_WORKFLOW_DIR) {
      return {
        ...(nextConfig as DeepPartial<Config>),
        workflow_dir: DEFAULT_WORKFLOW_DIR
      }
    }

    return nextConfig as DeepPartial<Config>
  }
}
