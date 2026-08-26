import {
  DEFAULT_CHECKPOINTS_DIR,
  DEFAULT_COMFYUI_ORIGIN,
  DEFAULT_CLIP_DIR,
  DEFAULT_CONTROLNET_DIR,
  DEFAULT_DIFFUSION_MODELS_DIR,
  DEFAULT_LORA_DIR,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_UNET_DIR,
  DEFAULT_UPSCALE_MODELS_DIR,
  DEFAULT_VAE_DIR,
  DEFAULT_WORKFLOW_DIR
} from './config'
import type { Config } from './config'
import { BuildEnv } from './buildEnv'
import { BuiltInPath } from '@shared/utils/utilWindow'
import { AUTOMATION_SCHEME_DEFINITION_DIR_NAME } from '@shared/automationScheme'

function isLocalComfyUIHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function isLegacyLocalDefaultOrigin(origin: string): boolean {
  try {
    const url = new URL(origin.includes('://') ? origin : `http://${origin}`)
    return url.protocol === 'http:' && isLocalComfyUIHostname(url.hostname) && url.port === ''
  } catch {
    return false
  }
}

/**
 * 用于统一配置计算字段的逻辑
 *
 * Browser 端没有 path 模块，需要传入 join 函数
 */
export class ConfigUtils {
  constructor(
    private config: Config,
    private buildEnv: BuildEnv,
    private path: BuiltInPath
  ) {}

  private getAppRootDir(): string {
    return this.buildEnv.pathMap.file
  }

  private getBundledContentDir(developmentSegments: string[], packagedDirName: string): string {
    if (this.buildEnv.env.build === 'development') {
      return this.path.join(this.getAppRootDir(), ...developmentSegments)
    }
    return this.path.join(this.getAppRootDir(), packagedDirName)
  }

  private isUsingDevelopmentEmbeddedComfyDataDir(): boolean {
    return (
      this.buildEnv.env.build === 'development' &&
      !this.config.local_comfyui_config.comfyui_dir.trim() &&
      Boolean(this.buildEnv.embeddedDefaults.comfyuiDir)
    )
  }

  private comfyDataSubDir(subDir: string): string {
    const [comfyUIDir, available] = this.getComfyUIDir()
    if (!available) {
      return ''
    }
    return this.path.join(comfyUIDir, '..', 'comfyui_data', subDir)
  }

  private resolveDefaultDevelopmentEmbeddedSubDir(value: string, defaultSubDir: string): string {
    const normalizedValue = value.trim()
    if (normalizedValue === defaultSubDir && this.isUsingDevelopmentEmbeddedComfyDataDir()) {
      return this.comfyDataSubDir(defaultSubDir)
    }
    return this.comfySubDir(normalizedValue)
  }

  private resolveLocalDirectoryPath(value: string): string {
    if (!value) {
      return ''
    }
    if (this.path.isAbsolute(value)) {
      return value
    }
    return this.path.join(this.getAppRootDir(), value)
  }

  private resolveLocalCommandPath(value: string): string {
    if (!value) {
      return ''
    }
    if (this.path.isAbsolute(value)) {
      return value
    }
    const looksLikePath =
      value.includes('/') || value.includes('\\') || value.startsWith('.') || value === '..'
    if (!looksLikePath && this.buildEnv.env.buildMode !== 'embedded') {
      return value
    }
    return this.path.join(this.getAppRootDir(), value)
  }

  // 本机由 MagicPot 管理的 ComfyUI 启动配置始终来自 local_comfyui_config，
  // 与当前工作流连接的是本地还是远程 API 无关。
  getManagedComfyUIDir(): [string, boolean] {
    const embeddedComfyuiDir = this.resolveLocalDirectoryPath(
      this.buildEnv?.embeddedDefaults.comfyuiDir || ''
    )
    const comfyuiDir =
      this.resolveLocalDirectoryPath(this.config.local_comfyui_config.comfyui_dir) ||
      embeddedComfyuiDir
    return [comfyuiDir, comfyuiDir !== '']
  }

