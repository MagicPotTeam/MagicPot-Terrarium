import fs from 'node:fs/promises'
import path from 'node:path'
import { isPathInsideRoot } from './managedMediaStore'

const MEDIA_ID = /^[a-f0-9]{64}$/u
const ORIGINAL_PATH = /^originals\/([a-f0-9]{2})\/([a-f0-9]{64})\.([a-z0-9]+)$/u
const DERIVATIVE_SCHEMA = 'magicpot.managed-media-derivative/v3'
const DERIVATIVE_FORMATS = new Set(['png', 'webp', 'jpeg'])
const DERIVATIVE_EXTENSIONS = new Set(['png', 'webp', 'jpg'])
const METADATA_SCHEMA = 'magicpot.managed-media/v1'

type Manifest = Record<string, unknown>
type Skipped = { relativePath: string; reason: string }

export type ManagedMediaCleanupAction = {
  /** Planner action for one validated derivative image file. */
  kind: 'derivative-file'
  mediaId: string
  relativePath: string
}
export type ManagedMediaCleanupPlan = {
  root: string
  referencedMediaIds: ReadonlySet<string>
  actions: ManagedMediaCleanupAction[]
  skipped: Skipped[]
}
export type PlanManagedMediaCleanupInput = {
  chatMediaRoot: string
  /** Complete authoritative set of original sha256 IDs referenced by durable state. */
  referencedMediaIds: Iterable<string>
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a),
    right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function normalizeReferences(values: Iterable<string>): ReadonlySet<string> {
  if (values == null || typeof values[Symbol.iterator] !== 'function')
    throw new TypeError('referencedMediaIds must be an authoritative iterable')
  const result = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || !MEDIA_ID.test(value))
      throw new TypeError('referencedMediaIds contains an invalid managed media ID')
    result.add(value)
  }
  return result
}

/** Verify every component is a real directory, not a symlink or mount-through path. */
async function safeDirectory(root: string, value: string): Promise<boolean> {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(value)
  if (!isPathInsideRoot(resolvedRoot, resolved)) return false
  let current = resolvedRoot
  for (const segment of path.relative(resolvedRoot, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !samePath(await fs.realpath(current), current)
    )
      return false
  }
  return true
}

async function safeFile(root: string, value: string): Promise<boolean> {
  const resolved = path.resolve(value)
  if (!isPathInsideRoot(path.resolve(root), resolved) || samePath(root, resolved)) return false
  if (!(await safeDirectory(root, path.dirname(resolved)))) return false
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return stat.isFile() && !stat.isSymbolicLink() && samePath(await fs.realpath(resolved), resolved)
}

function absoluteFromRelative(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\'))
    throw new Error('path is not a canonical managed-media relative path')
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('path contains traversal')
  const absolute = path.join(root, ...parts)
  if (!isPathInsideRoot(root, absolute) || samePath(root, absolute))
    throw new Error('path escapes managed-media root')
  return absolute
}

