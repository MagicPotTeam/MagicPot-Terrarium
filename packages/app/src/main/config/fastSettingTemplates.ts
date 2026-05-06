import {
  FastSettingTemplate,
  GetFastSettingValueResp,
  ListFastSettingTemplatesResp
} from '@shared/api/svcHyper'
import { Platform } from '@shared/config/buildEnv'
import path from 'path'
import { exists } from '../utils/fileUtils'
import { getBuildEnv } from './buildEnv'

type FastSettingHandler = (inputPath: string) => Promise<GetFastSettingValueResp>

type FastSettingHandlerParams = {
  tmplPythonCmd: string // 相对于用户选择的路径，或绝对路径
  tmplComfyuiDir: string // 相对于用户选择的路径，或绝对路径（ macos 的 ComfyUI Desktop 路径是固定的）
}

const validateValue = async (value: GetFastSettingValueResp): Promise<string> => {
  if (!(await exists(value.pythonCmd))) {
    return '未找到 python 可执行文件'
  }
  if (!(await exists(value.comfyuiDir))) {
    return '未找到 ComfyUI 文件夹'
  }
  return ''
}

const buildBasicHandler = ({
  tmplPythonCmd,
  tmplComfyuiDir
}: FastSettingHandlerParams): FastSettingHandler => {
  return async (inputPath: string) => {
    const pythonCmd = path.isAbsolute(tmplPythonCmd)
      ? tmplPythonCmd
      : path.join(inputPath, tmplPythonCmd)
    const comfyuiDir = path.isAbsolute(tmplComfyuiDir)
      ? tmplComfyuiDir
      : path.join(inputPath, tmplComfyuiDir)

    const errorMessage = await validateValue({ pythonCmd, comfyuiDir })
    if (errorMessage) {
      return {
        pythonCmd,
        comfyuiDir,
        errorMessage
      }
    }

    return {
      pythonCmd,
      comfyuiDir
    }
  }
}

const availableVenvs = ['.venv', 'venv']
type BuildVenvHandlerParams = {
  tmplPythonCmd: string // 相对于用户选择的路径下的 venv 文件夹的相对路径
}
const buildVenvHandler = ({ tmplPythonCmd }: BuildVenvHandlerParams): FastSettingHandler => {
  return async (inputPath: string) => {
    const absoluteVenvPaths = availableVenvs.map((venv) => path.join(inputPath, venv))

    const comfyuiDir = inputPath
    let pythonCmd = ''
    for (const venvPath of absoluteVenvPaths) {
      if (!(await exists(venvPath))) {
        continue
      }

      pythonCmd = path.join(venvPath, tmplPythonCmd)
    }
    if (!pythonCmd) {
      return {
        pythonCmd,
        comfyuiDir,
        errorMessage: '未找到 venv 文件夹'
      }
    }

    const errorMessage = await validateValue({ pythonCmd, comfyuiDir })
    if (errorMessage) {
      return {
        pythonCmd,
        comfyuiDir,
        errorMessage
      }
    }

    return {
      pythonCmd,
      comfyuiDir
    }
  }
}

// ComfyUI-aki-v2 专用处理器：优先使用 python\python.exe，如果不存在则使用 .ext\python.exe
const buildComfyUIAkiV2Handler = (): FastSettingHandler => {
  return async (inputPath: string) => {
    const comfyuiDir = path.join(inputPath, 'ComfyUI')

    // 优先尝试 python\python.exe
    const pythonPythonCmd = path.join(inputPath, 'python', 'python.exe')
    const extPythonCmd = path.join(inputPath, '.ext', 'python.exe')

    let pythonCmd = ''
    if (await exists(pythonPythonCmd)) {
      pythonCmd = pythonPythonCmd
    } else if (await exists(extPythonCmd)) {
      pythonCmd = extPythonCmd
    } else {
      return {
        pythonCmd: '',
        comfyuiDir,
        errorMessage: '未找到 Python 可执行文件（python\\python.exe 或 .ext\\python.exe）'
      }
    }

    const errorMessage = await validateValue({ pythonCmd, comfyuiDir })
    if (errorMessage) {
      return {
        pythonCmd,
        comfyuiDir,
        errorMessage
      }
    }

    return {
      pythonCmd,
      comfyuiDir
    }
  }
}

////////////////
// buildEnv 中的 FastSettingTemplates 文字信息
////////////////

export const FAST_SETTING_DESCRIPTION_WINDOWS_PORTABLE = `请选择包含 ComfyUI 文件夹与 python_embeded 文件夹的目录`
export const FAST_SETTING_DESCRIPTION_VENV = `请选择 ComfyUI 文件夹`
export const FAST_SETTING_DESCRIPTION_COMFYUI_DESKTOP = `请选择 ComfyUI Desktop 安装路径`
export const FAST_SETTING_DESCRIPTION_COMFYUI_AKI_V2 = `请选择 ComfyUI-aki-v2 根目录（包含 ComfyUI 文件夹与 python 文件夹的目录）`