  getManagedPythonCmd(): [string, boolean] {
    const embeddedPythonCmd = this.resolveLocalCommandPath(
      this.buildEnv?.embeddedDefaults.pythonCmd || ''
    )
    const pythonCmd =
      this.resolveLocalCommandPath(this.config.local_comfyui_config.python_cmd) || embeddedPythonCmd
    return [pythonCmd, pythonCmd !== '']
  }

  getManagedComfyUIPort(): string {
    const configuredPort = this.config.local_comfyui_config.comfyui_port.trim()
    if (configuredPort !== '') {
      return configuredPort
    }

    const configuredOrigin = this.config.remote_comfyui_config.comfyui_origin.trim()
    try {
      const url = new URL(
        configuredOrigin || DEFAULT_COMFYUI_ORIGIN,
        configuredOrigin.includes('://') ? undefined : 'http://'
      )
      if (isLocalComfyUIHostname(url.hostname) && url.port) {
        return url.port
      }
    } catch {
      // Keep the managed default when the configured API origin is invalid.
    }
    return '8188'
  }

  getManagedComfyUIArgs(): string[] {
    if (this.config.local_comfyui_config.comfyui_args.length > 0) {
      return this.config.local_comfyui_config.comfyui_args
    }
    return [
      ...(this.buildEnv?.embeddedDefaults.comfyuiArgs || []),
      '--port',
      this.getManagedComfyUIPort()
    ]
  }

  // Return the locally managed ComfyUI directory when available. A mapped directory
  // is retained as a compatibility fallback for installations configured before the
  // unified endpoint model.
  getComfyUIDir(): [string, boolean] {
    const [localComfyUIDir] = this.getManagedComfyUIDir()
    const mappedComfyUIDir = this.config.remote_comfyui_config.mapping_comfyui_dir.trim()
    const comfyuiDir = mappedComfyUIDir || localComfyUIDir
    return [comfyuiDir, comfyuiDir !== '']
  }

  // Return the managed Python command independently of the configured API endpoint.
  getPythonCmd(): [string, boolean] {
    return this.getManagedPythonCmd()
  }

  getComfyUIPort(): string {
    return this.getManagedComfyUIPort()
  }

  getComfyUIArgs(): string[] {
    if (this.config.local_comfyui_config.comfyui_args.length > 0) {
      return this.config.local_comfyui_config.comfyui_args
    }

    const embeddedComfyuiArgs = this.buildEnv?.embeddedDefaults.comfyuiArgs || []

    return [...embeddedComfyuiArgs, '--port', this.getComfyUIPort()]
  }

  getComfyUIOrigin(): string {
    const configuredOrigin = this.config.remote_comfyui_config.comfyui_origin.trim()
    if (!configuredOrigin) {
      return DEFAULT_COMFYUI_ORIGIN
    }

    // Older local configurations stored the API origin as localhost:8188 and
    // kept a custom port in local_comfyui_config. Preserve that setup while
    // using the unified origin field for all new configurations.
    if (
      isLegacyLocalDefaultOrigin(configuredOrigin) &&
      this.config.local_comfyui_config.comfyui_port.trim() !== '' &&
      this.config.local_comfyui_config.comfyui_port.trim() !== '8188'
    ) {
      return `http://127.0.0.1:${this.config.local_comfyui_config.comfyui_port.trim()}`
    }
    return configuredOrigin
  }

  getPortablePythonHomeDir(): string {
    return this.path.join(this.buildEnv.pathMap.data, 'runtime', 'home')
  }

  // 所有 ComfyUI 子目录统一逻辑：
  // 如果为绝对路径，则直接返回
  // 否则，返回相对于 ComfyUI 目录的相对路径
  // 如果是相对路径而 ComfyUI 目录未设置，则返回空字符串
  comfySubDir(subDir: string): string {
    if (this.path.isAbsolute(subDir)) {
      return subDir
    }
    const [comfyUIDir, available] = this.getComfyUIDir()
    if (!available) {
      return ''
    }
    return this.path.join(comfyUIDir, subDir)
  }

  getLoraDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(this.config.lora_dir, DEFAULT_LORA_DIR)
  }

  getClipDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(this.config.clip_dir, DEFAULT_CLIP_DIR)
  }

  getVAEDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(this.config.vae_dir, DEFAULT_VAE_DIR)
  }

  getControlnetDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(
      this.config.controlnet_dir,
      DEFAULT_CONTROLNET_DIR
    )
  }

  getDiffusionModelsDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(
      this.config.diffusion_models_dir,
      DEFAULT_DIFFUSION_MODELS_DIR
    )
  }

  getUNetDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(this.config.unet_dir, DEFAULT_UNET_DIR)
  }

  getUpscaleModelsDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(
      this.config.upscale_models_dir,
      DEFAULT_UPSCALE_MODELS_DIR
    )
  }

  getOutputDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(this.config.output_dir, DEFAULT_OUTPUT_DIR)
  }

  getCheckpointsDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(
      this.config.checkpoints_dir,
      DEFAULT_CHECKPOINTS_DIR
    )
  }

  getWorkflowDir(): string {
    return this.resolveDefaultDevelopmentEmbeddedSubDir(
      this.config.workflow_dir,
      DEFAULT_WORKFLOW_DIR
    )
  }

  /**
   * @returns 用户可写的 QApp 目录，位于 Electron userData/Data/qApps。
   *          开发环境与内置 QApp 的 packages/qapps 目录是两个不同来源。
   */
  getQAppDir(): string {
    return this.path.join(this.buildEnv.pathMap.data, 'qApps')
  }

  /**
   * @returns 只读内置 QApp 目录，指向应用文件根目录下的 qApps 文件夹。
   */
  getBuiltinQAppDir(): string {
    return this.getBundledContentDir(['packages', 'qapps'], 'qApps')
  }

  getBundledCustomSkillDir(): string {
    return this.getBundledContentDir(['packages', 'skills'], 'customSkills')
  }

  getBundledTargetSchemeDir(): string {
    return this.getBundledContentDir(['packages', 'target-schemes'], 'targetSchemes')
  }

  /**
   * @returns 自定义技能目录，指向项目根目录的 customSkills 文件夹
   * 每个技能以独立 JSON 文件存储，类似 QApp 的存储方式
   */
  getCustomSkillDir(): string {
    return this.path.join(this.buildEnv.pathMap.data, 'customSkills')
  }

  /**
   * @returns 自定义目标方案目录，指向项目根目录的 targetSchemes 文件夹。
   */
  getTargetSchemeDir(): string {
    return this.path.join(this.buildEnv.pathMap.data, 'targetSchemes')
  }

  /**
   * @returns 历史目标目录，指向项目根目录的 targetHistories 文件夹。
   */
  getTargetHistoryDir(): string {
    return this.path.join(this.buildEnv.pathMap.data, 'targetHistories')
  }

  getAutomationSchemeDir(): string {
    return this.path.join(this.buildEnv.pathMap.data, AUTOMATION_SCHEME_DEFINITION_DIR_NAME)
  }

  isManagedComfyUICommandAvailable(): boolean {
    return (
      this.getManagedComfyUIArgs().length > 0 &&
      this.getManagedComfyUIDir()[1] &&
      this.getManagedPythonCmd()[1]
    )
  }

  // 本地 ComfyUI 的目录设置都已完成
  isComfyUIDirAvailable(): boolean {
    const [comfyuiDir, available] = this.getComfyUIDir()
    return available
  }

  // 本地 ComfyUI 的 python 路径设置都已完成
  isPythonCmdAvailable(): boolean {
    const [pythonCmd, available] = this.getPythonCmd()
    return available
  }

  // 启动 ComfyUI 命令的必要设置都已完成
  isComfyUICommandAvailable(): boolean {
    return this.isManagedComfyUICommandAvailable()
  }

  // 连接到 ComfyUI API 的必要设置都已完成
  isComfyUIAPIAvailable(): boolean {
    return this.getComfyUIOrigin() !== ''
  }
}
