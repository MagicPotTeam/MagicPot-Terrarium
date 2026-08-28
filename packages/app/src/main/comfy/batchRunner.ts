import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ComfyBatchItemTiming,
  ComfyBatchProfile,
  ComfyBatchRunningItem,
  ComfyBatchStatus,
  StartComfyBatchReq
} from '@shared/api/svcComfyBatch'
import type { ComfyHistory, FileItem, ObjectInfoMap, Workflow } from '@shared/comfy/types'
import { ComfyBatchHttpClient, ComfyBatchHttpError } from './batchHttp'

export const COMFY_BATCH_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff'
])
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MANIFEST_VERSION = 2
export const COMFY_BATCH_HISTORY_POLL_MS = 200
const HISTORY_TIMEOUT_MS = 24 * 60 * 60 * 1000
const SUPERVISOR_WAIT_MS = 100
const PROFILE_REFRESH_INTERVAL_MS = 5_000
const PROFILE_RETRY_INTERVAL_MS = 250
// Hashing is the most expensive part of source discovery on large folders.
// Keep a bounded pool so a sync/network drive is used concurrently without
// creating an unbounded read burst.
const SCAN_READ_CONCURRENCY = 4
// A few completions are needed before wall-clock throughput is more reliable
// than the configured slot count. During warm-up, keep using the capacity
// estimate so the ETA does not jump around based on one unusually fast/slow item.
const MIN_ETA_THROUGHPUT_SAMPLES = 3
// Admit up to twice the configured execution slots for each instance. ComfyUI
// can take a noticeable amount of time to accept the next prompt; the doubled
// admission window keeps a GPU busy while the client waits at the HTTP/WebSocket
// boundary.
const COMFY_BATCH_EXECUTION_MULTIPLIER = 2
// Keep one additional item in the local read/upload preparation stage. This
// lets a slow source drive or remote upload stay ahead of the GPU without
// allowing an unbounded number of prepared buffers to accumulate.
const COMFY_BATCH_PREPARATION_HEADROOM = 1
const INPUT_MANIFEST_VERSION = 1
const INPUT_MANIFEST_FILENAME = '.magicpot-batch-input.json'
// Embedded ComfyUI can take well over a minute to load custom nodes and expose
// /object_info. Keep the batch pending during that startup window instead of
// converting every source image into a permanent failure.
export const NO_RUNTIME_RETRY_WINDOW_MS = 120_000
const COMFY_BATCH_RUN_KEY_PATTERN = /^\d{14}(?:-\d+)?$/

export type BatchSourceFile = {
  absolutePath: string
  relativePath: string
  size: number
  mtimeMs: number
  sha256: string
}

export type ComfyBatchScanProgress = {
  discovered: number
  hashed: number
}

export type ComfyBatchScanOptions = {
  onProgress?: (progress: ComfyBatchScanProgress) => void
}

type ManifestItemStatus = 'success' | 'failed'
export type ComfyBatchManifestItem = {
  relativePath: string
  size: number
  mtimeMs: number
  sha256: string
  planFingerprint: string
  status: ManifestItemStatus
  outputRelativePath: string
  error?: string
  updatedAt: number
}

export type ComfyBatchManifest = {
  version: 2
  sourceDir: string
  outputDir: string
  planFingerprint: string
  updatedAt: number
  items: Record<string, ComfyBatchManifestItem>
}

type ComfyBatchInputManifest = {
  version: 1
  sourceDir: string
  relativePaths: string[]
  files?: ComfyBatchInputSnapshotFile[]
  sourceMtimeMs?: number
  createdAt: number
}

type InstanceRuntime = {
  profile: ComfyBatchProfile
  client: ComfyBatchHttpClient
  inflight: number
  preparing: number
  compatible: boolean
  available: boolean
}

type PendingBatchItem = {
  source: BatchSourceFile
  outputPath: string
  outputRelativePath: string
  staged: boolean
}

export class ComfyExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComfyExecutionError'
  }
}

export function isValidComfyBatchRunKey(value: unknown): value is string {
  return typeof value === 'string' && COMFY_BATCH_RUN_KEY_PATTERN.test(value)
}

function batchArtifactSuffix(runKey?: string): string {
  if (runKey === undefined) return ''
  if (!isValidComfyBatchRunKey(runKey)) {
    throw new Error(`Invalid ComfyUI batch run key: ${runKey}`)
  }
  return `.${runKey}`
}

export function getComfyBatchOutputDir(sourceDir: string, runKey?: string): string {
  const resolved = path.resolve(sourceDir)
  const parsed = path.parse(resolved)
  if (resolved === parsed.root)
    throw new Error('A filesystem root cannot be used as a batch source')
  return `${resolved}.output${batchArtifactSuffix(runKey)}`
}

export function getComfyBatchInputDir(sourceDir: string, runKey?: string): string {
  const resolved = path.resolve(sourceDir)
  const parsed = path.parse(resolved)
  if (resolved === parsed.root)
    throw new Error('A filesystem root cannot be used as a batch source')
  return `${resolved}.input${batchArtifactSuffix(runKey)}`
}

export function getComfyBatchManifestPath(sourceDir: string, runKey?: string): string {
  return path.join(getComfyBatchOutputDir(sourceDir, runKey), '.magicpot-batch', 'manifest.json')
}

export function getComfyBatchOutputRelativePath(relativeSourcePath: string): string {
  const normalized = path.normalize(relativeSourcePath)
  if (
    path.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Unsafe relative source path: ${relativeSourcePath}`)
  }
  const parsed = path.parse(normalized)
  return path.join(parsed.dir, `${parsed.name}.png`)
}

function getComfyBatchInputManifestPath(inputDir: string): string {
  return path.join(inputDir, INPUT_MANIFEST_FILENAME)
}

async function hasDirectory(filename: string): Promise<boolean> {
  try {
    return (await fs.stat(filename)).isDirectory()
  } catch {
    return false
  }
}

async function ensureComfyBatchInputDirectory(inputDir: string): Promise<boolean> {
  if (await hasDirectory(inputDir)) return false
  try {
    await fs.stat(inputDir)
    throw new Error(`Batch input path exists but is not a directory: ${inputDir}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  try {
    await fs.mkdir(inputDir)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await hasDirectory(inputDir))) {
      throw new Error(`Batch input path exists but is not a directory: ${inputDir}`)
    }
    return false
  }
}

type ComfyBatchInputSnapshotFile = Pick<BatchSourceFile, 'relativePath' | 'size' | 'sha256'>

type PreparedBatchSource = {
  bytes: Uint8Array
  sha256: string
}

function resolveBatchInputPath(inputDir: string, relativePath: string): string {
  const resolvedInputDir = path.resolve(inputDir)
  const candidate = path.resolve(resolvedInputDir, relativePath)
  const relation = path.relative(resolvedInputDir, candidate)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`Unsafe relative input path: ${relativePath}`)
  }
  return candidate
}

async function copyComfyBatchInputFile(source: BatchSourceFile, inputDir: string): Promise<void> {
  const destination = resolveBatchInputPath(inputDir, source.relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temporaryPath = `${destination}.${randomUUID()}.tmp`
  try {
    await fs.copyFile(source.absolutePath, temporaryPath)
    await fs.rename(temporaryPath, destination)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function discoverComfyBatchImagePaths(
  sourceDir: string,
  options: ComfyBatchScanOptions = {}
): Promise<BatchSourceFile[]> {
  const root = path.resolve(sourceDir)
  const rootStats = await fs.stat(root)
  if (!rootStats.isDirectory()) throw new Error('Batch source must be a directory')

  const result: BatchSourceFile[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (
        !entry.isFile() ||
        !COMFY_BATCH_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        continue
      }
      result.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath),
        // Discovery intentionally does not open the image. Workers fill in
        // metadata and the content hash immediately before upload.
        size: -1,
        mtimeMs: -1,
        sha256: ''
      })
      options.onProgress?.({ discovered: result.length, hashed: 0 })
    }
  }
  await visit(root)
  return result
}

async function getBatchSourceMtime(sourceDir: string): Promise<number> {
  return (await fs.stat(sourceDir)).mtimeMs
}

function parseComfyBatchInputManifest(value: unknown): ComfyBatchInputManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<ComfyBatchInputManifest>
  const files = Array.isArray(candidate.files)
    ? candidate.files.filter(
        (file): file is ComfyBatchInputSnapshotFile =>
          Boolean(file) &&
          typeof file === 'object' &&
          typeof file.relativePath === 'string' &&
          Number.isFinite(file.size) &&
          typeof file.sha256 === 'string'
      )
    : undefined
  if (
    candidate.version !== INPUT_MANIFEST_VERSION ||
    typeof candidate.sourceDir !== 'string' ||
    !Array.isArray(candidate.relativePaths) ||
    !candidate.relativePaths.every((relativePath) => {
      if (typeof relativePath !== 'string') return false
      try {
        getComfyBatchOutputRelativePath(relativePath)
        return true
      } catch {
        return false
      }
    })
  ) {
    return null
  }
  return {
    version: INPUT_MANIFEST_VERSION,
    sourceDir: candidate.sourceDir,
    relativePaths: [...new Set(candidate.relativePaths)],
    ...(files ? { files } : {}),
    ...(typeof candidate.sourceMtimeMs === 'number'
      ? { sourceMtimeMs: candidate.sourceMtimeMs }
      : {}),
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now()
  }
}

