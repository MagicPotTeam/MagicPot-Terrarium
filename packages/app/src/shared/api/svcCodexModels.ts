import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type CodexModelEntrySource = 'current' | 'remote' | 'observed' | 'fallback'
export type CodexModelCatalogSource = 'remote' | 'cache' | 'fallback'

export type CodexModelCatalogEntry = {
  label: string
  value: string
  source: CodexModelEntrySource
  recommended?: boolean
}

export type CodexModelsCacheSnapshot = {
  models: Array<string | Pick<CodexModelCatalogEntry, 'label' | 'value'>>
  fetchedAt: string
  expiresAt?: string
}

export type GetCodexModelsReq = {
  currentModelName?: string
  observedModelNames?: string[]
  forceRefresh?: boolean
  cliProxyProfileId?: string
}

export type GetCodexModelsResp = {
  models: CodexModelCatalogEntry[]
  source: CodexModelCatalogSource
  stale: boolean
  fetchedAt: string
  expiresAt?: string
}

export type CodexModelsSvc = {
  list(req: GetCodexModelsReq): Promise<GetCodexModelsResp>
}

export const codexModelsSvcDef: ServiceDefSheet<CodexModelsSvc> = {
  list: {
    type: 'unary'
  }
}
