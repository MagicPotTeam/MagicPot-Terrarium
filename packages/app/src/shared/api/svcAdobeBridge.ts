import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import type { BridgeSourceContextSummary } from './bridgeSourceContext'
import type { BridgeTaskContext } from './bridgeTaskContext'

export type AdobeBridgeTarget = 'after-effects' | 'premiere'

export const ADOBE_BRIDGE_MANIFEST_FILE_NAME = 'bridge-manifest.json'
export const ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME = 'handoff-instructions.md'
export const ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME = 'handoff-payload.json'
export const ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME = 'handoff-recipe.json'
export const ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME = 'after-effects-handoff.jsx'
export const ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME = 'premiere-handoff.jsx'

export type AdobeBridgeHandoffArtifact = {
  fileName: string
  relativePath: string
  purpose: 'manual-handoff'
  target: AdobeBridgeTarget
}

export type AdobeBridgePackageContents = {
  assetFileName: string
  manifestFileName: string
  instructionsFileName: string
  payloadFileName: string
  recipeFileName: string
  scriptStubFileName: string
}

export type ExportAssetToAdobeReq = {
  target: AdobeBridgeTarget
  fileName?: string
  sourceUrl?: string
  data?: Uint8Array
  sourceLabel?: string
  sourceContextSummary?: BridgeSourceContextSummary
  taskContext?: BridgeTaskContext
  promptText?: string
  mimeType?: string
}

export type ExportAssetToAdobeResp = {
  target: AdobeBridgeTarget
  targetDir: string
  packageDir: string
  manifestPath: string
  instructionsPath: string
  payloadPath: string
  recipePath: string
  assetPath: string
  scriptStubPath?: string
  packageContents?: AdobeBridgePackageContents
}

export type AdobeBridgeSvc = {
  exportAsset(req: ExportAssetToAdobeReq): Promise<ExportAssetToAdobeResp>
}

export const adobeBridgeSvcDef: ServiceDefSheet<AdobeBridgeSvc> = {
  exportAsset: {
    type: 'unary'
  }
}
