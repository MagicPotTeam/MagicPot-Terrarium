import { api } from '@renderer/utils/windowUtils'
import { findNotInstalledNodeInfo } from '@shared/comfy/funcs'
import type { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import type { Config } from '@shared/config/config'
import type { ConfigUtils } from '@shared/config/configUtils'
import type { QAppCfg, QAppRequiredModel } from '@shared/qApp/cfgTypes'

export type MissingRequiredModel = {
  model: QAppRequiredModel
  filePath: string
  dirPath: string
  displayDir: string
}

export type QAppCustomNodeDependency = {
  url: string
  directoryName: string
  parentDir: string
  targetDir: string
  displayDir: string
  folderExists: boolean
}

export type QAppDependencyReport = {
  missingModels: MissingRequiredModel[]
  missingNodeClasses: string[]
  customNodes: QAppCustomNodeDependency[]
}

type QAppDependencyCheckConfig = Pick<Config, 'use_remote_comfyui'>

export function getRequiredModelBaseDir(
  model: QAppRequiredModel
): NonNullable<QAppRequiredModel['baseDir']> {
  return model.baseDir ?? 'comfyui'
}

export function resolveRequiredModelPaths(
  model: QAppRequiredModel,
  comfyDir: string,
  portableHomeDir: string
): { filePath: string; dirPath: string; displayDir: string } {
  const baseDir = getRequiredModelBaseDir(model)
  const rootDir = baseDir === 'portableHome' ? portableHomeDir : comfyDir
  const dirPath = window.path.join(rootDir, model.dir)
  const filePath = window.path.join(dirPath, model.name)
  const displayDir = baseDir === 'comfyui' ? `ComfyUI\\${model.dir.replace(/\//g, '\\')}` : dirPath

  return { filePath, dirPath, displayDir }
}

function sanitizePathSegment(value: string): string {
  return Array.from(value.trim(), (char) =>
    char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '-' : char
  )
    .join('')
    .replace(/\.+$/g, '')
    .replace(/^\.+$/g, '')
    .slice(0, 160)
}

export function getCustomNodeDirectoryName(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = decodeURIComponent(segments[segments.length - 1] || '')
    const withoutGitSuffix = last.replace(/\.git$/i, '')
    return sanitizePathSegment(withoutGitSuffix) || 'custom-node'
  } catch {
    const cleaned = url.split(/[?#]/)[0].replace(/\.git$/i, '')
    const segments = cleaned.split(/[\\/]/).filter(Boolean)
    return sanitizePathSegment(segments[segments.length - 1] || cleaned) || 'custom-node'
  }
}

export function resolveCustomNodeDependency(
  url: string,
  comfyDir: string,
  folderExists = false
): QAppCustomNodeDependency {
  const directoryName = getCustomNodeDirectoryName(url)
  const parentDir = window.path.join(comfyDir, 'custom_nodes')
  const targetDir = window.path.join(parentDir, directoryName)
  return {
    url,
    directoryName,
    parentDir,
    targetDir,
    displayDir: `ComfyUI\\custom_nodes\\${directoryName}`,
    folderExists
  }
}

export async function checkRequiredModels(
  requiredModels: QAppRequiredModel[] | undefined,
  configUtils: ConfigUtils,
  config: QAppDependencyCheckConfig
): Promise<MissingRequiredModel[]> {
  if (!requiredModels || requiredModels.length === 0) {
    return []
  }

  if (config.use_remote_comfyui) {
    return []
  }

  const [comfyDir, available] = configUtils.getComfyUIDir()
  if (!available) {
    return []
  }

  const portableHomeDir = configUtils.getPortablePythonHomeDir()
  const resolvedModels = requiredModels.map((model) => ({
    model,
    ...resolveRequiredModelPaths(model, comfyDir, portableHomeDir)
  }))
  const exists = await api().svcShell.fileExistsBatch(resolvedModels.map((model) => model.filePath))

  return resolvedModels.filter((_, index) => !exists[index])
}

export async function checkCustomNodeDependencies(
  customNodeUrls: string[] | undefined,
  configUtils: ConfigUtils
): Promise<QAppCustomNodeDependency[]> {
  const urls = (customNodeUrls ?? []).filter((url) => url.trim().length > 0)
  if (urls.length === 0) {
    return []
  }

  const [comfyDir, available] = configUtils.getComfyUIDir()
  if (!available) {
    return []
  }

  const unresolvedNodes = urls.map((url) => resolveCustomNodeDependency(url, comfyDir))
  const exists = await api().svcShell.fileExistsBatch(unresolvedNodes.map((node) => node.targetDir))
  return unresolvedNodes.map((node, index) => ({
    ...node,
    folderExists: exists[index]
  }))
}

export async function checkQAppDependencies(options: {
  cfg: QAppCfg | null | undefined
  workflow: Workflow | null | undefined
  objectInfos: ObjectInfoMap
  configUtils: ConfigUtils
  config: QAppDependencyCheckConfig
}): Promise<QAppDependencyReport> {
  const cfg = options.cfg
  const missingModels = await checkRequiredModels(
    cfg?.requiredModels,
    options.configUtils,
    options.config
  )
  const customNodes = await checkCustomNodeDependencies(cfg?.customNodeUrls, options.configUtils)
  const hasObjectInfos = options.objectInfos && Object.keys(options.objectInfos).length > 0
  const missingNodeClasses =
    hasObjectInfos && options.workflow
      ? findNotInstalledNodeInfo(options.workflow, options.objectInfos)
      : []

  return {
    missingModels,
    missingNodeClasses,
    customNodes
  }
}

export function hasBlockingQAppDependencyIssues(report: QAppDependencyReport): boolean {
  return report.missingModels.length > 0 || report.missingNodeClasses.length > 0
}
