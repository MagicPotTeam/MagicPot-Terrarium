import { spawn as nodeSpawn } from 'node:child_process'
import { access as nodeAccess } from 'node:fs/promises'
import * as path from 'node:path'

export const CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV = 'MAGICPOT_CANVAS_THUMBNAIL_SIDECAR'
export const CANVAS_THUMBNAIL_SIDECAR_PATH_ENV = 'MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH'
export const CANVAS_THUMBNAIL_SIDECAR_TIMEOUT_ENV = 'MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_TIMEOUT_MS'

const SIDECAR_PACKAGED_BINARY_BASENAME = 'magicpot-image-worker'
const SIDECAR_CARGO_BINARY_BASENAME = 'canvas-thumbnail-sidecar'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

export type CanvasThumbnailSidecarFailureReason =
  | 'feature-disabled'
  | 'binary-not-found'
  | 'request-serialization-failed'
  | 'spawn-error'
  | 'stdin-error'
  | 'timeout'
  | 'stdout-too-large'
  | 'sidecar-exit-failed'
  | 'invalid-json'

export type CanvasThumbnailSidecarSuccess<TResponse> = {
  ok: true
  response: TResponse
  binaryPath: string
  args: string[]
  stderr: string
  stderrTruncated: boolean
}

export type CanvasThumbnailSidecarFallback = {
  ok: false
  fallback: true
  reason: CanvasThumbnailSidecarFailureReason
  message: string
  binaryPath?: string
  args?: string[]
  candidates?: string[]
  stderr?: string
  stderrTruncated?: boolean
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
}

export type CanvasThumbnailSidecarResult<TResponse> =
  | CanvasThumbnailSidecarSuccess<TResponse>
  | CanvasThumbnailSidecarFallback

export type CanvasThumbnailSidecarProcess = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  resourcesPath?: string
  execPath?: string
  cwd(): string
}

export type CanvasThumbnailSidecarAccess = (candidatePath: string) => Promise<void>

type EventCallback = (...args: unknown[]) => void

type EventSourceLike = {
  on(event: string, listener: EventCallback): unknown
}

export type CanvasThumbnailSidecarWritable = {
  write(chunk: string): unknown
  end(): unknown
  destroy?(error?: Error): unknown
}

export type CanvasThumbnailSidecarChild = EventSourceLike & {
  stdin?: CanvasThumbnailSidecarWritable | null
  stdout?: EventSourceLike | null
  stderr?: EventSourceLike | null
  kill?(signal?: NodeJS.Signals | string): boolean
}

export type CanvasThumbnailSidecarSpawnOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide: boolean
  shell: false
}

export type CanvasThumbnailSidecarSpawn = (
  file: string,
  args: string[],
  options: CanvasThumbnailSidecarSpawnOptions
) => CanvasThumbnailSidecarChild

export type CanvasThumbnailSidecarResolveOptions = {
  process?: CanvasThumbnailSidecarProcess
  access?: CanvasThumbnailSidecarAccess
  binaryPath?: string
}

