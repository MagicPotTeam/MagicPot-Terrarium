import fs from 'fs/promises'
import path from 'path'

import {
  MAGIC_AGENT_PACKAGE_MANIFEST_FILE,
  type MagicAgentInstalledPackage,
  type MagicAgentPackageAgentDefinition,
  type MagicAgentPackageInspection,
  type MagicAgentPackageInstallResult,
  type MagicAgentPackageListEntry,
  type MagicAgentPackageValidationResult
} from '@shared/magicAgentRuntime/packageContracts'

import { packageAgentSpecToDefinition, validateMagicAgentPackageAgentSpec } from './agentSpec'
import { validateMagicAgentPackageManifest } from './manifest'

const METADATA_FILE = 'magicpot-installed-package.json'
const PACKAGE_CONTENT_DIR = 'package'
const UTF8_BOM_PATTERN = /^\uFEFF/
const WINDOWS_DRIVE_ENTRY_PATTERN = /^[A-Za-z]:[\\/]/

const DEFAULT_PACKAGE_RESOURCE_LIMITS = {
  maxDepth: 12,
  maxFiles: 2000,
  maxBytes: 50 * 1024 * 1024
}

type CopyOptions = {
  ignoreFileNames?: Set<string>
  limits?: typeof DEFAULT_PACKAGE_RESOURCE_LIMITS
  state?: {
    files: number
    bytes: number
  }
  depth?: number
  sourceRoot?: string
  sourceRootRealPath?: string
}

type PackageResourceUsage = {
  files: number
  bytes: number
  maxDepth: number
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false)
}

async function realpathOrResolved(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath)
  return fs.realpath(resolved).catch(() => resolved)
}

function assertSafePackageId(packageId: string): void {
  if (
    !packageId ||
    packageId.includes('/') ||
    packageId.includes('\\') ||
    packageId.includes('..')
  ) {
    throw new Error(`Unsafe package id: ${packageId}`)
  }
}

function stripBom(text: string): string {
  return text.replace(UTF8_BOM_PATTERN, '')
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(stripBom(await fs.readFile(filePath, 'utf8')))
}

function normalizePathSeparators(input: string): string {
  return input.replace(/\\/g, '/')
}

function assertWithinRoot(rootDir: string, candidatePath: string): void {
  const relative = normalizePathSeparators(path.relative(rootDir, candidatePath))
  if (
    relative === '' ||
    (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative))
  ) {
    return
  }

  throw new Error('Path escapes package root.')
}

function assertRelativeEntryPath(entry: string, _manifestPath: string): void {
  const normalized = normalizePathSeparators(entry)
  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    WINDOWS_DRIVE_ENTRY_PATTERN.test(entry)
  ) {
    throw new Error('Manifest contains an unsafe contribution entry path.')
  }
}

