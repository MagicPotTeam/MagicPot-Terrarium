export type TargetSchemeFile = {
  id: string
  name: string
  content: string
  language?: string
  mimeType?: string
  sizeBytes?: number
  attachmentUrl?: string
}

export type TargetScheme = {
  id: string
  name: string
  description: string
  enabled: boolean
  files: TargetSchemeFile[]
  createdAt: string
  updatedAt: string
}
