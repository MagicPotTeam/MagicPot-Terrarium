import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_RETAIN_NIGHTLY_VERSIONS,
  parseInstalledAppManifest,
  parseInstalledRuntimeManifest,
  type ActivePointerV1,
  type InstalledAppManifestV1,
  type LauncherSettingsV1
} from '../../shared/appUpdate/launcherProtocol'
import type { LauncherHealthStateV1 } from './launcherHealth'
import {
  getAppDirectory,
  getRuntimeDirectory,
  INSTALLED_MANIFEST_FILE,
  isPathInside,
  type LauncherLayout
} from './launcherLayout'

export interface LauncherRetentionFileSystem {
  readdir(directory: string): Promise<string[]>
  lstat(target: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>
  realpath(target: string): Promise<string>
  readFile(filePath: string, encoding: 'utf8'): Promise<string>
  rm(target: string, options: { recursive: true; force: false }): Promise<void>
}

export interface LauncherRetentionIssue {
  path: string
  message: string
}

export interface LauncherRetentionResult {
  keptApps: string[]
  deletedApps: string[]
  keptRuntimes: string[]
  deletedRuntimes: string[]
  pendingDeletes: string[]
  skipped: LauncherRetentionIssue[]
  errors: LauncherRetentionIssue[]
}

export interface LauncherRetentionOptions {
  layout: LauncherLayout
  settings: LauncherSettingsV1
  activePointer?: ActivePointerV1
  healthState?: LauncherHealthStateV1
  fileSystem?: LauncherRetentionFileSystem
  dryRun?: boolean
}

type ManagedDirectory = { directory: string; canonicalDirectory: string }
type InstalledApp = ManagedDirectory & { manifest: InstalledAppManifestV1 }
type InstalledRuntime = ManagedDirectory & { runtimeId: string }
type CanonicalLayout = { root: string; apps: string; runtimes: string }
type ScanResult<T> = { installations: T[]; complete: boolean }

const nodeFileSystem: LauncherRetentionFileSystem = {
  readdir: (directory) => fs.readdir(directory),
  lstat: (target) => fs.lstat(target),
  realpath: (target) => fs.realpath(target),
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  rm: (target, options) => fs.rm(target, options)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareApps(left: InstalledApp, right: InstalledApp): number {
  return (
    Date.parse(right.manifest.createdAt) - Date.parse(left.manifest.createdAt) ||
    right.manifest.version.localeCompare(left.manifest.version, 'en') ||
    right.manifest.buildId.localeCompare(left.manifest.buildId, 'en')
  )
}

function isNightlyVersion(version: string): boolean {
  const suffix = version.match(/^[^+-]+(?:-([^+]+))?(?:\+(.+))?$/)
  if (!suffix) return false
  return [suffix[1], suffix[2]]
    .filter((value): value is string => value !== undefined)
    .flatMap((value) => value.split('.'))
    .some((identifier) => identifier.toLowerCase() === 'nightly')
}

function safeManagedDirectory(
  layout: LauncherLayout,
  parent: string,
  id: string
): string | undefined {
  try {
    return parent === layout.apps ? getAppDirectory(layout, id) : getRuntimeDirectory(layout, id)
  } catch {
    return undefined
  }
}

async function bindDirectory(
  fileSystem: LauncherRetentionFileSystem,
  directory: string,
  canonicalParent: string,
  canonicalRoot: string
): Promise<string> {
  const stat = await fileSystem.lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Not a real directory')
  const canonical = path.resolve(await fileSystem.realpath(directory))
  if (
    canonical === canonicalParent ||
    !isPathInside(canonicalParent, canonical) ||
    canonical === canonicalRoot ||
    !isPathInside(canonicalRoot, canonical)
  ) {
    throw new TypeError('Canonical directory escapes its managed parent')
  }
  return canonical
}

async function validateLayout(
  fileSystem: LauncherRetentionFileSystem,
  layout: LauncherLayout
): Promise<CanonicalLayout> {
  if (
    !path.isAbsolute(layout.root) ||
    !isPathInside(layout.root, layout.apps) ||
    !isPathInside(layout.root, layout.runtimes) ||
    path.resolve(layout.apps) === path.resolve(layout.root) ||
    path.resolve(layout.runtimes) === path.resolve(layout.root)
  ) {
    throw new TypeError('Unsafe launcher layout')
  }
  const [rootStat, appsStat, runtimesStat] = await Promise.all([
    fileSystem.lstat(layout.root),
    fileSystem.lstat(layout.apps),
    fileSystem.lstat(layout.runtimes)
  ])
  if (
    rootStat.isSymbolicLink() ||
    appsStat.isSymbolicLink() ||
    runtimesStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    !appsStat.isDirectory() ||
    !runtimesStat.isDirectory()
  ) {
    throw new TypeError('Launcher layout contains a link or non-directory')
  }
  const [root, apps, runtimes] = await Promise.all([
    fileSystem.realpath(layout.root),
    fileSystem.realpath(layout.apps),
    fileSystem.realpath(layout.runtimes)
  ]).then((values) => values.map((value) => path.resolve(value)))
  if (
    apps === root ||
    runtimes === root ||
    !isPathInside(root, apps) ||
    !isPathInside(root, runtimes)
  ) {
    throw new TypeError('Canonical launcher layout escapes launcher root')
  }
  return { root, apps, runtimes }
}

async function scanInstallations<T extends InstalledApp | InstalledRuntime>(
  options: LauncherRetentionOptions,
  result: LauncherRetentionResult,
  canonicalLayout: CanonicalLayout,
  kind: 'app' | 'runtime'
): Promise<ScanResult<T>> {
  const fileSystem = options.fileSystem ?? nodeFileSystem
  const parent = kind === 'app' ? options.layout.apps : options.layout.runtimes
  const canonicalParent = kind === 'app' ? canonicalLayout.apps : canonicalLayout.runtimes
  let names: string[]
  try {
    names = await fileSystem.readdir(parent)
  } catch (error) {
    result.errors.push({ path: parent, message: message(error) })
    return { installations: [], complete: false }
  }

  const installations: Array<InstalledApp | InstalledRuntime> = []
  let complete = true
  for (const name of names.sort((left, right) => left.localeCompare(right, 'en'))) {
    const directory = safeManagedDirectory(options.layout, parent, name)
    if (!directory) {
      result.skipped.push({
        path: path.join(parent, name),
        message: `Invalid ${kind} directory name`
      })
      continue
    }
    try {
      const canonicalDirectory = await bindDirectory(
        fileSystem,
        directory,
        canonicalParent,
        canonicalLayout.root
      )
      const text = await fileSystem.readFile(
        path.join(canonicalDirectory, INSTALLED_MANIFEST_FILE),
        'utf8'
      )
      if (kind === 'app') {
        const manifest = parseInstalledAppManifest(text)
        if (manifest.buildId !== name)
          throw new TypeError('App manifest buildId does not match directory')
        installations.push({ directory, canonicalDirectory, manifest })
      } else {
        const manifest = parseInstalledRuntimeManifest(text)
        if (manifest.runtimeId !== name)
          throw new TypeError('Runtime manifest runtimeId does not match directory')
        installations.push({ directory, canonicalDirectory, runtimeId: manifest.runtimeId })
      }
    } catch (error) {
      complete = false
      result.skipped.push({ path: directory, message: message(error) })
    }
  }
  return { installations: installations as T[], complete }
}

async function removeDirectory(
  fileSystem: LauncherRetentionFileSystem,
  canonicalLayout: CanonicalLayout,
  canonicalParent: string,
  installation: ManagedDirectory,
  id: string,
  deleted: string[],
  result: LauncherRetentionResult,
  dryRun: boolean
): Promise<boolean> {
  try {
    const rebound = await bindDirectory(
      fileSystem,
      installation.directory,
      canonicalParent,
      canonicalLayout.root
    )
    if (rebound !== installation.canonicalDirectory) {
      throw new TypeError('Directory changed since retention scan')
    }
    if (dryRun) {
      deleted.push(id)
      return true
    }
    await fileSystem.rm(rebound, { recursive: true, force: false })
    deleted.push(id)
    return true
  } catch (error) {
    result.pendingDeletes.push(installation.directory)
    result.errors.push({ path: installation.directory, message: message(error) })
    return false
  }
}

export async function applyLauncherRetention(
  options: LauncherRetentionOptions
): Promise<LauncherRetentionResult> {
  const result: LauncherRetentionResult = {
    keptApps: [],
    deletedApps: [],
    keptRuntimes: [],
    deletedRuntimes: [],
    pendingDeletes: [],
    skipped: [],
    errors: []
  }
  const { layout, settings, activePointer, healthState } = options
  const fileSystem = options.fileSystem ?? nodeFileSystem
  let canonicalLayout: CanonicalLayout
  try {
    canonicalLayout = await validateLayout(fileSystem, layout)
  } catch (error) {
    result.errors.push({ path: layout.root, message: message(error) })
    return result
  }

  const [appScan, runtimeScan] = await Promise.all([
    scanInstallations<InstalledApp>(options, result, canonicalLayout, 'app'),
    scanInstallations<InstalledRuntime>(options, result, canonicalLayout, 'runtime')
  ])
  if (!appScan.complete || !runtimeScan.complete) {
    result.errors.push({
      path: layout.root,
      message: 'Retention scan incomplete; refusing cleanup'
    })
    return result
  }
  const apps = appScan.installations
  const runtimes = runtimeScan.installations
  const protectedApps = new Set(
    [
      activePointer?.activeBuildId,
      activePointer?.previousBuildId,
      healthState?.pending?.buildId
    ].filter((value): value is string => value !== undefined)
  )
  const protectedRuntimes = new Set(
    [
      activePointer?.activeRuntimeId,
      activePointer?.previousRuntimeId,
      healthState?.pending?.runtimeId
    ].filter((value): value is string => value !== undefined)
  )

  const candidates = apps
    .filter((app) => !protectedApps.has(app.manifest.buildId))
    .sort(compareApps)
  const retained = new Set(
    candidates.slice(0, settings.retainAppVersions).map((app) => app.manifest.buildId)
  )
  const retainNightlyVersions = settings.retainNightlyVersions ?? DEFAULT_RETAIN_NIGHTLY_VERSIONS
  let nightlyCount = 0
  for (const app of candidates) {
    if (isNightlyVersion(app.manifest.version) && nightlyCount++ < retainNightlyVersions)
      retained.add(app.manifest.buildId)
  }

  const keptApps = apps.filter(
    (app) => protectedApps.has(app.manifest.buildId) || retained.has(app.manifest.buildId)
  )
  result.keptApps.push(...keptApps.map((app) => app.manifest.buildId).sort())
  for (const app of apps.filter((item) => !keptApps.includes(item))) {
    const removed = await removeDirectory(
      fileSystem,
      canonicalLayout,
      canonicalLayout.apps,
      app,
      app.manifest.buildId,
      result.deletedApps,
      result,
      options.dryRun === true
    )
    if (!removed) protectedRuntimes.add(app.manifest.runtimeId)
  }

  for (const app of keptApps) protectedRuntimes.add(app.manifest.runtimeId)
  result.keptRuntimes.push(
    ...runtimes
      .filter((runtime) => protectedRuntimes.has(runtime.runtimeId))
      .map((runtime) => runtime.runtimeId)
      .sort()
  )
  for (const runtime of runtimes.filter((item) => !protectedRuntimes.has(item.runtimeId))) {
    await removeDirectory(
      fileSystem,
      canonicalLayout,
      canonicalLayout.runtimes,
      runtime,
      runtime.runtimeId,
      result.deletedRuntimes,
      result,
      options.dryRun === true
    )
  }

  result.deletedApps.sort()
  result.deletedRuntimes.sort()
  result.pendingDeletes.sort()
  return result
}
