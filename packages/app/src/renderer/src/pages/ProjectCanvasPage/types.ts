import type { FileItem } from '@shared/comfy/types'
import type { ReportBundleRole } from '@shared/reportBundle'
import type { Hy3dMediaState, Hy3dParams } from '../ChatPage/hy3d/types'
import type { CanvasImageSourceIdentity, CanvasImageThumbnailSet } from './canvasThumbnailTypes'

// packages/app/src/renderer/src/pages/ProjectCanvasPage/types.ts
// ─── 画布统一节点类型定义 ───

export type CanvasItemType = 'image' | 'model3d' | 'video' | 'text' | 'annotation' | 'html' | 'file'

export type CanvasProvenanceSourceKind =
  | 'magicpot-native'
  | 'figma'
  | 'psd'
  | 'psb'
  | 'svg'
  | 'imported-file'
  | 'external'

export interface CanvasProvenanceSource {
  kind: CanvasProvenanceSourceKind
  sourceFileName?: string
  sourceDocumentId?: string
  sourceNodeId?: string
  sourceNodeName?: string
  importedAt?: string
  bridgeTraceId?: string
  notes?: string
}

// ─── 基础节点属性 ───
export interface CanvasItemBase {
  id: string
  type: CanvasItemType
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
  locked: boolean
  provenance?: CanvasProvenanceSource
  tagging?: {
    tags: string[]
    tagsText: string
    caption: string
    updatedAt: string
    source: 'agent'
    jobId?: string
    score?: number
    warnings?: string[]
    provider?: {
      profileId?: string
      modelName?: string
      providerId?: string
      family?: 'tagger' | 'ocr' | 'vlm' | 'caption'
    }
    review?: {
      highlightRate?: number
      categoryMap?: Record<string, string[]>
      issues?: string[]
      folderRuleMatched?: boolean
    }
  }
  reportBundleId?: string
  reportBundleRole?: ReportBundleRole
  reportBundleRefName?: string
  reportBundleManifestUrl?: string
}

export interface CanvasGroup {
  id: string
  name: string
  itemIds: string[]
  createdAt: string
  branchId?: string | null
  defaultIndex?: number
  provenance?: CanvasProvenanceSource
}

export interface CanvasGroupBranch {
  id: string
  name: string
  createdAt: string
}

// ─── HTML 节点 ───
export interface CanvasHtmlItem extends CanvasItemBase {
  type: 'html'
  htmlData: string // raw HTML code
  interactive?: boolean // whether pointer events pass through
  ocrBundleId?: string
}

// ─── 图片节点 ───
export type CanvasImageAsset = HTMLImageElement | ImageBitmap | HTMLCanvasElement

export interface CanvasImageItem extends CanvasItemBase {
  type: 'image'
  src: string // data URL or object URL
  fileName?: string
  sourceFile?: Blob
  sizeBytes?: number
  hasAlpha?: boolean
  image?: CanvasImageAsset
  sourceIdentity?: CanvasImageSourceIdentity
  thumbnailSet?: CanvasImageThumbnailSet
  sourceWidth?: number
  sourceHeight?: number
  crop?: { x: number; y: number; width: number; height: number }
  promptId?: string
  fileItem?: FileItem
  ocrBundleId?: string
}

// ─── 3D 模型节点 ───
export interface CanvasModel3DItem extends CanvasItemBase {
  type: 'model3d'
  src: string // object URL or file path
  fileName: string
  sourceFile?: Blob
  hy3dQuickAppKey?: string
  hy3dParams?: Hy3dParams
  hy3dMediaState?: Hy3dMediaState
  textures?: Record<string, string> // 贴图文件映射: 原始文件名 → blob URL
}

// ─── 视频节点 ───
export interface CanvasVideoItem extends CanvasItemBase {
  type: 'video'
  src: string // object URL or file path
  fileName: string
  sourceFile?: Blob
  playing: boolean
  muted: boolean
  volume: number
  promptId?: string
  fileItem?: FileItem
}

export type CanvasFileKind = 'text' | 'markdown' | 'word' | 'excel' | 'powerpoint' | 'generic'

export interface CanvasFilePreviewImage {
  id: string
  src: string
  mimeType: string
  fileName: string
}

export interface CanvasFilePreviewSheetCell {
  row: number
  col: number
  text: string
  ocrCellId?: string
  ocrBboxIds?: string[]
}

export interface CanvasFilePreviewSheet {
  id: string
  name: string
  rows: number
  cols: number
  cells: CanvasFilePreviewSheetCell[]
}

