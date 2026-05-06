import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ListImagesReq = {
  type: 'loras' | 'checkpoints'
}
export type ListImagesResp = Record<string, string> // key: model name, value: image name

export type ViewImageReq = {
  name: string // image name
}
export type ViewImageResp = {
  image: Uint8Array
}

/**
 * 调用 ComfyUI 中 Pysssss 自定义节点的 API
 *
 * 需要先安装该节点，否则无法使用
 */
export type PysssssSvc = {
  /**
   * 列出所有图片地址
   * @param req
   * @returns
   */
  listImages(req: ListImagesReq): Promise<ListImagesResp>
  /**
   * 查看图片
   * @param req
   * @returns
   */
  viewImage(req: ViewImageReq): Promise<ViewImageResp>
}

export const pysssssSvcDef: ServiceDefSheet<PysssssSvc> = {
  listImages: {
    type: 'unary'
  },
  viewImage: {
    type: 'unary'
  }
}
