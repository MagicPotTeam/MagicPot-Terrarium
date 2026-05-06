/**
 * Custom Skill file system operations.
 *
 * Each skill is stored as a single JSON file: `{id}.skill.json`
 * Categories are tracked in a separate `_categories.json` file.
 * This mirrors the QApp file-based storage pattern.
 */

import path from 'path'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig } from '../config/config'
import { ConfigUtils } from '@shared/config/configUtils'
import { BuildEnv } from '@shared/config/buildEnv'
import { Config, CustomSkill, normalizeCustomSkill } from '@shared/config/config'
import fs from 'fs/promises'
import { exists } from '../utils/fileUtils'

/** Strip UTF-8 BOM that cloud-sync tools may inject. */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/^\0+/, '')
}

const SKILL_SUFFIX = '.skill.json'
const CATEGORIES_FILE = '_categories.json'

function normalizePathKey(targetPath: string): string {
  const normalized = path.normalize(targetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export class CustomSkillFSCli {
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

  private getLegacySkillDirs(): string[] {
    const candidates = [
      this.configUtils.getBundledCustomSkillDir(),
      path.join(this.buildEnv.pathMap.file, 'customSkills')
    ]
    return candidates.filter(
      (candidate, index) =>
        candidates.findIndex((entry) => normalizePathKey(entry) === normalizePathKey(candidate)) ===
        index
    )
  }

  private async directoryHasEntries(dir: string): Promise<boolean> {
    if (!(await exists(dir))) {
      return false
    }
    const dirents = await fs.readdir(dir)
    return dirents.length > 0
  }

  private async migrateLegacySkillDirIfNeeded(dir: string): Promise<void> {
    if (await this.directoryHasEntries(dir)) {
      return
    }

    for (const legacyDir of this.getLegacySkillDirs()) {
      if (normalizePathKey(legacyDir) === normalizePathKey(dir) || !(await exists(legacyDir))) {
        continue
      }

      await fs.mkdir(dir, { recursive: true })
      await fs.cp(legacyDir, dir, { recursive: true, force: false, errorOnExist: false })
      return
    }
  }

  async getSkillDir(): Promise<string> {
    const dir = this.configUtils.getCustomSkillDir()
    await this.ensureDir(dir)
    await this.migrateLegacySkillDirIfNeeded(dir)
    return dir
  }

  private getSkillFilePath(dir: string, skill: CustomSkill): string {
    const categoryStr = skill.category?.trim() || ''
    const sanitizedCategory = categoryStr.replace(/[\\/:*?"<>|]/g, '_')

    const skillNameStr = skill.skillName?.trim() || skill.id
    const sanitizedSkillName = skillNameStr.replace(/[\\/:*?"<>|]/g, '_')

    const fileName = `${sanitizedSkillName}${SKILL_SUFFIX}`

    if (sanitizedCategory) {
      return path.join(dir, sanitizedCategory, fileName)
    }
    return path.join(dir, fileName)
  }

  async listSkills(): Promise<{ skills: CustomSkill[]; categories: string[] }> {
    const dir = await this.getSkillDir()
    const dirents = await fs.readdir(dir, { withFileTypes: true })

    const skills: CustomSkill[] = []
    let needMigration = false

    for (const dirent of dirents) {
      if (dirent.isFile() && dirent.name.endsWith(SKILL_SUFFIX)) {
        if (dirent.name.startsWith('skill_')) {
          needMigration = true
        }
        try {
          const filePath = path.join(dir, dirent.name)
          const raw = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8')))
          if (raw?.id) skills.push(normalizeCustomSkill(raw as CustomSkill))
        } catch (error) {
          console.error(`[CustomSkillFS] Failed to read skill file ${dirent.name}:`, error)
        }
      } else if (dirent.isDirectory()) {
        const subDir = path.join(dir, dirent.name)
        const subDirents = await fs.readdir(subDir, { withFileTypes: true })
        for (const subDirent of subDirents) {
          if (subDirent.isFile() && subDirent.name.endsWith(SKILL_SUFFIX)) {
            try {
              const filePath = path.join(subDir, subDirent.name)
              const raw = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8')))
              if (raw?.id) skills.push(normalizeCustomSkill(raw as CustomSkill))
            } catch (error) {
              console.error(`[CustomSkillFS] Failed to read skill file ${subDirent.name}:`, error)
            }
          }
        }
      }
    }

    // Read categories
    let categories: string[] = []
    const catPath = path.join(dir, CATEGORIES_FILE)
    if (await exists(catPath)) {
      try {
        const catRaw = JSON.parse(stripBom(await fs.readFile(catPath, 'utf8')))
        if (Array.isArray(catRaw)) {
          categories = catRaw.filter((c: unknown) => typeof c === 'string' && c.trim())
        }
      } catch (error) {
        console.error('[CustomSkillFS] Failed to read categories:', error)
      }
    }

    // If we detected old flat-root `skill_172xxx.skill.json` files,
    // let's auto-migrate them to the category/skillName hierarchy right away.
    if (needMigration) {
      await this.batchSave(
        skills.map((skill) => normalizeCustomSkill(skill)),
        categories
      )
      // Refresh list to ensure we serve the correct new hierarchical structure
      return { skills, categories }
    }

    return { skills, categories }
  }

  async saveSkill(skill: CustomSkill): Promise<void> {
    const dir = await this.getSkillDir()
    const filePath = this.getSkillFilePath(dir, skill)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(normalizeCustomSkill(skill), null, 2), 'utf8')
  }

  async deleteSkill(id: string): Promise<void> {
    // Note: since filenames no longer just use ID, to delete a skill by ID directly
    // we must list them all and find it.
    const { skills } = await this.listSkills()
    const skill = skills.find((s) => s.id === id)
    if (skill) {
      const dir = await this.getSkillDir()
      const filePath = this.getSkillFilePath(dir, skill)
      if (await exists(filePath)) {
        await fs.unlink(filePath)
      }
    }
  }

  async saveCategories(categories: string[]): Promise<void> {
    const dir = await this.getSkillDir()
    const catPath = path.join(dir, CATEGORIES_FILE)
    await fs.writeFile(catPath, JSON.stringify(categories, null, 2), 'utf8')
  }

  async batchSave(skills: CustomSkill[], categories: string[]): Promise<void> {
    const dir = await this.getSkillDir()

    // 1. Gather all existing skill files
    const existingFiles = new Set<string>()
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    for (const d of dirents) {
      if (d.isFile() && d.name.endsWith(SKILL_SUFFIX)) {
        existingFiles.add(path.join(dir, d.name))
      } else if (d.isDirectory()) {
        const subDir = path.join(dir, d.name)
        const subDirents = await fs.readdir(subDir, { withFileTypes: true })
        for (const subD of subDirents) {
          if (subD.isFile() && subD.name.endsWith(SKILL_SUFFIX)) {
            existingFiles.add(path.join(subDir, subD.name))
          }
        }
      }
    }

    // 2. Write new files and remove them from existingFiles set
    for (const skill of skills) {
      if (!skill.id) continue
      const filePath = this.getSkillFilePath(dir, skill)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(normalizeCustomSkill(skill), null, 2), 'utf8')
      existingFiles.delete(filePath)
    }

    // 3. Delete files that are no longer needed
    for (const oldFile of existingFiles) {
      if (await exists(oldFile)) {
        await fs.unlink(oldFile)
      }
    }

    // 4. Create empty directories for explicitly managed categories
    for (const cat of categories) {
      const catStr = cat.trim()
      if (catStr) {
        const sanitizedCat = catStr.replace(/[\\/:*?"<>|]/g, '_')
        await fs.mkdir(path.join(dir, sanitizedCat), { recursive: true })
      }
    }

    // 5. Clean up empty directories
    const afterDirents = await fs.readdir(dir, { withFileTypes: true })
    for (const d of afterDirents) {
      if (d.isDirectory()) {
        const dPath = path.join(dir, d.name)
        const contents = await fs.readdir(dPath)
        if (contents.length === 0) {
          const isManaged = categories.some(
            (c) => c.trim().replace(/[\\/:*?"<>|]/g, '_') === d.name
          )
          if (!isManaged) {
            await fs.rmdir(dPath)
          }
        }
      }
    }

    // 6. Save categories registry
    await this.saveCategories(categories)
  }
}