async function validateContributionEntries(
  packageDir: string,
  manifestPath: string,
  validation: MagicAgentPackageValidationResult
): Promise<MagicAgentPackageValidationResult> {
  if (!validation.ok) {
    return validation
  }

  const errors: { path: string; message: string }[] = []
  const warnings = [...validation.warnings]

  for (const [index, contribution] of (validation.manifest.contributions || []).entries()) {
    if (!contribution.entry) {
      continue
    }

    try {
      assertRelativeEntryPath(contribution.entry, manifestPath)
      const entryPath = path.resolve(packageDir, contribution.entry)
      assertWithinRoot(packageDir, entryPath)
      if (!(await pathExists(entryPath))) {
        errors.push({
          path: `contributions.${index}.entry`,
          message: `Contribution entry does not exist: ${contribution.entry}`
        })
        continue
      }

      if (contribution.kind === 'agent') {
        if (!contribution.entry.toLowerCase().endsWith('.json')) {
          errors.push({
            path: `contributions.${index}.entry`,
            message: 'Agent contribution entry must be a JSON file.'
          })
          continue
        }

        let rawAgentSpec: unknown
        try {
          rawAgentSpec = await readJsonFile(entryPath)
        } catch {
          errors.push({
            path: `contributions.${index}.entry`,
            message: 'Unable to read or parse agent contribution spec.'
          })
          continue
        }

        const agentSpecValidation = validateMagicAgentPackageAgentSpec(rawAgentSpec)
        if (!agentSpecValidation.ok) {
          const messages = agentSpecValidation.errors.map(
            (issue) => `${issue.path}: ${issue.message}`
          )
          errors.push({
            path: `contributions.${index}.entry`,
            message: `Invalid agent contribution spec. ${messages.join('; ')}`
          })
        }
      }
    } catch (error) {
      errors.push({
        path: `contributions.${index}.entry`,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings }
  }

  return validation
}

async function readManifestFromDir(packageDir: string): Promise<{
  manifestPath: string
  validation: MagicAgentPackageValidationResult
}> {
  const manifestPath = path.join(packageDir, MAGIC_AGENT_PACKAGE_MANIFEST_FILE)
  let rawManifest: unknown

  try {
    rawManifest = await readJsonFile(manifestPath)
  } catch (error) {
    return {
      manifestPath,
      validation: {
        ok: false,
        errors: [
          {
            path: MAGIC_AGENT_PACKAGE_MANIFEST_FILE,
            message: 'Unable to read or parse package manifest.'
          }
        ],
        warnings: []
      }
    }
  }

  return {
    manifestPath,
    validation: await validateContributionEntries(
      packageDir,
      manifestPath,
      validateMagicAgentPackageManifest(rawManifest)
    )
  }
}

async function inspectDirectoryResources(
  sourceDir: string,
  limits = DEFAULT_PACKAGE_RESOURCE_LIMITS,
  state: PackageResourceUsage = { files: 0, bytes: 0, maxDepth: 0 },
  depth = 0
): Promise<PackageResourceUsage> {
  if (depth > limits.maxDepth) {
    throw new Error(`Package exceeds maximum directory depth of ${limits.maxDepth}.`)
  }
  state.maxDepth = Math.max(state.maxDepth, depth)

  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)

    if (entry.isSymbolicLink()) {
      throw new Error('Package contains unsupported symbolic link.')
    }

    if (entry.isDirectory()) {
      await inspectDirectoryResources(sourcePath, limits, state, depth + 1)
      continue
    }

    if (entry.isFile()) {
      const stats = await fs.stat(sourcePath)
      state.files += 1
      state.bytes += stats.size
      if (state.files > limits.maxFiles) {
        throw new Error(`Package exceeds maximum file count of ${limits.maxFiles}.`)
      }
      if (state.bytes > limits.maxBytes) {
        throw new Error(`Package exceeds maximum total size of ${limits.maxBytes} bytes.`)
      }
    }
  }

  return state
}

async function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  options: CopyOptions = {}
): Promise<void> {
  const limits = options.limits || DEFAULT_PACKAGE_RESOURCE_LIMITS
  const state = options.state || { files: 0, bytes: 0 }
  const depth = options.depth || 0
  if (depth > limits.maxDepth) {
    throw new Error(`Package exceeds maximum directory depth of ${limits.maxDepth}.`)
  }

  const sourceRoot = path.resolve(options.sourceRoot ?? sourceDir)
  const sourceRootRealPath = options.sourceRootRealPath ?? (await realpathOrResolved(sourceRoot))
  const resolvedSourceDir = path.resolve(sourceDir)
  assertWithinRoot(sourceRoot, resolvedSourceDir)

  const sourceStats = await fs.lstat(resolvedSourceDir)
  if (sourceStats.isSymbolicLink()) {
    throw new Error('Package contains unsupported symbolic link.')
  }
  if (!sourceStats.isDirectory()) {
    throw new Error('Package copy source must be a directory.')
  }

  const sourceRealPath = await fs.realpath(resolvedSourceDir)
  assertWithinRoot(sourceRootRealPath, sourceRealPath)

  await fs.mkdir(targetDir, { recursive: true })
  const entries = await fs.readdir(resolvedSourceDir, { withFileTypes: true })

  for (const entry of entries) {
    if (options.ignoreFileNames?.has(entry.name)) {
      continue
    }

    const sourcePath = path.join(resolvedSourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    const stats = await fs.lstat(sourcePath)

    if (stats.isSymbolicLink()) {
      throw new Error('Package contains unsupported symbolic link.')
    }

    if (stats.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath, {
        ...options,
        limits,
        state,
        depth: depth + 1,
        sourceRoot,
        sourceRootRealPath
      })
      continue
    }

    if (stats.isFile()) {
      state.files += 1
      state.bytes += stats.size
      if (state.files > limits.maxFiles) {
        throw new Error(`Package exceeds maximum file count of ${limits.maxFiles}.`)
      }
      if (state.bytes > limits.maxBytes) {
        throw new Error(`Package exceeds maximum total size of ${limits.maxBytes} bytes.`)
      }
      await fs.copyFile(sourcePath, targetPath)
    }
  }
}

