import type {
  DuplicateCheckMatchLevel,
  DuplicateCheckMethod,
  DuplicateCheckThresholdPreset,
  DuplicateCheckVisualModelConfig
} from '@shared/duplicateCheck/types'
import type { ServerStreaming } from './apiUtils/streaming'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type DuplicateCheckComparableImage = {
  id: string
  name: string
  data?: Uint8Array
  sourcePath?: string
  sourceUrl?: string
  mimeType?: string
  itemId?: string
  canvasId?: string
  canvasName?: string
  originLabel?: string
}

export type DuplicateCheckVisualAnalysisGroupKind =
  | 'source_assets'
  | 'selection_snapshot'
  | 'scheme_images'
  | 'upstream_results'

export type DuplicateCheckVisualAnalysisImage = DuplicateCheckComparableImage & {
  groupKind: DuplicateCheckVisualAnalysisGroupKind
  groupLabel?: string
}

export type DuplicateCheckVisualAnalysisPairMode = 'cross_group' | 'all_pairs'

export type DuplicateCheckVisualAnalysisReq = {
  modelId: string
  images: DuplicateCheckVisualAnalysisImage[]
  pairMode?: DuplicateCheckVisualAnalysisPairMode
}

export type DuplicateCheckVisualAnalysisPairResult = {
  leftImageId: string
  leftName: string
  leftGroupKind: DuplicateCheckVisualAnalysisGroupKind
  leftGroupLabel?: string
  rightImageId: string
  rightName: string
  rightGroupKind: DuplicateCheckVisualAnalysisGroupKind
  rightGroupLabel?: string
  visualSimilarity: number | null
  robustnessSimilarity: number | null
}

export type DuplicateCheckVisualAnalysisResult = {
  modelId: string
  modelName: string
  provider?: string
  warnings: string[]
  imageCount: number
  pairMode: DuplicateCheckVisualAnalysisPairMode
  groups: Array<{
    kind: DuplicateCheckVisualAnalysisGroupKind
    label: string
    imageCount: number
  }>
  pairResults: DuplicateCheckVisualAnalysisPairResult[]
}

export type DuplicateCheckScope =
  | {
      type: 'folder'
      folderPath: string
      recursive: boolean
      imageExtensions: string[]
    }
  | {
      type: 'canvas'
      canvasId: string
      canvasName: string
      selectionOnly?: boolean
      images: DuplicateCheckComparableImage[]
    }

export type DuplicateCheckRunReq = {
  taskId: string
  scope: DuplicateCheckScope
  queries: DuplicateCheckComparableImage[]
  methods: DuplicateCheckMethod[]
  preset: DuplicateCheckThresholdPreset
  hashDistance: number
  uncertainHashDistance: number
  visualSimilarity: number
  uncertainVisualSimilarity: number
  robustnessSimilarity: number
  excludeSelf: boolean
  enableCache: boolean
  useGpu: boolean
  fallbackToCpu: boolean
  batchSize: number
  maxConcurrency: number
  visualModels: DuplicateCheckVisualModelConfig[]
}

export type DuplicateCheckScoreBundle = {
  sha256Equal: boolean
  pHashDistance: number | null
  dHashDistance: number | null
  visualSimilarityByModel: Record<string, number>
  robustnessSimilarityByModel: Record<string, number>
}

export type DuplicateCheckMatch = {
  level: DuplicateCheckMatchLevel
  reasons: string[]
  target: DuplicateCheckComparableImage
  scores: DuplicateCheckScoreBundle
}

export type DuplicateCheckQueryResult = {
  query: DuplicateCheckComparableImage
  exactMatches: DuplicateCheckMatch[]
  highMatches: DuplicateCheckMatch[]
  uncertainMatches: DuplicateCheckMatch[]
}

export type DuplicateCheckSkippedImage = {
  image: DuplicateCheckComparableImage
  reason: string
}

export type DuplicateCheckRunResult = {
  taskId: string
  startedAt: string
  finishedAt: string
  scopeType: DuplicateCheckScope['type']
  scopeCount: number
  queryCount: number
  exactCount: number
  highCount: number
  uncertainCount: number
  totalMatchCount: number
  cacheHitCount: number
  cacheMissCount: number
  providerByModel: Record<string, string>
  warnings: string[]
  skippedScopeImages: DuplicateCheckSkippedImage[]
  queryResults: DuplicateCheckQueryResult[]
}

export type DuplicateCheckRunEvent =
  | {
      type: 'status'
      phase: 'prepare' | 'scan' | 'hash' | 'visual' | 'match' | 'done'
      message: string
      current?: number
      total?: number
      percent?: number
      modelId?: string
    }
  | {
      type: 'complete'
      result: DuplicateCheckRunResult
    }

export type DuplicateCheckSvc = {
  runVisualAnalysis(
    req: DuplicateCheckVisualAnalysisReq
  ): Promise<DuplicateCheckVisualAnalysisResult>
  runDuplicateCheck(
    req: DuplicateCheckRunReq,
    resp: ServerStreaming<DuplicateCheckRunEvent>
  ): Promise<void>
}

export const duplicateCheckSvcDef: ServiceDefSheet<DuplicateCheckSvc> = {
  runVisualAnalysis: {
    type: 'unary'
  },
  runDuplicateCheck: {
    type: 'serverStreaming'
  }
}