async function readComfyBatchInputManifest(
  inputDir: string
): Promise<ComfyBatchInputManifest | null> {
  try {
    return parseComfyBatchInputManifest(
      JSON.parse(await fs.readFile(getComfyBatchInputManifestPath(inputDir), 'utf8'))
    )
  } catch {
    return null
  }
}

async function writeComfyBatchInputManifest(
  inputDir: string,
  sourceDir: string,
  relativePaths: string[],
  files?: ComfyBatchInputSnapshotFile[],
  sourceMtimeMs?: number
): Promise<void> {
  await atomicWriteFile(
    getComfyBatchInputManifestPath(inputDir),
    JSON.stringify({
      version: INPUT_MANIFEST_VERSION,
      sourceDir,
      relativePaths: [...new Set(relativePaths)],
      ...(files ? { files } : {}),
      ...(sourceMtimeMs !== undefined ? { sourceMtimeMs } : {}),
      createdAt: Date.now()
    } satisfies ComfyBatchInputManifest)
  )
}

async function reconcileComfyBatchInput(
  sourceDir: string,
  inputDir: string,
  previous: ComfyBatchInputManifest,
  options: ComfyBatchScanOptions = {}
): Promise<{ sources: BatchSourceFile[]; snapshotRelativePaths: string[] }> {
  const currentSources = await scanComfyBatchImages(sourceDir, options)
  const currentPaths = new Set(currentSources.map((source) => source.relativePath))

  // A changed source-folder mtime is the explicit compatibility escape hatch
  // for legacy tasks. Re-stage every current image so that additions,
  // edits, deletions, and outputs removed between runs are all reconciled in
  // one pass. The normal resume path below never reaches this source scan.
  for (const source of currentSources) {
    await copyComfyBatchInputFile(source, inputDir)
  }

  // A source deleted since the last run must no longer participate in output
  // cleanup or future retries. Removing its staged copy is safe because the
  // original source directory remains untouched.
  for (const relativePath of previous.relativePaths) {
    if (currentPaths.has(relativePath)) continue
    await fs
      .rm(resolveBatchInputPath(inputDir, relativePath), { force: true })
      .catch(() => undefined)
  }

  const snapshotRelativePaths = currentSources.map((source) => source.relativePath)
  await writeComfyBatchInputManifest(
    inputDir,
    sourceDir,
    snapshotRelativePaths,
    currentSources.map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 })),
    await getBatchSourceMtime(sourceDir)
  )
  return {
    sources: await scanComfyBatchImages(inputDir, options),
    snapshotRelativePaths
  }
}

function normalizeCollisionKey(value: string): string {
  const normalized = path.normalize(value).replaceAll('\\', '/')
  return process.platform === 'linux' ? normalized : normalized.toLocaleLowerCase()
}

export function assertNoComfyBatchOutputCollisions(sources: BatchSourceFile[]): void {
  const sourceByOutput = new Map<string, string>()
  for (const source of sources) {
    const outputRelativePath = getComfyBatchOutputRelativePath(source.relativePath)
    const key = normalizeCollisionKey(outputRelativePath)
    const existing = sourceByOutput.get(key)
    if (existing) {
      throw new Error(
        `Output filename collision: ${existing} and ${source.relativePath} both map to ${outputRelativePath}`
      )
    }
    sourceByOutput.set(key, source.relativePath)
  }
}

export async function scanComfyBatchImages(
  sourceDir: string,
  options: ComfyBatchScanOptions = {}
): Promise<BatchSourceFile[]> {
  const root = path.resolve(sourceDir)
  const rootStats = await fs.stat(root)
  if (!rootStats.isDirectory()) throw new Error('Batch source must be a directory')

  const candidates: Array<{ absolutePath: string; relativePath: string }> = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (
        !entry.isFile() ||
        !COMFY_BATCH_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        continue
      }
      candidates.push({ absolutePath, relativePath: path.relative(root, absolutePath) })
      options.onProgress?.({ discovered: candidates.length, hashed: 0 })
    }
  }
  await visit(root)

  const result = new Array<BatchSourceFile>(candidates.length)
  let nextIndex = 0
  let hashed = 0
  const readNext = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      const index = nextIndex
      nextIndex += 1
      const candidate = candidates[index]
      result[index] = await readComfyBatchSourceFile(candidate.absolutePath, candidate.relativePath)
      hashed += 1
      options.onProgress?.({ discovered: candidates.length, hashed })
    }
  }
  const workerCount = Math.min(SCAN_READ_CONCURRENCY, candidates.length)
  await Promise.all(Array.from({ length: workerCount }, () => readNext()))
  return result
}