export type CanvasThumbnailSidecarRunOptions = CanvasThumbnailSidecarResolveOptions & {
  spawn?: CanvasThumbnailSidecarSpawn
  args?: string[]
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export type CanvasThumbnailSidecarThumbnailFormat = 'png' | 'jpg' | 'jpeg' | 'webp'
export type CanvasThumbnailSidecarHashAlgorithm = 'blake3' | 'sha256'

export type CanvasThumbnailSidecarThumbnailOptions = {
  levels?: number[]
  maxSide?: number
  maxWidth?: number
  maxHeight?: number
  allowUpscale?: boolean
  format?: CanvasThumbnailSidecarThumbnailFormat
}

export type CanvasThumbnailSidecarBatchItem = {
  id: string
  path: string
}

export type CanvasThumbnailSidecarBatchThumbnailRequest = {
  cacheRoot: string
  items: CanvasThumbnailSidecarBatchItem[]
  thumbnail?: CanvasThumbnailSidecarThumbnailOptions
  maxConcurrency?: number
  maxDecodedPixels?: number
  hash?: CanvasThumbnailSidecarHashAlgorithm
}

export type CanvasThumbnailSidecarBatchJsonRequest = CanvasThumbnailSidecarBatchThumbnailRequest

export type CanvasThumbnailSidecarItemError = {
  code: string
  message: string
}

export type CanvasThumbnailSidecarSourceIdentity = {
  kind: 'local-file'
  canonicalPath: string
  sizeBytes: number
  lastModifiedMs: number
  cacheKey: string
  cacheRootDir: string
}

export type CanvasThumbnailSidecarSourceMetadata = {
  path: string
  canonicalPath?: string
  byteLength: number
  sizeBytes?: number
  lastModifiedMs?: number
  width: number
  height: number
  colorType: string
  format: string
}

export type CanvasThumbnailSidecarFileHash = {
  algorithm: CanvasThumbnailSidecarHashAlgorithm
  hex: string
}

export type CanvasThumbnailSidecarThumbnailLevelMetadata = {
  maxSide: number
  width: number
  height: number
  filename: string
  path: string
  src: string
  mimeType: string
  sizeBytes: number
}

export type CanvasThumbnailSidecarThumbnailMetadata = {
  maxSide?: number
  path: string
  width: number
  height: number
  filename?: string
  mimeType?: string
  sizeBytes?: number
  format: CanvasThumbnailSidecarThumbnailFormat
}

export type CanvasThumbnailSidecarThumbnailManifest = {
  schemaVersion: number
  version?: number
  id: string
  cacheKey?: string
  canonicalPath?: string
  sourceSizeBytes?: number
  sourceLastModifiedMs?: number
  sourceWidth?: number
  sourceHeight?: number
  sourceIdentity?: CanvasThumbnailSidecarSourceIdentity
  source: CanvasThumbnailSidecarSourceMetadata
  hash: CanvasThumbnailSidecarFileHash
  levels?: CanvasThumbnailSidecarThumbnailLevelMetadata[]
  thumbnail: CanvasThumbnailSidecarThumbnailMetadata
  manifestPath: string
  createdAt?: string
  updatedAt?: string
}

export type CanvasThumbnailSidecarBatchItemResult = {
  id: string
  ok: boolean
  manifest?: CanvasThumbnailSidecarThumbnailManifest
  error?: CanvasThumbnailSidecarItemError
}

export type CanvasThumbnailSidecarBatchThumbnailResponse = {
  ok: boolean
  cacheRoot: string
  results: CanvasThumbnailSidecarBatchItemResult[]
}

/**
 * @deprecated The Rust image worker does not implement the old create-thumbnail op.
 * Use generateCanvasThumbnailsViaSidecar with the batch JSON protocol instead.
 */
export type CanvasThumbnailSidecarCreateThumbnailRequest = {
  fullPath: string
  maxSide: number
}

/**
 * @deprecated The Rust image worker does not implement the old create-thumbnail op.
 * Use CanvasThumbnailSidecarBatchJsonRequest instead.
 */
export type CanvasThumbnailSidecarCreateThumbnailJsonRequest = {
  op: 'create-thumbnail'
  fullPath: string
  maxSide: number
}

/**
 * @deprecated The Rust image worker writes thumbnail files/manifests instead of returning base64 data.
 * Use CanvasThumbnailSidecarBatchThumbnailResponse instead.
 */
export type CanvasThumbnailSidecarCreateThumbnailResponse = {
  dataBase64: string
  width: number
  height: number
  mimeType: 'image/png' | 'image/webp'
}

type CaptureBuffer = {
  text: string
  bytes: number
  maxBytes: number
  truncated: boolean
}

function getDefaultProcess(): CanvasThumbnailSidecarProcess {
  return process as unknown as CanvasThumbnailSidecarProcess
}

function getDefaultSpawn(): CanvasThumbnailSidecarSpawn {
  return nodeSpawn as unknown as CanvasThumbnailSidecarSpawn
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function createCaptureBuffer(maxBytes: number): CaptureBuffer {
  return {
    text: '',
    bytes: 0,
    maxBytes,
    truncated: false
  }
}

function appendCapturedChunk(capture: CaptureBuffer, chunk: unknown): boolean {
  const chunkBuffer = Buffer.isBuffer(chunk)
    ? chunk
    : chunk instanceof Uint8Array
      ? Buffer.from(chunk)
      : Buffer.from(String(chunk ?? ''), 'utf8')
  const remainingBytes = capture.maxBytes - capture.bytes
  if (remainingBytes <= 0) {
    capture.truncated = true
    return false
  }

  const chunkToAppend =
    chunkBuffer.byteLength > remainingBytes ? chunkBuffer.subarray(0, remainingBytes) : chunkBuffer
  capture.text += chunkToAppend.toString('utf8')
  capture.bytes += chunkToAppend.byteLength
  if (chunkToAppend.byteLength < chunkBuffer.byteLength) {
    capture.truncated = true
    return false
  }

  return true
}

function createFallback(
  reason: CanvasThumbnailSidecarFailureReason,
  message: string,
  details: Omit<CanvasThumbnailSidecarFallback, 'ok' | 'fallback' | 'reason' | 'message'> = {}
): CanvasThumbnailSidecarFallback {
  return {
    ok: false,
    fallback: true,
    reason,
    message,
    ...details
  }
}

function parseTimeoutMs(timeoutMs: number | undefined, env: NodeJS.ProcessEnv): number {
  const rawTimeoutMs = timeoutMs ?? Number(env[CANVAS_THUMBNAIL_SIDECAR_TIMEOUT_ENV])
  if (Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0) {
    return Math.min(Math.floor(rawTimeoutMs), MAX_TIMEOUT_MS)
  }

  return DEFAULT_TIMEOUT_MS
}

export function isCanvasThumbnailSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

export function getCanvasThumbnailSidecarBinaryName(
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32'
    ? `${SIDECAR_PACKAGED_BINARY_BASENAME}.exe`
    : SIDECAR_PACKAGED_BINARY_BASENAME
}

function getCanvasThumbnailSidecarCargoBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `${SIDECAR_CARGO_BINARY_BASENAME}.exe`
    : SIDECAR_CARGO_BINARY_BASENAME
}

export function normalizeCanvasThumbnailSidecarBinaryPath(
  rawPath: string | undefined
): string | null {
  const trimmed = rawPath?.trim()
  if (!trimmed) {
    return null
  }

  const firstChar = trimmed[0]
  const lastChar = trimmed[trimmed.length - 1]
  if ((firstChar === '"' || firstChar === "'") && firstChar === lastChar) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

export function getCanvasThumbnailSidecarCandidatePaths(
  sidecarProcess: CanvasThumbnailSidecarProcess = getDefaultProcess(),
  explicitBinaryPath?: string
): string[] {
  const binaryName = getCanvasThumbnailSidecarBinaryName(sidecarProcess.platform)
  const cargoBinaryName = getCanvasThumbnailSidecarCargoBinaryName(sidecarProcess.platform)
  const copiedOrQuotedPath = normalizeCanvasThumbnailSidecarBinaryPath(explicitBinaryPath)
  const envPath = normalizeCanvasThumbnailSidecarBinaryPath(
    sidecarProcess.env[CANVAS_THUMBNAIL_SIDECAR_PATH_ENV]
  )
  const executableDir = sidecarProcess.execPath ? path.dirname(sidecarProcess.execPath) : undefined
  const resourcesPath = sidecarProcess.resourcesPath
  const cwd = sidecarProcess.cwd()

  // Do not add shell quotes here. spawn(file, args) receives the executable path as a
  // dedicated value, so Windows paths with spaces must remain unquoted.
  return Array.from(
    new Set(
      [
        copiedOrQuotedPath,
        envPath,
        resourcesPath
          ? path.join(
              resourcesPath,
              'bin',
              'image-worker',
              `${sidecarProcess.platform}-${sidecarProcess.arch}`,
              binaryName
            )
          : undefined,
        executableDir
          ? path.join(
              executableDir,
              'resources',
              'bin',
              'image-worker',
              `${sidecarProcess.platform}-${sidecarProcess.arch}`,
              binaryName
            )
          : undefined,
        path.join(
          cwd,
          'packages',
          'runtime-assets',
          'resources',
          'bin',
          'image-worker',
          `${sidecarProcess.platform}-${sidecarProcess.arch}`,
          binaryName
        ),
        path.join(
          cwd,
          'bin',
          'image-worker',
          `${sidecarProcess.platform}-${sidecarProcess.arch}`,
          binaryName
        ),
        path.join(
          cwd,
          '.cache',
          'cargo-target',
          'canvas-thumbnail-sidecar',
          'release',
          cargoBinaryName
        )
      ].filter((candidate): candidate is string => Boolean(candidate))
    )
  )
}

export async function resolveCanvasThumbnailSidecarBinary(
  options: CanvasThumbnailSidecarResolveOptions = {}
): Promise<
  { ok: true; binaryPath: string; candidates: string[] } | { ok: false; candidates: string[] }
> {
  const sidecarProcess = options.process ?? getDefaultProcess()
  const access = options.access ?? nodeAccess
  const candidates = getCanvasThumbnailSidecarCandidatePaths(sidecarProcess, options.binaryPath)

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return { ok: true, binaryPath: candidate, candidates }
    } catch {
      // Try the next candidate. The caller receives all candidates for diagnostics.
    }
  }

  return { ok: false, candidates }
}