export interface CanvasFileItem extends CanvasItemBase {
  type: 'file'
  src: string // object URL or file path
  fileName: string
  sourceFile?: Blob
  mimeType: string
  fileKind: CanvasFileKind
  sizeBytes?: number
  previewText?: string
  previewImages?: CanvasFilePreviewImage[]
  previewSheets?: CanvasFilePreviewSheet[]
  content?: string
  editable?: boolean
  ocrBundleId?: string
}

// ─── 文字节点 ───
export interface CanvasTextItem extends CanvasItemBase {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  fill: string
  fontWeight?: 'normal' | 'bold'
}

// ─── 标注形状类型 ───
export type AnnotationShape =
  | 'rect'
  | 'ellipse'
  | 'circle'
  | 'arrow'
  | 'line'
  | 'freedraw'
  | 'text-anno'
  | 'rhombus'
  | 'parallelogram'
  | 'double-line-rect'
  | 'document'
  | 'cylinder'
  | 'rounded-rect'

// ─── 标注节点 ───
export interface CanvasAnnotationItem extends CanvasItemBase {
  type: 'annotation'
  shape: AnnotationShape // 标注形状
  stroke: string // 边框颜色 (hex)
  fillOpacity: number // 填充透明度 0~0.5
  strokeWidth: number // 边框宽度 px
  label: string // 可选文字标签 (rect/ellipse)
  // ── 箭头专用 ──
  endX?: number // 箭头终点 X (画布坐标)
  endY?: number // 箭头终点 Y (画布坐标)
  // ── 自由画笔专用 ──
  points?: number[] // 点阵列 [x0,y0, x1,y1, ...]
  // ── 文字标注专用 ──
  text?: string
  fontSize?: number
  fontWeight?: 'normal' | 'bold'
  ocrBundleId?: string
  ocrBoxId?: string
  ocrCellIds?: string[]
  attachedToId?: string
  attachmentPlacement?: 'bottom-center'
  attachmentRole?: 'constraint' | 'tagging-result'
  attachmentBaseScale?: number
  attachmentBaseFontSize?: number
  attachmentBaseHeight?: number
}

// ─── 联合类型 ───
export type CanvasItem =
  | CanvasImageItem
  | CanvasModel3DItem
  | CanvasVideoItem
  | CanvasFileItem
  | CanvasTextItem
  | CanvasAnnotationItem
  | CanvasHtmlItem

// ─── 文件类型检测 ───
export const MODEL_3D_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx', '.stl']
export const MODEL_ARCHIVE_EXTENSIONS = ['.zip']
export const MODEL_IMPORT_EXTENSIONS = [...MODEL_3D_EXTENSIONS, ...MODEL_ARCHIVE_EXTENSIONS]
export const PSD_IMPORT_EXTENSIONS = ['.psd', '.psb']
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogg']
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']
export const FILE_EXTENSIONS = [
  '.txt',
  '.md',
  '.csv',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx'
]
export const FILE_TEXT_EXTENSIONS = ['.txt', '.md', '.csv']
export const FILE_IMPORT_EXTENSIONS = [...FILE_EXTENSIONS]
export const OFFICE_PREVIEW_EXTENSIONS = [
  '.txt',
  '.md',
  '.csv',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx'
]

export function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx).toLowerCase() : ''
}

export function detectFileType(filename: string): CanvasItemType | null {
  const ext = getFileExtension(filename)
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  if (MODEL_3D_EXTENSIONS.includes(ext)) return 'model3d'
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
  if (FILE_EXTENSIONS.includes(ext)) return 'file'
  return null
}

export function detectCanvasFileKind(filename: string): CanvasFileKind {
  const ext = getFileExtension(filename)
  if (ext === '.txt') return 'text'
  if (ext === '.md') return 'markdown'
  if (ext === '.csv') return 'excel'
  if (ext === '.doc' || ext === '.docx') return 'word'
  if (ext === '.xls' || ext === '.xlsx') return 'excel'
  if (ext === '.ppt' || ext === '.pptx') return 'powerpoint'
  return 'generic'
}

export function isEditableCanvasFile(filename: string): boolean {
  return FILE_TEXT_EXTENSIONS.includes(getFileExtension(filename))
}

export function isEditableSpreadsheetCanvasFile(filename: string): boolean {
  return getFileExtension(filename) === '.xlsx'
}

export function isOfficePreviewableFile(filename: string): boolean {
  return OFFICE_PREVIEW_EXTENSIONS.includes(getFileExtension(filename))
}

export function isModelArchiveFile(filename: string): boolean {
  return MODEL_ARCHIVE_EXTENSIONS.includes(getFileExtension(filename))
}

// ─── Accept 字符串 ───
export const ALL_ACCEPT = [
  'image/*',
  ...PSD_IMPORT_EXTENSIONS,
  ...MODEL_IMPORT_EXTENSIONS,
  ...FILE_IMPORT_EXTENSIONS,
  'video/*'
].join(',')