export const FAST_SETTING_ERROR_DESCRIPTION_WINDOWS_PORTABLE = `Windows Portable 版本指从官方仓库 release 下载的 ComfyUI_windows_portable_nvidia.7z 解压后的 ComfyUI 。
请先从 https://github.com/comfyanonymous/ComfyUI/releases 下载解压，
然后选择包含 ComfyUI 文件夹与 python_embeded 文件夹的目录。`
export const FAST_SETTING_ERROR_DESCRIPTION_VENV = `venv 版本指从官方仓库克隆后，使用 venv 虚拟环境运行的 ComfyUI 。
不建议完全没有开发经验的人使用这个版本。

请先将 ComfyUI 官方仓库克隆到本地，并创建 venv 虚拟环境，然后选择 ComfyUI 文件夹。
只支持虚拟环境文件夹放在项目中，且名为 .venv 。`
export const FAST_SETTING_ERROR_DESCRIPTION_COMFYUI_DESKTOP = `请选择 ComfyUI 官网上下载的 ComfyUI Desktop 安装路径。
这个文件夹里应当含有 .venv 、 models 、 custom_nodes 等文件夹。`
export const FAST_SETTING_ERROR_DESCRIPTION_COMFYUI_AKI_V2 = `ComfyUI-aki-v2 是秋葉aaaki制作的 ComfyUI 整合包，包含预配置的 Python 环境和 ComfyUI。
请选择 ComfyUI-aki-v2 的根目录，该目录应包含：
- ComfyUI 文件夹（ComfyUI 主程序）
- python 文件夹（Python 环境）
- 绘世启动器.exe（启动器）`

////////////////
// 快速设置模板
////////////////

export type ComfyUIFastSettingTemplate = {
  template: FastSettingTemplate
  handler: FastSettingHandler
}

const fastSettingTemplatesByPlatform: Record<Platform, ComfyUIFastSettingTemplate[]> = {
  windows: [
    {
      template: {
        key: 'windows_portable',
        name: 'Windows Portable',
        description: FAST_SETTING_DESCRIPTION_WINDOWS_PORTABLE,
        errorDescription: FAST_SETTING_ERROR_DESCRIPTION_WINDOWS_PORTABLE
      },
      handler: buildBasicHandler({
        tmplPythonCmd: './python_embeded/python.exe',
        tmplComfyuiDir: './ComfyUI'
      })
    },
    {
      template: {
        key: 'comfyui_desktop',
        name: 'ComfyUI Desktop',
        description: FAST_SETTING_DESCRIPTION_COMFYUI_DESKTOP,
        errorDescription: FAST_SETTING_ERROR_DESCRIPTION_COMFYUI_DESKTOP
      },
      handler: buildBasicHandler({
        tmplPythonCmd: './.venv/Scripts/python.exe',
        tmplComfyuiDir: path.join(
          process.env.LOCALAPPDATA || '',
          'Programs',
          '@comfyorgcomfyui-electron',
          'resources',
          'ComfyUI'
        )
      })
    },
    {
      template: {
        key: 'comfyui_aki_v2',
        name: '秋葉绘世启动器',
        description: FAST_SETTING_DESCRIPTION_COMFYUI_AKI_V2,
        errorDescription: FAST_SETTING_ERROR_DESCRIPTION_COMFYUI_AKI_V2
      },
      handler: buildComfyUIAkiV2Handler()
    }
  ],
  macos: [
    {
      template: {
        key: 'comfyui_desktop',
        name: 'ComfyUI Desktop',
        description: FAST_SETTING_DESCRIPTION_COMFYUI_DESKTOP,
        errorDescription: FAST_SETTING_ERROR_DESCRIPTION_COMFYUI_DESKTOP
      },
      handler: buildBasicHandler({
        tmplPythonCmd: './.venv/bin/python',
        tmplComfyuiDir: '/Applications/ComfyUI.app/Contents/Resources/ComfyUI'
      })
    }
  ],
  unknown: []
}

export const listFastSettingTemplates = async (): Promise<ListFastSettingTemplatesResp> => {
  const buildEnv = getBuildEnv()
  const platform = buildEnv.env.platform
  const fastSettingTemplates = fastSettingTemplatesByPlatform[platform] || []
  return {
    templates: fastSettingTemplates.map((template) => template.template)
  }
}

export const getFastSettingValue = async (
  inputPath: string,
  key: string
): Promise<GetFastSettingValueResp> => {
  const buildEnv = getBuildEnv()
  const platform = buildEnv.env.platform
  const fastSettingTemplates = fastSettingTemplatesByPlatform[platform] || []

  const fastSettingTemplate = fastSettingTemplates.find((template) => template.template.key === key)
  if (!fastSettingTemplate) {
    return {
      pythonCmd: '',
      comfyuiDir: '',
      errorMessage: '未找到快速设置模板'
    }
  }

  return await fastSettingTemplate.handler(inputPath)
}
