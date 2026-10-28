import { createHash } from 'node:crypto'
import { type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeImage } from 'electron'
import type { LLMChatResp } from '@shared/api/svcLLMProxy'
import { FigPluginBridgeError } from '@shared/figplugin/bridge'
import { FIGPLUGIN_ASSET_MAX_BYTES, type FigPluginAssetMime } from '@shared/figplugin/hostAssets'
import { FigPluginManagementError } from '@shared/figplugin/management'
import {
  figPluginManagedAssetReferenceSchema,
  type FigPluginManagedAssetReference
} from '@shared/figplugin/managedSessionAsset'
import { assertRemoteFetchHostnameIsNotExplicitlyLocal } from '../api/remoteFetchPolicy'
import { safeRemoteDownload } from '../api/safeRemoteDownload'
import { getChatMediaDir } from '../llmProxy/chatMediaDir'
import {
  importManagedMediaStream,
  readManagedMediaBytes,
  resolveManagedMediaReference
} from '../llmProxy/managedMediaStore'
import { inspectSessionAssetImage } from './sessionAssetImage'

export type MaterializedProviderImageOutput = {
  reference: FigPluginManagedAssetReference
  localMediaUrl: string
  width: number
  height: number
  /** Main-only ownership rollback; never serialize this capability across IPC. */
  discard: () => Promise<void>
}

export type ProviderImageOutputMaterializer = (
  response: LLMChatResp,
  options: {
    runId: string
    check: () => void
    signal: AbortSignal
    maxBytes: number
    deadlineAt: number
  }
) => Promise<MaterializedProviderImageOutput>

const MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const invalid = (): never => {
  throw new FigPluginBridgeError('INVALID_REQUEST')
}
const samePath = (left: string, right: string): boolean => {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino
const sameFile = (left: Stats, right: Stats): boolean =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs &&
  left.nlink === right.nlink
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const mime = (value: unknown): FigPluginAssetMime => {
  if (!MIME_TYPES.includes(value as FigPluginAssetMime)) return invalid()
  return value as FigPluginAssetMime
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

function selectSource(response: LLMChatResp): { url: string; mimeType?: FigPluginAssetMime } {
  const result = record(response)
  if (!result || typeof result.content !== 'string') return invalid()
  if (result.finishReason !== undefined && result.finishReason !== 'stop') return invalid()
  for (const container of [result, record(result.metadata)]) {
    for (const key of ['toolCalls', 'tool_calls', 'toolHistory']) {
      const value = container?.[key]
      if (value !== undefined && (!Array.isArray(value) || value.length > 0)) return invalid()
    }
  }
  const sources = new Map<string, FigPluginAssetMime | undefined>()
  const add = (url: unknown, declaredMime?: unknown) => {
    if (typeof url !== 'string' || !url || url !== url.trim()) return invalid()
    const mimeType = declaredMime === undefined ? undefined : mime(declaredMime)
    const previous = sources.get(url)
    if (previous && mimeType && previous !== mimeType) return invalid()
    sources.set(url, previous ?? mimeType)
    if (sources.size > 1) return invalid()
  }
  if (result.attachments !== undefined) {
    if (!Array.isArray(result.attachments) || result.attachments.length > 16) return invalid()
    for (const item of result.attachments) {
      const attachment = record(item)
      if (
        !attachment ||
        attachment.type !== 'image' ||
        attachment.media !== undefined ||
        attachment.binary !== undefined ||
        attachment.relativePath !== undefined ||
        (attachment.finishReason !== undefined && attachment.finishReason !== 'stop')
      )
        return invalid()
      add(attachment.url, attachment.mimeType)
    }
  }
  if (result.imageUrl !== undefined) add(result.imageUrl)
  if (sources.size !== 1) return invalid()
  const [url, mimeType] = sources.entries().next().value!
  return { url, mimeType }
}

function publicHttps(value: string): void {
  try {
    if (value.length > 8192 || /[\s\\\p{Cc}]/u.test(value) || !value.startsWith('https://'))
      return invalid()
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return invalid()
    assertRemoteFetchHostnameIsNotExplicitlyLocal(url.hostname)
  } catch {
    return invalid()
  }
}

function decodeDataUrl(
  url: string,
  maxBytes: number
): { bytes: Buffer; mimeType: FigPluginAssetMime } {
  if (url.length > Math.ceil(maxBytes / 3) * 4 + 32) return invalid()
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url)
  if (!match || match[2].length % 4 !== 0) return invalid()
  const encoded = match[2]
  const size =
    (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
  if (size < 1 || size > maxBytes) return invalid()
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== size || bytes.toString('base64') !== encoded) {
    bytes.fill(0)
    return invalid()
  }
  return { bytes, mimeType: mime(match[1]) }
}

async function directoryState(
  directory: string,
  check: () => void = () => undefined
): Promise<Stats> {
  const stat = await fs.lstat(directory)
  check()
  const canonical = await fs.realpath(directory)
  check()
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(canonical, directory))
    throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
  return stat
}

