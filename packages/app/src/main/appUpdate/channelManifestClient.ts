import { createHash, randomUUID, type KeyLike } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  parseChannelManifestV1,
  verifyChannelManifestSignature,
  type ChannelManifestV1,
  type TrustedReleaseSource,
  type UpdateChannel
} from './channelManifestProtocol'

const CACHE_SCHEMA = 1 as const
const HIGH_WATER_SCHEMA = 1 as const
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

export interface ChannelManifestFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface ChannelManifestClock {
  now(): Date
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ChannelManifestClientOptions {
  url: string
  channel: UpdateChannel
  cachePath: string
  highWaterPath?: string
  publicKeys: Readonly<Record<string, KeyLike>>
  trustedSources?: readonly TrustedReleaseSource[]
  fetch?: typeof globalThis.fetch
  fileSystem?: ChannelManifestFileSystem
  clock?: ChannelManifestClock
  timeoutMs?: number
  maxResponseBytes?: number
  uniqueId?: () => string
}

export interface ChannelManifestFetchResult {
  manifest: ChannelManifestV1
  source: 'network' | 'revalidated-cache' | 'network-error-cache'
  etag?: string
  lastModified?: string
  verifiedAt: string
}

interface CacheEnvelope {
  schema: 1
  rawManifest: string
  etag?: string
  lastModified?: string
  verifiedAt: string
}

interface ManifestHighWater {
  schema: 1
  generatedAt: string
  digest: string
  releaseIdentity: string
}

export class ChannelManifestClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ChannelManifestClientError'
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function optionalHeader(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8_192 ||
    /[\r\n]/.test(value)
  )
    throw new ChannelManifestClientError(`Invalid channel manifest cache ${field}`)
  return value
}

function parseHighWater(text: string): ManifestHighWater {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new ChannelManifestClientError('Channel manifest high-water mark is not valid JSON', {
      cause: error
    })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ChannelManifestClientError('Channel manifest high-water mark must be an object')
  const record = value as Record<string, unknown>
  const allowed = new Set(['schema', 'generatedAt', 'digest', 'releaseIdentity'])
  for (const key of Object.keys(record))
    if (!allowed.has(key))
      throw new ChannelManifestClientError(`Unknown channel manifest high-water field ${key}`)
  if (
    record.schema !== HIGH_WATER_SCHEMA ||
    typeof record.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.generatedAt)) ||
    typeof record.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.digest) ||
    typeof record.releaseIdentity !== 'string' ||
    record.releaseIdentity.length === 0
  )
    throw new ChannelManifestClientError('Invalid channel manifest high-water mark')
  return {
    schema: HIGH_WATER_SCHEMA,
    generatedAt: record.generatedAt,
    digest: record.digest,
    releaseIdentity: record.releaseIdentity
  }
}

function parseCacheEnvelope(text: string): CacheEnvelope {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new ChannelManifestClientError('Channel manifest cache is not valid JSON', {
      cause: error
    })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ChannelManifestClientError('Channel manifest cache must be an object')
  const record = value as Record<string, unknown>
  const allowed = new Set(['schema', 'rawManifest', 'etag', 'lastModified', 'verifiedAt'])
  for (const key of Object.keys(record))
    if (!allowed.has(key))
      throw new ChannelManifestClientError(`Unknown channel manifest cache field ${key}`)
  if (record.schema !== CACHE_SCHEMA || typeof record.rawManifest !== 'string')
    throw new ChannelManifestClientError('Invalid channel manifest cache schema')
  if (typeof record.verifiedAt !== 'string' || !Number.isFinite(Date.parse(record.verifiedAt)))
    throw new ChannelManifestClientError('Invalid channel manifest cache verifiedAt')
  return {
    schema: CACHE_SCHEMA,
    rawManifest: record.rawManifest,
    etag: optionalHeader(record.etag, 'etag'),
    lastModified: optionalHeader(record.lastModified, 'lastModified'),
    verifiedAt: record.verifiedAt
  }
}

