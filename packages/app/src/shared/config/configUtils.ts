import {
  DEFAULT_CHECKPOINTS_DIR,
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
import { parsePortFromOrigin } from '@shared/utils/utilFuncs'
import { AUTOMATION_SCHEME_DEFINITION_DIR_NAME } from '@shared/automationScheme'

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
      !this.config.use_remote_comfyui &&
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

  // return [comfyui_dir, available]
  // 1. 使用本地 ComfyUI ，未设置 comfyui_dir 且非 Embedded  -> 不可用
  // 2. 使用本地 ComfyUI ，未设置 comfyui_dir 且 Embedded -> embeddedComfyuiDir
  // 3. 使用本地 ComfyUI ，设置了 comfyui_dir -> comfyui_dir
  // 4. 使用远程 ComfyUI ，未设置 mapping_comfyui_dir -> 不可用
  // 5. 使用远程 ComfyUI ，设置了 mapping_comfyui_dir -> mapping_comfyui_dir
  getComfyUIDir(): [string, boolean] {
    // 始终优先使用 embeddedDefaults（ComfyUI 已嵌入源代码）
    const embeddedComfyuiDir = this.resolveLocalDirectoryPath(
      this.buildEnv?.embeddedDefaults.comfyuiDir || ''
    )
    const localComfyUIDir =
      this.resolveLocalDirectoryPath(this.config.local_comfyui_config.comfyui_dir) ||
      embeddedComfyuiDir
    const remoteComfyUIDir = this.config.remote_comfyui_config.mapping_comfyui_dir
    const comfyuiDir = this.config.use_remote_comfyui ? remoteComfyUIDir : localComfyUIDir
    return [comfyuiDir, comfyuiDir !== '']
  }

  // return [python_cmd, available]
  // 1. 使用远程 ComfyUI -> 不可用
  // 2. 使用本地 ComfyUI ，未设置 python_cmd 且非 Embedded -> 不可用
  // 3. 使用本地 ComfyUI ，未设置 python_cmd 且 Embedded -> embeddedPythonCmd
  // 4. 使用本地 ComfyUI ，设置了 python_cmd -> python_cmd
  getPythonCmd(): [string, boolean] {
    if (this.config.use_remote_comfyui) {
      return ['', false]
    }
    // 始终优先使用 embeddedDefaults（Python 环境已嵌入源代码）
    const embeddedPythonCmd = this.resolveLocalCommandPath(
      this.buildEnv?.embeddedDefaults.pythonCmd || ''
    )
    const pythonCmd =
      this.resolveLocalCommandPath(this.config.local_comfyui_config.python_cmd) || embeddedPythonCmd
    return [pythonCmd, pythonCmd !== '']
  }

  getComfyUIPort(): string {
    if (this.config.use_remote_comfyui) {
      return parsePortFromOrigin(this.config.remote_comfyui_config.comfyui_origin)
    }
    const port = this.config.local_comfyui_config.comfyui_port
    if (port === '') {
      return '8188'
    }
    return port
  }

  getComfyUIArgs(): string[] {
    if (this.config.use_remote_comfyui) {
      return []
    }
    if (this.config.local_comfyui_config.comfyui_args.length > 0) {
      return this.config.local_comfyui_config.comfyui_args
    }

    const embeddedComfyuiArgs = this.buildEnv?.embeddedDefaults.comfyuiArgs || []

    return [...embeddedComfyuiArgs, '--port', this.getComfyUIPort()]
  }

  getComfyUIOrigin(): string {
    if (this.config.use_remote_comfyui) {
      return this.config.remote_comfyui_config.comfyui_origin
    }

    const port = this.getComfyUIPort()
    return `http://localhost:${port}`
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
   * @returns QApp 目录，指向项目根目录的 qApps 文件夹（可被 git 跟踪）
   */
  getQAppDir(): string {
    // 始终使用项目根目录的 qApps 文件夹（开发环境是 process.cwd()，生产环境是 resources 的父目录）
    // 即用户请求的 Local/Programs/magicpot 目录下
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
    const comfyUIArgsAvailable = this.getComfyUIArgs().length > 0
    return comfyUIArgsAvailable && this.isComfyUIDirAvailable() && this.isPythonCmdAvailable()
  }

  // 连接到 ComfyUI API 的必要设置都已完成
  isComfyUIAPIAvailable(): boolean {
    return this.getComfyUIOrigin() !== ''
  }
}
