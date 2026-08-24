import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ComfyBatchProfile,
  ComfyBatchStatus,
  StartComfyBatchReq
} from '@shared/api/svcComfyBatch'
import type { ComfyHistory, FileItem, ObjectInfoMap, Workflow } from '@shared/comfy/types'
import { ComfyBatchHttpClient } from './batchHttp'

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
const HISTORY_POLL_MS = 400
const HISTORY_TIMEOUT_MS = 24 * 60 * 60 * 1000

export type BatchSourceFile = {
  absolutePath: string
  relativePath: string
  size: number
  mtimeMs: number
  sha256: string
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

type InstanceRuntime = {
  profile: ComfyBatchProfile
  client: ComfyBatchHttpClient
  inflight: number
  compatible: boolean
}

type PendingBatchItem = {
  source: BatchSourceFile
  outputPath: string
  outputRelativePath: string
}

export class ComfyExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComfyExecutionError'
  }
}

export function getComfyBatchOutputDir(sourceDir: string): string {
  const resolved = path.resolve(sourceDir)
  const parsed = path.parse(resolved)
  if (resolved === parsed.root)
    throw new Error('A filesystem root cannot be used as a batch source')
  return `${resolved}.output`
}

export function getComfyBatchManifestPath(sourceDir: string): string {
  return path.join(getComfyBatchOutputDir(sourceDir), '.magicpot-batch', 'manifest.json')
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

export async function scanComfyBatchImages(sourceDir: string): Promise<BatchSourceFile[]> {
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
      const before = await fs.stat(absolutePath)
      const bytes = await fs.readFile(absolutePath)
      const after = await fs.stat(absolutePath)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`Batch source changed while scanning: ${absolutePath}`)
      }
      result.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath),
        size: after.size,
        mtimeMs: after.mtimeMs,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    }
  }
  await visit(root)
  return result
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

export async function hasValidPngFile(filename: string): Promise<boolean> {
  try {
    return isValidPng(new Uint8Array(await fs.readFile(filename)))
  } catch {
    return false
  }
}

async function readManifest(sourceDir: string): Promise<ComfyBatchManifest | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(getComfyBatchManifestPath(sourceDir), 'utf8'))
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

export async function atomicCommitPng(filename: string, bytes: Uint8Array): Promise<void> {
  if (!isValidPng(bytes)) throw new Error('ComfyUI output is not a valid PNG')
  await atomicWriteFile(filename, bytes)
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
        (outputInfo.output_node !== true && (outputInfo.output?.length ?? 0) === 0)
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
    (item): item is FileItem & { filename: string } => item?.type === 'output' && !!item.filename
  )
  if (outputImages.length !== 1) {
    throw new Error(
      outputImages.length === 0
        ? 'No type=output image was produced by the bound output nodes'
        : 'Expected exactly one image from the bound output nodes'
    )
  }
  return outputImages[0]
}

export class LeastLoadRoundRobinScheduler<
  T extends { inflight: number; profile: { maxConcurrency: number } }
> {
  private cursor = 0

  pick(instances: T[], excluded = new Set<T>()): T | null {
    if (!instances.length) return null
    const available = instances.filter(
      (instance) =>
        !excluded.has(instance) && instance.inflight < Math.max(1, instance.profile.maxConcurrency)
    )
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
    await new Promise((resolve) => setTimeout(resolve, HISTORY_POLL_MS))
  }
  throw new Error('Timed out waiting for ComfyUI history')
}

export type ComfyBatchRunnerOptions = {
  createClient?: (baseUrl: string) => ComfyBatchHttpClient
  onStatus?: (status: ComfyBatchStatus) => void
}

export class ComfyBatchRunner {
  readonly jobId = randomUUID()
  readonly abortController = new AbortController()
  private manifest!: ComfyBatchManifest
  private imageInputBinding!: ImageInputBinding
  private queue: PendingBatchItem[] = []
  private runtimes: InstanceRuntime[] = []
  private scheduler = new LeastLoadRoundRobinScheduler<InstanceRuntime>()
  private manifestWriteQueue: Promise<void> = Promise.resolve()
  private readonly createClient: (baseUrl: string) => ComfyBatchHttpClient
  private readonly activePrompts = new Map<string, ComfyBatchHttpClient>()
  private statusValue: ComfyBatchStatus

