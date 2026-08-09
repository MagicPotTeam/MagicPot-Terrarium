import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type { InstalledLauncherVersion } from '../../shared/api/svcAppUpdate'
import {
  parseActivePointer,
  parseInstalledAppManifest,
  parseInstalledRuntimeManifest,
  isValidBuildId,
  isValidRuntimeId
} from '../../shared/appUpdate/launcherProtocol'

export type LauncherInstalledVersionsInventory = {
  versions: InstalledLauncherVersion[]
  issues: string[]
}

const MAX_INVENTORY_JSON_BYTES = 1024 * 1024
const APP_MANIFEST_NAME = 'app-installed.json'
const RUNTIME_MANIFEST_NAME = 'runtime-installed.json'

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

async function requireContainedDirectory(directory: string, parent: string): Promise<string> {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory is not regular')
  const [realParent, realDirectory] = await Promise.all([
    fs.realpath(parent),
    fs.realpath(directory)
  ])
  if (!isContained(realParent, realDirectory)) throw new Error('directory escapes launcher root')
  // Node exposes symbolic links but cannot reliably identify every Windows reparse-point type.
  // The launcher performs the authoritative native validation before any mutation.
  if (process.platform === 'win32' && stat.isSymbolicLink())
    throw new Error('symbolic link is not allowed')
  return realDirectory
}

async function readBoundedJsonFile(file: string, parent: string): Promise<string> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('manifest is not a regular file')
  if (stat.size > MAX_INVENTORY_JSON_BYTES) throw new Error('manifest exceeds inventory size limit')
  const [realParent, realFile] = await Promise.all([fs.realpath(parent), fs.realpath(file)])
  if (!isContained(realParent, realFile)) throw new Error('manifest escapes installed directory')
  return fs.readFile(realFile, 'utf8')
}

async function readHealth(root: string): Promise<{ pending?: string; healthy?: string }> {
  try {
    const text = await readBoundedJsonFile(path.join(root, 'launcher-health.json'), root)
    const value = JSON.parse(text) as {
      pending?: { buildId?: unknown }
      lastHealthy?: { buildId?: unknown }
    }
    return {
      pending: isValidBuildId(value.pending?.buildId) ? value.pending.buildId : undefined,
      healthy: isValidBuildId(value.lastHealthy?.buildId) ? value.lastHealthy.buildId : undefined
    }
  } catch {
    return {}
  }
}

export async function scanLauncherInstalledVersions(
  root: string
): Promise<LauncherInstalledVersionsInventory> {
  const issues: string[] = []
  const versions: InstalledLauncherVersion[] = []
  let pointer: ReturnType<typeof parseActivePointer> | undefined
  try {
    pointer = parseActivePointer(await readBoundedJsonFile(path.join(root, 'active.json'), root))
  } catch {
    // An absent pointer is normal before the launcher has completed its first install.
    // Removal remains disabled because every inventory entry will have active=false.
  }
  const health = await readHealth(root)
  let appsRoot: string
  let entries: Dirent[]
  try {
    appsRoot = await requireContainedDirectory(path.join(root, 'apps'), root)
    entries = await fs.readdir(appsRoot, { withFileTypes: true })
  } catch {
    return {
      versions,
      issues: pointer ? [...issues, 'Installed app inventory is unavailable'] : issues
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isValidBuildId(entry.name)) {
      if (entry.isDirectory()) issues.push(`Ignored untrusted app entry: ${entry.name}`)
      continue
    }
    const appDirectory = path.join(appsRoot, entry.name)
    try {
      const realAppDirectory = await requireContainedDirectory(appDirectory, appsRoot)
      const app = parseInstalledAppManifest(
        await readBoundedJsonFile(path.join(realAppDirectory, APP_MANIFEST_NAME), realAppDirectory)
      )
      if (app.buildId !== entry.name)
        throw new Error('app manifest build ID does not match directory')
      if (!isValidRuntimeId(app.runtimeId)) throw new Error('runtime ID is invalid')

      const runtimesRoot = await requireContainedDirectory(path.join(root, 'runtimes'), root)
      const runtimeDirectory = await requireContainedDirectory(
        path.join(runtimesRoot, app.runtimeId),
        runtimesRoot
      )
      const runtime = parseInstalledRuntimeManifest(
        await readBoundedJsonFile(
          path.join(runtimeDirectory, RUNTIME_MANIFEST_NAME),
          runtimeDirectory
        )
      )
      if (runtime.runtimeId !== app.runtimeId) throw new Error('runtime manifest ID does not match')

      const active = pointer?.activeBuildId === app.buildId
      const rollback = pointer?.previousBuildId === app.buildId
      const pending = health.pending === app.buildId
      const healthy = health.healthy === app.buildId
      const removalBlockedReason = !pointer
        ? 'Active and rollback pointers could not be verified'
        : active
          ? 'Active version cannot be removed'
          : rollback
            ? 'Rollback version cannot be removed'
            : pending
              ? 'Version has a pending health check'
              : !healthy
                ? 'Version health is unknown or failed'
                : undefined
      const appBytes = Number.isSafeInteger(app.unpackedSize) ? app.unpackedSize : null
      const runtimeBytes = Number.isSafeInteger(runtime.unpackedSize) ? runtime.unpackedSize : null
      versions.push({
        version: app.version,
        buildId: app.buildId,
        runtimeId: app.runtimeId,
        installedAt: app.createdAt,
        appBytes,
        runtimeBytes,
        totalBytes: appBytes !== null && runtimeBytes !== null ? appBytes + runtimeBytes : null,
        health: pending ? 'pending' : healthy ? 'healthy' : 'unknown',
        active,
        rollback,
        removable: removalBlockedReason === undefined,
        removalBlockedReason
      })
    } catch (error) {
      issues.push(
        `Ignored invalid installed version ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  versions.sort((left, right) => right.installedAt.localeCompare(left.installedAt))
  return { versions, issues }
}