const systemClock: ChannelManifestClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export class ChannelManifestClient {
  private readonly options: ChannelManifestClientOptions
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly fileSystem: ChannelManifestFileSystem
  private readonly clock: ChannelManifestClock
  private readonly uniqueId: () => string

  constructor(options: ChannelManifestClientOptions) {
    const url = new URL(options.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new TypeError('Channel manifest URL must be HTTPS without credentials or fragment')
    if (!path.isAbsolute(options.cachePath))
      throw new TypeError('Channel manifest cachePath must be absolute')
    if (options.highWaterPath && !path.isAbsolute(options.highWaterPath))
      throw new TypeError('Channel manifest highWaterPath must be absolute')
    if ((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) <= 0)
      throw new TypeError('Channel manifest timeoutMs must be positive')
    if ((options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) <= 0)
      throw new TypeError('Channel manifest maxResponseBytes must be positive')
    this.options = options
    this.fetchImplementation = options.fetch ?? globalThis.fetch
    this.fileSystem = options.fileSystem ?? fs
    this.clock = options.clock ?? systemClock
    this.uniqueId = options.uniqueId ?? randomUUID
  }

  async fetchManifest(): Promise<ChannelManifestFetchResult> {
    let highWater = await this.loadHighWater()
    const loadedCache = await this.loadCache()
    let cached = loadedCache
    if (cached) {
      if (highWater) {
        if (!this.isAtOrAboveHighWater(cached.manifest, cached.envelope.rawManifest, highWater)) {
          cached = undefined
        }
      } else {
        highWater = this.highWaterFor(cached.manifest, cached.envelope.rawManifest)
        await this.saveHighWater(highWater)
      }
    }
    const headers = new Headers({ Accept: 'application/json' })
    if (cached?.envelope.etag) headers.set('If-None-Match', cached.envelope.etag)
    if (cached?.envelope.lastModified)
      headers.set('If-Modified-Since', cached.envelope.lastModified)

    let response: Response
    let rawManifest: string | undefined
    try {
      ;({ response, rawManifest } = await this.requestWithTimeout(headers))
    } catch (error) {
      if (error instanceof ChannelManifestClientError) throw error
      if (cached) return this.result(cached.manifest, cached.envelope, 'network-error-cache')
      throw new ChannelManifestClientError('Failed to fetch channel manifest', { cause: error })
    }

    if (response.status === 304) {
      if (!cached)
        throw new ChannelManifestClientError(
          'Server returned 304 without a verified manifest cache'
        )
      return this.result(cached.manifest, cached.envelope, 'revalidated-cache')
    }
    if (response.status !== 200)
      throw new ChannelManifestClientError(
        `Unexpected channel manifest HTTP status ${response.status}`
      )

    if (rawManifest === undefined)
      throw new ChannelManifestClientError('Channel manifest response has no body')
    const manifest = this.parseAndVerify(rawManifest)
    this.assertAtOrAboveHighWater(manifest, rawManifest, highWater)
    const envelope: CacheEnvelope = {
      schema: CACHE_SCHEMA,
      rawManifest,
      etag: optionalHeader(response.headers.get('etag') ?? undefined, 'etag'),
      lastModified: optionalHeader(
        response.headers.get('last-modified') ?? undefined,
        'lastModified'
      ),
      verifiedAt: this.clock.now().toISOString()
    }
    await this.saveHighWater(this.highWaterFor(manifest, rawManifest))
    await this.saveCache(envelope)
    return this.result(manifest, envelope, 'network')
  }

  private result(
    manifest: ChannelManifestV1,
    envelope: CacheEnvelope,
    source: ChannelManifestFetchResult['source']
  ): ChannelManifestFetchResult {
    return {
      manifest,
      source,
      etag: envelope.etag,
      lastModified: envelope.lastModified,
      verifiedAt: envelope.verifiedAt
    }
  }

  private parseAndVerify(rawManifest: string): ChannelManifestV1 {
    const manifest = parseChannelManifestV1(rawManifest, {
      expectedChannel: this.options.channel,
      trustedSources: this.options.trustedSources
    })
    if (!verifyChannelManifestSignature(manifest, this.options.publicKeys))
      throw new ChannelManifestClientError('Channel manifest Ed25519 signature verification failed')
    return manifest
  }

  private highWaterFor(manifest: ChannelManifestV1, rawManifest: string): ManifestHighWater {
    return {
      schema: HIGH_WATER_SCHEMA,
      generatedAt: manifest.generatedAt,
      digest: createHash('sha256').update(rawManifest, 'utf8').digest('hex'),
      releaseIdentity:
        manifest.releases.map(({ version, buildId }) => `${version}:${buildId}`).join(',') ||
        'empty'
    }
  }

  private isAtOrAboveHighWater(
    manifest: ChannelManifestV1,
    rawManifest: string,
    highWater: ManifestHighWater
  ): boolean {
    const candidate = this.highWaterFor(manifest, rawManifest)
    const order = Date.parse(candidate.generatedAt) - Date.parse(highWater.generatedAt)
    return order > 0 || (order === 0 && candidate.digest === highWater.digest)
  }

  private assertAtOrAboveHighWater(
    manifest: ChannelManifestV1,
    rawManifest: string,
    highWater: ManifestHighWater | undefined
  ): void {
    if (!highWater) return
    const candidate = this.highWaterFor(manifest, rawManifest)
    const order = Date.parse(candidate.generatedAt) - Date.parse(highWater.generatedAt)
    if (order < 0)
      throw new ChannelManifestClientError(
        `Channel manifest rollback rejected: ${candidate.generatedAt} is older than ${highWater.generatedAt}`
      )
    if (order === 0 && candidate.digest !== highWater.digest)
      throw new ChannelManifestClientError(
        'Channel manifest equivocation rejected: identical generatedAt has a different digest'
      )
  }

  private highWaterPath(): string {
    return path.normalize(this.options.highWaterPath ?? `${this.options.cachePath}.high-water`)
  }

  private async loadHighWater(): Promise<ManifestHighWater | undefined> {
    try {
      return parseHighWater(await this.fileSystem.readFile(this.highWaterPath(), 'utf8'))
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined
      if (error instanceof ChannelManifestClientError) throw error
      throw new ChannelManifestClientError('Failed to read channel manifest high-water mark', {
        cause: error
      })
    }
  }

  private async loadCache(): Promise<
    { envelope: CacheEnvelope; manifest: ChannelManifestV1 } | undefined
  > {
    let text: string
    try {
      text = await this.fileSystem.readFile(path.normalize(this.options.cachePath), 'utf8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined
      throw error
    }
    const envelope = parseCacheEnvelope(text)
    return { envelope, manifest: this.parseAndVerify(envelope.rawManifest) }
  }

  private async requestWithTimeout(
    headers: Headers
  ): Promise<{ response: Response; rawManifest?: string }> {
    const controller = new AbortController()
    const timeout = this.clock.setTimeout(
      () => controller.abort(new Error('Channel manifest request timed out')),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )
    try {
      const response = await this.fetchImplementation(this.options.url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error'
      })
      return {
        response,
        rawManifest: response.status === 200 ? await this.readLimitedBody(response) : undefined
      }
    } finally {
      this.clock.clearTimeout(timeout)
    }
  }

  private async readLimitedBody(response: Response): Promise<string> {
    const limit = this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit))
      throw new ChannelManifestClientError('Channel manifest response exceeds size limit')
    if (!response.body)
      throw new ChannelManifestClientError('Channel manifest response has no body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limit) {
          await reader.cancel()
          throw new ChannelManifestClientError('Channel manifest response exceeds size limit')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  private saveHighWater(highWater: ManifestHighWater): Promise<void> {
    return this.atomicWrite(this.highWaterPath(), JSON.stringify(highWater))
  }

  private saveCache(envelope: CacheEnvelope): Promise<void> {
    return this.atomicWrite(path.normalize(this.options.cachePath), JSON.stringify(envelope))
  }

  private async atomicWrite(targetPath: string, contents: string): Promise<void> {
    const temporaryPath = `${targetPath}.${this.uniqueId()}.tmp`
    await this.fileSystem.mkdir(path.dirname(targetPath), { recursive: true })
    try {
      await this.fileSystem.writeFile(temporaryPath, contents, 'utf8')
      await this.fileSystem.rename(temporaryPath, targetPath)
    } finally {
      try {
        await this.fileSystem.unlink(temporaryPath)
      } catch {
        // Cleanup must not hide the atomic write result.
      }
    }
  }
}

export function createChannelManifestClient(
  options: ChannelManifestClientOptions
): ChannelManifestClient {
  return new ChannelManifestClient(options)
}
