import { FILE_NODE_DEFAULT_HEIGHT, FILE_NODE_DEFAULT_WIDTH } from './projectCanvasPageShared'
import type {
  CanvasFileItem,
  CanvasGroup,
  CanvasImageAsset,
  CanvasHtmlItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasProvenanceSource,
  CanvasTextItem,
  CanvasVideoItem
} from './types'

type BaseCanvasItemDraftOptions = {
  id: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  rotation?: number
  scaleX?: number
  scaleY?: number
  locked?: boolean
  provenance?: CanvasProvenanceSource
}

function buildBaseCanvasItemDraft({
  id,
  x,
  y,
  width,
  height,
  zIndex,
  rotation = 0,
  scaleX = 1,
  scaleY = 1,
  locked = false,
  provenance
}: BaseCanvasItemDraftOptions) {
  return {
    id,
    x,
    y,
    width,
    height,
    rotation,
    scaleX,
    scaleY,
    zIndex,
    locked,
    ...(provenance ? { provenance } : {})
  }
}

export function createCanvasItemId(prefix: string, seed: number = Date.now()): string {
  return `${prefix}-${seed}-${Math.random().toString(36).slice(2, 8)}`
}

export function createCanvasImageItemDraft(
  options: BaseCanvasItemDraftOptions & {
    src: string
    image?: CanvasImageAsset
    fileName?: string
    sourceFile?: Blob
    sizeBytes?: number
    hasAlpha?: boolean
    sourceWidth?: number
    sourceHeight?: number
    sourceIdentity?: CanvasImageItem['sourceIdentity']
    thumbnailSet?: CanvasImageItem['thumbnailSet']
    promptId?: string
    fileItem?: CanvasImageItem['fileItem']
    ocrBundleId?: string
    reportBundleId?: CanvasImageItem['reportBundleId']
    reportBundleRole?: CanvasImageItem['reportBundleRole']
    reportBundleRefName?: CanvasImageItem['reportBundleRefName']
    reportBundleManifestUrl?: CanvasImageItem['reportBundleManifestUrl']
  }
): CanvasImageItem {
  return {
    ...buildBaseCanvasItemDraft(options),
    type: 'image',
    src: options.src,
    ...(options.fileName ? { fileName: options.fileName } : {}),
    ...(options.sourceFile ? { sourceFile: options.sourceFile } : {}),
    ...(typeof options.sizeBytes === 'number' ? { sizeBytes: options.sizeBytes } : {}),
    ...(typeof options.hasAlpha === 'boolean' ? { hasAlpha: options.hasAlpha } : {}),
    ...(options.image ? { image: options.image } : {}),
    ...(options.sourceIdentity ? { sourceIdentity: options.sourceIdentity } : {}),
    ...(options.thumbnailSet ? { thumbnailSet: options.thumbnailSet } : {}),
    ...(typeof options.sourceWidth === 'number' ? { sourceWidth: options.sourceWidth } : {}),
    ...(typeof options.sourceHeight === 'number' ? { sourceHeight: options.sourceHeight } : {}),
    ...(options.promptId ? { promptId: options.promptId } : {}),
    ...(options.fileItem ? { fileItem: options.fileItem } : {}),
    ...(options.ocrBundleId ? { ocrBundleId: options.ocrBundleId } : {}),
    ...(options.reportBundleId ? { reportBundleId: options.reportBundleId } : {}),
    ...(options.reportBundleRole ? { reportBundleRole: options.reportBundleRole } : {}),
    ...(options.reportBundleRefName ? { reportBundleRefName: options.reportBundleRefName } : {}),
    ...(options.reportBundleManifestUrl
      ? { reportBundleManifestUrl: options.reportBundleManifestUrl }
      : {})
  }
}