  constructor(
    private readonly request: StartComfyBatchReq,
    private readonly profiles: ComfyBatchProfile[],
    private readonly options: ComfyBatchRunnerOptions = {}
  ) {
    this.createClient = options.createClient ?? ((baseUrl) => new ComfyBatchHttpClient(baseUrl))
    this.statusValue = {
      jobId: this.jobId,
      state: 'idle',
      sourceDir: path.resolve(request.sourceDir),
      outputDir: getComfyBatchOutputDir(request.sourceDir),
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
    return { ...this.statusValue, failedFiles: [...this.statusValue.failedFiles] }
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
    const outputDir = getComfyBatchOutputDir(sourceDir)
    const planFingerprint = buildComfyBatchPlanFingerprint(this.request)
    this.statusValue.planFingerprint = planFingerprint
    const sources = await scanComfyBatchImages(sourceDir)
    if (!sources.length) throw new Error('No supported images were found in the selected folder')
    assertNoComfyBatchOutputCollisions(sources)
    const previous = await readManifest(sourceDir)
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

    const currentSourcePaths = new Set(sources.map((source) => source.relativePath))
    for (const [relativePath, item] of Object.entries(this.manifest.items)) {
      if (currentSourcePaths.has(relativePath)) continue
      await fs.rm(path.join(outputDir, item.outputRelativePath), { force: true })
      delete this.manifest.items[relativePath]
    }

    this.queue = []
    let skipped = 0
    for (const source of sources) {
      const outputRelativePath = getComfyBatchOutputRelativePath(source.relativePath)
      const outputPath = path.join(outputDir, outputRelativePath)
      const previousItem = this.manifest.items[source.relativePath]
      const unchangedSuccess =
        previousItem?.status === 'success' &&
        previousItem.size === source.size &&
        previousItem.mtimeMs === source.mtimeMs &&
        previousItem.sha256 === source.sha256 &&
        previousItem.planFingerprint === planFingerprint &&
        previousItem.outputRelativePath === outputRelativePath &&
        (await hasValidPngFile(outputPath))
      if (unchangedSuccess) {
        skipped += 1
        continue
      }
      await fs.rm(outputPath, { force: true })
      this.queue.push({ source, outputPath, outputRelativePath })
    }
    this.statusValue = {
      ...this.statusValue,
      state: 'running',
      total: sources.length,
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

    const enabled = this.profiles.filter((profile) => profile.enabled)
    if (!enabled.length) throw new Error('No enabled ComfyUI batch profiles')
    const probes = await Promise.allSettled(
      enabled.map(async (profile) => {
        const client = this.createClient(profile.baseUrl)
        await client.probe()
        const objectInfo = await client.objectInfo(this.abortController.signal)
        const compatible = hasCompatibleNodeClasses(this.request.workflow, objectInfo)
        if (compatible) {
          validateComfyBatchBindings(
            this.request.workflow,
            this.request.imageInputSlot,
            this.request.outputNodeIds,
            objectInfo
          )
        }
        return {
          profile,
          client,
          inflight: 0,
          compatible
        }
      })
    )
    this.runtimes = probes.flatMap((probe) => (probe.status === 'fulfilled' ? [probe.value] : []))
    this.runtimes = this.runtimes.filter((runtime) => runtime.compatible)
    if (!this.runtimes.length)
      throw new Error('No enabled ComfyUI instance supports all workflow nodes')
  }

  private async readVerifiedSource(item: PendingBatchItem): Promise<Uint8Array> {
    const before = await fs.stat(item.source.absolutePath)
    if (before.size !== item.source.size || before.mtimeMs !== item.source.mtimeMs) {
      throw new Error('Batch source image changed after scanning')
    }
    const bytes = new Uint8Array(await fs.readFile(item.source.absolutePath))
    const after = await fs.stat(item.source.absolutePath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (
      after.size !== item.source.size ||
      after.mtimeMs !== item.source.mtimeMs ||
      sha256 !== item.source.sha256
    ) {
      throw new Error('Batch source image changed while it was being read')
    }
    return bytes
  }

  private async runOneOnInstance(item: PendingBatchItem, runtime: InstanceRuntime): Promise<void> {
    const bytes = await this.readVerifiedSource(item)
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
    let promptId: string = requestedPromptId
    this.activePrompts.set(promptId, runtime.client)
    try {
      promptId = await runtime.client.prompt(
        workflow,
        `magicpot-batch-${this.jobId}`,
        requestedPromptId,
        this.abortController.signal
      )
      if (promptId !== requestedPromptId) {
        this.activePrompts.delete(requestedPromptId)
        this.activePrompts.set(promptId, runtime.client)
      }
    } catch (error) {
      const recovered = await runtime.client.waitForPromptAdmission(
        requestedPromptId,
        this.abortController.signal
      )
      if (!recovered) {
        this.activePrompts.delete(requestedPromptId)
        throw error
      }
    }
    try {
      const history = await waitForHistory(runtime.client, promptId, this.abortController.signal)
      const output = selectBoundOutputImage(history, this.request.outputNodeIds)
      const outputBytes = await runtime.client.view(output, this.abortController.signal)
      await atomicCommitPng(item.outputPath, outputBytes)
    } finally {
      this.activePrompts.delete(promptId)
    }
  }

  private async processItem(item: PendingBatchItem): Promise<void> {
    const tried = new Set<InstanceRuntime>()
    let executionSwitches = 0
    while (true) {
      const runtime = this.scheduler.pick(this.runtimes, tried)
      if (!runtime) throw new Error('No compatible ComfyUI instance is available')
      tried.add(runtime)
      runtime.inflight += 1
      this.statusValue.running += 1
      this.emit()
      try {
        await this.runOneOnInstance(item, runtime)
        this.manifest.items[item.source.relativePath] = {
          relativePath: item.source.relativePath,
          size: item.source.size,
          mtimeMs: item.source.mtimeMs,
          sha256: item.source.sha256,
          planFingerprint: this.manifest.planFingerprint,
          status: 'success',
          outputRelativePath: item.outputRelativePath,
          updatedAt: Date.now()
        }
        await this.persistManifest()
        this.statusValue.success += 1
        return
      } catch (error) {
        if (
          error instanceof ComfyExecutionError &&
          executionSwitches < 1 &&
          this.runtimes.some((candidate) => !tried.has(candidate))
        ) {
          executionSwitches += 1
          continue
        }
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
        this.statusValue.failedFiles.push(item.source.relativePath)
        return
      } finally {
        runtime.inflight -= 1
        this.statusValue.running -= 1
        this.emit()
      }
    }
  }

  async run(): Promise<ComfyBatchStatus> {
    this.startingStatus()
    this.emit()
    try {
      await this.initialize()
      const workerCount = Math.max(
        1,
        this.runtimes.reduce((sum, runtime) => sum + Math.max(1, runtime.profile.maxConcurrency), 0)
      )
      let nextIndex = 0
      const workers = Array.from({ length: workerCount }, async () => {
        while (!this.abortController.signal.aborted) {
          const index = nextIndex
          const item = this.queue[index]
          if (!item) break
          nextIndex += 1
          this.statusValue.pending = Math.max(0, this.statusValue.pending - 1)
          await this.processItem(item)
        }
      })
      await Promise.all(workers)
      await this.manifestWriteQueue
      this.statusValue.state = this.abortController.signal.aborted ? 'cancelled' : 'completed'
      this.statusValue.pending = Math.max(0, this.queue.length - nextIndex)
      this.statusValue.finishedAt = Date.now()
      this.emit()
      return this.status
    } catch (error) {
      this.statusValue.state = this.abortController.signal.aborted ? 'cancelled' : 'error'
      this.statusValue.error = errorMessage(error)
      this.statusValue.finishedAt = Date.now()
      this.emit()
      return this.status
    }
  }
}