async function readInstalledMetadata(
  packagePath: string
): Promise<MagicAgentInstalledPackage | undefined> {
  const metadataPath = path.join(packagePath, METADATA_FILE)
  if (!(await pathExists(metadataPath))) {
    return undefined
  }

  const parsed = await readJsonFile(metadataPath)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }

  return {
    ...(parsed as MagicAgentInstalledPackage),
    packagePath
  }
}

async function readPackageAgentDefinitions(
  installed: MagicAgentInstalledPackage
): Promise<MagicAgentPackageAgentDefinition[]> {
  const packageContentPath = path.join(installed.packagePath, PACKAGE_CONTENT_DIR)
  const agents: MagicAgentPackageAgentDefinition[] = []

  for (const contribution of installed.manifest.contributions || []) {
    if (contribution.kind !== 'agent') {
      continue
    }
    if (!contribution.entry) {
      throw new Error(`Agent contribution "${contribution.id}" is missing an entry file.`)
    }
    if (!contribution.entry.toLowerCase().endsWith('.json')) {
      throw new Error(`Agent contribution "${contribution.id}" must use a JSON entry file.`)
    }

    assertRelativeEntryPath(
      contribution.entry,
      path.join(packageContentPath, MAGIC_AGENT_PACKAGE_MANIFEST_FILE)
    )
    const entryPath = path.resolve(packageContentPath, contribution.entry)
    assertWithinRoot(packageContentPath, entryPath)
    const parsed = await readJsonFile(entryPath)
    const validation = validateMagicAgentPackageAgentSpec(parsed)
    if (!validation.ok) {
      const messages = validation.errors.map((issue) => `${issue.path}: ${issue.message}`)
      throw new Error(
        `Invalid agent contribution "${contribution.id}" in package "${installed.id}". ${messages.join('; ')}`
      )
    }

    agents.push(
      packageAgentSpecToDefinition({
        installedPackage: installed,
        contributionId: contribution.id,
        ...(contribution.title ? { contributionTitle: contribution.title } : {}),
        spec: validation.spec
      })
    )
  }

  return agents
}

export class MagicAgentPackageStore {
  private readonly packageRoot: string
  private readonly storeDir: string

  constructor(packageRoot: string, storeDir?: string) {
    this.packageRoot = path.resolve(packageRoot)
    this.storeDir = path.resolve(storeDir ?? path.join(this.packageRoot, 'installed'))
  }

  async validateManifest(packageDir: string): Promise<MagicAgentPackageValidationResult> {
    return (await readManifestFromDir(path.resolve(packageDir))).validation
  }

