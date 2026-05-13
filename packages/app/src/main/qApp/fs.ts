/**
 * QApp file system operations.
 */

import path from 'path'
import type { Dirent } from 'fs'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig } from '../config/config'
import { ConfigUtils } from '@shared/config/configUtils'
import { BuildEnv } from '@shared/config/buildEnv'
import { Config } from '@shared/config/config'
import fs from 'fs/promises'
import { QAppCfg } from '@shared/qApp/cfgTypes'
import { Workflow } from '@shared/comfy/types'
import { isGuiWorkflow } from '@shared/comfy/guiWorkflowToPrompt'
import { convertGuiWorkflowToPrompt } from '@shared/comfy/guiWorkflowToPrompt'
import { normalizeExecutableWorkflow } from '@shared/comfy/funcs'
import { isWorkflow } from '@shared/comfy/typeGuards'
import { exists } from '../utils/fileUtils'
import { QAppMenuItem } from '@shared/api/svcQApp'
import { inferQAppCategory } from '@shared/qApp/category'
import {
  QAppManifest,
  buildDefaultQAppManifest,
  normalizeQAppManifest
} from '@shared/qApp/packageBundle'

/** Strip UTF-8 BOM and other invisible leading characters that cloud-sync tools may inject. */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/^\0+/, '')
}

type QAppSource = {
  dir: string
  isBuiltin: boolean
}

type QAppBundleData = {
  cfg: QAppCfg
  workflow: Workflow
  manifest: QAppManifest
}

export class QAppFSCli {
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

  private async getWritableQAppDir(): Promise<string> {
    const dir = this.configUtils.getQAppDir()
    return this.ensureDir(dir)
  }

  private async getReadableQAppSources(): Promise<QAppSource[]> {
    // 内置与用户自定义 qApps 统一在同一目录（extraFiles 直接放到安装根目录）
    await this.prepareQAppStorage()
    const builtinDir = await this.getBuiltinQAppDir()
    const writableDir = await this.getWritableQAppDir()
    return [
      { dir: builtinDir, isBuiltin: true },
      { dir: writableDir, isBuiltin: false }
    ]
  }

  private getManifestPath(baseDir: string, key: string): string {
    return path.join(baseDir, `${key}.manifest.json`)
  }

  private async getBuiltinQAppDir(): Promise<string> {
    const dir = this.configUtils.getBuiltinQAppDir()
    return this.ensureDir(dir)
  }

  private async getDirectoryDirents(currentDir: string, dirents: Dirent[]): Promise<Dirent[]> {
    const directories: Dirent[] = []

    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        directories.push(dirent)
        continue
      }

      if (!dirent.isSymbolicLink()) {
        continue
      }

