import type { FigmaBindingPage } from '@shared/figma'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ResolveFigmaFileReq = {
  accessToken: string
  fileKeyOrUrl: string
}

export type ResolveFigmaFileResp = {
  fileKey: string
  fileName: string
  pages: FigmaBindingPage[]
  lastModified?: string
  version?: string
}

export type SyncFigmaFileReq = {
  accessToken: string
  fileKeyOrUrl: string
  pageNodeId?: string
}

export type SyncFigmaCanvasItem = {
  nodeId: string
  nodeName?: string
  fileName: string
  src: string
  x: number
  y: number
  width: number
  height: number
}

export type SyncFigmaFileResp = {
  fileKey: string
  fileName: string
  pages: FigmaBindingPage[]
  pageNodeId: string
  pageName: string
  lastModified?: string
  version?: string
  items: SyncFigmaCanvasItem[]
  warnings: string[]
}

export type CheckFigmaFileUpdateReq = {
  accessToken: string
  fileKey: string
  knownLastModified?: string
  knownVersion?: string
}

export type CheckFigmaFileUpdateResp = {
  fileKey: string
  fileName: string
  pages: FigmaBindingPage[]
  lastModified?: string
  version?: string
  hasUpdate: boolean
}

export type FigmaSvc = {
  resolveFile(req: ResolveFigmaFileReq): Promise<ResolveFigmaFileResp>
  syncFile(req: SyncFigmaFileReq): Promise<SyncFigmaFileResp>
  checkFileUpdate(req: CheckFigmaFileUpdateReq): Promise<CheckFigmaFileUpdateResp>
}

export const figmaSvcDef: ServiceDefSheet<FigmaSvc> = {
  resolveFile: { type: 'unary' },
  syncFile: { type: 'unary' },
  checkFileUpdate: { type: 'unary' }
}
