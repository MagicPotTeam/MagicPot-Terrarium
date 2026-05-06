import { ComfySvc, CustomNodeInfo } from '@shared/api/svcComfy'
import {
  ListImagesReq,
  ListImagesResp,
  PysssssSvc,
  ViewImageReq,
  ViewImageResp
} from '@shared/api/svcPysssss'

const PYSSSSS_INFO_NAME = 'comfyui-custom-scripts'

/**
 * 用于包装 ComfyUI 中自定义节点相关的 API
 *
 * 统一判断，统一处理自定义节点有无安装的情况
 */
export class ComfyUtils implements PysssssSvc {
  private installed: Record<string, CustomNodeInfo> | null = null
  constructor(
    private comfySvc: ComfySvc,
    private pysssssSvc: PysssssSvc
  ) {}
  private async getInstalled(): Promise<Record<string, CustomNodeInfo>> {
    if (this.installed) {
      return this.installed
    }
    this.installed = await this.comfySvc.getInstalled({})
    return this.installed
  }

  private async mustPysssssInstalled(): Promise<void> {
    const installed = await this.getInstalled()
    if (!installed[PYSSSSS_INFO_NAME]?.enabled) {
      throw new Error('Pysssss is not installed')
    }
  }

  listImages = async (req: ListImagesReq): Promise<ListImagesResp> => {
    await this.mustPysssssInstalled()
    return this.pysssssSvc.listImages(req)
  }
  viewImage = async (req: ViewImageReq): Promise<ViewImageResp> => {
    await this.mustPysssssInstalled()
    return this.pysssssSvc.viewImage(req)
  }
}