export function createCanvasFileItemDraft(
  options: BaseCanvasItemDraftOptions & {
    src: string
    fileName: string
    sourceFile?: Blob
    mimeType: string
    fileKind: CanvasFileItem['fileKind']
    sizeBytes?: number
    previewText?: string
    previewImages?: CanvasFileItem['previewImages']
    previewSheets?: CanvasFileItem['previewSheets']
    content?: string
    editable?: boolean
    ocrBundleId?: string
    reportBundleId?: CanvasFileItem['reportBundleId']
    reportBundleRole?: CanvasFileItem['reportBundleRole']
    reportBundleRefName?: CanvasFileItem['reportBundleRefName']
    reportBundleManifestUrl?: CanvasFileItem['reportBundleManifestUrl']
  }
): CanvasFileItem {
  return {
    ...buildBaseCanvasItemDraft({
      ...options,
      width: options.width || FILE_NODE_DEFAULT_WIDTH,
      height: options.height || FILE_NODE_DEFAULT_HEIGHT
    }),
    type: 'file',
    src: options.src,
    fileName: options.fileName,
    ...(options.sourceFile ? { sourceFile: options.sourceFile } : {}),
    mimeType: options.mimeType,
    fileKind: options.fileKind,
    ...(typeof options.sizeBytes === 'number' ? { sizeBytes: options.sizeBytes } : {}),
    ...(options.previewText ? { previewText: options.previewText } : {}),
    ...(options.previewImages ? { previewImages: options.previewImages } : {}),
    ...(options.previewSheets ? { previewSheets: options.previewSheets } : {}),
    ...(typeof options.content === 'string' ? { content: options.content } : {}),
    ...(typeof options.editable === 'boolean' ? { editable: options.editable } : {}),
    ...(options.ocrBundleId ? { ocrBundleId: options.ocrBundleId } : {}),
    ...(options.reportBundleId ? { reportBundleId: options.reportBundleId } : {}),
    ...(options.reportBundleRole ? { reportBundleRole: options.reportBundleRole } : {}),
    ...(options.reportBundleRefName ? { reportBundleRefName: options.reportBundleRefName } : {}),
    ...(options.reportBundleManifestUrl
      ? { reportBundleManifestUrl: options.reportBundleManifestUrl }
      : {})
  }
}

export function createCanvasModel3DItemDraft(
  options: BaseCanvasItemDraftOptions & {
    src: string
    fileName: string
    sourceFile?: Blob
    textures?: Record<string, string>
    hy3dQuickAppKey?: CanvasModel3DItem['hy3dQuickAppKey']
    hy3dParams?: CanvasModel3DItem['hy3dParams']
    hy3dMediaState?: CanvasModel3DItem['hy3dMediaState']
  }
): CanvasModel3DItem {
  return {
    ...buildBaseCanvasItemDraft(options),
    type: 'model3d',
    src: options.src,
    fileName: options.fileName,
    ...(options.sourceFile ? { sourceFile: options.sourceFile } : {}),
    ...(options.textures ? { textures: options.textures } : {}),
    ...(options.hy3dQuickAppKey ? { hy3dQuickAppKey: options.hy3dQuickAppKey } : {}),
    ...(options.hy3dParams ? { hy3dParams: options.hy3dParams } : {}),
    ...(options.hy3dMediaState ? { hy3dMediaState: options.hy3dMediaState } : {})
  }
}

export function createCanvasHtmlItemDraft(
  options: BaseCanvasItemDraftOptions & {
    htmlData: string
    interactive?: boolean
    ocrBundleId?: string
  }
): CanvasHtmlItem {
  return {
    ...buildBaseCanvasItemDraft(options),
    type: 'html',
    htmlData: options.htmlData,
    interactive: options.interactive ?? true,
    ...(options.ocrBundleId ? { ocrBundleId: options.ocrBundleId } : {})
  }
}

export function createCanvasVideoItemDraft(
  options: BaseCanvasItemDraftOptions & {
    src: string
    fileName: string
    sourceFile?: Blob
    playing?: boolean
    muted?: boolean
    volume?: number
    promptId?: string
    fileItem?: CanvasVideoItem['fileItem']
  }
): CanvasVideoItem {
  return {
    ...buildBaseCanvasItemDraft(options),
    type: 'video',
    src: options.src,
    fileName: options.fileName,
    ...(options.sourceFile ? { sourceFile: options.sourceFile } : {}),
    playing: options.playing ?? false,
    muted: options.muted ?? true,
    volume: options.volume ?? 0.5,
    ...(options.promptId ? { promptId: options.promptId } : {}),
    ...(options.fileItem ? { fileItem: options.fileItem } : {})
  }
}

export function createCanvasTextItemDraft(
  options: BaseCanvasItemDraftOptions & {
    text: string
    fontSize?: number
    fontFamily?: string
    fill?: string
    fontWeight?: CanvasTextItem['fontWeight']
  }
): CanvasTextItem {
  return {
    ...buildBaseCanvasItemDraft(options),
    type: 'text',
    text: options.text,
    fontSize: options.fontSize ?? 24,
    fontFamily: options.fontFamily ?? 'system-ui, sans-serif',
    fill: options.fill ?? '#ffffff',
    ...(options.fontWeight ? { fontWeight: options.fontWeight } : {})
  }
}

export function normalizeImportedCanvasGroups(
  groups: CanvasGroup[],
  items: CanvasItem[]
): CanvasGroup[] {
  const restoredItemIds = new Set(items.map((item) => item.id))
  return groups
    .map((group) => ({
      ...group,
      itemIds: group.itemIds.filter((itemId) => restoredItemIds.has(itemId))
    }))
    .filter((group) => group.itemIds.length > 0)
}