export async function runCanvasThumbnailSidecarJson<TResponse = unknown>(
  request: unknown,
  options: CanvasThumbnailSidecarRunOptions = {}
): Promise<CanvasThumbnailSidecarResult<TResponse>> {
  const sidecarProcess = options.process ?? getDefaultProcess()
  if (!isCanvasThumbnailSidecarEnabled(sidecarProcess.env)) {
    return createFallback('feature-disabled', 'Canvas thumbnail sidecar feature flag is disabled.')
  }

  let requestJson: string
  try {
    requestJson = `${JSON.stringify(request)}\n`
  } catch (error) {
    return createFallback(
      'request-serialization-failed',
      `Failed to serialize canvas thumbnail sidecar request: ${getErrorMessage(error)}`
    )
  }

  const binaryResolution = await resolveCanvasThumbnailSidecarBinary(options)
  if (!binaryResolution.ok) {
    return createFallback('binary-not-found', 'Canvas thumbnail sidecar binary was not found.', {
      candidates: binaryResolution.candidates
    })
  }

  const binaryPath = binaryResolution.binaryPath
  const args = [...(options.args ?? [])]
  const timeoutMs = parseTimeoutMs(options.timeoutMs, sidecarProcess.env)
  const stdout = createCaptureBuffer(options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES)
  const stderr = createCaptureBuffer(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES)
  const spawn = options.spawn ?? getDefaultSpawn()

  let child: CanvasThumbnailSidecarChild
  try {
    child = spawn(binaryPath, args, {
      cwd: options.cwd ?? sidecarProcess.cwd(),
      env: options.env ?? sidecarProcess.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    })
  } catch (error) {
    return createFallback(
      'spawn-error',
      `Failed to spawn canvas thumbnail sidecar: ${getErrorMessage(error)}`,
      {
        binaryPath,
        args,
        stderr: stderr.text,
        stderrTruncated: stderr.truncated
      }
    )
  }

  return new Promise((resolve) => {
    let settled = false

    const settle = (result: CanvasThumbnailSidecarResult<TResponse>): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const timeout = setTimeout(() => {
      child.kill?.('SIGKILL')
      settle(
        createFallback('timeout', `Canvas thumbnail sidecar timed out after ${timeoutMs}ms.`, {
          binaryPath,
          args,
          stderr: stderr.text,
          stderrTruncated: stderr.truncated,
          timedOut: true
        })
      )
    }, timeoutMs)

    child.stdout?.on('data', (...eventArgs) => {
      const appended = appendCapturedChunk(stdout, eventArgs[0])
      if (!appended) {
        child.kill?.('SIGKILL')
        settle(
          createFallback(
            'stdout-too-large',
            'Canvas thumbnail sidecar stdout exceeded the limit.',
            {
              binaryPath,
              args,
              stderr: stderr.text,
              stderrTruncated: stderr.truncated
            }
          )
        )
      }
    })

    child.stderr?.on('data', (...args) => {
      appendCapturedChunk(stderr, args[0])
    })

    child.on('error', (...eventArgs) => {
      settle(
        createFallback(
          'spawn-error',
          `Canvas thumbnail sidecar failed: ${getErrorMessage(eventArgs[0])}`,
          {
            binaryPath,
            args,
            stderr: stderr.text,
            stderrTruncated: stderr.truncated
          }
        )
      )
    })

    child.on('close', (...eventArgs) => {
      const exitCode = typeof eventArgs[0] === 'number' ? eventArgs[0] : null
      const signal = typeof eventArgs[1] === 'string' ? eventArgs[1] : null
      if (exitCode !== 0 || signal) {
        settle(
          createFallback('sidecar-exit-failed', 'Canvas thumbnail sidecar exited unsuccessfully.', {
            binaryPath,
            args,
            stderr: stderr.text,
            stderrTruncated: stderr.truncated,
            exitCode,
            signal
          })
        )
        return
      }

      try {
        const response = JSON.parse(stdout.text.trim()) as TResponse
        settle({
          ok: true,
          response,
          binaryPath,
          args,
          stderr: stderr.text,
          stderrTruncated: stderr.truncated
        })
      } catch (error) {
        settle(
          createFallback(
            'invalid-json',
            `Canvas thumbnail sidecar returned invalid JSON: ${getErrorMessage(error)}`,
            {
              binaryPath,
              args,
              stderr: stderr.text,
              stderrTruncated: stderr.truncated
            }
          )
        )
      }
    })

    if (!child.stdin) {
      child.kill?.('SIGKILL')
      settle(
        createFallback('stdin-error', 'Canvas thumbnail sidecar stdin was not available.', {
          binaryPath,
          args,
          stderr: stderr.text,
          stderrTruncated: stderr.truncated
        })
      )
      return
    }

    try {
      child.stdin.write(requestJson)
      child.stdin.end()
    } catch (error) {
      child.kill?.('SIGKILL')
      settle(
        createFallback(
          'stdin-error',
          `Failed to write sidecar request: ${getErrorMessage(error)}`,
          {
            binaryPath,
            args,
            stderr: stderr.text,
            stderrTruncated: stderr.truncated
          }
        )
      )
    }
  })
}

function sanitizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }

  return fallback
}

function sanitizeOptionalPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }

  return undefined
}

function sanitizeCanvasThumbnailSidecarFormat(
  format: CanvasThumbnailSidecarThumbnailFormat | undefined
): CanvasThumbnailSidecarThumbnailFormat | undefined {
  if (format === 'png' || format === 'jpg' || format === 'jpeg' || format === 'webp') {
    return format
  }

  return undefined
}

function sanitizeCanvasThumbnailSidecarLevels(levels: number[] | undefined): number[] | undefined {
  if (!Array.isArray(levels)) {
    return undefined
  }

  const normalized = [
    ...new Set(levels.map((level) => sanitizeOptionalPositiveInteger(level)).filter(Boolean))
  ]
    .filter((level): level is number => typeof level === 'number')
    .sort((left, right) => left - right)
  return normalized.length > 0 ? normalized : undefined
}

function sanitizeCanvasThumbnailSidecarThumbnailOptions(
  thumbnail: CanvasThumbnailSidecarThumbnailOptions | undefined
): CanvasThumbnailSidecarThumbnailOptions | undefined {
  if (!thumbnail) {
    return undefined
  }

  const levels = sanitizeCanvasThumbnailSidecarLevels(thumbnail.levels)
  const maxSide = sanitizeOptionalPositiveInteger(thumbnail.maxSide)
  const maxWidth = sanitizeOptionalPositiveInteger(thumbnail.maxWidth)
  const maxHeight = sanitizeOptionalPositiveInteger(thumbnail.maxHeight)
  const format = sanitizeCanvasThumbnailSidecarFormat(thumbnail.format)
  const sanitized = {
    ...(levels ? { levels } : {}),
    ...(maxSide ? { maxSide } : {}),
    ...(maxWidth ? { maxWidth } : {}),
    ...(maxHeight ? { maxHeight } : {}),
    ...(typeof thumbnail.allowUpscale === 'boolean'
      ? { allowUpscale: thumbnail.allowUpscale }
      : {}),
    ...(format ? { format } : {})
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

export function createCanvasThumbnailSidecarBatchRequest(
  request: CanvasThumbnailSidecarBatchThumbnailRequest
): CanvasThumbnailSidecarBatchJsonRequest {
  const thumbnail = sanitizeCanvasThumbnailSidecarThumbnailOptions(request.thumbnail)
  const maxConcurrency = sanitizeOptionalPositiveInteger(request.maxConcurrency)
  const maxDecodedPixels = sanitizeOptionalPositiveInteger(request.maxDecodedPixels)

  return {
    cacheRoot: path.resolve(request.cacheRoot),
    items: request.items.map((item) => ({
      id: item.id,
      path: path.resolve(item.path)
    })),
    ...(thumbnail ? { thumbnail } : {}),
    ...(maxConcurrency ? { maxConcurrency } : {}),
    ...(maxDecodedPixels ? { maxDecodedPixels } : {}),
    ...(request.hash ? { hash: request.hash } : {})
  }
}

export async function generateCanvasThumbnailsViaSidecar(
  request: CanvasThumbnailSidecarBatchThumbnailRequest,
  options: CanvasThumbnailSidecarRunOptions = {}
): Promise<CanvasThumbnailSidecarResult<CanvasThumbnailSidecarBatchThumbnailResponse>> {
  return runCanvasThumbnailSidecarJson<CanvasThumbnailSidecarBatchThumbnailResponse>(
    createCanvasThumbnailSidecarBatchRequest(request),
    options
  )
}

/**
 * @deprecated The Rust image worker does not implement the old create-thumbnail op.
 * Use generateCanvasThumbnailsViaSidecar with cacheRoot/items/thumbnail instead.
 */
export async function createCanvasThumbnailViaSidecar(
  _request: CanvasThumbnailSidecarCreateThumbnailRequest,
  _options: CanvasThumbnailSidecarRunOptions = {}
): Promise<CanvasThumbnailSidecarResult<CanvasThumbnailSidecarCreateThumbnailResponse>> {
  return createFallback(
    'sidecar-exit-failed',
    'Deprecated create-thumbnail sidecar request is incompatible with the Rust batch protocol; use generateCanvasThumbnailsViaSidecar.'
  )
}
