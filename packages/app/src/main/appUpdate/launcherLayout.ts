import path from 'node:path'
import {
  isSafeRelativePath,
  isValidBuildId,
  isValidRuntimeId
} from '../../shared/appUpdate/launcherProtocol'

export const INSTALLED_MANIFEST_FILE = 'manifest.json'
export const ACTIVE_POINTER_FILE = 'active.json'
export const ACTIVATION_JOURNAL_FILE = 'activation-journal.json'

export interface LauncherLayout {
  root: string
  activePointer: string
  activationJournal: string
  apps: string
  runtimes: string
}

export function createLauncherLayout(root: string): LauncherLayout {
  if (!path.isAbsolute(root)) throw new TypeError('Launcher root must be absolute')
  const normalizedRoot = path.normalize(root)
  return {
    root: normalizedRoot,
    activePointer: path.join(normalizedRoot, ACTIVE_POINTER_FILE),
    activationJournal: path.join(normalizedRoot, ACTIVATION_JOURNAL_FILE),
    apps: path.join(normalizedRoot, 'apps'),
    runtimes: path.join(normalizedRoot, 'runtimes')
  }
}

export function getAppDirectory(layout: LauncherLayout, buildId: string): string {
  if (!isValidBuildId(buildId)) throw new TypeError('Invalid launcher build ID')
  return path.join(layout.apps, buildId)
}

export function getRuntimeDirectory(layout: LauncherLayout, runtimeId: string): string {
  if (!isValidRuntimeId(runtimeId)) throw new TypeError('Invalid launcher runtime ID')
  return path.join(layout.runtimes, runtimeId)
}

export function resolveInstalledPath(directory: string, relativePath: string): string {
  if (!path.isAbsolute(directory)) throw new TypeError('Installation directory must be absolute')
  if (!isSafeRelativePath(relativePath)) throw new TypeError('Invalid installed relative path')
  const normalizedDirectory = path.resolve(directory)
  const resolved = path.resolve(normalizedDirectory, relativePath)
  const relative = path.relative(normalizedDirectory, resolved)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    throw new TypeError('Installed path escapes its directory')
  return resolved
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}
