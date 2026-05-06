export type DuplicateCheckMethod = 'hash' | 'visual' | 'robust'

export type DuplicateCheckThresholdPreset = 'strict' | 'balanced' | 'loose'

export type DuplicateCheckMatchLevel = 'exact' | 'high' | 'uncertain'

export type DuplicateCheckVisualModelConfig = {
  id: string
  name: string
  modelPath: string
  inputSize: number
  inputName?: string
  outputName?: string
  embeddingDim?: number
  normalizeEmbedding?: boolean
  mean?: number[]
  std?: number[]
  defaultThreshold?: number
  enabled: boolean
}

export type DuplicateCheckThresholdPresetValues = {
  hashDistance: number
  uncertainHashDistance: number
  visualSimilarity: number
  uncertainVisualSimilarity: number
  robustnessSimilarity: number
}

export type DuplicateCheckSettings = {
  enabled: boolean
  defaultPreset: DuplicateCheckThresholdPreset
  defaultMethods: DuplicateCheckMethod[]
  enableCache: boolean
  recursiveScan: boolean
  imageOnlyScan: boolean
  excludeSelf: boolean
  gpuAcceleration: boolean
  fallbackToCpu: boolean
  reuseComfyPython: boolean
  pythonCommandOverride?: string
  cacheDir?: string
  maxConcurrency: number
  batchSize: number
  imageExtensions: string[]
  visualModels: DuplicateCheckVisualModelConfig[]
}

export const DEFAULT_DUPLICATE_CHECK_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.ico'
]

export const DUPLICATE_CHECK_THRESHOLD_PRESETS: Record<
  DuplicateCheckThresholdPreset,
  DuplicateCheckThresholdPresetValues
> = {
  strict: {
    hashDistance: 8,
    uncertainHashDistance: 10,
    visualSimilarity: 0.92,
    uncertainVisualSimilarity: 0.88,
    robustnessSimilarity: 0.9
  },
  balanced: {
    hashDistance: 12,
    uncertainHashDistance: 15,
    visualSimilarity: 0.88,
    uncertainVisualSimilarity: 0.84,
    robustnessSimilarity: 0.86
  },
  loose: {
    hashDistance: 16,
    uncertainHashDistance: 20,
    visualSimilarity: 0.84,
    uncertainVisualSimilarity: 0.8,
    robustnessSimilarity: 0.82
  }
}

export const DEFAULT_DUPLICATE_CHECK_SETTINGS: DuplicateCheckSettings = {
  enabled: true,
  defaultPreset: 'balanced',
  defaultMethods: ['hash'],
  enableCache: true,
  recursiveScan: true,
  imageOnlyScan: true,
  excludeSelf: true,
  gpuAcceleration: true,
  fallbackToCpu: true,
  reuseComfyPython: true,
  pythonCommandOverride: '',
  cacheDir: '',
  maxConcurrency: 4,
  batchSize: 8,
  imageExtensions: DEFAULT_DUPLICATE_CHECK_IMAGE_EXTENSIONS,
  visualModels: []
}

export const DEFAULT_DUPLICATE_CHECK_MODEL_MEAN = [0.5, 0.5, 0.5]
export const DEFAULT_DUPLICATE_CHECK_MODEL_STD = [0.5, 0.5, 0.5]

/*
export const createEmptyDuplicateCheckVisualModel = (): DuplicateCheckVisualModelConfig => ({
  id: crypto.randomUUID(),
  name: '新视觉模型',
  modelPath: '',
  inputSize: 224,
  inputName: '',
  outputName: '',
  embeddingDim: 0,
  normalizeEmbedding: true,
  mean: [...DEFAULT_DUPLICATE_CHECK_MODEL_MEAN],
  std: [...DEFAULT_DUPLICATE_CHECK_MODEL_STD],
  defaultThreshold: DUPLICATE_CHECK_THRESHOLD_PRESETS.balanced.visualSimilarity,
  enabled: true
})
*/

export const createEmptyDuplicateCheckVisualModel = (): DuplicateCheckVisualModelConfig => ({
  id: crypto.randomUUID(),
  name: '\u65b0\u89c6\u89c9\u6a21\u578b',
  modelPath: '',
  inputSize: 224,
  inputName: '',
  outputName: '',
  embeddingDim: 0,
  normalizeEmbedding: true,
  mean: [...DEFAULT_DUPLICATE_CHECK_MODEL_MEAN],
  std: [...DEFAULT_DUPLICATE_CHECK_MODEL_STD],
  defaultThreshold: DUPLICATE_CHECK_THRESHOLD_PRESETS.balanced.visualSimilarity,
  enabled: true
})
