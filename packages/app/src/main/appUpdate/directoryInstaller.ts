import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  isSafeRelativePath,
  parseInstalledAppManifest,
  parseInstalledRuntimeManifest,
  type InstalledAppManifestV1,
  type InstalledFileV1,
  type InstalledRuntimeManifestV1
} from '../../shared/appUpdate/launcherProtocol'
import {
  createLauncherLayout,
  getAppDirectory,
  getRuntimeDirectory,
  INSTALLED_MANIFEST_FILE
} from './launcherLayout'

export type InstallDirectoryKind = 'app' | 'runtime'

export interface InstallPreExtractedDirectoryOptions {
  root: string
  sourceDirectory: string
  kind: InstallDirectoryKind
  expectedId: string
  expectedRuntimeId?: string
  uniqueId?: () => string
}

export interface InstalledDirectoryResult {
  destination: string
  manifest: InstalledAppManifestV1 | InstalledRuntimeManifestV1
  installed: boolean
}

export class DirectoryInstallationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryInstallationError'
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function normalizeManifestPath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/')
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false
    throw error
  }
}

async function requireRealDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new DirectoryInstallationError(`${label} must be a real directory`)
}

async function readManifest(
  directory: string,
  kind: InstallDirectoryKind
): Promise<InstalledAppManifestV1 | InstalledRuntimeManifestV1> {
  const manifestPath = path.join(directory, INSTALLED_MANIFEST_FILE)
  const stat = await fs.lstat(manifestPath)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new DirectoryInstallationError('Embedded manifest must be a regular file')
  const text = await fs.readFile(manifestPath, 'utf8')
  return kind === 'app' ? parseInstalledAppManifest(text) : parseInstalledRuntimeManifest(text)
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) return hash.digest('hex')
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
}

async function verifyTree(directory: string, declaredFiles: InstalledFileV1[]): Promise<void> {
  const declared = new Map(
    declaredFiles.map((file) => [normalizeManifestPath(file.path), file] as const)
  )
  const seen = new Set<string>()
  const visit = async (current: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      const relative = normalizeManifestPath(path.join(relativeDirectory, entry.name))
      if (!isSafeRelativePath(relative))
        throw new DirectoryInstallationError(`Unsafe source path: ${relative}`)
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink())
        throw new DirectoryInstallationError(`Symbolic links are not allowed: ${relative}`)
      if (stat.isDirectory()) {
        await visit(target, relative)
        continue
      }
      if (!stat.isFile())
        throw new DirectoryInstallationError(`Unsupported filesystem entry: ${relative}`)
      if (samePath(relative, INSTALLED_MANIFEST_FILE)) continue
      const declaration = [...declared].find(([declaredPath]) =>
        samePath(declaredPath, relative)
      )?.[1]
      if (!declaration) throw new DirectoryInstallationError(`Undeclared file: ${relative}`)
      if (stat.size !== declaration.size)
        throw new DirectoryInstallationError(
          `File size mismatch for ${relative}: expected ${declaration.size}, received ${stat.size}`
        )
      const sha256 = await hashFile(target)
      if (sha256 !== declaration.sha256)
        throw new DirectoryInstallationError(`SHA-256 mismatch for ${relative}`)
      seen.add(normalizeManifestPath(declaration.path))
    }
  }
  await visit(directory, '')
  for (const declaredPath of declared.keys()) {
    if (!seen.has(declaredPath))
      throw new DirectoryInstallationError(`Declared file is missing: ${declaredPath}`)
  }
}

async function validateDirectory(
  directory: string,
  kind: InstallDirectoryKind,
  expectedId: string,
  expectedRuntimeId?: string
): Promise<InstalledAppManifestV1 | InstalledRuntimeManifestV1> {
  await requireRealDirectory(directory, 'Installation source')
  const manifest = await readManifest(directory, kind)
  if (kind === 'app') {
    const app = manifest as InstalledAppManifestV1
    if (app.buildId !== expectedId)
      throw new DirectoryInstallationError('App manifest build ID does not match the requested ID')
    if (expectedRuntimeId !== undefined && app.runtimeId !== expectedRuntimeId)
      throw new DirectoryInstallationError(
        'App manifest runtime ID does not match the requested runtime'
      )
  } else if ((manifest as InstalledRuntimeManifestV1).runtimeId !== expectedId) {
    throw new DirectoryInstallationError('Runtime manifest ID does not match the requested ID')
  }
  if (!manifest.files)
    throw new DirectoryInstallationError('Installation manifest must declare every payload file')
  await verifyTree(directory, manifest.files)
  return manifest
}

async function sameInstalledIdentity(
  source: string,
  destination: string,
  kind: InstallDirectoryKind,
  expectedId: string,
  expectedRuntimeId?: string
): Promise<InstalledAppManifestV1 | InstalledRuntimeManifestV1 | undefined> {
  try {
    const [sourceManifest, destinationManifest] = await Promise.all([
      validateDirectory(source, kind, expectedId, expectedRuntimeId),
      validateDirectory(destination, kind, expectedId, expectedRuntimeId)
    ])
    return JSON.stringify(sourceManifest) === JSON.stringify(destinationManifest)
      ? destinationManifest
      : undefined
  } catch {
    return undefined
  }
}

export async function installPreExtractedDirectory(
  options: InstallPreExtractedDirectoryOptions
): Promise<InstalledDirectoryResult> {
  const layout = createLauncherLayout(options.root)
  const destination =
    options.kind === 'app'
      ? getAppDirectory(layout, options.expectedId)
      : getRuntimeDirectory(layout, options.expectedId)
  const parent = path.dirname(destination)
  const partial = path.join(
    parent,
    `${options.expectedId}.${(options.uniqueId ?? randomUUID)()}.partial`
  )
  const source = path.resolve(options.sourceDirectory)
  const relativeToParent = path.relative(parent, source)
  if (
    relativeToParent === '' ||
    (!path.isAbsolute(relativeToParent) &&
      relativeToParent !== '..' &&
      !relativeToParent.startsWith(`..${path.sep}`))
  )
    throw new DirectoryInstallationError('Installation source must be outside managed destinations')

  await fs.mkdir(layout.root, { recursive: true })
  await requireRealDirectory(layout.root, 'Launcher root')
  await fs.mkdir(parent, { recursive: true })
  await requireRealDirectory(parent, `Managed ${options.kind} root`)

  if (await exists(destination)) {
    const manifest = await sameInstalledIdentity(
      source,
      destination,
      options.kind,
      options.expectedId,
      options.expectedRuntimeId
    )
    if (manifest) return { destination, manifest, installed: false }
    throw new DirectoryInstallationError(`Installation destination already exists: ${destination}`)
  }
  if (await exists(partial)) throw new DirectoryInstallationError(`Staging collision: ${partial}`)

  try {
    await validateDirectory(source, options.kind, options.expectedId, options.expectedRuntimeId)
    await fs.cp(source, partial, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true
    })
    const manifest = await validateDirectory(
      partial,
      options.kind,
      options.expectedId,
      options.expectedRuntimeId
    )
    try {
      await fs.rename(partial, destination)
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY')) {
        const existing = await sameInstalledIdentity(
          partial,
          destination,
          options.kind,
          options.expectedId,
          options.expectedRuntimeId
        )
        if (existing) return { destination, manifest: existing, installed: false }
        throw new DirectoryInstallationError(`Installation destination collision: ${destination}`)
      }
      throw error
    }
    return { destination, manifest, installed: true }
  } finally {
    await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined)
  }
}