      const isDirectory = await fs
        .stat(path.join(currentDir, dirent.name))
        .then((stat) => stat.isDirectory())
        .catch(() => false)
      if (isDirectory) {
        directories.push(dirent)
      }
    }

    return directories
  }

  private getQAppPaths(
    baseDir: string,
    key: string
  ): {
    basePath: string
    qAppPath: string
    workflowPath: string
    manifestPath: string
  } {
    const basePath = path.join(baseDir, key)
    return {
      basePath,
      qAppPath: `${basePath}.qacfg.json`,
      workflowPath: `${basePath}.prompt.json`,
      manifestPath: `${basePath}.manifest.json`
    }
  }

  private getCurrentAppVersion(): string {
    return this.buildEnv.env.packageVersion || '0.0.0'
  }

  private createDefaultManifest(
    key: string,
    overrides?: Partial<QAppManifest> | null
  ): QAppManifest {
    return buildDefaultQAppManifest(path.basename(key), this.getCurrentAppVersion(), overrides)
  }

  private async readManifest(
    baseDir: string,
    key: string,
    overrides?: Partial<QAppManifest> | null
  ): Promise<QAppManifest> {
    const manifestPath = this.getManifestPath(baseDir, key)
    if (await exists(manifestPath)) {
      try {
        const raw = JSON.parse(stripBom(await fs.readFile(manifestPath, 'utf8')))
        return normalizeQAppManifest(raw, {
          name: path.basename(key),
          appVersion: this.getCurrentAppVersion(),
          source: 'local'
        })
      } catch (error) {
        void error
      }
    }

    return this.createDefaultManifest(key, overrides)
  }

  private async copyQAppBundleToWritableDir(baseDir: string, key: string): Promise<boolean> {
    const writableDir = await this.getWritableQAppDir()
    const sourcePaths = this.getQAppPaths(baseDir, key)
    const targetPaths = this.getQAppPaths(writableDir, key)

    await fs.mkdir(path.dirname(targetPaths.qAppPath), { recursive: true })

    const copyIfMissing = async (sourcePath: string, targetPath: string) => {
      if ((await exists(sourcePath)) && !(await exists(targetPath))) {
        await fs.copyFile(sourcePath, targetPath)
      }
    }

    await copyIfMissing(sourcePaths.qAppPath, targetPaths.qAppPath)
    await copyIfMissing(sourcePaths.workflowPath, targetPaths.workflowPath)
    await copyIfMissing(sourcePaths.manifestPath, targetPaths.manifestPath)

    return (await exists(targetPaths.qAppPath)) && (await exists(targetPaths.workflowPath))
  }

  private async removeQAppBundle(baseDir: string, key: string): Promise<void> {
    const { qAppPath, workflowPath, manifestPath } = this.getQAppPaths(baseDir, key)
    if (await exists(qAppPath)) {
      await fs.unlink(qAppPath)
    }
    if (await exists(workflowPath)) {
      await fs.unlink(workflowPath)
    }
    if (await exists(manifestPath)) {
      await fs.unlink(manifestPath)
    }
  }

  private async migrateLegacyQApps(baseDir: string, relativeDir: string = ''): Promise<void> {
    const currentDir = relativeDir ? path.join(baseDir, relativeDir) : baseDir
    const dirents = await fs.readdir(currentDir, { withFileTypes: true })

    const fileNames = dirents.filter((d) => d.isFile()).map((d) => d.name)
    const promptNames = new Set(
      fileNames.filter((n) => n.endsWith('.prompt.json')).map((n) => n.replace('.prompt.json', ''))
    )
    const qacfgNames = new Set(
      fileNames.filter((n) => n.endsWith('.qacfg.json')).map((n) => n.replace('.qacfg.json', ''))
    )

    for (const name of promptNames) {
      if (!qacfgNames.has(name)) {
        continue
      }

      const key = relativeDir ? `${relativeDir.split(path.sep).join('/')}/${name}` : name
      const manifest = await this.readManifest(baseDir, key, {
        source: 'builtin'
      })
      if (manifest.source === 'builtin') {
        continue
      }

      const migrated = await this.copyQAppBundleToWritableDir(baseDir, key)
      if (migrated) {
        try {
          await this.removeQAppBundle(baseDir, key)
        } catch (error) {
          console.warn('[QAppFSCli] Failed to remove legacy qApp bundle after migration:', error)
        }
      }
    }

    for (const dirent of await this.getDirectoryDirents(currentDir, dirents)) {
      const subRelative = relativeDir ? path.join(relativeDir, dirent.name) : dirent.name
      await this.migrateLegacyQApps(baseDir, subRelative)
    }
  }

  private async prepareQAppStorage(): Promise<void> {
    const builtinDir = await this.getBuiltinQAppDir()
    await this.migrateLegacyQApps(builtinDir)
    await this.getWritableQAppDir()
  }

  private async buildTree(
    baseDir: string,
    isBuiltin: boolean,
    relativeDir: string = ''
  ): Promise<QAppMenuItem[]> {
    const currentDir = relativeDir ? path.join(baseDir, relativeDir) : baseDir
    const dirents = await fs.readdir(currentDir, { withFileTypes: true })

    const fileNames = dirents.filter((d) => d.isFile()).map((d) => d.name)
    const promptNames = new Set(
      fileNames.filter((n) => n.endsWith('.prompt.json')).map((n) => n.replace('.prompt.json', ''))
    )
    const qacfgNames = new Set(
      fileNames.filter((n) => n.endsWith('.qacfg.json')).map((n) => n.replace('.qacfg.json', ''))
    )

    const items: QAppMenuItem[] = []

    for (const name of promptNames) {
      if (!qacfgNames.has(name)) {
        continue
      }

      // key always uses POSIX style separators for web UI compatibility
      const key = relativeDir ? `${relativeDir.split(path.sep).join('/')}/${name}` : name
      let isHidden = false
      let icon = ''
      let category: QAppMenuItem['category']
      const manifest = await this.readManifest(baseDir, key, {
        source: isBuiltin ? 'builtin' : 'local'
      })

      try {
        const cfgPath = path.join(currentDir, `${name}.qacfg.json`)
        const cfg = JSON.parse(stripBom(await fs.readFile(cfgPath, 'utf8')))
        const workflowPath = path.join(currentDir, `${name}.prompt.json`)
        const workflowData = JSON.parse(stripBom(await fs.readFile(workflowPath, 'utf8')))
        const workflow = isWorkflow(workflowData)
          ? normalizeExecutableWorkflow(workflowData)
          : isGuiWorkflow(workflowData)
            ? convertGuiWorkflowToPrompt(workflowData)
            : null
        isHidden = cfg.isHidden === true || cfg.hidden === true
        icon = cfg.icon || ''
        category = inferQAppCategory({
          key,
          name,
          category: manifest.category,
          cfg,
          workflow
        })
      } catch (error) {
        void error
      }

      items.push({
        key,
        name,
        isBuiltin,
        isHidden,
        icon,
        category,
        manifest
      })
    }

    // A category only contains sub-QApps
    for (const dirent of await this.getDirectoryDirents(currentDir, dirents)) {
      const subRelative = relativeDir ? path.join(relativeDir, dirent.name) : dirent.name
      const children = await this.buildTree(baseDir, isBuiltin, subRelative)

      // If it has `.qacfg.json` matching its own dir name, it's a QApp bundle, but for now we only need it to have valid items inside.
      if (children.length > 0) {
        items.push({
          key: subRelative.split(path.sep).join('/'),
          name: dirent.name,
          isBuiltin,
          isDirectory: true,
          children
        })
      }
    }

    return items
  }

  async listQAppKeys(): Promise<QAppMenuItem[]> {
    const sources = await this.getReadableQAppSources()
    const merged = new Map<string, QAppMenuItem>()

    for (const source of sources) {
      const tree = await this.buildTree(source.dir, source.isBuiltin)
      for (const item of tree) {
        const existing = merged.get(item.key)
        merged.set(item.key, existing ? this.mergeQAppMenuItem(existing, item) : item)
      }
    }

    return Array.from(merged.values())
  }

  private mergeQAppMenuItems(
    baseItems: QAppMenuItem[] = [],
    overrideItems: QAppMenuItem[] = []
  ): QAppMenuItem[] {
    const merged = new Map<string, QAppMenuItem>()

    for (const item of baseItems) {
      merged.set(item.key, item)
    }

    for (const item of overrideItems) {
      const existing = merged.get(item.key)
      merged.set(item.key, existing ? this.mergeQAppMenuItem(existing, item) : item)
    }

    return Array.from(merged.values())
  }

  private mergeQAppMenuItem(baseItem: QAppMenuItem, overrideItem: QAppMenuItem): QAppMenuItem {
    if (baseItem.isDirectory && overrideItem.isDirectory) {
      return {
        ...baseItem,
        ...overrideItem,
        children: this.mergeQAppMenuItems(baseItem.children, overrideItem.children)
      }
    }

    return overrideItem
  }

  async getQApp(key: string): Promise<QAppBundleData> {
    const sources = await this.getReadableQAppSources()

    // User directory should override bundled resources when keys collide.
    for (let i = sources.length - 1; i >= 0; i -= 1) {
      const qAppDir = sources[i].dir
      const workflowPath = path.join(qAppDir, `${key}.prompt.json`)
      const qAppPath = path.join(qAppDir, `${key}.qacfg.json`)

      if (!(await exists(workflowPath)) || !(await exists(qAppPath))) {
        continue
      }

      const qAppCfg = JSON.parse(stripBom(await fs.readFile(qAppPath, 'utf8')))
      const workflow = JSON.parse(stripBom(await fs.readFile(workflowPath, 'utf8')))
      const manifest = await this.readManifest(qAppDir, key, {
        source: sources[i].isBuiltin ? 'builtin' : 'local'
      })
      if (isWorkflow(workflow)) {
        return { cfg: qAppCfg, workflow: normalizeExecutableWorkflow(workflow), manifest }
      }
      if (isGuiWorkflow(workflow)) {
        const converted = convertGuiWorkflowToPrompt(workflow)
        if (converted) {
          return { cfg: qAppCfg, workflow: converted, manifest }
        }
      }
      throw new Error(`Workflow ${workflowPath} is not a valid workflow`)
    }

    throw new Error(`QApp ${key} not found`)
  }

  async saveQApp(
    key: string,
    cfg: QAppCfg,
    workflow: Workflow,
    manifest?: Partial<QAppManifest>
  ): Promise<void> {
    await this.prepareQAppStorage()
    const qAppDir = await this.getWritableQAppDir()
    const targetDir = path.dirname(path.join(qAppDir, key))
    await fs.mkdir(targetDir, { recursive: true })

    const workflowPath = path.join(qAppDir, `${key}.prompt.json`)
    const qAppPath = path.join(qAppDir, `${key}.qacfg.json`)
    const manifestPath = this.getManifestPath(qAppDir, key)
    const existingManifest = await this.readManifest(qAppDir, key).catch(() => null)

    await fs.writeFile(qAppPath, JSON.stringify(cfg, null, 2))
    await fs.writeFile(workflowPath, JSON.stringify(workflow, null, 2))
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        this.createDefaultManifest(key, {
          ...(existingManifest || {}),
          ...(manifest || {})
        }),
        null,
        2
      )
    )
  }

  async deleteQApp(key: string): Promise<void> {
    await this.prepareQAppStorage()
    const deleteFromDir = async (qAppDir: string): Promise<boolean> => {
      const { basePath, qAppPath, workflowPath, manifestPath } = this.getQAppPaths(qAppDir, key)
      const hasDirectory = await exists(basePath)
      const hasBundle = (await exists(qAppPath)) || (await exists(workflowPath))

      if (!hasDirectory && !hasBundle) {
        return false
      }

      if (hasDirectory) {
        const stat = await fs.stat(basePath)
        if (stat.isDirectory()) {
          await fs.rm(basePath, { recursive: true, force: true })
          return true
        }
      }

      if (await exists(qAppPath)) await fs.unlink(qAppPath)
      if (await exists(workflowPath)) await fs.unlink(workflowPath)
      if (await exists(manifestPath)) await fs.unlink(manifestPath)
      return true
    }

    if (await deleteFromDir(await this.getWritableQAppDir())) {
      return
    }
    if (await deleteFromDir(await this.getBuiltinQAppDir())) {
      return
    }

    throw new Error(`QApp ${key} not found`)
  }

  async renameQApp(key: string, name: string): Promise<void> {
    if (key.startsWith('~') || name.startsWith('~')) {
      throw new Error('Names starting with ~ are reserved for built-in apps')
    }

    await this.prepareQAppStorage()
    const qAppDir = await this.getWritableQAppDir()
    const newKey = key.replace(path.basename(key), name)
    const { basePath, qAppPath, workflowPath, manifestPath } = this.getQAppPaths(qAppDir, key)
    const isDirectory = await fs
      .stat(basePath)
      .then((stat) => stat.isDirectory())
      .catch(() => false)
    const hasBundle = (await exists(qAppPath)) && (await exists(workflowPath))

    if (!isDirectory && !hasBundle) {
      throw new Error(`QApp ${key} is read-only`)
    }

    const newBasePath = path.join(qAppDir, newKey)
    const newQAppPath = `${newBasePath}.qacfg.json`
    const newPromptPath = `${newBasePath}.prompt.json`
    const newManifestPath = `${newBasePath}.manifest.json`
    if (
      (await exists(newQAppPath)) ||
      (await exists(newPromptPath)) ||
      (await exists(newManifestPath))
    ) {
      throw new Error(`QApp ${newKey} already exists`)
    }

    if (isDirectory) {
      await fs.rename(basePath, newBasePath)
      return
    }

    await fs.rename(qAppPath, newQAppPath)
    await fs.rename(workflowPath, newPromptPath)
    if (await exists(manifestPath)) {
      await fs.rename(manifestPath, newManifestPath)
    }
  }
}
