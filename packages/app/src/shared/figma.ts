export type FigmaBindingPage = {
  nodeId: string
  name: string
  childCount: number
}

export type CanvasFigmaBinding = {
  fileKey: string
  fileName: string
  fileUrl?: string
  pageNodeId?: string
  pageName?: string
  pages: FigmaBindingPage[]
  autoCheckUpdates: boolean
  lastSyncedAt?: string
  lastCheckedAt?: string
  lastKnownVersion?: string
  lastKnownModifiedAt?: string
  updateAvailable?: boolean
}