async function entries(value: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(value, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function validDerivativePath(
  value: unknown,
  root: string,
  mediaId: string,
  identity: string,
  format: string
): value is string {
  if (typeof value !== 'string') return false
  const expected = `derivatives/${mediaId.slice(0, 2)}/${mediaId}/${identity}/committed/image.${format === 'jpeg' ? 'jpg' : format}`
  return (
    value === expected &&
    DERIVATIVE_EXTENSIONS.has(path.extname(value).slice(1)) &&
    isPathInsideRoot(root, path.resolve(root, ...value.split('/')))
  )
}

function validManifest(
  manifest: Manifest,
  root: string,
  mediaId: string,
  identity: string
): manifest is Manifest & { relativePath: string } {
  const format = manifest.format
  return (
    manifest.schema === DERIVATIVE_SCHEMA &&
    manifest.purpose === 'managed-media-derivative' &&
    manifest.identity === identity &&
    manifest.originalSha256 === mediaId &&
    typeof format === 'string' &&
    DERIVATIVE_FORMATS.has(format) &&
    validDerivativePath(manifest.relativePath, root, mediaId, identity, format)
  )
}

async function planDerivatives(
  root: string,
  mediaId: string,
  skipped: Skipped[]
): Promise<ManagedMediaCleanupAction[]> {
  const baseRelative = `derivatives/${mediaId.slice(0, 2)}/${mediaId}`
  const base = absoluteFromRelative(root, baseRelative)
  if (!(await safeDirectory(root, base))) {
    if (
      await fs.lstat(base).then(
        () => true,
        () => false
      )
    )
      skipped.push({ relativePath: baseRelative, reason: 'unsafe derivative identity path' })
    return []
  }
  const actions: ManagedMediaCleanupAction[] = []
  for (const entry of await entries(base)) {
    const identityRelative = `${baseRelative}/${entry.name}`
    if (entry.isSymbolicLink() || !entry.isDirectory() || !MEDIA_ID.test(entry.name)) {
      skipped.push({ relativePath: identityRelative, reason: 'unrecognized derivative identity' })
      continue
    }
    const committedRelative = `${identityRelative}/committed`
    const manifestRelative = `${committedRelative}/manifest.json`
    try {
      const committed = absoluteFromRelative(root, committedRelative)
      const manifestPath = absoluteFromRelative(root, manifestRelative)
      if (!(await safeDirectory(root, committed)) || !(await safeFile(root, manifestPath)))
        throw new Error('unsafe or missing derivative manifest')
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest
      if (!validManifest(manifest, root, mediaId, entry.name))
        throw new Error('invalid derivative manifest')
      const imagePath = absoluteFromRelative(root, manifest.relativePath)
      if (!(await safeFile(root, imagePath)))
        throw new Error('unsafe, missing, or non-regular derivative image')
      actions.push({ kind: 'derivative-file', mediaId, relativePath: manifest.relativePath })
    } catch (error) {
      skipped.push({ relativePath: identityRelative, reason: (error as Error).message })
    }
  }
  return actions
}

export async function planManagedMediaCleanup(
  input: PlanManagedMediaCleanupInput
): Promise<ManagedMediaCleanupPlan> {
  const root = path.resolve(input.chatMediaRoot)
  if (!(await safeDirectory(path.dirname(root), root)) || !samePath(root, await fs.realpath(root)))
    throw new Error('Managed media cleanup root must be an existing canonical directory')
  const referencedMediaIds = normalizeReferences(input.referencedMediaIds)
  const skipped: Skipped[] = []
  const actions: ManagedMediaCleanupAction[] = []
  const metadataRoot = path.join(root, 'metadata')
  if (!(await safeDirectory(root, metadataRoot)))
    return { root, referencedMediaIds, actions, skipped }
  for (const entry of await entries(metadataRoot)) {
    const match = /^([a-f0-9]{64})\.json$/u.exec(entry.name)
    const relative = `metadata/${entry.name}`
    if (!match) {
      skipped.push({ relativePath: relative, reason: 'malformed metadata entry' })
      continue
    }
    if (referencedMediaIds.has(match[1])) continue
    if (entry.isSymbolicLink() || !entry.isFile()) {
      skipped.push({ relativePath: relative, reason: 'metadata is not a regular file' })
      continue
    }
    const mediaId = match[1]
    try {
      const metadataPath = absoluteFromRelative(root, relative)
      if (!(await safeFile(root, metadataPath))) throw new Error('unsafe metadata path')
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Manifest
      if (
        metadata.schema !== METADATA_SCHEMA ||
        metadata.sha256 !== mediaId ||
        typeof metadata.relativePath !== 'string'
      )
        throw new Error('invalid metadata')
      const original = ORIGINAL_PATH.exec(metadata.relativePath)
      if (!original || original[1] !== mediaId.slice(0, 2) || original[2] !== mediaId)
        throw new Error('invalid original path')
      if (!(await safeFile(root, absoluteFromRelative(root, metadata.relativePath))))
        throw new Error('unsafe or missing original')
      actions.push(...(await planDerivatives(root, mediaId, skipped)))
    } catch (error) {
      skipped.push({ relativePath: relative, reason: (error as Error).message })
    }
  }
  return { root, referencedMediaIds, actions, skipped }
}
