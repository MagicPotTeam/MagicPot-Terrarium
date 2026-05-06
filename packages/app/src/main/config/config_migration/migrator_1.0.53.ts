import { Config } from '@shared/config/config'
import { Migrator } from './migrator'
import { isConfig1053 } from './type_1.0.53'
import { DeepPartial } from '@shared/utils/utilTypes'
import { parsePortFromOrigin } from '@shared/utils/utilFuncs'

export const migrator1_0_53: Migrator<DeepPartial<Config>> = {
  migrate: (config: unknown): DeepPartial<Config> => {
    if (!isConfig1053(config)) {
      return config as DeepPartial<Config>
    }

    const comfyuiHost = config.comfyui_host
    const comfyuiPort = comfyuiHost ? parseInt(parsePortFromOrigin(comfyuiHost)) : 0
    const pythonCmd = config.python_cmd
    const comfyuiDir = config.comfyui_dir
    const comfyuiArgs = config.comfyui_args

    if (config.comfyui_host) {
      delete config.comfyui_host
    }
    if (config.python_cmd) {
      delete config.python_cmd
    }
    if (config.comfyui_dir) {
      delete config.comfyui_dir
    }
    if (config.comfyui_args) {
      delete config.comfyui_args
    }

    const newConfig: DeepPartial<Config> = {
      ...config,
      config_version: '>1.0.53',
      use_remote_comfyui: false,
      local_comfyui_config: {
        python_cmd: pythonCmd,
        comfyui_dir: comfyuiDir,
        comfyui_args: comfyuiArgs,
        comfyui_port: comfyuiPort.toString()
      }
    }
    return newConfig
  }
}
