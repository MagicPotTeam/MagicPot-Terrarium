import path from 'node:path'
import { createRequire } from 'node:module'
import { EmbeddingProviderRegistry } from './embeddingProviderRegistry'
import { SemanticMemoryService } from './semanticMemoryService'
import { SqliteSemanticMemoryStore } from './sqliteSemanticMemoryStore'

export type ProductionSemanticMemory = Readonly<{
  store: SqliteSemanticMemoryStore
  providers: EmbeddingProviderRegistry
  service: SemanticMemoryService
}>

let production: ProductionSemanticMemory | undefined

const resolveDataRoot = (): string => {
  if (process.env.MAGICPOT_DATA_DIR) return process.env.MAGICPOT_DATA_DIR
  const require = createRequire(import.meta.url)
  const { getBuildEnv } = require('../../config/buildEnv') as typeof import('../../config/buildEnv')
  return getBuildEnv().pathMap.data
}

export const getProductionSemanticMemory = (): ProductionSemanticMemory => {
  if (production) return production
  const databasePath =
    process.env.NODE_ENV === 'test'
      ? ':memory:'
      : path.join(resolveDataRoot(), 'magic-agent-platform-2', 'semantic-memory.sqlite')
  const store = new SqliteSemanticMemoryStore(databasePath)
  const providers = new EmbeddingProviderRegistry()
  production = { store, providers, service: new SemanticMemoryService(store, providers) }
  return production
}

export const closeProductionSemanticMemory = (): void => {
  production?.store.close()
  production = undefined
}
