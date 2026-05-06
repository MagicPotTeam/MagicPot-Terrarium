import path from 'path'
import fs from 'fs/promises'
import type { Config } from '@shared/config/config'
import type { BuildEnv } from '@shared/config/buildEnv'
import {
  AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX,
  LEGACY_AUTOMATION_SCHEME_FILE_SUFFIXES,
  type AutomationScheme
} from '@shared/automationScheme'
import { ConfigUtils } from '@shared/config/configUtils'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig } from '../config/config'
import { exists } from '../utils/fileUtils'

const AUTOMATION_SCHEME_FILE_SUFFIX = AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX
const SUPPORTED_AUTOMATION_SCHEME_FILE_SUFFIXES = [
  AUTOMATION_SCHEME_FILE_SUFFIX,
  ...LEGACY_AUTOMATION_SCHEME_FILE_SUFFIXES
]

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/^\0+/, '')
}

export class AutomationSchemeFSCli {
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

  private async migrateLegacyFileNames(dir: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true })

    for (const dirent of dirents) {
      const legacySuffix = LEGACY_AUTOMATION_SCHEME_FILE_SUFFIXES.find((suffix) =>
        dirent.name.endsWith(suffix)
      )
      if (!dirent.isFile() || !legacySuffix) {
        continue
      }

      const legacyFilePath = path.join(dir, dirent.name)
      const nextFilePath = path.join(
        dir,
        dirent.name.replace(legacySuffix, AUTOMATION_SCHEME_FILE_SUFFIX)
      )

      if (await exists(nextFilePath)) {
        await fs.unlink(legacyFilePath)
        continue
      }

      await fs.rename(legacyFilePath, nextFilePath)
    }
  }

  async getAutomationSchemeDir(): Promise<string> {
    const dir = this.configUtils.getAutomationSchemeDir()
    await this.ensureDir(dir)
    await this.migrateLegacyFileNames(dir)
    return dir
  }

  private getAutomationSchemeFilePaths(dir: string, schemeId: string): string[] {
    const safeId = schemeId.replace(/[\\/:*?"<>|]/g, '_')
    return [
      path.join(dir, `${safeId}${AUTOMATION_SCHEME_FILE_SUFFIX}`),
      ...LEGACY_AUTOMATION_SCHEME_FILE_SUFFIXES.map((suffix) =>
        path.join(dir, `${safeId}${suffix}`)
      )
    ]
  }

  async listSchemes(): Promise<AutomationScheme[]> {
    const dir = await this.getAutomationSchemeDir()
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const schemes: AutomationScheme[] = []

    for (const dirent of dirents) {
      if (
        !dirent.isFile() ||
        !SUPPORTED_AUTOMATION_SCHEME_FILE_SUFFIXES.some((suffix) => dirent.name.endsWith(suffix))
      ) {
        continue
      }

      try {
        const filePath = path.join(dir, dirent.name)
        const raw = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8')))
        if (raw?.id) {
          schemes.push(raw as AutomationScheme)
        }
      } catch (error) {
        console.error(`[AutomationSchemeFS] Failed to read scheme file ${dirent.name}:`, error)
      }
    }

    return schemes.sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || '') || 0
      const rightTime = Date.parse(right.updatedAt || right.createdAt || '') || 0
      if (leftTime !== rightTime) return rightTime - leftTime
      return left.name.localeCompare(right.name)
    })
  }

  async saveScheme(scheme: AutomationScheme): Promise<void> {
    const dir = await this.getAutomationSchemeDir()
    const [preferredFilePath, ...legacyFilePaths] = this.getAutomationSchemeFilePaths(
      dir,
      scheme.id
    )
    await fs.writeFile(preferredFilePath, JSON.stringify(scheme, null, 2), 'utf8')
    for (const legacyFilePath of legacyFilePaths) {
      if (await exists(legacyFilePath)) {
        await fs.unlink(legacyFilePath)
      }
    }
  }

  async deleteScheme(id: string): Promise<void> {
    const dir = await this.getAutomationSchemeDir()
    for (const filePath of this.getAutomationSchemeFilePaths(dir, id)) {
      if (await exists(filePath)) {
        await fs.unlink(filePath)
      }
    }
  }
}
