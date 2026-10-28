import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { nativeImage } from 'electron'
import { FIGPLUGIN_ASSET_MAX_BYTES, type FigPluginAssetMime } from '@shared/figplugin/hostAssets'
import { FigPluginBridgeError } from '@shared/figplugin/bridge'
import { FigPluginManagementError } from '@shared/figplugin/management'
import {
  figPluginManagedAssetReferenceSchema,
  type FigPluginManagedAssetReference
} from '@shared/figplugin/managedSessionAsset'
import {
  importManagedMediaFile,
  readManagedMediaBytes,
  resolveManagedMediaReference
} from '../llmProxy/managedMediaStore'
import { getChatMediaDir } from '../llmProxy/chatMediaDir'
import { inspectSessionAssetImage } from './sessionAssetImage'

export type MaterializedSessionAsset = {
  mimeType: FigPluginAssetMime
  width: number
  height: number
  sha256: string
  bytes: Uint8Array
}

type MaterializationOptions = {
  check: () => void
  signal: AbortSignal
  maxBytes: number
}

export type SessionAssetMaterializer = (
  selectedPath: string,
  options: MaterializationOptions
) => Promise<MaterializedSessionAsset>

export type ManagedSessionAssetMaterializer = (
  reference: FigPluginManagedAssetReference,
  options: MaterializationOptions
) => Promise<MaterializedSessionAsset>

const sameFilesystemPath = (left: string, right: string): boolean => {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Read an explicitly selected original without granting its path or durable ownership. */
export const materializeManagedSessionAsset: ManagedSessionAssetMaterializer = async (
  input,
  { check, signal, maxBytes: requestedMaxBytes }
) => {
  let retained: Buffer | undefined
  const checkSelection = () => {
    check()
    if (signal.aborted) throw new FigPluginBridgeError('CANCELLED')
  }
  try {
    checkSelection()
    if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 1)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const maxBytes = Math.min(FIGPLUGIN_ASSET_MAX_BYTES, requestedMaxBytes)
    const reference = figPluginManagedAssetReferenceSchema.parse(input)
    // Resolution verifies the original by streaming it. Reject excessive selected
    // metadata before even that read, not only before the later buffer allocation.
    if (reference.sizeBytes > maxBytes) throw new FigPluginBridgeError('INVALID_REQUEST')
    const configuredRoot = getChatMediaDir()
    if (!path.isAbsolute(configuredRoot)) throw new FigPluginBridgeError('INVALID_REQUEST')
    const root = path.resolve(configuredRoot)
    const checkCurrent = () => {
      checkSelection()
      if (!sameFilesystemPath(getChatMediaDir(), root))
        throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    const [rootStat, canonicalRoot] = await Promise.all([fs.lstat(root), fs.realpath(root)])
    checkCurrent()
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      !sameFilesystemPath(canonicalRoot, root)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')

    const resolved = await resolveManagedMediaReference(root, reference, { authorizedRoot: root })
    checkCurrent()
    const bytes = await readManagedMediaBytes(resolved.storeRoot ?? root, resolved.metadata, {
      authorizedRoot: root,
      maxBytes
    })
    retained = bytes
    checkCurrent()
    const [currentStat, currentRoot] = await Promise.all([fs.lstat(root), fs.realpath(root)])
    checkCurrent()
    if (
      currentStat.isSymbolicLink() ||
      !currentStat.isDirectory() ||
      !sameFilesystemPath(currentRoot, root) ||
      currentStat.dev !== rootStat.dev ||
      currentStat.ino !== rootStat.ino
    )
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    const inspected = inspectSessionAssetImage(bytes)
    if (inspected.mimeType !== reference.mimeType || bytes.byteLength !== reference.sizeBytes)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const decoded = nativeImage.createFromBuffer(bytes)
    const size = decoded.getSize()
    if (decoded.isEmpty() || size.width !== inspected.width || size.height !== inspected.height)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    checkCurrent()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== reference.sha256) throw new FigPluginBridgeError('INVALID_REQUEST')
    return { ...inspected, sha256, bytes }
  } catch (error) {
    retained?.fill(0)
    if (error instanceof FigPluginBridgeError || error instanceof FigPluginManagementError)
      throw error
    throw new FigPluginBridgeError('INVALID_REQUEST')
  }
}

