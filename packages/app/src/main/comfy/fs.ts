// AIEngineElectron/packages/app/src/main/comfy/fs.ts
import { Config } from '@shared/config/config'
import { BuildEnv } from '@shared/config/buildEnv'
import fs from 'fs/promises'
import { exists } from '../utils/fileUtils'
import path from 'path'
import { ConfigUtils } from '@shared/config/configUtils'
import { getConfig } from '../config/config'
import { getBuildEnv } from '../config/buildEnv'
import { FileInfo, GetExtraModelPathsResp } from '@shared/api/svcHyper'
import { load } from 'js-yaml'

export type ExtraModelPaths = {
  base_path?: string
  checkpoints?: string
  vae?: string
  loras?: string
  controlnet?: string
}

/**
 * ComfyUI 文件操作
 */
export class ComfyFSCli {
  private configUtils: ConfigUtils

  constructor(
    private config: Config = getConfig(),
    private buildEnv: BuildEnv = getBuildEnv()
  ) {
    this.configUtils = new ConfigUtils(this.config, this.buildEnv, path)
  }

  /**
   * 递归遍历目录，按扩展名过滤并逐个回调
   */
  private async walkAndEmit(
    absDir: string,
    exts: string[] | undefined,
    onFile: (file: FileInfo) => Promise<void>
  ): Promise<void> {
    if (!(await exists(absDir))) return

    // 统一扩展名为 .xxx 形式（小写）
    const allowExts =
      exts && exts.length
        ? exts.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))
        : null

    const dirents = await fs.readdir(absDir, { withFileTypes: true })
    for (const d of dirents) {
      const full = path.join(absDir, d.name)
      if (d.isDirectory()) {
        // 继续递归子目录
        await this.walkAndEmit(full, exts, onFile)
      } else if (d.isFile()) {
        // 后缀过滤
        if (allowExts) {
          const ext = path.extname(d.name).toLowerCase()
          if (!allowExts.includes(ext)) continue
        }
        // 读取 stat，并把可能的 bigint 转成 number
        const st = await fs.stat(full)
        await onFile({
          name: d.name,
          path: full,
          size: st.size,
          lastModified: st.mtimeMs
        })
      }
      // 其他类型（符号链接/管道等）忽略
    }
  }

  /**
   * 对外：遍历并回调文件信息（递归所有子目录）
   */
  async forEachFileInfo(
    comfyDir: string,
    exts: string[] | undefined,
    onFile: (file: FileInfo) => Promise<void>
  ): Promise<void> {
    const absDir = this.configUtils.comfySubDir(comfyDir)
    if (!absDir) {
      console.error('[ComfyFSCli] base dir is not available:', comfyDir)
      return
    }
    await this.walkAndEmit(absDir, exts, onFile)
  }

  async getExtraModelPaths(): Promise<ExtraModelPaths> {
    const [comfyUIDir, available] = this.configUtils.getComfyUIDir()
    if (!available) {
      throw new Error('ComfyUI directory is not available')
    }

    let filePath = path.join(comfyUIDir, 'extra_model_paths.yaml')
    if (!(await exists(filePath))) {
      filePath = path.join(comfyUIDir, 'extra_model_paths.yml')
    }
    if (!(await exists(filePath))) {
      throw new Error('Extra model paths file not found')
    }

    const extraModelPaths = await fs.readFile(filePath, 'utf-8')
    const parsed = load(extraModelPaths)

    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const target = (parsed as Record<string, unknown>)['a111']
    if (!target || typeof target !== 'object') {
      return {}
    }

    return target as ExtraModelPaths
  }
}