  async scanLocalDirectory(packageDir: string): Promise<MagicAgentPackageInspection> {
    const resolvedPackageDir = await this.resolveApprovedPackageDirectory(packageDir)
    let resourceError: Error | undefined
    await inspectDirectoryResources(resolvedPackageDir).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      resourceError =
        /maximum directory depth|maximum file count|maximum total size|unsupported symbolic link/.test(
          message
        )
          ? new Error(message)
          : new Error('Unable to inspect package directory resources.')
      return undefined
    })
    const { manifestPath, validation: manifestValidation } =
      await readManifestFromDir(resolvedPackageDir)
    const validation = resourceError
      ? {
          ok: false as const,
          errors: [{ path: '.', message: resourceError.message }],
          warnings: manifestValidation.warnings
        }
      : manifestValidation
    const installed = validation.ok ? await this.findInstalled(validation.manifest.id) : undefined

    return {
      manifestPath,
      packagePath: resolvedPackageDir,
      validation,
      ...(installed ? { installed } : {})
    }
  }

  async install(packageDir: string): Promise<MagicAgentPackageInstallResult> {
    const inspection = await this.scanLocalDirectory(packageDir)
    if (!inspection.validation.ok) {
      const messages = inspection.validation.errors.map(
        (issue) => `${issue.path}: ${issue.message}`
      )
      throw new Error(`Invalid MagicPot package manifest. ${messages.join('; ')}`)
    }

    await fs.mkdir(this.storeDir, { recursive: true })

    const manifest = inspection.validation.manifest
    assertSafePackageId(manifest.id)
    const packagePath = path.join(this.storeDir, manifest.id)
    assertWithinRoot(this.storeDir, packagePath)

    const replaced = await pathExists(packagePath)
    const stagePath = path.join(
      this.storeDir,
      `.install-${manifest.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    )
    const stagePackagePath = path.join(stagePath, PACKAGE_CONTENT_DIR)

    await fs.mkdir(stagePath, { recursive: true })

    try {
      await copyDirectoryContents(inspection.packagePath, stagePackagePath, {
        ignoreFileNames: new Set([METADATA_FILE]),
        limits: DEFAULT_PACKAGE_RESOURCE_LIMITS
      })

      const installedAt = new Date().toISOString()
      const installed: MagicAgentInstalledPackage = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description ? { description: manifest.description } : {}),
        ...(manifest.author ? { author: manifest.author } : {}),
        installedAt,
        sourcePath: inspection.packagePath,
        packagePath,
        manifest
      }

      await fs.writeFile(path.join(stagePath, METADATA_FILE), JSON.stringify(installed, null, 2))

      if (replaced) {
        await fs.rm(packagePath, { recursive: true, force: true })
      }
      await fs.rename(stagePath, packagePath)

      return { installed, replaced }
    } catch (error) {
      await fs.rm(stagePath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async list(): Promise<MagicAgentPackageListEntry[]> {
    if (!(await pathExists(this.storeDir))) {
      return []
    }

    const entries = await fs.readdir(this.storeDir, { withFileTypes: true })
    const packages: MagicAgentPackageListEntry[] = []

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.install-')) {
        continue
      }

      const packagePath = path.join(this.storeDir, entry.name)
      const installed = await readInstalledMetadata(packagePath).catch(() => undefined)
      if (installed) {
        packages.push(installed)
      }
    }

    return packages.sort((left, right) => left.id.localeCompare(right.id))
  }

  async inspect(packageId: string): Promise<MagicAgentPackageInspection> {
    const installed = await this.findInstalled(packageId).catch(() => undefined)
    if (installed) {
      return {
        manifestPath: path.join(
          installed.packagePath,
          PACKAGE_CONTENT_DIR,
          MAGIC_AGENT_PACKAGE_MANIFEST_FILE
        ),
        packagePath: path.join(installed.packagePath, PACKAGE_CONTENT_DIR),
        validation: { ok: true, manifest: installed.manifest, warnings: [] },
        installed
      }
    }

    return {
      manifestPath: '',
      packagePath: '',
      validation: {
        ok: false,
        errors: [{ path: 'packageId', message: 'MagicAgent package is not installed.' }],
        warnings: []
      }
    }
  }

  async listAgents(): Promise<MagicAgentPackageAgentDefinition[]> {
    const packages = await this.list()
    const agentsById = new Map<string, MagicAgentPackageAgentDefinition>()

    for (const installed of packages) {
      for (const agent of await readPackageAgentDefinitions(installed)) {
        if (agentsById.has(agent.id)) {
          throw new Error(`Duplicate package agent id: ${agent.id}`)
        }
        agentsById.set(agent.id, agent)
      }
    }

    return [...agentsById.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  async uninstall(packageId: string): Promise<boolean> {
    assertSafePackageId(packageId)
    const packagePath = path.join(this.storeDir, packageId)
    assertWithinRoot(this.storeDir, packagePath)

    if (!(await pathExists(packagePath))) {
      return false
    }

    await fs.rm(packagePath, { recursive: true, force: true })
    return true
  }

  private async findInstalled(packageId: string): Promise<MagicAgentInstalledPackage | undefined> {
    assertSafePackageId(packageId)
    const packagePath = path.join(this.storeDir, packageId)
    assertWithinRoot(this.storeDir, packagePath)
    return readInstalledMetadata(packagePath).catch(() => undefined)
  }

  private async resolveApprovedPackageDirectory(packageDir: string): Promise<string> {
    const resolvedPackageDir = path.resolve(packageDir)
    assertWithinRoot(this.packageRoot, resolvedPackageDir)

    const stats = await fs.lstat(resolvedPackageDir).catch(() => undefined)
    if (stats?.isSymbolicLink()) {
      throw new Error('MagicAgent package directory must not be a symbolic link.')
    }

    if (stats) {
      const rootRealPath = await realpathOrResolved(this.packageRoot)
      const packageRealPath = await realpathOrResolved(resolvedPackageDir)
      assertWithinRoot(rootRealPath, packageRealPath)
    }

    return resolvedPackageDir
  }

  getPackageRoot(): string {
    return this.packageRoot
  }

  getStoreDir(): string {
    return this.storeDir
  }
}
