import { Config } from '@shared/config/config'
import { Migrator } from './migrator'
import { DeepPartial } from '@shared/utils/utilTypes'

/**
 * 迁移器：修复 promptOptimizationQAppKey 路径（已废弃）
 * 该字段已被删除，此迁移器保留为空操作
 */
export const migratorQAppPath: Migrator<DeepPartial<Config>> = {
  migrate: (config: unknown): DeepPartial<Config> => {
    return config as DeepPartial<Config>
  }
}
