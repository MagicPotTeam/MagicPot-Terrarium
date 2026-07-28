import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  ArtifactVerificationError,
  type ArtifactExpectation,
  type VerifiedArtifact,
  verifyLocalArtifact
} from './artifactVerifier'

export interface ArtifactFileHandle {
  write(data: Uint8Array): Promise<unknown>
  close(): Promise<void>
}

export interface ArtifactDownloadFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  lstat(path: string): Promise<unknown>
  open(path: string, flags: 'wx'): Promise<ArtifactFileHandle>
  link(existingPath: string, newPath: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface ArtifactDownloadDependencies {
  fetch?: typeof fetch
  fileSystem?: ArtifactDownloadFileSystem
  verifyArtifact?: (path: string, expected: ArtifactExpectation) => Promise<VerifiedArtifact>
  uniqueId?: () => string
}

export interface DownloadArtifactOptions {
  url: string
  destinationPath: string
  expected: ArtifactExpectation
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
}

export class ArtifactDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ArtifactDownloadError'
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function validateOptions(options: DownloadArtifactOptions): URL {
  const url = new URL(options.url)
  if (url.protocol !== 'https:') throw new TypeError('Artifact URL must use HTTPS')
  if (!Number.isSafeInteger(options.expected.size) || options.expected.size < 0)
    throw new TypeError('Artifact size must be a non-negative safe integer')
  if (!/^[0-9a-f]{64}$/.test(options.expected.sha256))
    throw new TypeError('Artifact SHA-256 must be 64 lowercase hexadecimal characters')
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new TypeError('Maximum artifact size must be a non-negative safe integer')
  if (options.expected.size > options.maxBytes)
    throw new ArtifactDownloadError('Expected artifact size exceeds the configured maximum')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new TypeError('Artifact download timeout must be a positive safe integer')
  return url
}

async function pathExists(
  fileSystem: ArtifactDownloadFileSystem,
  filePath: string
): Promise<boolean> {
  try {
    await fileSystem.lstat(filePath)
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

export async function downloadArtifact(
  options: DownloadArtifactOptions,
  dependencies: ArtifactDownloadDependencies = {}
): Promise<VerifiedArtifact> {
  const requestedUrl = validateOptions(options)
  const fetchImpl = dependencies.fetch ?? fetch
  const fileSystem = dependencies.fileSystem ?? fs
  const verifier = dependencies.verifyArtifact ?? verifyLocalArtifact
  const makeUniqueId = dependencies.uniqueId ?? randomUUID

  await fileSystem.mkdir(path.dirname(options.destinationPath), { recursive: true })
  if (await pathExists(fileSystem, options.destinationPath)) {
    try {
      return await verifier(options.destinationPath, options.expected)
    } catch (error) {
      const quarantinePath = `${options.destinationPath}.${makeUniqueId()}.quarantine`
      try {
        await fileSystem.rename(options.destinationPath, quarantinePath)
      } catch (quarantineError) {
        if (!(await pathExists(fileSystem, options.destinationPath))) {
          // Another process already moved the invalid artifact; continue with a fresh download.
        } else {
          throw new ArtifactDownloadError('Failed to quarantine invalid existing artifact', {
            cause: quarantineError
          })
        }
      }
    }
  }

  const tempPath = `${options.destinationPath}.${makeUniqueId()}.tmp`
  const controller = new AbortController()
  const abortFromCaller = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (options.signal?.aborted) abortFromCaller()
  const timeout = setTimeout(
    () => controller.abort(new Error('Artifact download timed out')),
    options.timeoutMs
  )

  let handle: ArtifactFileHandle | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let tempCreated = false
  try {
    handle = await fileSystem.open(tempPath, 'wx')
    tempCreated = true

    const response = await fetchImpl(requestedUrl, { signal: controller.signal })
    if (!response.ok)
      throw new ArtifactDownloadError(`Artifact request failed with HTTP ${response.status}`)
    if (response.url && new URL(response.url).protocol !== 'https:')
      throw new ArtifactDownloadError('Artifact response redirected to a non-HTTPS URL')

    const contentLengthValue = response.headers.get('content-length')
    if (contentLengthValue !== null) {
      if (!/^\d+$/.test(contentLengthValue))
        throw new ArtifactDownloadError('Artifact Content-Length is invalid')
      const contentLength = Number(contentLengthValue)
      if (!Number.isSafeInteger(contentLength) || contentLength !== options.expected.size)
        throw new ArtifactDownloadError(
          `Artifact Content-Length mismatch: expected ${options.expected.size}, received ${contentLengthValue}`
        )
      if (contentLength > options.maxBytes)
        throw new ArtifactDownloadError('Artifact Content-Length exceeds the configured maximum')
    }
    if (!response.body) throw new ArtifactDownloadError('Artifact response has no body')

    const hash = createHash('sha256')
    let received = 0
    reader = response.body.getReader()
    while (true) {
      const result = await reader.read()
      if (result.done) break
      received += result.value.byteLength
      if (received > options.maxBytes)
        throw new ArtifactDownloadError('Artifact download exceeds the configured maximum')
      if (received > options.expected.size)
        throw new ArtifactDownloadError('Artifact download exceeds the expected size')
      hash.update(result.value)
      await handle.write(result.value)
    }
    await handle.close()
    handle = undefined

    if (received !== options.expected.size)
      throw new ArtifactDownloadError(
        `Artifact size mismatch: expected ${options.expected.size}, received ${received}`
      )
    const sha256 = hash.digest('hex')
    if (sha256 !== options.expected.sha256)
      throw new ArtifactDownloadError('Artifact SHA-256 mismatch')

    try {
      // A hard link is an atomic no-replace publish on every supported platform.
      await fileSystem.link(tempPath, options.destinationPath)
      await fileSystem.unlink(tempPath)
      tempCreated = false
      return { path: options.destinationPath, size: received, sha256 }
    } catch (publishError) {
      if (!(await pathExists(fileSystem, options.destinationPath))) throw publishError
      try {
        const existing = await verifier(options.destinationPath, options.expected)
        await fileSystem.unlink(tempPath)
        tempCreated = false
        return existing
      } catch (error) {
        if (error instanceof ArtifactVerificationError)
          throw new ArtifactDownloadError(
            'Existing artifact conflicts with the requested artifact',
            {
              cause: error
            }
          )
        throw error
      }
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new ArtifactDownloadError('Artifact download was aborted or timed out', {
        cause: error
      })
    if (error instanceof ArtifactDownloadError) throw error
    throw new ArtifactDownloadError('Artifact download failed', { cause: error })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
    if (reader) await reader.cancel().catch(() => undefined)
    if (handle) await handle.close().catch(() => undefined)
    if (tempCreated) await fileSystem.unlink(tempPath).catch(() => undefined)
  }
}