const mimeForExtension = (selectedPath: string): FigPluginAssetMime => {
  switch (path.extname(selectedPath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      throw new FigPluginBridgeError('INVALID_REQUEST')
  }
}

/** A private transient ManagedMedia store, not a retained chat/canvas asset or model upload. */
export const materializeSessionAsset: SessionAssetMaterializer = async (
  selectedPath,
  { check, signal, maxBytes: requestedMaxBytes }
) => {
  let temporaryRoot: string | undefined
  let temporaryParent: string | undefined
  let retained: Buffer | undefined
  const cleanup = async () => {
    if (!temporaryRoot || !temporaryParent) return
    const target = path.resolve(temporaryRoot)
    if (
      target !== temporaryRoot ||
      path.dirname(target) !== temporaryParent ||
      !path.basename(target).startsWith('figplugin-session-image-')
    ) {
      retained?.fill(0)
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
    // Only this operation's freshly created absolute directory is recursively removed.
    try {
      await fs.rm(target, { recursive: true, force: true })
    } catch {
      retained?.fill(0)
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
    try {
      check()
    } catch (error) {
      retained?.fill(0)
      if (error instanceof FigPluginBridgeError || error instanceof FigPluginManagementError)
        throw error
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
  }
  try {
    check()
    if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 1)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const maxBytes = Math.min(FIGPLUGIN_ASSET_MAX_BYTES, requestedMaxBytes)
    if (
      typeof selectedPath !== 'string' ||
      !path.isAbsolute(selectedPath) ||
      selectedPath.length > 4096 ||
      selectedPath.includes('\0') ||
      /^[\\/]{2}/.test(selectedPath) ||
      (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(selectedPath))
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const mimeType = mimeForExtension(selectedPath)
    temporaryParent = await fs.realpath(os.tmpdir())
    check()
    temporaryRoot = await fs.mkdtemp(path.join(temporaryParent, 'figplugin-session-image-'))
    check()
    // Reuse the existing bounded, canonical-source import and integrity-checked read path.
    // This store is never registered with the local-media protocol and is removed below.
    const imported = await importManagedMediaFile(
      {
        chatMediaRoot: temporaryRoot,
        sourcePath: selectedPath,
        mimeType,
        originalFileName: `selected.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)}`,
        provenance: { source: 'figplugin-session-local-preview' },
        maxBytes,
        signal
      },
      { authorizedRoot: temporaryRoot }
    )
    check()
    const resolved = await resolveManagedMediaReference(temporaryRoot, imported.reference, {
      authorizedRoot: temporaryRoot
    })
    check()
    const bytes = await readManagedMediaBytes(temporaryRoot, resolved.metadata, {
      authorizedRoot: temporaryRoot,
      maxBytes
    })
    retained = bytes
    check()
    // Structural dimensions and animation limits must be checked before invoking a decoder.
    const inspected = inspectSessionAssetImage(bytes)
    if (inspected.mimeType !== mimeType) throw new FigPluginBridgeError('INVALID_REQUEST')
    const decoded = nativeImage.createFromBuffer(bytes)
    const size = decoded.getSize()
    if (decoded.isEmpty() || size.width !== inspected.width || size.height !== inspected.height)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    check()
    return { ...inspected, sha256: createHash('sha256').update(bytes).digest('hex'), bytes }
  } catch (error) {
    retained?.fill(0)
    if (error instanceof FigPluginBridgeError || error instanceof FigPluginManagementError)
      throw error
    // Source paths and decoder/store errors must never cross renderer IPC.
    throw new FigPluginBridgeError('INVALID_REQUEST')
  } finally {
    await cleanup()
  }
}
