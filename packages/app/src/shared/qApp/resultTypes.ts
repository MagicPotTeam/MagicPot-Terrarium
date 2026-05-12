import { FileItem } from '@shared/comfy/types'

export type ResultItemBase<ItemType extends string> = {
  id: string
  promptId: string
  type: ItemType
  projectId?: string
}

export type ResultItemImage = ResultItemBase<'image'> & {
  objectUrl: string
  fileItem: FileItem
  sourceBlob?: Blob
  sourceWidth?: number
  sourceHeight?: number
}

export type ResultItemVideo = ResultItemBase<'video'> & {
  objectUrl: string
  fileItem: FileItem
}

export type TextItem = {
  text: string
  nodeId: string
  nodeTitle?: string
  nodeClassType?: string
}

export type ResultItemTexts = ResultItemBase<'texts'> & {
  resultItems: TextItem[]
}

export type ResultItemText = ResultItemBase<'text'> & {
  text: string
  nodeId: string
  nodeTitle?: string
  nodeClassType?: string
}

export type ResultItem = ResultItemImage | ResultItemVideo | ResultItemTexts | ResultItemText
export type ResultItemType = ResultItem['type']
export type ResultItemTypeMap = {
  [K in ResultItemType]: Extract<ResultItem, { type: K }>
}
