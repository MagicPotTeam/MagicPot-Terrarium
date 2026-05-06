import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import type { BridgeSourceContextSummary } from './bridgeSourceContext'
import type { BridgeTaskContext } from './bridgeTaskContext'

export type DccBridgeTarget = 'unity' | 'unreal'

export const DCC_BRIDGE_EXPORT_ROOT_DIR = 'MagicPotImports'
export const DCC_BRIDGE_MANIFEST_FILE_NAME = 'bridge-manifest.json'
export const DCC_BRIDGE_VALIDATION_FILE_NAME = 'bridge-validation.json'
export const DCC_BRIDGE_TARGET_RECIPE_FILE_NAMES = {
  unity: 'unity-import-recipe.json',
  unreal: 'unreal-import-recipe.json'
} as const

export const DCC_BRIDGE_TARGET_IMPORT_STUB_FILE_NAMES = {
  unity: 'unity-import-helper.cs',
  unreal: 'unreal-import-helper.py'
} as const

export const DCC_BRIDGE_SUPPORTED_MODEL_SOURCE_FORMATS = [
  '.glb',
  '.gltf',
  '.obj',
  '.fbx',
  '.dae',
  '.3ds',
  '.ply',
  '.stl'
] as const

export type DccBridgeModelSourceFormat = (typeof DCC_BRIDGE_SUPPORTED_MODEL_SOURCE_FORMATS)[number]

export type DccBridgeSourceResolutionKind = 'buffer' | 'data-url' | 'local-file' | 'http-url'

const getFileExtension = (fileName: string): string => {
  const trimmed = fileName.trim().toLowerCase()
  if (!trimmed) return ''
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot < 0 || lastDot === trimmed.length - 1) return ''
  return trimmed.slice(lastDot)
}

export const getDccBridgeModelSourceFormat = (fileName: string): string =>
  getFileExtension(fileName)

export const isSupportedDccBridgeModelSourceFormat = (fileName: string): boolean =>
  DCC_BRIDGE_SUPPORTED_MODEL_SOURCE_FORMATS.includes(
    getDccBridgeModelSourceFormat(fileName) as DccBridgeModelSourceFormat
  )

export const getDccBridgeTargetLabel = (target: DccBridgeTarget): string =>
  target === 'unity' ? 'Unity' : 'Unreal'

export const getDccBridgeImportRecipeFileName = (target: DccBridgeTarget): string =>
  DCC_BRIDGE_TARGET_RECIPE_FILE_NAMES[target]

export const getDccBridgeImportStubFileName = (target: DccBridgeTarget): string =>
  DCC_BRIDGE_TARGET_IMPORT_STUB_FILE_NAMES[target]

export const getDccBridgeExpectedPackageFileNames = (
  modelFileName: string,
  target: DccBridgeTarget
): string[] => [
  modelFileName,
  DCC_BRIDGE_MANIFEST_FILE_NAME,
  DCC_BRIDGE_VALIDATION_FILE_NAME,
  getDccBridgeImportRecipeFileName(target),
  getDccBridgeImportStubFileName(target)
]

export type ExportModelToDccReq = {
  target: DccBridgeTarget
  fileName?: string
  sourceUrl?: string
  data?: Uint8Array
  sourceLabel?: string
  sourceContextSummary?: BridgeSourceContextSummary
  taskContext?: BridgeTaskContext
}

export type ExportModelToDccResp = {
  target: DccBridgeTarget
  targetDir: string
  packageDir: string
  manifestPath: string
  manifestSha256: string
  validationPath: string
  validationSha256: string
  recipePath: string
  recipeSha256: string
  modelPath: string
  importStubPath: string
  importStubSha256: string
  artifactSizeBytes: number
  artifactSha256: string
}

export type DccBridgeSvc = {
  exportModel(req: ExportModelToDccReq): Promise<ExportModelToDccResp>
}

export const dccBridgeSvcDef: ServiceDefSheet<DccBridgeSvc> = {
  exportModel: {
    type: 'unary'
  }
}
