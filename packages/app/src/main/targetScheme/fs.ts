import path from 'path'
import fs from 'fs/promises'
import type { Config } from '@shared/config/config'
import type { BuildEnv } from '@shared/config/buildEnv'
import type { TargetHistoryEntry } from '@shared/targetHistory'
import type { TargetScheme } from '@shared/targetScheme'
import { ConfigUtils } from '@shared/config/configUtils'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig } from '../config/config'
import { exists } from '../utils/fileUtils'

const TARGET_SCHEME_FILE_SUFFIX = '.target.json'
const TARGET_HISTORY_FILE_SUFFIX = '.target-history.json'
const LEGACY_TARGET_SCHEME_FILE_SUFFIXES = ['.automation.json', '.check.json'] as const
const SUPPORTED_TARGET_SCHEME_FILE_SUFFIXES = [
  TARGET_SCHEME_FILE_SUFFIX,
  ...LEGACY_TARGET_SCHEME_FILE_SUFFIXES
]

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/^\0+/, '')
}

function normalizePathKey(targetPath: string): string {
  const normalized = path.normalize(targetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export class TargetSchemeFSCli {
  private configUtils: ConfigUtils

  constructor(
    private config: Config = getConfig(),
    private buildEnv: BuildEnv = getBuildEnv()
  ) {
    this.configUtils = new ConfigUtils(this.config, this.buildEnv, path)
  }

  private async ensureDir(dir: string): Promise<string> {
    if (!(await exists(dir))) {
      await fs.mkdir(dir, { recursive: true })
    }
    return dir
  }

  private getLegacySchemeDirs(): string[] {
    const candidates = [
      this.configUtils.getBundledTargetSchemeDir(),
      path.join(this.buildEnv.pathMap.file, 'automationSchemes'),
      path.join(this.buildEnv.pathMap.file, 'targetSchemes'),
      path.join(this.buildEnv.pathMap.data, 'automationSchemes'),
      path.join(this.buildEnv.pathMap.file, 'customChecks'),
      path.join(this.buildEnv.pathMap.data, 'customChecks')
    ]

    return candidates.filter(
      (candidate, index) =>
        candidates.findIndex((entry) => normalizePathKey(entry) === normalizePathKey(candidate)) ===
        index
    )
  }

  private shouldRemoveLegacySourceAfterImport(dir: string): boolean {
    const userDataLegacyDirs = [
      path.join(this.buildEnv.pathMap.data, 'automationSchemes'),
      path.join(this.buildEnv.pathMap.data, 'customChecks')
    ]
    const normalizedDir = normalizePathKey(dir)
    return userDataLegacyDirs.some((entry) => normalizePathKey(entry) === normalizedDir)
  }

  private isSupportedTargetSchemeFileName(fileName: string): boolean {
    return SUPPORTED_TARGET_SCHEME_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))
  }

  private getTargetPathsForLegacyFileName(dir: string, fileName: string): string[] {
    const matchedSuffix = SUPPORTED_TARGET_SCHEME_FILE_SUFFIXES.find((suffix) =>
      fileName.endsWith(suffix)
    )
    if (!matchedSuffix) {
      return [path.join(dir, fileName)]
    }

    const fileStem = fileName.slice(0, -matchedSuffix.length)
    return [
      path.join(dir, `${fileStem}${TARGET_SCHEME_FILE_SUFFIX}`),
      ...LEGACY_TARGET_SCHEME_FILE_SUFFIXES.map((suffix) => path.join(dir, `${fileStem}${suffix}`))
    ]
  }

  private async migrateLegacyFileNames(dir: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true })

    for (const dirent of dirents) {
      const legacySuffix = LEGACY_TARGET_SCHEME_FILE_SUFFIXES.find((suffix) =>
        dirent.name.endsWith(suffix)
      )
      if (!dirent.isFile() || !legacySuffix) {
        continue
      }

      const legacyFilePath = path.join(dir, dirent.name)
      const nextFilePath = path.join(
        dir,
        dirent.name.replace(legacySuffix, TARGET_SCHEME_FILE_SUFFIX)
      )

      if (await exists(nextFilePath)) {
        await fs.unlink(legacyFilePath)
        continue
      }

      await fs.rename(legacyFilePath, nextFilePath)
    }
  }

  private async mergeLegacySchemeDirs(dir: string): Promise<void> {
    for (const legacyDir of this.getLegacySchemeDirs()) {
      if (normalizePathKey(legacyDir) === normalizePathKey(dir)) {
        continue
      }
      if (!(await exists(legacyDir))) {
        continue
      }

      const dirents = await fs.readdir(legacyDir, { withFileTypes: true })
      for (const dirent of dirents) {
        if (!dirent.isFile() || !this.isSupportedTargetSchemeFileName(dirent.name)) {
          continue
        }

        const sourcePath = path.join(legacyDir, dirent.name)
        const shouldRemoveSource = this.shouldRemoveLegacySourceAfterImport(legacyDir)
        const targetPaths = this.getTargetPathsForLegacyFileName(dir, dirent.name)
        const targetExists = await Promise.all(targetPaths.map((targetPath) => exists(targetPath)))
        if (targetExists.some(Boolean)) {
          if (shouldRemoveSource) {
            await fs.unlink(sourcePath)
          }
          continue
        }

        await fs.copyFile(sourcePath, path.join(dir, dirent.name))
        if (shouldRemoveSource) {
          await fs.unlink(sourcePath)
        }
      }
    }
  }

  async getTargetSchemeDir(): Promise<string> {
    const dir = this.configUtils.getTargetSchemeDir()
    await this.ensureDir(dir)
    await this.mergeLegacySchemeDirs(dir)
    await this.migrateLegacyFileNames(dir)
    return dir
  }

  async getTargetHistoryDir(): Promise<string> {
    const dir = this.configUtils.getTargetHistoryDir()
    await this.ensureDir(dir)
    return dir
  }

  private getTargetSchemeFilePaths(dir: string, schemeId: string): string[] {
    const safeId = schemeId.replace(/[\\/:*?"<>|]/g, '_')
    return [
      path.join(dir, `${safeId}${TARGET_SCHEME_FILE_SUFFIX}`),
      ...LEGACY_TARGET_SCHEME_FILE_SUFFIXES.map((suffix) => path.join(dir, `${safeId}${suffix}`))
    ]
  }

  private getTargetHistoryFilePath(dir: string, targetId: string): string {
    const safeId = targetId.replace(/[\\/:*?"<>|]/g, '_')
    return path.join(dir, `${safeId}${TARGET_HISTORY_FILE_SUFFIX}`)
  }

  async listSchemes(): Promise<TargetScheme[]> {
    const dir = await this.getTargetSchemeDir()
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const schemes: TargetScheme[] = []

    for (const dirent of dirents) {
      if (
        !dirent.isFile() ||
        !SUPPORTED_TARGET_SCHEME_FILE_SUFFIXES.some((suffix) => dirent.name.endsWith(suffix))
      ) {
        continue
      }

      try {
        const filePath = path.join(dir, dirent.name)
        const raw = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8')))
        if (raw?.id) {
          schemes.push(raw as TargetScheme)
        }
      } catch (error) {
        console.error(`[TargetSchemeFS] Failed to read scheme file ${dirent.name}:`, error)
      }
    }

    return schemes.sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || '') || 0
      const rightTime = Date.parse(right.updatedAt || right.createdAt || '') || 0
      if (leftTime !== rightTime) return rightTime - leftTime
      return left.name.localeCompare(right.name)
    })
  }

  async saveScheme(scheme: TargetScheme): Promise<void> {
    const dir = await this.getTargetSchemeDir()
    const [preferredFilePath, legacyFilePath] = this.getTargetSchemeFilePaths(dir, scheme.id)
    await fs.writeFile(preferredFilePath, JSON.stringify(scheme, null, 2), 'utf8')
    if (await exists(legacyFilePath)) {
      await fs.unlink(legacyFilePath)
    }
  }

  async deleteScheme(id: string): Promise<void> {
    const dir = await this.getTargetSchemeDir()
    for (const filePath of this.getTargetSchemeFilePaths(dir, id)) {
      if (await exists(filePath)) {
        await fs.unlink(filePath)
      }
    }
  }

  async listHistoryTargets(): Promise<TargetHistoryEntry[]> {
    const dir = await this.getTargetHistoryDir()
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const targets: TargetHistoryEntry[] = []

    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(TARGET_HISTORY_FILE_SUFFIX)) {
        continue
      }

      try {
        const filePath = path.join(dir, dirent.name)
        const raw = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8')))
        if (raw?.id) {
          targets.push(raw as TargetHistoryEntry)
        }
      } catch (error) {
        console.error(`[TargetSchemeFS] Failed to read history target file ${dirent.name}:`, error)
      }
    }

    return targets.sort((left, right) => {
      const leftTime =
        Date.parse(left.lastRunAt || left.updatedAt || left.createdAt || '') ||
        Date.parse(left.updatedAt || left.createdAt || '') ||
        0
      const rightTime =
        Date.parse(right.lastRunAt || right.updatedAt || right.createdAt || '') ||
        Date.parse(right.updatedAt || right.createdAt || '') ||
        0
      if (leftTime !== rightTime) return rightTime - leftTime
      return left.name.localeCompare(right.name)
    })
  }

  async saveHistoryTarget(target: TargetHistoryEntry): Promise<void> {
    const dir = await this.getTargetHistoryDir()
    await fs.writeFile(
      this.getTargetHistoryFilePath(dir, target.id),
      JSON.stringify(target, null, 2),
      'utf8'
    )
  }

  async deleteHistoryTarget(id: string): Promise<void> {
    const dir = await this.getTargetHistoryDir()
    const filePath = this.getTargetHistoryFilePath(dir, id)
    if (await exists(filePath)) {
      await fs.unlink(filePath)
    }
  }
}