async function readComfyBatchSourceFile(
  absolutePath: string,
  relativePath: string
): Promise<BatchSourceFile> {
  const before = await fs.stat(absolutePath)
  const bytes = await fs.readFile(absolutePath)
  const after = await fs.stat(absolutePath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Batch source changed while scanning: ${absolutePath}`)
  }
  return {
    absolutePath,
    relativePath,
    size: after.size,
    mtimeMs: after.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

async function scanComfyBatchSourceFile(
  sourceDir: string,
  relativePath: string
): Promise<BatchSourceFile | null> {
  const absolutePath = resolveBatchInputPath(sourceDir, relativePath)
  try {
    const stats = await fs.stat(absolutePath)
    if (
      !stats.isFile() ||
      !COMFY_BATCH_IMAGE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
    ) {
      return null
    }
    return await readComfyBatchSourceFile(absolutePath, relativePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function buildComfyBatchPlanFingerprint(input: {
  qAppKey: string
  workflow: Workflow
  imageInputSlot: string
  outputNodeIds: string[]
}): string {
  return createHash('sha256').update(stableJson(input)).digest('hex')
}

export function isPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= PNG_SIGNATURE.byteLength &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  )
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  )
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

let pngCrcTable: Uint32Array | undefined
function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  if (!pngCrcTable) {
    pngCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      return value >>> 0
    })
  }
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc = pngCrcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function isValidPng(bytes: Uint8Array): boolean {
  if (!isPngSignature(bytes) || bytes.byteLength < 45) return false

  let offset = PNG_SIGNATURE.byteLength
  let chunkIndex = 0
  let hasIdat = false
  while (offset <= bytes.byteLength - 12) {
    const dataLength = readUint32Be(bytes, offset)
    const dataOffset = offset + 8
    const crcOffset = dataOffset + dataLength
    const nextOffset = crcOffset + 4
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.byteLength) return false

    const type = chunkType(bytes, offset + 4)
    if (chunkIndex === 0 && (type !== 'IHDR' || dataLength !== 13)) return false
    if (readUint32Be(bytes, crcOffset) !== pngCrc32(bytes, offset + 4, crcOffset)) return false
    if (type === 'IDAT') hasIdat = true
    if (type === 'IEND') return dataLength === 0 && hasIdat && nextOffset === bytes.byteLength

    offset = nextOffset
    chunkIndex += 1
  }
  return false
}

export type ComfyBatchOutputMetadata = {
  sourceSha256: string
  planFingerprint: string
}

const BATCH_PNG_TEXT_KEY = 'MagicPotBatch'

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes)
  crcInput.set(data, typeBytes.length)
  const chunk = new Uint8Array(12 + data.length)
  chunk.set(
    Uint8Array.from([
      (data.length >>> 24) & 0xff,
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff
    ])
  )
  chunk.set(typeBytes, 4)
  chunk.set(data, 8)
  const crc = pngCrc32(crcInput, 0, crcInput.length)
  chunk.set(
    Uint8Array.from([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]),
    8 + data.length
  )
  return chunk
}

function addBatchPngMetadata(bytes: Uint8Array, metadata: ComfyBatchOutputMetadata): Uint8Array {
  if (!isValidPng(bytes)) throw new Error('ComfyUI output is not a valid PNG')
  const text = new TextEncoder().encode(`${BATCH_PNG_TEXT_KEY}\0${JSON.stringify(metadata)}`)
  let offset = PNG_SIGNATURE.length
  while (offset <= bytes.length - 12) {
    const dataLength = readUint32Be(bytes, offset)
    const nextOffset = offset + 12 + dataLength
    if (chunkType(bytes, offset + 4) === 'IEND') {
      const chunk = makePngChunk('tEXt', text)
      const result = new Uint8Array(bytes.length + chunk.length)
      result.set(bytes.slice(0, offset))
      result.set(chunk, offset)
      result.set(bytes.slice(offset), offset + chunk.length)
      return result
    }
    offset = nextOffset
  }
  throw new Error('PNG is missing IEND')
}

type BatchPngInspection = {
  valid: boolean
  metadata: ComfyBatchOutputMetadata | null
}

function inspectBatchPng(bytes: Uint8Array): BatchPngInspection {
  if (!isValidPng(bytes)) return { valid: false, metadata: null }
  let metadata: ComfyBatchOutputMetadata | null = null
  let offset = PNG_SIGNATURE.length
  while (offset <= bytes.length - 12) {
    const dataLength = readUint32Be(bytes, offset)
    const dataOffset = offset + 8
    const nextOffset = offset + 12 + dataLength
    if (chunkType(bytes, offset + 4) === 'tEXt') {
      const data = new TextDecoder().decode(bytes.slice(dataOffset, dataOffset + dataLength))
      const separator = data.indexOf('\0')
      if (separator >= 0 && data.slice(0, separator) === BATCH_PNG_TEXT_KEY) {
        try {
          const parsed = JSON.parse(data.slice(separator + 1)) as Partial<ComfyBatchOutputMetadata>
          if (
            typeof parsed.sourceSha256 === 'string' &&
            typeof parsed.planFingerprint === 'string'
          ) {
            metadata = parsed as ComfyBatchOutputMetadata
          }
        } catch {
          return { valid: true, metadata: null }
        }
      }
    }
    if (chunkType(bytes, offset + 4) === 'IEND') break
    offset = nextOffset
  }
  return { valid: true, metadata }
}

function readBatchPngMetadata(bytes: Uint8Array): ComfyBatchOutputMetadata | null {
  return inspectBatchPng(bytes).metadata
}

async function readBatchPngInspection(filename: string): Promise<BatchPngInspection> {
  try {
    return inspectBatchPng(new Uint8Array(await fs.readFile(filename)))
  } catch {
    return { valid: false, metadata: null }
  }
}

async function findGeneratedBatchOutputs(
  outputDir: string,
  expectedOutputPaths = new Set<string>()
): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string, relativeDirectory = ''): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.magicpot-batch') continue
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.png') continue
      // Expected files are inspected once below. Avoid reading each one here
      // and then reading it again while deciding whether it can be skipped.
      if (expectedOutputPaths.has(relativePath)) continue
      try {
        const metadata = readBatchPngMetadata(new Uint8Array(await fs.readFile(absolutePath)))
        if (metadata) result.push(relativePath)
      } catch {
        // Ignore files that are not complete batch outputs.
      }
    }
  }
  await visit(outputDir)
  return result
}

export async function hasValidPngFile(filename: string): Promise<boolean> {
  try {
    return isValidPng(new Uint8Array(await fs.readFile(filename)))
  } catch {
    return false
  }
}

function isSafeOutputRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return false
  const normalized = path.normalize(value)
  return (
    normalized !== '..' &&
    !normalized.startsWith(`..${path.sep}`) &&
    path.extname(normalized).toLowerCase() === '.png'
  )
}

function resolveManifestOutputPath(outputDir: string, relativePath: unknown): string | null {
  if (!isSafeOutputRelativePath(relativePath)) return null
  const resolvedOutputDir = path.resolve(outputDir)
  const candidate = path.resolve(resolvedOutputDir, relativePath)
  const relation = path.relative(resolvedOutputDir, candidate)
  return relation && !relation.startsWith('..') && !path.isAbsolute(relation) ? candidate : null
}

async function readManifest(
  sourceDir: string,
  runKey?: string
): Promise<ComfyBatchManifest | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(getComfyBatchManifestPath(sourceDir, runKey), 'utf8')
    )
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.items !== 'object') return null
    return parsed as ComfyBatchManifest
  } catch {
    return null
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (process.platform !== 'win32') throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function replaceFile(tempPath: string, filename: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 4 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rename(tempPath, filename)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = ['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(code || '')
      if (!retryable) throw error
      if (process.platform === 'win32' && attempt === attempts) {
        await fs.rm(filename, { force: true })
        await fs.rename(tempPath, filename)
        return
      }
      if (attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt))
    }
  }
}

async function atomicWriteFile(filename: string, bytes: Uint8Array | string): Promise<void> {
  const directory = path.dirname(filename)
  await fs.mkdir(directory, { recursive: true })
  const tempPath = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(tempPath, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await replaceFile(tempPath, filename)
    await fsyncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function atomicCommitPng(
  filename: string,
  bytes: Uint8Array,
  metadata?: ComfyBatchOutputMetadata
): Promise<void> {
  const committedBytes = metadata ? addBatchPngMetadata(bytes, metadata) : bytes
  if (!isValidPng(committedBytes)) throw new Error('ComfyUI output is not a valid PNG')
  await atomicWriteFile(filename, committedBytes)
}

async function writeManifest(manifest: ComfyBatchManifest): Promise<void> {
  manifest.updatedAt = Date.now()
  await atomicWriteFile(
    path.join(manifest.outputDir, '.magicpot-batch', 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  )
}

export function requiredWorkflowClassTypes(workflow: Workflow): string[] {
  return Array.from(
    new Set(
      Object.values(workflow)
        .map((node) => node?.class_type)
        .filter((classType): classType is string => Boolean(classType))
    )
  ).sort()
}

export function hasCompatibleNodeClasses(
  workflow: Workflow,
  objectInfo: Record<string, unknown>
): boolean {
  return requiredWorkflowClassTypes(workflow).every((classType) =>
    Object.prototype.hasOwnProperty.call(objectInfo, classType)
  )
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const IMAGE_INPUT_SLOT_PATTERN = /^\$\.([^.[\]]+)\.inputs\.([^.[\]]+)$/

type ImageInputBinding = { nodeId: string; field: string }

export function validateComfyBatchBindings(
  workflow: Workflow,
  imageInputSlot: string,
  outputNodeIds: string[],
  objectInfo?: ObjectInfoMap
): ImageInputBinding {
  const match = IMAGE_INPUT_SLOT_PATTERN.exec(imageInputSlot)
  if (!match) {
    throw new Error('imageInputSlot must match $.<node id>.inputs.<field>')
  }
  const [, nodeId, field] = match
  if (FORBIDDEN_PATH_SEGMENTS.has(nodeId) || FORBIDDEN_PATH_SEGMENTS.has(field)) {
    throw new Error('imageInputSlot contains a forbidden path segment')
  }
  if (!Object.prototype.hasOwnProperty.call(workflow, nodeId)) {
    throw new Error(`imageInputSlot node does not exist: ${nodeId}`)
  }
  const node = workflow[nodeId]
  if (!node || !Object.prototype.hasOwnProperty.call(node, 'inputs') || !node.inputs) {
    throw new Error(`imageInputSlot node has no own inputs object: ${nodeId}`)
  }
  if (!Object.prototype.hasOwnProperty.call(node.inputs, field)) {
    throw new Error(`imageInputSlot field does not exist: ${field}`)
  }

  if (!outputNodeIds.length) throw new Error('Quick App outputNodeIds must not be empty')
  if (new Set(outputNodeIds).size !== outputNodeIds.length) {
    throw new Error('Quick App outputNodeIds must be unique')
  }
  for (const outputNodeId of outputNodeIds) {
    if (FORBIDDEN_PATH_SEGMENTS.has(outputNodeId)) {
      throw new Error('outputNodeIds contains a forbidden node id')
    }
    if (!Object.prototype.hasOwnProperty.call(workflow, outputNodeId)) {
      throw new Error(`Output node does not exist: ${outputNodeId}`)
    }
  }

  if (objectInfo) {
    const inputNodeInfo = objectInfo[node.class_type]
    const fieldInfo =
      inputNodeInfo?.input?.required?.[field] ?? inputNodeInfo?.input?.optional?.[field]
    const fieldType = fieldInfo?.[0]
    const fieldOptions = fieldInfo?.[1]
    const isImageUpload =
      Array.isArray(fieldInfo) &&
      Array.isArray(fieldType) &&
      typeof fieldOptions === 'object' &&
      fieldOptions !== null &&
      (fieldOptions as { image_upload?: unknown }).image_upload === true
    if (!isImageUpload) {
      throw new Error(`imageInputSlot must bind an image upload field: ${node.class_type}.${field}`)
    }
    for (const outputNodeId of outputNodeIds) {
      const outputNode = workflow[outputNodeId]
      const outputInfo = objectInfo[outputNode.class_type]
      if (
        !outputInfo ||
        (outputInfo.output_node !== true &&
          !outputInfo.output?.some((outputType) => outputType === 'IMAGE'))
      ) {
        throw new Error(`Configured output node is not an output-producing node: ${outputNodeId}`)
      }
    }
  }

  return { nodeId, field }
}

function bindUploadedImage(workflow: Workflow, binding: ImageInputBinding, value: string): void {
  workflow[binding.nodeId].inputs[binding.field] = value
}

export function selectBoundOutputImage(
  history: Pick<ComfyHistory, 'outputs'>,
  outputNodeIds: string[]
): FileItem {
  if (!outputNodeIds.length) throw new Error('Quick App outputNodeIds must not be empty')
  const images = outputNodeIds.flatMap((nodeId) => history.outputs?.[nodeId]?.images || [])
  const outputImages = images.filter(
    (item): item is FileItem & { filename: string } =>
      (item?.type === 'output' || item?.type === 'temp') && !!item.filename
  )
  if (outputImages.length !== 1) {
    throw new Error(
      outputImages.length === 0
        ? 'No output or preview image was produced by the bound output nodes'
        : 'Expected exactly one image from the bound output nodes'
    )
  }
  return outputImages[0]
}

export class LeastLoadRoundRobinScheduler<
  T extends {
    inflight: number
    preparing?: number
    profile: { maxConcurrency: number; enabled?: boolean }
  }
> {
  private cursor = 0

  pick(instances: T[], excluded = new Set<T>()): T | null {
    if (!instances.length) return null
    const available = instances.filter((instance) => {
      if (
        excluded.has(instance) ||
        instance.profile.enabled === false ||
        ('available' in instance && instance.available === false) ||
        ('compatible' in instance && instance.compatible === false)
      ) {
        return false
      }
      const executionCapacity =
        Math.max(1, instance.profile.maxConcurrency) * COMFY_BATCH_EXECUTION_MULTIPLIER
      const admitted = instance.inflight + (instance.preparing || 0)
      // Only use the extra preparation slot while no prompt has reached
      // ComfyUI yet. Once execution is admitted, retain the original total
      // queue bound so retries and profile discovery stay deterministic.
      const preparationCapacity =
        instance.preparing === undefined
          ? executionCapacity
          : executionCapacity + COMFY_BATCH_PREPARATION_HEADROOM
      return (
        admitted < executionCapacity || (instance.inflight === 0 && admitted < preparationCapacity)
      )
    })
    if (!available.length) return null
    const ratios = available.map(
      (instance) => instance.inflight / Math.max(1, instance.profile.maxConcurrency)
    )
    const minimum = Math.min(...ratios)
    const tied = available.filter(
      (instance) => instance.inflight / Math.max(1, instance.profile.maxConcurrency) === minimum
    )
    const start = this.cursor % instances.length
    const picked =
      [...instances.slice(start), ...instances.slice(0, start)].find((instance) =>
        tied.includes(instance)
      ) || tied[0]
    this.cursor = (instances.indexOf(picked) + 1) % instances.length
    return picked
  }
}

function cloneWorkflow(workflow: Workflow): Workflow {
  return JSON.parse(JSON.stringify(workflow)) as Workflow
}

function uploadedValue(file: FileItem): string {
  return file.subfolder ? `${file.subfolder}/${file.filename} [input]` : file.filename || ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRetryableInstanceError(error: unknown): boolean {
  if (error instanceof ComfyExecutionError) return true
  if (error instanceof ComfyBatchHttpError) {
    // A reverse proxy or a stale AutoDL port can answer ComfyUI requests with
    // an HTML 404 page. Treat that as an instance failure so another profile
    // gets a chance instead of converting every item into a permanent error.
    return error.retryable || error.status === 404
  }
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('fetch failed') ||
      message.includes('econn') ||
      message.includes('socket')
    )
  }
  return false
}

async function waitForHistory(
  client: ComfyBatchHttpClient,
  promptId: string,
  signal: AbortSignal
): Promise<ComfyHistory> {
  const deadline = Date.now() + HISTORY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Batch cancelled')
    const response = await client.history(promptId, signal)
    const result = response[promptId]
    if (result) {
      if (result.status?.status_str === 'error') {
        const executionMessage = result.status.messages?.find(
          (message) => message[0] === 'execution_error'
        )
        const detail = executionMessage?.[1]
        throw new ComfyExecutionError(
          typeof detail === 'object' && detail && 'exception_message' in detail
            ? String(detail.exception_message)
            : 'ComfyUI execution failed'
        )
      }
      if (result.status?.completed || result.status?.status_str === 'success') return result
    }
    await new Promise((resolve) => setTimeout(resolve, COMFY_BATCH_HISTORY_POLL_MS))
  }
  throw new Error('Timed out waiting for ComfyUI history')
}

export type ComfyBatchRunnerOptions = {
  createClient?: (baseUrl: string) => ComfyBatchHttpClient
  onStatus?: (status: ComfyBatchStatus) => void
  jobId?: string
  getProfiles?: () => ComfyBatchProfile[]
  runKey?: string
}

export class ComfyBatchRunner {
  readonly jobId: string
  readonly abortController = new AbortController()
  private manifest!: ComfyBatchManifest
  private imageInputBinding!: ImageInputBinding
  private queue: PendingBatchItem[] = []
  private runtimes: InstanceRuntime[] = []
  private scheduler = new LeastLoadRoundRobinScheduler<InstanceRuntime>()
  private manifestWriteQueue: Promise<void> = Promise.resolve()
  private readonly createClient: (baseUrl: string) => ComfyBatchHttpClient
  private readonly activePrompts = new Map<string, ComfyBatchHttpClient>()
  private readonly runningItems = new Map<string, ComfyBatchRunningItem>()
  private readonly recentItems: ComfyBatchItemTiming[] = []
  private readonly itemAttempts = new Map<string, number>()
  private readonly retryQueuedPaths = new Set<string>()
  private inputDir!: string
  private inputSnapshotSourceDir = ''
  private inputSnapshotSourceMtimeMs: number | undefined
  private inputSnapshotRelativePaths: string[] = []
  private readonly inputSnapshotFiles = new Map<string, ComfyBatchInputSnapshotFile>()
  private inputSnapshotDirty = false
  private runtimeRefreshPromise: Promise<void> | undefined
  private lastProfileFingerprint = ''
  private lastProfileRefreshAt = 0
  private statusValue: ComfyBatchStatus
  private nextQueueIndex = 0

  constructor(
    private readonly request: StartComfyBatchReq,
    private readonly profiles: ComfyBatchProfile[],
    private readonly options: ComfyBatchRunnerOptions = {}
  ) {
    this.jobId = options.jobId || randomUUID()
    this.createClient = options.createClient ?? ((baseUrl) => new ComfyBatchHttpClient(baseUrl))
    this.statusValue = {
      jobId: this.jobId,
      state: 'idle',
      sourceDir: path.resolve(request.sourceDir),
      outputDir: getComfyBatchOutputDir(request.sourceDir, options.runKey),
      qAppKey: request.qAppKey,
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      running: 0,
      pending: 0,
      failedFiles: []
    }
  }

  get status(): ComfyBatchStatus {
    const now = Date.now()
    const startedAt = this.statusValue.startedAt
    const elapsedMs = startedAt ? (this.statusValue.finishedAt || now) - startedAt : undefined
    const measuredItems = this.recentItems.filter(
      (item) => Number.isFinite(item.durationMs) && item.durationMs >= 0
    )
    const totalMeasuredMs = measuredItems.reduce((sum, item) => sum + item.durationMs, 0)
    const averageItemMs = measuredItems.length ? totalMeasuredMs / measuredItems.length : undefined
    const remainingItems = Math.max(0, this.statusValue.pending + this.statusValue.running)
    // Estimate wall-clock time in waves across currently usable instance slots.
    // Keep a one-slot fallback while runtime probing is still in progress.
    const availableConcurrency = this.runtimes.reduce((sum, runtime) => {
      if (!runtime.compatible || !runtime.available || runtime.profile.enabled === false) return sum
      return sum + Math.max(1, runtime.profile.maxConcurrency)
    }, 0)
    const estimatedBatches = Math.ceil(remainingItems / Math.max(1, availableConcurrency))
    const capacityEtaMs = averageItemMs !== undefined ? averageItemMs * estimatedBatches : undefined
    const throughputSamples = measuredItems.filter(
      (item) =>
        Number.isFinite(item.startedAt) &&
        Number.isFinite(item.finishedAt) &&
        item.finishedAt >= item.startedAt
    )
    let etaMs = capacityEtaMs
    if (throughputSamples.length >= MIN_ETA_THROUGHPUT_SAMPLES) {
      const observationStart = Math.min(...throughputSamples.map((item) => item.startedAt))
      const observationEnd = Math.max(...throughputSamples.map((item) => item.finishedAt))
      const observationMs = Math.max(1, observationEnd - observationStart)
      const observedThroughputPerMs = throughputSamples.length / observationMs
      etaMs = remainingItems > 0 ? remainingItems / observedThroughputPerMs : 0
    }
    return {
      ...this.statusValue,
      elapsedMs,
      averageItemMs,
      etaMs,
      recentItems: [...this.recentItems],
      runningItems: [...this.runningItems.values()],
      lastItem: this.recentItems.at(-1),
      failedFiles: [...this.statusValue.failedFiles]
    }
  }

  startingStatus(): ComfyBatchStatus {
    if (this.statusValue.state === 'idle') {
      this.statusValue.state = 'running'
      this.statusValue.startedAt = Date.now()
    }
    return this.status
  }

  cancel(): void {
    this.abortController.abort()
    for (const [promptId, client] of this.activePrompts) {
      void client.cancelPrompt(promptId).catch(() => undefined)
    }
    this.emit()
  }

  private emit(): void {
    this.options.onStatus?.(this.status)
  }

  private persistManifest(): Promise<void> {
    const write = this.manifestWriteQueue.then(() => writeManifest(this.manifest))
    this.manifestWriteQueue = write.catch(() => undefined)
    return write
  }

  private rememberInputSnapshotFile(source: BatchSourceFile): void {
    if (!source.sha256 || source.size < 0 || source.mtimeMs < 0) return
    this.inputSnapshotFiles.set(source.relativePath, {
      relativePath: source.relativePath,
      size: source.size,
      sha256: source.sha256
    })
    this.inputSnapshotDirty = true
  }

  private async persistInputSnapshot(): Promise<void> {
    if (!this.inputSnapshotDirty || !this.inputSnapshotSourceDir) return
    await writeComfyBatchInputManifest(
      this.inputDir,
      this.inputSnapshotSourceDir,
      this.inputSnapshotRelativePaths,
      [...this.inputSnapshotFiles.values()],
      this.inputSnapshotSourceMtimeMs
    )
    this.inputSnapshotDirty = false
  }

  private currentProfiles(): ComfyBatchProfile[] {
    return this.options.getProfiles?.() ?? this.profiles
  }

  private profileKey(profile: ComfyBatchProfile): string {
    return JSON.stringify([profile.id, profile.baseUrl])
  }

  private async probeCompatibleRuntimes(
    profiles: ComfyBatchProfile[],
    onProbe?: (runtime: InstanceRuntime) => void
  ): Promise<{
    runtimes: InstanceRuntime[]
    failedKeys: Set<string>
    incompatibleKeys: Set<string>
  }> {
    // Disabled profiles are configuration, not endpoints. In particular, do
    // not probe them during a refresh (and never create a runtime for them).
    const enabledProfiles = profiles.filter((profile) => profile.enabled !== false)
    if (!enabledProfiles.length) {
      return { runtimes: [], failedKeys: new Set(), incompatibleKeys: new Set() }
    }
    const probes = await Promise.allSettled(
      enabledProfiles.map((profile) =>
        (async () => {
          const client = this.createClient(profile.baseUrl)
          await client.probe()
          const objectInfo = await client.objectInfo(this.abortController.signal)
          if (!hasCompatibleNodeClasses(this.request.workflow, objectInfo)) {
            return {
              profile,
              client,
              inflight: 0,
              preparing: 0,
              compatible: false as const,
              available: false
            }
          }
          validateComfyBatchBindings(
            this.request.workflow,
            this.request.imageInputSlot,
            this.request.outputNodeIds,
            objectInfo
          )
          return {
            profile,
            client,
            inflight: 0,
            preparing: 0,
            compatible: true as const,
            available: true
          }
        })().then((runtime) => {
          // Publish healthy profiles as soon as they are ready. A slow or
          // offline profile must not delay work on an already-available one.
          onProbe?.(runtime)
          return runtime
        })
      )
    )
    const runtimes: InstanceRuntime[] = []
    const failedKeys = new Set<string>()
    const incompatibleKeys = new Set<string>()
    probes.forEach((probe, index) => {
      const profile = enabledProfiles[index]
      const key = this.profileKey(profile)
      if (probe.status === 'fulfilled') {
        if (probe.value.compatible) runtimes.push(probe.value)
        else incompatibleKeys.add(key)
      } else {
        // A transient endpoint/object-info failure must not evict a runtime
        // that was already admitted and known to be healthy.
        failedKeys.add(key)
      }
    })
    return { runtimes, failedKeys, incompatibleKeys }
  }

  private publishProbedRuntime(probed: InstanceRuntime): void {
    const key = this.profileKey(probed.profile)
    const existingIndex = this.runtimes.findIndex(
      (runtime) => this.profileKey(runtime.profile) === key
    )
    const existing = existingIndex >= 0 ? this.runtimes[existingIndex] : undefined

    if (probed.compatible && probed.available) {
      if (existing) {
        existing.profile = probed.profile
        existing.compatible = true
        existing.available = true
      } else {
        this.runtimes.push(probed)
      }
      this.emit()
      return
    }

    if (!existing) return
    if (existing.inflight > 0) {
      existing.profile = probed.profile
      existing.compatible = false
      existing.available = false
    } else {
      this.runtimes.splice(existingIndex, 1)
    }
    this.emit()
  }

  private async refreshProfilesIfNeeded(force = false): Promise<void> {
    const profiles = this.currentProfiles()
    const fingerprint = stableJson(profiles)
    const now = Date.now()
    if (
      !force &&
      fingerprint === this.lastProfileFingerprint &&
      now - this.lastProfileRefreshAt < PROFILE_REFRESH_INTERVAL_MS
    ) {
      return
    }
    if (this.runtimeRefreshPromise) return this.runtimeRefreshPromise
    this.runtimeRefreshPromise = (async () => {
      const {
        runtimes: probed,
        failedKeys,
        incompatibleKeys
      } = await this.probeCompatibleRuntimes(profiles, (runtime) =>
        this.publishProbedRuntime(runtime)
      )
      const configuredByKey = new Map(
        profiles.map((profile) => [this.profileKey(profile), profile])
      )
      const existingByKey = new Map(
        this.runtimes.map((runtime) => [this.profileKey(runtime.profile), runtime])
      )
      const probedByKey = new Map(
        probed.map((runtime) => [this.profileKey(runtime.profile), runtime])
      )
      const nextByKey = new Map<string, InstanceRuntime>()

      for (const profile of profiles) {
        const key = this.profileKey(profile)
        const existing = existingByKey.get(key)
        if (profile.enabled === false) {
          // An in-flight task may finish on a disabled endpoint, but it must
          // not receive any newly scheduled work.
          if (existing && existing.inflight > 0) {
            existing.profile = { ...profile, enabled: false }
            existing.compatible = false
            existing.available = false
            nextByKey.set(key, existing)
          }
          continue
        }

        const probedRuntime = probedByKey.get(key)
        if (probedRuntime) {
          if (existing) {
            existing.profile = profile
            existing.compatible = true
            existing.available = true
            nextByKey.set(key, existing)
          } else {
            nextByKey.set(key, probedRuntime)
          }
          continue
        }

        if (existing && failedKeys.has(key)) {
          // Keep an in-flight task attached to its old client so it can drain,
          // but quarantine the runtime for new work until a later probe passes.
          existing.profile = profile
          existing.compatible = false
          existing.available = false
          if (existing.inflight > 0) nextByKey.set(key, existing)
        } else if (existing && incompatibleKeys.has(key) && existing.inflight > 0) {
          // Compatibility is a real configuration change, so finish admitted
          // work but do not admit more to this runtime.
          existing.profile = { ...profile, enabled: false }
          existing.compatible = false
          existing.available = false
          nextByKey.set(key, existing)
        }
      }

      // Removed profiles and profiles whose URL/id changed are retained only
      // long enough for already admitted work to drain, and are never reused.
      for (const [key, existing] of existingByKey) {
        if (configuredByKey.has(key) || existing.inflight <= 0) continue
        existing.profile = { ...existing.profile, enabled: false }
        existing.compatible = false
        nextByKey.set(key, existing)
      }

      this.runtimes = [...nextByKey.values()]
      this.lastProfileFingerprint = fingerprint
      this.lastProfileRefreshAt = Date.now()
    })()
    try {
      await this.runtimeRefreshPromise
    } finally {
      this.runtimeRefreshPromise = undefined
    }
  }

  private async initialize(): Promise<void> {
    if (!this.request.qAppKey.trim()) throw new Error('qAppKey is required')
    if (!this.request.imageInputSlot.trim())
      throw new Error('batchProcess.imageInputSlot is required')
    this.imageInputBinding = validateComfyBatchBindings(
      this.request.workflow,
      this.request.imageInputSlot,
      this.request.outputNodeIds
    )
    const sourceDir = path.resolve(this.request.sourceDir)
    const outputDir = getComfyBatchOutputDir(sourceDir, this.options.runKey)
    const inputDir = getComfyBatchInputDir(sourceDir, this.options.runKey)
    this.inputDir = inputDir
    const planFingerprint = buildComfyBatchPlanFingerprint(this.request)
    this.statusValue.planFingerprint = planFingerprint
    const sourceStats = await fs.stat(sourceDir)
    if (!sourceStats.isDirectory()) throw new Error('Batch source must be a directory')

    const scanOptions: ComfyBatchScanOptions = {
      onProgress: ({ discovered }) => {
        // Make discovery visible to the status poller while the input
        // snapshot is being prepared. The callback intentionally does not
        // emit per-file IPC updates; liveStatus reads these fields directly.
        this.statusValue.total = discovered
        this.statusValue.pending = discovered
      }
    }
    const createdInput = await ensureComfyBatchInputDirectory(inputDir)
    let inputManifest = await readComfyBatchInputManifest(inputDir)
    if (inputManifest && path.resolve(inputManifest.sourceDir) !== sourceDir) {
      throw new Error(`Batch input belongs to a different source folder: ${inputDir}`)
    }

    let sources: BatchSourceFile[]
    let snapshotRelativePaths: string[]
    if (createdInput && !inputManifest) {
      // A fresh batch only needs a path snapshot before work can start. Do
      // not copy or hash every image up front; each worker stages and hashes
      // its own item immediately before uploading it.
      sources = await discoverComfyBatchImagePaths(sourceDir, scanOptions)
      snapshotRelativePaths = sources.map((source) => source.relativePath)
      inputManifest = {
        version: INPUT_MANIFEST_VERSION,
        sourceDir,
        relativePaths: snapshotRelativePaths,
        files: [],
        sourceMtimeMs: sourceStats.mtimeMs,
        createdAt: Date.now()
      }
      await writeComfyBatchInputManifest(
        inputDir,
        sourceDir,
        snapshotRelativePaths,
        [],
        sourceStats.mtimeMs
      )
    } else if (
      inputManifest?.sourceMtimeMs !== undefined &&
      inputManifest.sourceMtimeMs !== sourceStats.mtimeMs
    ) {
      // The source folder changed structurally since the last run. Reconcile
      // only then; normal resume scans the already bounded .input queue and
      // never walks the potentially huge original folder.
      const reconciled = await reconcileComfyBatchInput(
        sourceDir,
        inputDir,
        inputManifest,
        scanOptions
      )
      sources = reconciled.sources
      snapshotRelativePaths = reconciled.snapshotRelativePaths
    } else {
      sources = await scanComfyBatchImages(inputDir, scanOptions)
      snapshotRelativePaths = inputManifest?.relativePaths.length
        ? inputManifest.relativePaths
        : sources.map((source) => source.relativePath)
      // Always refresh the input manifest after a crash or a legacy task that
      // has an .input folder but no manifest. This records source-folder mtime
      // for cheap change detection on the next resume.
      await writeComfyBatchInputManifest(
        inputDir,
        sourceDir,
        snapshotRelativePaths,
        inputManifest?.files ??
          sources.map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 })),
        sourceStats.mtimeMs
      )
    }

    const previous = await readManifest(sourceDir, this.options.runKey)
    if (!sources.length && !snapshotRelativePaths.length) {
      await fs.rm(inputDir, { recursive: true, force: true })
      throw new Error('No supported images were found in the selected folder')
    }

    const stagedSourcePaths = new Set(sources.map((source) => source.relativePath))
    const inputFilesByPath = new Map(
      (inputManifest?.files ?? []).map((file) => [file.relativePath, file] as const)
    )
    const recoveredSources: BatchSourceFile[] = []
    const retainedSnapshotPaths: string[] = []
    for (const relativePath of snapshotRelativePaths) {
      if (stagedSourcePaths.has(relativePath)) {
        retainedSnapshotPaths.push(relativePath)
        continue
      }

      // A completed input image is normally gone from .input. Check only its
      // source metadata and output marker here; hash the original source again
      // only if the output is missing or invalid and must be retried.
      const sourcePath = resolveBatchInputPath(sourceDir, relativePath)
      let sourceExists = false
      try {
        sourceExists = (await fs.stat(sourcePath)).isFile()
      } catch {
        sourceExists = false
      }
      const outputRelativePath = getComfyBatchOutputRelativePath(relativePath)
      const outputPath = path.join(outputDir, outputRelativePath)
      if (!sourceExists) {
        await fs.rm(outputPath, { force: true })
        continue
      }

      const snapshotFile = inputFilesByPath.get(relativePath)
      const previousItem = previous?.items[relativePath]
      const outputInspection = await readBatchPngInspection(outputPath)
      const expectedSha256 = snapshotFile?.sha256 ?? previousItem?.sha256
      const expectedSize = snapshotFile?.size ?? previousItem?.size
      const outputHasCurrentMarker =
        outputInspection.metadata?.sourceSha256 === expectedSha256 &&
        outputInspection.metadata?.planFingerprint === planFingerprint
      const legacySuccess =
        previousItem?.status === 'success' &&
        previousItem.size === expectedSize &&
        previousItem.sha256 === expectedSha256 &&
        previousItem.planFingerprint === planFingerprint &&
        previousItem.outputRelativePath === outputRelativePath
      if (outputInspection.valid && (outputHasCurrentMarker || legacySuccess)) {
        retainedSnapshotPaths.push(relativePath)
        continue
      }

      const recovered = await scanComfyBatchSourceFile(sourceDir, relativePath)
      if (!recovered) {
        await fs.rm(outputPath, { force: true })
        continue
      }
      await copyComfyBatchInputFile(recovered, inputDir)
      recoveredSources.push(recovered)
      retainedSnapshotPaths.push(relativePath)
      inputFilesByPath.set(relativePath, {
        relativePath,
        size: recovered.size,
        sha256: recovered.sha256
      })
    }
    if (retainedSnapshotPaths.length !== snapshotRelativePaths.length || recoveredSources.length) {
      snapshotRelativePaths = retainedSnapshotPaths
      const retainedPathSet = new Set(snapshotRelativePaths)
      sources = await scanComfyBatchImages(inputDir, scanOptions)
      await writeComfyBatchInputManifest(
        inputDir,
        sourceDir,
        snapshotRelativePaths,
        [...inputFilesByPath.values()].filter((file) => retainedPathSet.has(file.relativePath)),
        sourceStats.mtimeMs
      )
    }
    this.inputSnapshotSourceDir = sourceDir
    this.inputSnapshotSourceMtimeMs = sourceStats.mtimeMs
    this.inputSnapshotRelativePaths = [...snapshotRelativePaths]
    this.inputSnapshotFiles.clear()
    const inputSnapshotPathSet = new Set(this.inputSnapshotRelativePaths)
    for (const file of inputFilesByPath.values()) {
      if (inputSnapshotPathSet.has(file.relativePath)) {
        this.inputSnapshotFiles.set(file.relativePath, file)
      }
    }
    for (const source of sources) {
      if (source.sha256 && source.size >= 0 && source.mtimeMs >= 0) {
        this.inputSnapshotFiles.set(source.relativePath, {
          relativePath: source.relativePath,
          size: source.size,
          sha256: source.sha256
        })
      }
    }
    this.inputSnapshotDirty = false
    const sourceByPath = new Map(sources.map((source) => [source.relativePath, source]))
    assertNoComfyBatchOutputCollisions(
      snapshotRelativePaths.map(
        (relativePath) =>
          sourceByPath.get(relativePath) ?? {
            absolutePath: resolveBatchInputPath(inputDir, relativePath),
            relativePath,
            size: 0,
            mtimeMs: 0,
            sha256: ''
          }
      )
    )
    this.manifest =
      previous ||
      ({
        version: MANIFEST_VERSION,
        sourceDir,
        outputDir,
        planFingerprint,
        updatedAt: Date.now(),
        items: {}
      } satisfies ComfyBatchManifest)
    this.manifest.version = MANIFEST_VERSION
    this.manifest.sourceDir = sourceDir
    this.manifest.outputDir = outputDir
    this.manifest.planFingerprint = planFingerprint

    const currentSourcePaths = new Set(snapshotRelativePaths)
    for (const [relativePath, item] of Object.entries(this.manifest.items)) {
      if (currentSourcePaths.has(relativePath)) continue
      const staleOutputPath = resolveManifestOutputPath(outputDir, item.outputRelativePath)
      if (staleOutputPath) await fs.rm(staleOutputPath, { force: true })
      delete this.manifest.items[relativePath]
    }
    const expectedOutputPaths = new Set(
      snapshotRelativePaths.map((relativePath) => getComfyBatchOutputRelativePath(relativePath))
    )
    for (const generatedOutput of await findGeneratedBatchOutputs(outputDir, expectedOutputPaths)) {
      if (!expectedOutputPaths.has(generatedOutput)) {
        await fs.rm(path.join(outputDir, generatedOutput), { force: true })
      }
    }

    this.queue = []
    const pendingSourcePaths = new Set(sources.map((source) => source.relativePath))
    let skipped = snapshotRelativePaths.filter(
      (relativePath) => !pendingSourcePaths.has(relativePath)
    ).length
    for (const source of sources) {
      const outputRelativePath = getComfyBatchOutputRelativePath(source.relativePath)
      const outputPath = path.join(outputDir, outputRelativePath)
      if (!source.sha256) {
        // Fresh source files are discovered by path only. Their output marker
        // can be evaluated after a worker has prepared the file and computed
        // its hash, so they can enter the execution queue immediately.
        this.queue.push({ source, outputPath, outputRelativePath, staged: false })
        continue
      }
      const previousItem = this.manifest.items[source.relativePath]
      const outputInspection = await readBatchPngInspection(outputPath)
      const outputIsComplete = outputInspection.valid
      const outputHasCurrentMarker =
        outputInspection.metadata?.sourceSha256 === source.sha256 &&
        outputInspection.metadata?.planFingerprint === planFingerprint
      const legacySuccess =
        previousItem?.status === 'success' &&
        previousItem.size === source.size &&
        previousItem.sha256 === source.sha256 &&
        previousItem.planFingerprint === planFingerprint &&
        previousItem.outputRelativePath === outputRelativePath
      const unchangedSuccess = outputIsComplete && (outputHasCurrentMarker || legacySuccess)
      if (unchangedSuccess) {
        await fs.rm(source.absolutePath, { force: true }).catch(() => undefined)
        if (previousItem?.status === 'success') delete this.manifest.items[source.relativePath]
        skipped += 1
        continue
      }
      await fs.rm(outputPath, { force: true })
      this.queue.push({ source, outputPath, outputRelativePath, staged: true })
    }
    this.statusValue = {
      ...this.statusValue,
      state: 'running',
      total: snapshotRelativePaths.length,
      success: 0,
      failed: 0,
      skipped,
      running: 0,
      pending: this.queue.length,
      error: undefined,
      failedFiles: [],
      startedAt: Date.now(),
      finishedAt: undefined
    }

    await fs.mkdir(path.join(outputDir, '.magicpot-batch'), { recursive: true })
    await this.persistManifest()
    this.emit()
    if (!this.queue.length) return

    // Runtime availability is retried by the supervisor. Do not fail
    // initialization on a transient probe outage; otherwise a job can never
    // reach the bounded no-runtime policy below.
    // Runtime probing is best effort and may involve a slow/offline profile.
    // Start it in the background so a ready instance can receive work now.
    void this.refreshProfilesIfNeeded(true).catch(() => undefined)
  }

  private async prepareItem(item: PendingBatchItem): Promise<PreparedBatchSource> {
    if (!item.staged) {
      const sourcePath = item.source.absolutePath
      const before = await fs.stat(sourcePath)
      if (
        (item.source.size >= 0 && before.size !== item.source.size) ||
        (item.source.mtimeMs >= 0 && before.mtimeMs !== item.source.mtimeMs)
      ) {
        throw new Error('Batch source image changed after discovery')
      }
      await copyComfyBatchInputFile(item.source, this.inputDir)
      const after = await fs.stat(sourcePath)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('Batch source image changed while it was being staged')
      }
      item.source.absolutePath = resolveBatchInputPath(this.inputDir, item.source.relativePath)
      item.staged = true
    }
    const prepared = await this.readVerifiedSource(item)
    this.rememberInputSnapshotFile(item.source)
    return prepared
  }

  private async readVerifiedSource(item: PendingBatchItem): Promise<PreparedBatchSource> {
    const before = await fs.stat(item.source.absolutePath)
    if (
      (item.source.size >= 0 && before.size !== item.source.size) ||
      (item.source.mtimeMs >= 0 && before.mtimeMs !== item.source.mtimeMs)
    ) {
      throw new Error('Batch source image changed after scanning')
    }
    const bytes = new Uint8Array(await fs.readFile(item.source.absolutePath))
    const after = await fs.stat(item.source.absolutePath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (
      (item.source.size >= 0 && after.size !== item.source.size) ||
      (item.source.mtimeMs >= 0 && after.mtimeMs !== item.source.mtimeMs) ||
      (item.source.sha256 && sha256 !== item.source.sha256)
    ) {
      throw new Error('Batch source image changed while it was being read')
    }
    item.source.size = after.size
    item.source.mtimeMs = after.mtimeMs
    item.source.sha256 = sha256
    return { bytes, sha256 }
  }

  private async runOneOnInstance(
    item: PendingBatchItem,
    runtime: InstanceRuntime,
    prepared: PreparedBatchSource,
    onExecutionStarted?: () => void,
    onExecutionFinished?: () => void
  ): Promise<void> {
    const bytes = prepared.bytes
    const extension = path.extname(item.source.relativePath).toLowerCase()
    const uploadName = `magicpot-batch-${this.jobId}-${randomUUID()}${extension || '.png'}`
    const uploaded = await runtime.client.uploadImage(
      uploadName,
      bytes,
      this.abortController.signal
    )
    const workflow = cloneWorkflow(this.request.workflow)
    bindUploadedImage(workflow, this.imageInputBinding, uploadedValue(uploaded))
    const requestedPromptId = randomUUID()
    const clientId = `magicpot-batch-${this.jobId}-${requestedPromptId}`
    let promptId: string = requestedPromptId
    this.activePrompts.set(promptId, runtime.client)
    // Reserve the execution slot while the prompt admission request is in
    // flight. This prevents the preparation headroom from admitting another
    // item behind a prompt that is already waiting on ComfyUI.
    onExecutionStarted?.()
    try {
      promptId = await runtime.client.prompt(
        workflow,
        clientId,
        requestedPromptId,
        this.abortController.signal
      )
      if (promptId !== requestedPromptId) {
        this.activePrompts.delete(requestedPromptId)
        this.activePrompts.set(promptId, runtime.client)
      }
    } catch (error) {
      const recovery = await runtime.client.waitForPromptAdmission(
        requestedPromptId,
        this.abortController.signal,
        5_000,
        clientId
      )
      if (!recovery.admitted) {
        this.activePrompts.delete(requestedPromptId)
        throw error
      }
      promptId = recovery.promptId
      if (promptId !== requestedPromptId) {
        this.activePrompts.delete(requestedPromptId)
        this.activePrompts.set(promptId, runtime.client)
      }
    }
    try {
      const history = await waitForHistory(runtime.client, promptId, this.abortController.signal)
      // ComfyUI has finished using the GPU once history is complete. Release
      // the execution slot before downloading/committing the output so a slow
      // remote filesystem or /view response cannot leave the GPU idle.
      onExecutionFinished?.()
      const output = selectBoundOutputImage(history, this.request.outputNodeIds)
      const outputBytes = await runtime.client.view(output, this.abortController.signal)
      await atomicCommitPng(item.outputPath, outputBytes, {
        sourceSha256: item.source.sha256,
        planFingerprint: this.manifest.planFingerprint
      })
      // The output is atomically committed and validated before removing the
      // staged input. If cleanup fails, the marker lets the next resume skip
      // the item safely.
      await fs.rm(item.source.absolutePath, { force: true }).catch(() => undefined)
    } finally {
      this.activePrompts.delete(promptId)
    }
  }

  private async recordItemFailure(
    item: PendingBatchItem,
    error: unknown,
    context?: { runtime?: InstanceRuntime; startedAt?: number; attempt?: number }
  ): Promise<void> {
    const message = errorMessage(error)
    await fs.rm(item.outputPath, { force: true }).catch(() => undefined)
    this.manifest.items[item.source.relativePath] = {
      relativePath: item.source.relativePath,
      size: item.source.size,
      mtimeMs: item.source.mtimeMs,
      sha256: item.source.sha256,
      planFingerprint: this.manifest.planFingerprint,
      status: 'failed',
      outputRelativePath: item.outputRelativePath,
      error: message,
      updatedAt: Date.now()
    }
    await this.persistManifest()
    this.statusValue.failed += 1
    // Keep the first concrete failure reason so the job detail can explain
    // why the batch failed instead of replacing it with only an item count.
    this.statusValue.error ??= message
    this.statusValue.failedFiles.push(item.source.relativePath)
    const finishedAt = Date.now()
    const startedAt = context?.startedAt ?? finishedAt
    const timing: ComfyBatchItemTiming = {
      relativePath: item.source.relativePath,
      durationMs: Math.max(0, finishedAt - startedAt),
      startedAt,
      finishedAt,
      profileId: context?.runtime?.profile.id,
      attempt: context?.attempt ?? (this.itemAttempts.get(item.source.relativePath) || 1),
      state: 'failed'
    }
    this.recentItems.push(timing)
    if (this.recentItems.length > 100) this.recentItems.shift()
  }

  private async skipIfOutputCurrent(item: PendingBatchItem): Promise<boolean> {
    const previousItem = this.manifest.items[item.source.relativePath]
    const outputInspection = await readBatchPngInspection(item.outputPath)
    const outputHasCurrentMarker =
      outputInspection.metadata?.sourceSha256 === item.source.sha256 &&
      outputInspection.metadata?.planFingerprint === this.manifest.planFingerprint
    const legacySuccess =
      previousItem?.status === 'success' &&
      previousItem.size === item.source.size &&
      previousItem.mtimeMs === item.source.mtimeMs &&
      previousItem.sha256 === item.source.sha256 &&
      previousItem.planFingerprint === this.manifest.planFingerprint &&
      previousItem.outputRelativePath === item.outputRelativePath
    if (!outputInspection.valid || (!outputHasCurrentMarker && !legacySuccess)) return false

    await fs.rm(item.source.absolutePath, { force: true }).catch(() => undefined)
    if (previousItem?.status === 'success') delete this.manifest.items[item.source.relativePath]
    this.statusValue.skipped += 1
    await this.persistManifest()
    this.emit()
    return true
  }

  private async processItem(
    item: PendingBatchItem,
    initialRuntime?: InstanceRuntime
  ): Promise<void> {
    this.retryQueuedPaths.delete(item.source.relativePath)
    const tried = new Set<InstanceRuntime>()
    let runtime = initialRuntime
    let prepared: PreparedBatchSource | undefined
    let noRuntimeSince: number | undefined
    while (!this.abortController.signal.aborted) {
      if (!runtime) {
        try {
          await this.refreshProfilesIfNeeded()
        } catch {
          // A failed refresh is transient; keep retrying while the item is
          // still pending instead of converting the whole job to an error.
        }
        runtime = this.scheduler.pick(this.runtimes, tried) ?? undefined
        if (!runtime) {
          tried.clear()
          runtime = this.scheduler.pick(this.runtimes) ?? undefined
        }
        if (!runtime) {
          const configured = this.currentProfiles().some((profile) => profile.enabled !== false)
          noRuntimeSince ??= Date.now()
          if (!configured || Date.now() - noRuntimeSince >= NO_RUNTIME_RETRY_WINDOW_MS) {
            await this.recordItemFailure(item, 'No compatible ComfyUI instance is available')
            return
          }
          await new Promise((resolve) => setTimeout(resolve, SUPERVISOR_WAIT_MS))
          continue
        }
        noRuntimeSince = undefined
      }

      const activeRuntime = runtime
      tried.add(activeRuntime)
      const attempt = (this.itemAttempts.get(item.source.relativePath) || 0) + 1
      this.itemAttempts.set(item.source.relativePath, attempt)
      const startedAt = Date.now()
      this.runningItems.set(item.source.relativePath, {
        relativePath: item.source.relativePath,
        startedAt,
        profileId: activeRuntime.profile.id,
        attempt
      })
      activeRuntime.preparing += 1
      this.statusValue.running += 1
      this.emit()
      let executionStarted = false
      const markExecutionStarted = (): void => {
        if (executionStarted) return
        executionStarted = true
        activeRuntime.preparing -= 1
        activeRuntime.inflight += 1
      }
      let executionSlotReleased = false
      const releaseExecutionSlot = (): void => {
        if (executionSlotReleased || !executionStarted) return
        executionSlotReleased = true
        activeRuntime.inflight -= 1
      }
      try {
        prepared ??= await this.prepareItem(item)
        if (await this.skipIfOutputCurrent(item)) return
        await this.runOneOnInstance(
          item,
          activeRuntime,
          prepared,
          markExecutionStarted,
          releaseExecutionSlot
        )
        delete this.manifest.items[item.source.relativePath]
        await this.persistManifest()
        this.statusValue.success += 1
        const finishedAt = Date.now()
        const timing: ComfyBatchItemTiming = {
          relativePath: item.source.relativePath,
          durationMs: finishedAt - startedAt,
          startedAt,
          finishedAt,
          profileId: activeRuntime.profile.id,
          attempt,
          state: 'success'
        }
        this.recentItems.push(timing)
        if (this.recentItems.length > 100) this.recentItems.shift()
        return
      } catch (error) {
        if (this.abortController.signal.aborted) return
        if (isRetryableInstanceError(error)) {
          let hasUntriedRuntime = this.runtimes.some(
            (candidate) => candidate !== activeRuntime && !tried.has(candidate)
          )
          if (!hasUntriedRuntime) {
            // The fallback may have been unavailable during the last probe. A
            // connection failure is the signal to refresh all profiles now so
            // an instance that just came online can take over this item.
            try {
              await this.refreshProfilesIfNeeded(true)
            } catch {
              // Keep the failed runtime error as the item result if the
              // fallback probe itself is unavailable.
            }
            hasUntriedRuntime = this.runtimes.some(
              (candidate) => candidate !== activeRuntime && !tried.has(candidate)
            )
          }
          if (hasUntriedRuntime) {
            runtime = undefined
            continue
          }
        }
        await this.recordItemFailure(item, error, {
          runtime: activeRuntime,
          startedAt,
          attempt
        })
        return
      } finally {
        if (!executionStarted) activeRuntime.preparing -= 1
        releaseExecutionSlot()
        this.runningItems.delete(item.source.relativePath)
        this.statusValue.running -= 1
        this.emit()
      }
    }
  }

  retryFailedItems(): ComfyBatchStatus {
    if (this.statusValue.state !== 'running') {
      throw new Error('Cannot retry a batch that is not running')
    }

    const failedPaths = [...new Set(this.statusValue.failedFiles)].filter(
      (relativePath) => !this.retryQueuedPaths.has(relativePath)
    )
    const retryItems = failedPaths
      .map((relativePath) =>
        this.queue.find((candidate) => candidate.source.relativePath === relativePath)
      )
      .filter((item): item is PendingBatchItem => Boolean(item))
    if (!retryItems.length) return this.status

    retryItems.forEach((item) => this.retryQueuedPaths.add(item.source.relativePath))
    this.queue.splice(this.nextQueueIndex, 0, ...retryItems)
    const retriedPaths = new Set(retryItems.map((item) => item.source.relativePath))
    this.statusValue.failed = Math.max(0, this.statusValue.failed - retryItems.length)
    this.statusValue.failedFiles = this.statusValue.failedFiles.filter(
      (relativePath) => !retriedPaths.has(relativePath)
    )
    this.statusValue.pending += retryItems.length
    this.statusValue.error = undefined
    this.emit()
    return this.status
  }

  private async failPendingItems(nextIndex: number, message: string): Promise<number> {
    for (let index = nextIndex; index < this.queue.length; index += 1) {
      if (this.abortController.signal.aborted) return index
      await this.recordItemFailure(this.queue[index], message)
      this.statusValue.pending = Math.max(0, this.statusValue.pending - 1)
    }
    return this.queue.length
  }

  private async supervise(): Promise<void> {
    this.nextQueueIndex = 0
    const workers = new Set<Promise<void>>()
    let noRuntimeSince: number | undefined
    let lastSupervisorRefreshAt = 0
    while (
      !this.abortController.signal.aborted &&
      (this.nextQueueIndex < this.queue.length || workers.size > 0)
    ) {
      if (Date.now() - lastSupervisorRefreshAt >= PROFILE_RETRY_INTERVAL_MS) {
        // Successful probes publish incrementally; don't block dispatch on a
        // slower profile or a temporarily unavailable endpoint.
        void this.refreshProfilesIfNeeded().catch(() => undefined)
        lastSupervisorRefreshAt = Date.now()
      }

      while (!this.abortController.signal.aborted && this.nextQueueIndex < this.queue.length) {
        const runtime = this.scheduler.pick(this.runtimes)
        if (!runtime) break
        const item = this.queue[this.nextQueueIndex]
        this.nextQueueIndex += 1
        this.statusValue.pending = Math.max(0, this.statusValue.pending - 1)
        const task = this.processItem(item, runtime).catch(async (error) => {
          // processItem normally records item-level failures itself. Keep this
          // boundary as a last-resort guard for bookkeeping or unexpected
          // errors, but do not let one worker terminate supervision.
          if (!this.abortController.signal.aborted) {
            await this.recordItemFailure(item, error)
          }
        })
        workers.add(task)
        void task.then(
          () => workers.delete(task),
          () => workers.delete(task)
        )
      }

      if (!workers.size && this.nextQueueIndex < this.queue.length) {
        const hasConfiguredProfile = this.currentProfiles().some(
          (profile) => profile.enabled !== false
        )
        const hasUsableRuntime = this.runtimes.some(
          (runtime) => runtime.compatible && runtime.available && runtime.profile.enabled !== false
        )
        noRuntimeSince ??= Date.now()
        if (!hasConfiguredProfile) {
          this.nextQueueIndex = await this.failPendingItems(
            this.nextQueueIndex,
            'No enabled ComfyUI batch profiles'
          )
          break
        }
        if (!hasUsableRuntime && Date.now() - noRuntimeSince >= NO_RUNTIME_RETRY_WINDOW_MS) {
          this.nextQueueIndex = await this.failPendingItems(
            this.nextQueueIndex,
            'No compatible ComfyUI instance is available'
          )
          break
        }
        await new Promise((resolve) => setTimeout(resolve, SUPERVISOR_WAIT_MS))
        continue
      }
      noRuntimeSince = undefined
      if (workers.size) {
        await Promise.race([
          ...workers,
          new Promise((resolve) => setTimeout(resolve, SUPERVISOR_WAIT_MS))
        ])
      }
    }
    await Promise.allSettled(workers)
    this.statusValue.pending = Math.max(0, this.queue.length - this.nextQueueIndex)
  }

  private async cleanupCompletedInput(): Promise<void> {
    await fs.rm(this.inputDir, { recursive: true, force: true }).catch(() => undefined)
  }

  async run(): Promise<ComfyBatchStatus> {
    this.startingStatus()
    this.emit()
    try {
      await this.initialize()
      await this.supervise()
      await this.persistInputSnapshot()
      await this.manifestWriteQueue
      if (this.abortController.signal.aborted) {
        this.statusValue.state = 'cancelled'
      } else if (
        this.statusValue.failed > 0 ||
        this.statusValue.pending > 0 ||
        this.statusValue.running > 0
      ) {
        // The batch loop can finish processing every item while some items
        // still failed. Do not report that outcome as a green success: the
        // failure-only manifest is precisely what the user must retry.
        this.statusValue.state = 'error'
        this.statusValue.error ??= `${this.statusValue.failed} batch item(s) failed`
      } else {
        this.statusValue.state = 'completed'
        await this.cleanupCompletedInput()
      }
      this.statusValue.finishedAt = Date.now()
      this.emit()
      return this.status
    } catch (error) {
      await this.persistInputSnapshot().catch(() => undefined)
      this.statusValue.state = this.abortController.signal.aborted ? 'cancelled' : 'error'
      this.statusValue.error = errorMessage(error)
      this.statusValue.finishedAt = Date.now()
      this.emit()
      return this.status
    }
  }
}
