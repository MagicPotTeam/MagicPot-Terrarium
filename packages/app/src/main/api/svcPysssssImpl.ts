import {
  ListImagesReq,
  ListImagesResp,
  PysssssSvc,
  ViewImageReq,
  ViewImageResp
} from '@shared/api/svcPysssss'
import { ComfyHttpCli } from '../comfy/http'

export class PysssssSvcImpl implements PysssssSvc {
  private cli = () => new ComfyHttpCli()

  //////////////////////
  // 以下为一比一仿真的 Pysssss API
  // 全部透传
  //////////////////////

  listImages = async (req: ListImagesReq): Promise<ListImagesResp> => {
    const res = await this.cli().listImages(req.type)
    return res
  }
  viewImage = async (req: ViewImageReq): Promise<ViewImageResp> => {
    const res = await this.cli().viewImage(req.name)
    return { image: res }
  }
}