/** Produces an owned original, not a session grant, generation receipt or write permission. */
export const materializeProviderImageOutput: ProviderImageOutputMaterializer = async (
  response,
  { runId, check, signal, maxBytes: signedMaxBytes, deadlineAt }
) => {
  let root: string | undefined
  let scope: string | undefined
  let bytes: Buffer | undefined
  let verifiedBytes: Buffer | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(new FigPluginBridgeError('CANCELLED'))
  const directories = new Map<string, Stats>()
  const ownedDirectories: string[] = []
  const files = new Map<string, { maxBytes: number; state?: Stats }>()
  let discarded = false
  let discarding: Promise<void> | undefined
  const checkCurrent = () => {
    check()
    if (signal.aborted) throw new FigPluginBridgeError('CANCELLED')
    if (Date.now() >= deadlineAt || controller.signal.aborted)
      throw new FigPluginBridgeError('TIMEOUT')
    if (root && !samePath(getChatMediaDir(), root))
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
  }
  const assertDirectories = async (cleanup = false) => {
    for (const [directory, original] of directories) {
      try {
        const current = await directoryState(directory, cleanup ? undefined : checkCurrent)
        if (!sameIdentity(original, current))
          throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
      } catch (error) {
        if (!cleanup || !ownedDirectories.includes(directory) || !missing(error)) throw error
      }
    }
  }
  const fileState = async (filename: string, limit: number): Promise<Stats> => {
    const stat = await fs.lstat(filename)
    const canonical = await fs.realpath(filename)
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > limit ||
      !samePath(canonical, filename)
    )
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    return stat
  }
  const cleanup = async () => {
    if (!scope || !directories.has(scope)) return
    // Never traverse or recursively remove a tree. Only exact output leaves and
    // directories created by this run are removable; unknown entries remain.
    // Path-based Node APIs still assume app-controlled parents, not a hostile
    // same-user process swapping them atomically between verification and unlink.
    await assertDirectories(true)
    const candidates = new Map<string, Stats>()
    for (const [filename, owned] of files) {
      try {
        const current = await fileState(filename, owned.maxBytes)
        if (owned.state && !sameFile(owned.state, current))
          throw new FigPluginBridgeError('UPSTREAM_FAILED')
        candidates.set(filename, current)
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    for (const [filename, original] of candidates) {
      await assertDirectories(true)
      if (!sameFile(original, await fileState(filename, files.get(filename)!.maxBytes)))
        throw new FigPluginBridgeError('UPSTREAM_FAILED')
      await fs.unlink(filename)
    }
    for (const directory of [...ownedDirectories].reverse()) {
      await assertDirectories(true)
      try {
        await fs.rmdir(directory)
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
  }
  const discard = async (): Promise<void> => {
    if (discarded) return
    if (!discarding) {
      discarding = cleanup()
        .then(() => {
          discarded = true
        })
        .catch(() => {
          throw new FigPluginBridgeError('UPSTREAM_FAILED')
        })
        .finally(() => {
          discarding = undefined
        })
    }
    return discarding
  }
  const createOwnedDirectory = async (directory: string) => {
    await assertDirectories()
    checkCurrent()
    await fs.mkdir(directory, { mode: 0o700 })
    // Capture the freshly created identity before cancellation can request rollback.
    directories.set(directory, await fs.lstat(directory))
    ownedDirectories.push(directory)
    checkCurrent()
    await assertDirectories()
  }
  try {
    if (
      !UUID.test(runId) ||
      !Number.isSafeInteger(signedMaxBytes) ||
      signedMaxBytes < 1 ||
      !Number.isSafeInteger(deadlineAt) ||
      deadlineAt < 1
    )
      return invalid()
    checkCurrent()
    const maxBytes = Math.min(FIGPLUGIN_ASSET_MAX_BYTES, signedMaxBytes)
    const source = selectSource(response)
    signal.addEventListener('abort', forwardAbort, { once: true })
    const expire = () => {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) controller.abort(new FigPluginBridgeError('TIMEOUT'))
      else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
    }
    expire()
    const configured = getChatMediaDir()
    if (!path.isAbsolute(configured) || /^[\\/]{2}/.test(configured)) return invalid()
    root = path.resolve(configured)
    directories.set(root, await directoryState(root, checkCurrent))
    checkCurrent()
    let sourceMime: FigPluginAssetMime
    if (source.url.startsWith('data:')) {
      const decoded = decodeDataUrl(source.url, maxBytes)
      bytes = decoded.bytes
      sourceMime = decoded.mimeType
    } else {
      publicHttps(source.url)
      checkCurrent()
      const downloaded = await safeRemoteDownload(source.url, {
        allowedContentTypes: MIME_TYPES,
        maxBytes,
        maxRedirects: 3,
        timeoutMs: Math.min(30_000, deadlineAt - Date.now()),
        signal: controller.signal,
        errorLabel: 'generated image'
      })
      bytes = downloaded.buffer
      checkCurrent()
      sourceMime = mime(downloaded.contentType)
      publicHttps(downloaded.finalUrl.toString())
    }
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maxBytes) return invalid()
    if (source.mimeType && source.mimeType !== sourceMime) return invalid()
    checkCurrent()
    await assertDirectories()
    checkCurrent()
    const sha256 = hash(bytes)
    let inspected: ReturnType<typeof inspectSessionAssetImage>
    try {
      inspected = inspectSessionAssetImage(bytes)
      if (inspected.mimeType !== sourceMime) return invalid()
      const decoded = nativeImage.createFromBuffer(bytes)
      const size = decoded.getSize()
      if (decoded.isEmpty() || size.width !== inspected.width || size.height !== inspected.height)
        return invalid()
    } catch {
      return invalid()
    }
    checkCurrent()
    if (hash(bytes) !== sha256) return invalid()

    const parent = path.join(root, 'user-output')
    await assertDirectories()
    try {
      await fs.mkdir(parent, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    checkCurrent()
    directories.set(parent, await directoryState(parent, checkCurrent))
    scope = path.join(parent, `figplugin-${runId}`)
    await createOwnedDirectory(scope)
    const extension = sourceMime === 'image/jpeg' ? 'jpg' : sourceMime.slice(6)
    const originalPath = path.join(scope, 'originals', sha256.slice(0, 2), `${sha256}.${extension}`)
    const metadataPath = path.join(scope, 'metadata', `${sha256}.json`)
    files.set(originalPath, { maxBytes: bytes.length })
    files.set(metadataPath, { maxBytes: 64 * 1024 })
    for (const directory of [
      path.join(scope, '.staging'),
      path.join(scope, 'metadata'),
      path.join(scope, 'originals'),
      path.dirname(originalPath)
    ])
      await createOwnedDirectory(directory)
    const ownedBytes = bytes
    const imported = await importManagedMediaStream(
      {
        chatMediaRoot: scope,
        stream: (async function* () {
          for (let offset = 0; offset < ownedBytes.length; offset += 64 * 1024) {
            checkCurrent()
            yield ownedBytes.subarray(offset, offset + 64 * 1024)
          }
        })(),
        mimeType: sourceMime,
        originalFileName: `generated.${extension}`,
        provenance: { source: 'figplugin-provider-image', runId },
        maxBytes,
        signal: controller.signal
      },
      { authorizedRoot: root }
    )
    checkCurrent()
    await assertDirectories()
    const reference = figPluginManagedAssetReferenceSchema.parse(imported.reference)
    if (
      reference.relativePath !== path.relative(root, originalPath).split(path.sep).join('/') ||
      reference.sha256 !== sha256 ||
      reference.sizeBytes !== bytes.length ||
      reference.mimeType !== sourceMime ||
      reference.originalFileName !== `generated.${extension}` ||
      !samePath(imported.absolutePath, originalPath) ||
      !samePath(imported.metadataPath, metadataPath)
    )
      return invalid()
    for (const [filename, owned] of files) {
      owned.state = await fileState(filename, owned.maxBytes)
      checkCurrent()
    }
    const resolved = await resolveManagedMediaReference(root, reference, { authorizedRoot: root })
    checkCurrent()
    verifiedBytes = await readManagedMediaBytes(resolved.storeRoot ?? scope, resolved.metadata, {
      authorizedRoot: root,
      maxBytes
    })
    checkCurrent()
    if (verifiedBytes.length !== bytes.length || hash(verifiedBytes) !== sha256) return invalid()
    await assertDirectories()
    for (const [filename, owned] of files) {
      if (!sameFile(owned.state!, await fileState(filename, owned.maxBytes))) return invalid()
      checkCurrent()
    }
    const fileUrl = pathToFileURL(originalPath).toString()
    checkCurrent()
    return {
      reference,
      localMediaUrl: `local-media://${fileUrl.slice('file://'.length)}`,
      width: inspected.width,
      height: inspected.height,
      discard
    }
  } catch (error) {
    await discard().catch(() => undefined)
    if (error instanceof FigPluginBridgeError || error instanceof FigPluginManagementError)
      throw error
    if (signal.aborted) throw new FigPluginBridgeError('CANCELLED')
    if (
      Date.now() >= deadlineAt ||
      controller.signal.aborted ||
      (error as Error)?.name === 'TimeoutError'
    )
      throw new FigPluginBridgeError('TIMEOUT')
    throw new FigPluginBridgeError('UPSTREAM_FAILED')
  } finally {
    bytes?.fill(0)
    verifiedBytes?.fill(0)
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', forwardAbort)
  }
}
