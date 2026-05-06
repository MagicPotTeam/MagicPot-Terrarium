import { DeepPartial } from '@shared/utils/utilTypes'

export type Config1_0_53 = {
  comfyui_host: string
  /**
   * 调用 ComfyUI API 时用的 client_id
   * 放在 Config 里，算是保证了：
   * - 前后端 client_id 一致
   * - 用户保存配置后，可以保证 client_id 不变
   * - 不同软件实例间 client_id 之间不冲突
   *
   * 也许有更优雅的实现方式，但暂时先这样吧
   */
  client_id: string

  /*
  这三个如果为空，代表使用 embedded 的 python 和 comfyui
  值由 build env 决定
  */
  python_cmd: string
  comfyui_dir: string
  comfyui_args: string[]

  /*
  以下如果为相对路径，代表相对于 comfyui_dir 的相对路径
  */
  workflow_dir: string
  checkpoints_dir: string
  vae_dir: string
  lora_dir: string
  controlnet_dir: string
  output_dir: string
}

export function isConfig1053(config: unknown): config is DeepPartial<Config1_0_53> {
  return (
    typeof config === 'object' &&
    config !== null &&
    !('config_version' in config) &&
    ('comfyui_host' in config ||
      'python_cmd' in config ||
      'comfyui_dir' in config ||
      'comfyui_args' in config)
  )
}
