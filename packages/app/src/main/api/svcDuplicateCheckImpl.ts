import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type {
  DuplicateCheckComparableImage,
  DuplicateCheckVisualAnalysisImage,
  DuplicateCheckVisualAnalysisPairMode,
  DuplicateCheckVisualAnalysisPairResult,
  DuplicateCheckVisualAnalysisReq,
  DuplicateCheckVisualAnalysisResult,
  DuplicateCheckMatch,
  DuplicateCheckQueryResult,
  DuplicateCheckRunEvent,
  DuplicateCheckRunReq,
  DuplicateCheckRunResult,
  DuplicateCheckSkippedImage,
  DuplicateCheckScoreBundle,
  DuplicateCheckSvc
} from '@shared/api/svcDuplicateCheck'
import { ConfigUtils } from '@shared/config/configUtils'
import type {
  DuplicateCheckMatchLevel,
  DuplicateCheckMethod,
  DuplicateCheckVisualModelConfig
} from '@shared/duplicateCheck/types'
import { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig } from '../config/config'
import { createPortablePythonEnv } from '../config/portablePaths'
import { DuplicateCheckCacheStore, type CachedBlobFeatureEntry } from '../duplicateCheck/cacheStore'
import {
  computeBasicImageHashes,
  computeSha256,
  hammingDistanceFromHex
} from '../duplicateCheck/imageFeatures'
import {
  isSvgImageDescriptor,
  looksLikeSvgBuffer,
  rasterizeSvgToPngBuffer
} from '../duplicateCheck/svgRasterizer'
import { resolveDuplicateCheckTempRoot } from '../duplicateCheck/tempArtifacts'

type PreparedImage = {
  descriptor: DuplicateCheckComparableImage
  buffer?: Buffer
  tempPath?: string
  tempExtension?: string
  tempMimeType?: string
  sha256: string
  width: number
  height: number
  pHash: string
  dHash: string
  visualSimilarityByModel: Record<string, number>
  robustnessSimilarityByModel: Record<string, number>
  embeddingsByModel: Record<string, number[]>
  robustEmbeddingsByModel: Record<string, number[]>
}

type PreparedImageContext = {
  cache: DuplicateCheckCacheStore | null
  cacheHitCount: number
  cacheMissCount: number
}

type PythonWorkerOutput = {
  provider?: string
  items?: Array<{
    id: string
    embedding?: number[]
    robustEmbedding?: number[]
    error?: string
  }>
}

export type DuplicateCheckWorkerHandle = {
  process: ChildProcessWithoutNullStreams
  terminate: (reason?: Error) => Promise<void>
}

export type DuplicateCheckWorkerProcessOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  deadlineMs?: number
  terminationGraceMs?: number
  forceKillWaitMs?: number
  maxStderrBytes?: number
  setActiveWorker?: (worker: DuplicateCheckWorkerHandle | null) => void
}

const DEFAULT_WORKER_DEADLINE_MS = 15 * 60 * 1000
const DEFAULT_WORKER_TERMINATION_GRACE_MS = 3 * 1000
const DEFAULT_WORKER_FORCE_KILL_WAIT_MS = 5 * 1000
const DEFAULT_WORKER_MAX_STDERR_BYTES = 64 * 1024
const TASKKILL_WAIT_MS = 2 * 1000

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, durationMs)))

const runWindowsTaskkill = async (pid: number, force: boolean): Promise<boolean> => {
  const args = ['/PID', String(pid), '/T']
  if (force) {
    args.push('/F')
  }

  return new Promise((resolve) => {
    let settled = false
    const taskkill = spawn('taskkill.exe', args, {
      stdio: 'ignore',
      windowsHide: true
    })
    const timeout = setTimeout(() => {
      taskkill.kill('SIGKILL')
      finish(false)
    }, TASKKILL_WAIT_MS)
    function finish(success: boolean) {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(success)
    }

    taskkill.once('error', () => finish(false))
    taskkill.once('close', (code) => finish(code === 0))
  })
}

const signalWorkerTree = async (
  child: ChildProcessWithoutNullStreams,
  signal: 'SIGTERM' | 'SIGKILL'
): Promise<void> => {
  if (!child.pid) {
    return
  }

  if (process.platform === 'win32') {
    const taskkillSucceeded = await runWindowsTaskkill(child.pid, signal === 'SIGKILL')
    if (taskkillSucceeded) {
      return
    }
  } else {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The process group may already be gone or unavailable; fall back to the direct child.
    }
  }

  try {
    child.kill(signal)
  } catch {
    // The worker may have exited between the liveness check and the signal.
  }
}

/** Runs the worker process boundary without loading an ONNX model in the host process. */
export const runDuplicateCheckWorkerProcess = async (
  command: string,
  args: string[],
  options: DuplicateCheckWorkerProcessOptions
): Promise<void> => {
  const deadlineMs = Math.max(1, options.deadlineMs ?? DEFAULT_WORKER_DEADLINE_MS)
  const terminationGraceMs = Math.max(
    0,
    options.terminationGraceMs ?? DEFAULT_WORKER_TERMINATION_GRACE_MS
  )
  const forceKillWaitMs = Math.max(0, options.forceKillWaitMs ?? DEFAULT_WORKER_FORCE_KILL_WAIT_MS)
  const maxStderrBytes = Math.max(0, options.maxStderrBytes ?? DEFAULT_WORKER_MAX_STDERR_BYTES)
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    windowsHide: true
  })

  let closed = false
  let processGroupGone = false
  let settled = false
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stderrTruncated = false
  let terminalError: Error | null = null
  let terminatePromise: Promise<void> | null = null
  let resolveClosed: () => void = () => undefined
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const appendStderr = (chunk: Buffer | string) => {
    if (maxStderrBytes === 0) {
      stderrTruncated = true
      return
    }
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (incoming.length >= maxStderrBytes) {
      stderrTruncated = stderr.length > 0 || incoming.length > maxStderrBytes
      stderr = incoming.subarray(incoming.length - maxStderrBytes)
      return
    }
    const retainedBytes = Math.min(stderr.length, maxStderrBytes - incoming.length)
    if (retainedBytes < stderr.length) {
      stderrTruncated = true
    }
    stderr = Buffer.concat([stderr.subarray(stderr.length - retainedBytes), incoming])
  }

  const formatStderr = (): string => {
    const captured = stderr.toString('utf8').trim()
    return stderrTruncated
      ? `[stderr truncated to last ${maxStderrBytes} bytes]\n${captured}`
      : captured
  }

  let resolveRun: () => void = () => undefined
  let rejectRun: (error: Error) => void = () => undefined
  const runPromise = new Promise<void>((resolve, reject) => {
    resolveRun = resolve
    rejectRun = reject
  })
  const finish = (error?: Error) => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(deadline)
    options.setActiveWorker?.(null)
    if (error) {
      rejectRun(error)
    } else {
      resolveRun()
    }
  }

  const isWorkerTreeAlive = (): boolean => {
    if (process.platform === 'win32' || !child.pid) {
      return !closed
    }
    if (processGroupGone) {
      return false
    }
    try {
      process.kill(-child.pid, 0)
      return true
    } catch {
      processGroupGone = true
      return false
    }
  }

  const waitForWorkerTreeExit = async (durationMs: number): Promise<boolean> => {
    const expiresAt = Date.now() + durationMs
    while (isWorkerTreeAlive()) {
      const remainingMs = expiresAt - Date.now()
      if (remainingMs <= 0) {
        return false
      }
      await Promise.race([closedPromise, delay(Math.min(25, remainingMs))])
      if (closed && process.platform === 'win32') {
        return true
      }
    }
    return true
  }

  const waitForChildClose = async (durationMs: number): Promise<boolean> => {
    if (!closed) {
      await Promise.race([closedPromise, delay(durationMs)])
    }
    return closed
  }

  const handle: DuplicateCheckWorkerHandle = {
    process: child,
    terminate: (reason = new Error('Visual model worker was cancelled')) => {
      terminalError ||= reason
      if (!terminatePromise) {
        terminatePromise = (async () => {
          await signalWorkerTree(child, 'SIGTERM')
          if (await waitForWorkerTreeExit(terminationGraceMs)) {
            if (await waitForChildClose(forceKillWaitMs)) {
              return
            }
          }

          await signalWorkerTree(child, 'SIGKILL')
          if (await waitForWorkerTreeExit(forceKillWaitMs)) {
            if (await waitForChildClose(forceKillWaitMs)) {
              return
            }
          }

          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          finish(terminalError || reason)
        })()
      }
      return terminatePromise
    }
  }

  child.stderr.on('data', appendStderr)
  child.once('error', (error) => {
    closed = true
    resolveClosed()
    finish(terminalError || error)
  })
  child.once('close', (code, signal) => {
    closed = true
    resolveClosed()
    if (terminalError) {
      finish(terminalError)
      return
    }
    if (code === 0) {
      finish()
      return
    }

    const capturedStderr = formatStderr()
    finish(
      new Error(
        capturedStderr ||
          `Visual model worker exited with ${code === null ? `signal ${signal || 'unknown'}` : `code ${code}`}`
      )
    )
  })

  options.setActiveWorker?.(handle)
  const deadline = setTimeout(() => {
    void handle.terminate(new Error(`Visual model worker exceeded its ${deadlineMs} ms deadline`))
  }, deadlineMs)

  return runPromise
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.ico'])

const stripComparableData = (
  image: DuplicateCheckComparableImage
): DuplicateCheckComparableImage => ({
  ...image,
  data: undefined
})

const normalizeFilePath = (value: string | undefined): string =>
  value ? path.resolve(value).replace(/\\/g, '/').toLowerCase() : ''

const inferExtension = (image: DuplicateCheckComparableImage): string => {
  const nameExtension = path.extname(image.name || '').trim()
  if (nameExtension) {
    return nameExtension
  }

  if (image.mimeType?.startsWith('image/')) {
    return `.${image.mimeType.slice('image/'.length).replace('svg+xml', 'svg')}`
  }

  return '.png'
}

const inferPreparedImageExtension = (image: PreparedImage): string =>
  image.tempExtension || inferExtension(image.descriptor)

const normalizePrepareImageErrorMessage = (
  image: DuplicateCheckComparableImage,
  error: unknown
): string => {
  const rawMessage = error instanceof Error ? error.message : String(error || '')
  const imageName = image.name || image.sourcePath || image.id

  if (rawMessage.includes('Image source is unavailable')) {
    return `无法读取图片“${imageName}”的源数据`
  }

  if (rawMessage.includes('Unsupported or invalid image payload')) {
    return `图片“${imageName}”格式不受支持，或图片数据已损坏`
  }

  if (rawMessage.includes('SVG external references are unsupported')) {
    return (
      '\u56fe\u7247\u201c' +
      imageName +
      '\u201d\u5305\u542b\u5916\u90e8 SVG \u8d44\u6e90\u5f15\u7528\uff0c\u6682\u4e0d\u652f\u6301\u68c0\u67e5'
    )
  }

  if (rawMessage.includes('SVG script content is unsupported')) {
    return (
      '\u56fe\u7247\u201c' +
      imageName +
      '\u201d\u5305\u542b SVG \u811a\u672c\u5185\u5bb9\uff0c\u6682\u4e0d\u652f\u6301\u68c0\u67e5'
    )
  }

  if (rawMessage.includes('SVG rasterization failed')) {
    return (
      '\u65e0\u6cd5\u5c06\u56fe\u7247\u201c' +
      imageName +
      '\u201d\u8f6c\u6362\u4e3a\u53ef\u68c0\u67e5\u7684\u4f4d\u56fe'
    )
  }

  if (rawMessage.includes('Image dimensions are unavailable')) {
    return `无法读取图片“${imageName}”的尺寸信息`
  }

  if (/[\u4e00-\u9fff]/.test(rawMessage)) {
    return rawMessage
  }

  return `处理图片“${imageName}”时失败：${rawMessage || '未知错误'}`
}

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

const listFolderFiles = async (
  folderPath: string,
  recursive: boolean,
  imageExtensions: string[]
): Promise<DuplicateCheckComparableImage[]> => {
  if (!folderPath || !(await pathExists(folderPath))) {
    return []
  }

  const normalizedExtensions = new Set(
    imageExtensions
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
      .map((value) => (value.startsWith('.') ? value : `.${value}`))
  )

  const queue = [folderPath]
  const results: DuplicateCheckComparableImage[] = []

  while (queue.length > 0) {
    const currentDir = queue.shift()
    if (!currentDir) {
      continue
    }

    let entries
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (recursive) {
          queue.push(fullPath)
        }
        continue
      }
      if (!entry.isFile()) {
        continue
      }

      const extension = path.extname(entry.name).toLowerCase()
      if (normalizedExtensions.size > 0) {
        if (!normalizedExtensions.has(extension)) {
          continue
        }
      } else if (!IMAGE_EXTENSIONS.has(extension)) {
        continue
      }

      results.push({
        id: `folder:${fullPath}`,
        name: entry.name,
        sourcePath: fullPath,
        originLabel: currentDir
      })
    }
  }

  return results
}

const cosineSimilarity = (left: readonly number[], right: readonly number[]): number => {
  if (left.length === 0 || left.length !== right.length) {
    return 0
  }

  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] * left[index]
    rightMagnitude += right[index] * right[index]
  }

  if (leftMagnitude <= 0 || rightMagnitude <= 0) {
    return 0
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

const sanitizeModelConfig = (
  model: DuplicateCheckVisualModelConfig
): DuplicateCheckVisualModelConfig => ({
  ...model,
  mean: Array.isArray(model.mean) && model.mean.length === 3 ? model.mean : [0.5, 0.5, 0.5],
  std: Array.isArray(model.std) && model.std.length === 3 ? model.std : [0.5, 0.5, 0.5]
})

const mergeBlobCacheEntry = (
  existing: CachedBlobFeatureEntry | null,
  next: PreparedImage,
  providerByModel: Record<string, string>
): CachedBlobFeatureEntry => {
  const mergedEmbeddings = { ...(existing?.embeddings || {}) }
  for (const [modelId, embedding] of Object.entries(next.embeddingsByModel)) {
    mergedEmbeddings[modelId] = {
      embedding,
      robustEmbedding: next.robustEmbeddingsByModel[modelId],
      provider: providerByModel[modelId],
      updatedAt: new Date().toISOString()
    }
  }

  return {
    sha256: next.sha256,
    width: next.width,
    height: next.height,
    dHash: next.dHash,
    pHash: next.pHash,
    embeddings: mergedEmbeddings,
    updatedAt: new Date().toISOString()
  }
}

const resolvePythonCommand = (
  visualModels: DuplicateCheckVisualModelConfig[],
  useGpu: boolean
): string => {
  const config = getConfig()
  const buildEnv = getBuildEnv()
  const configUtils = new ConfigUtils(config, buildEnv, path)
  const duplicateSettings = config.plugin_config?.duplicateCheck

  if (!visualModels.length && !useGpu) {
    return ''
  }

  if (!duplicateSettings?.reuseComfyPython && duplicateSettings?.pythonCommandOverride?.trim()) {
    return duplicateSettings.pythonCommandOverride.trim()
  }

  const [pythonCmd, available] = configUtils.getPythonCmd()
  if (available) {
    return pythonCmd
  }

  if (duplicateSettings?.pythonCommandOverride?.trim()) {
    return duplicateSettings.pythonCommandOverride.trim()
  }

  return ''
}

const resolveWorkerScriptPath = (): string => {
  const buildEnv = getBuildEnv()
  return path.join(buildEnv.pathMap.resources, 'duplicateCheckWorker.py')
}

const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true })
}

const buildVisualAnalysisGroupKey = (image: DuplicateCheckVisualAnalysisImage): string =>
  `${image.groupKind}:${image.groupLabel || ''}`

const resolveVisualAnalysisPairMode = (
  images: DuplicateCheckVisualAnalysisImage[],
  requestedPairMode?: DuplicateCheckVisualAnalysisPairMode
): DuplicateCheckVisualAnalysisPairMode => {
  if (requestedPairMode) {
    return requestedPairMode
  }

  const groupKeys = new Set(images.map((image) => buildVisualAnalysisGroupKey(image)))
  return groupKeys.size > 1 ? 'cross_group' : 'all_pairs'
}

const mapWithConcurrency = async <T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(values.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(values[index], index)
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, values.length))
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

export class DuplicateCheckSvcImpl implements DuplicateCheckSvc {
  async runVisualAnalysis(
    req: DuplicateCheckVisualAnalysisReq
  ): Promise<DuplicateCheckVisualAnalysisResult> {
    const normalizedImages = Array.from(
      new Map(
        (Array.isArray(req.images) ? req.images : [])
          .filter((image) => image && image.id && image.name)
          .map((image) => [image.id, image] as const)
      ).values()
    )
    if (!req.modelId?.trim()) {
      throw new Error('A local model is required for target visual analysis')
    }
    if (normalizedImages.length === 0) {
      throw new Error('No compatible images were supplied for target visual analysis')
    }

    const buildEnv = getBuildEnv()
    const config = getConfig()
    const duplicateSettings = config.plugin_config?.duplicateCheck
    const selectedModel =
      duplicateSettings?.visualModels?.find(
        (model) => model.id === req.modelId && model.enabled && model.modelPath.trim()
      ) || null
    if (!selectedModel) {
      throw new Error(`Local model is unavailable: ${req.modelId}`)
    }

    const cacheRoot =
      duplicateSettings?.cacheDir?.trim() ||
      path.join(buildEnv.pathMap.data, 'duplicate-check-cache')
    const cache = duplicateSettings?.enableCache ? new DuplicateCheckCacheStore(cacheRoot) : null
    const context: PreparedImageContext = {
      cache,
      cacheHitCount: 0,
      cacheMissCount: 0
    }

    const duplicateCheckTempRoot = resolveDuplicateCheckTempRoot()
    await fs.mkdir(duplicateCheckTempRoot, { recursive: true })
    const tempDir = await fs.mkdtemp(path.join(duplicateCheckTempRoot, 'magicpot-visual-analysis-'))
    let currentPythonWorker: DuplicateCheckWorkerHandle | null = null

    try {
      const preparedImages = await mapWithConcurrency(
        normalizedImages,
        Math.max(1, duplicateSettings?.maxConcurrency || 4),
        async (image) => this.prepareImage(image, context, { requireVisualPayload: true })
      )

      const pythonCmd = resolvePythonCommand(
        [selectedModel],
        Boolean(duplicateSettings?.gpuAcceleration)
      )
      if (!pythonCmd) {
        throw new Error('No Python runtime is available for the local model backend')
      }

      const workerScriptPath = resolveWorkerScriptPath()
      if (!(await pathExists(workerScriptPath))) {
        throw new Error(`Visual analysis worker script is missing: ${workerScriptPath}`)
      }

      const output = await this.runVisualModelWorker(
        pythonCmd,
        workerScriptPath,
        selectedModel,
        preparedImages,
        Boolean(duplicateSettings?.gpuAcceleration),
        duplicateSettings?.fallbackToCpu !== false,
        Math.max(1, duplicateSettings?.batchSize || 8),
        true,
        tempDir,
        (worker) => {
          currentPythonWorker = worker
        }
      )

      const provider = output.provider || 'CPUExecutionProvider'
      const warnings = (output.items || [])
        .filter((item) => item.error)
        .map((item) => `Image ${item.id}: ${item.error}`)
      const resultById = new Map((output.items || []).map((item) => [item.id, item]))

      for (const image of preparedImages) {
        const result = resultById.get(image.descriptor.id)
        if (!result || !Array.isArray(result.embedding) || result.embedding.length === 0) {
          continue
        }

        image.embeddingsByModel[selectedModel.id] = result.embedding
        if (Array.isArray(result.robustEmbedding) && result.robustEmbedding.length > 0) {
          image.robustEmbeddingsByModel[selectedModel.id] = result.robustEmbedding
        }

        if (cache) {
          await cache.upsertBlob(
            mergeBlobCacheEntry(await cache.getBlob(image.sha256), image, {
              [selectedModel.id]: provider
            })
          )
          if (image.descriptor.sourcePath) {
            const stats = await fs.stat(image.descriptor.sourcePath)
            await cache.upsertFile(
              image.descriptor.sourcePath,
              stats.size,
              stats.mtimeMs,
              image.sha256
            )
          }
        }
      }

      const sourceImageById = new Map(normalizedImages.map((image) => [image.id, image]))
      const pairMode = resolveVisualAnalysisPairMode(normalizedImages, req.pairMode)
      const pairResults: DuplicateCheckVisualAnalysisPairResult[] = []

      for (let leftIndex = 0; leftIndex < preparedImages.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < preparedImages.length; rightIndex += 1) {
          const leftPrepared = preparedImages[leftIndex]
          const rightPrepared = preparedImages[rightIndex]
          const leftSource = sourceImageById.get(leftPrepared.descriptor.id)
          const rightSource = sourceImageById.get(rightPrepared.descriptor.id)
          if (!leftSource || !rightSource) {
            continue
          }

          if (
            pairMode === 'cross_group' &&
            buildVisualAnalysisGroupKey(leftSource) === buildVisualAnalysisGroupKey(rightSource)
          ) {
            continue
          }

          const leftEmbedding = leftPrepared.embeddingsByModel[selectedModel.id]
          const rightEmbedding = rightPrepared.embeddingsByModel[selectedModel.id]
          const leftRobustEmbedding = leftPrepared.robustEmbeddingsByModel[selectedModel.id]
          const rightRobustEmbedding = rightPrepared.robustEmbeddingsByModel[selectedModel.id]

          pairResults.push({
            leftImageId: leftSource.id,
            leftName: leftSource.name,
            leftGroupKind: leftSource.groupKind,
            leftGroupLabel: leftSource.groupLabel,
            rightImageId: rightSource.id,
            rightName: rightSource.name,
            rightGroupKind: rightSource.groupKind,
            rightGroupLabel: rightSource.groupLabel,
            visualSimilarity:
              Array.isArray(leftEmbedding) && Array.isArray(rightEmbedding)
                ? cosineSimilarity(leftEmbedding, rightEmbedding)
                : null,
            robustnessSimilarity:
              Array.isArray(leftRobustEmbedding) && Array.isArray(rightRobustEmbedding)
                ? cosineSimilarity(leftRobustEmbedding, rightRobustEmbedding)
                : null
          })
        }
      }

      pairResults.sort((left, right) => {
        const leftScore = Math.max(left.robustnessSimilarity ?? -1, left.visualSimilarity ?? -1)
        const rightScore = Math.max(right.robustnessSimilarity ?? -1, right.visualSimilarity ?? -1)
        return rightScore - leftScore
      })

      await cache?.save()

      return {
        modelId: selectedModel.id,
        modelName: selectedModel.name,
        provider,
        warnings,
        imageCount: normalizedImages.length,
        pairMode,
        groups: Array.from(
          normalizedImages.reduce<
            Map<
              string,
              {
                kind: DuplicateCheckVisualAnalysisImage['groupKind']
                label: string
                imageCount: number
              }
            >
          >((groups, image) => {
            const key = buildVisualAnalysisGroupKey(image)
            const current = groups.get(key)
            groups.set(key, {
              kind: image.groupKind,
              label: image.groupLabel || image.groupKind,
              imageCount: (current?.imageCount || 0) + 1
            })
            return groups
          }, new Map())
        ).map(([, group]) => group),
        pairResults
      }
    } finally {
      if (currentPythonWorker) {
        await currentPythonWorker.terminate()
      }
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures
      }
      currentPythonWorker = null
    }
  }

  private async prepareImage(
    image: DuplicateCheckComparableImage,
    context: PreparedImageContext,
    options: {
      requireVisualPayload: boolean
    }
  ): Promise<PreparedImage> {
    const normalizedDescriptor = stripComparableData(image)
    const hasPath = Boolean(normalizedDescriptor.sourcePath?.trim())
    const isSvgDescriptor = isSvgImageDescriptor(normalizedDescriptor)
    let buffer: Buffer | undefined
    let cached: CachedBlobFeatureEntry | null = null
    let size = 0
    let mtimeMs = 0
    let tempExtension: string | undefined
    let tempMimeType: string | undefined
    let shouldKeepRasterizedBuffer = false

    if (hasPath && normalizedDescriptor.sourcePath) {
      const stats = await fs.stat(normalizedDescriptor.sourcePath)
      size = stats.size
      mtimeMs = stats.mtimeMs
      cached =
        (await context.cache?.getFile(normalizedDescriptor.sourcePath, size, mtimeMs)) || null
      if (cached) {
        context.cacheHitCount += 1
      }
    }

    if (!cached || (isSvgDescriptor && options.requireVisualPayload)) {
      const sourceBuffer = image.data
        ? Buffer.from(image.data)
        : image.sourcePath
          ? await fs.readFile(image.sourcePath)
          : undefined

      if (!sourceBuffer) {
        throw new Error(`Image source is unavailable: ${normalizedDescriptor.name}`)
      }

      const isSvgPayload = isSvgDescriptor || looksLikeSvgBuffer(sourceBuffer)
      let workingBuffer = sourceBuffer
      let workingMimeType = normalizedDescriptor.mimeType
      if (isSvgPayload) {
        const rasterized = await rasterizeSvgToPngBuffer(sourceBuffer)
        workingBuffer = Buffer.from(rasterized.pngBuffer)
        workingMimeType = 'image/png'
        tempExtension = '.png'
        tempMimeType = 'image/png'
        buffer = Buffer.from(rasterized.pngBuffer)
        shouldKeepRasterizedBuffer = options.requireVisualPayload
      } else {
        buffer = sourceBuffer
      }

      if (!cached) {
        const sha256 = computeSha256(workingBuffer)
        cached = (await context.cache?.getBlob(sha256)) || null

        if (!cached) {
          let hashes: ReturnType<typeof computeBasicImageHashes>
          try {
            hashes = computeBasicImageHashes({
              buffer: workingBuffer,
              sourcePath: tempMimeType ? undefined : normalizedDescriptor.sourcePath,
              mimeType: workingMimeType,
              name: normalizedDescriptor.name
            })
          } catch (error) {
            throw new Error(normalizePrepareImageErrorMessage(normalizedDescriptor, error))
          }
          cached = {
            sha256: hashes.sha256,
            width: hashes.width,
            height: hashes.height,
            dHash: hashes.dHash,
            pHash: hashes.pHash,
            embeddings: {},
            updatedAt: new Date().toISOString()
          }
          context.cacheMissCount += 1
        } else {
          context.cacheHitCount += 1
        }

        if (context.cache) {
          await context.cache.upsertBlob(cached)
          if (hasPath && normalizedDescriptor.sourcePath) {
            await context.cache.upsertFile(
              normalizedDescriptor.sourcePath,
              size,
              mtimeMs,
              cached.sha256
            )
          }
        }
      }
    }

    return {
      descriptor: normalizedDescriptor,
      buffer:
        buffer && (!normalizedDescriptor.sourcePath || shouldKeepRasterizedBuffer)
          ? buffer
          : undefined,
      tempExtension,
      tempMimeType,
      sha256: cached.sha256,
      width: cached.width,
      height: cached.height,
      dHash: cached.dHash,
      pHash: cached.pHash,
      visualSimilarityByModel: {},
      robustnessSimilarityByModel: {},
      embeddingsByModel: Object.fromEntries(
        Object.entries(cached.embeddings || {}).map(([modelId, entry]) => [
          modelId,
          entry.embedding
        ])
      ),
      robustEmbeddingsByModel: Object.fromEntries(
        Object.entries(cached.embeddings || {})
          .filter(
            ([, entry]) => Array.isArray(entry.robustEmbedding) && entry.robustEmbedding.length > 0
          )
          .map(([modelId, entry]) => [modelId, entry.robustEmbedding as number[]])
      )
    }
  }

  private async ensureTempPath(image: PreparedImage, tempDir: string): Promise<string> {
    if (image.descriptor.sourcePath?.trim() && !image.buffer) {
      return image.descriptor.sourcePath
    }

    if (image.tempPath) {
      return image.tempPath
    }

    if (!image.buffer) {
      throw new Error(`Missing in-memory payload for ${image.descriptor.name}`)
    }

    await ensureDir(tempDir)
    const tempFilePath = path.join(
      tempDir,
      `${image.descriptor.id.replace(/[^a-zA-Z0-9_-]/g, '_')}${inferPreparedImageExtension(image)}`
    )
    await fs.writeFile(tempFilePath, image.buffer)
    image.tempPath = tempFilePath
    return tempFilePath
  }

  private async runVisualModelWorker(
    pythonCmd: string,
    workerScriptPath: string,
    model: DuplicateCheckVisualModelConfig,
    items: PreparedImage[],
    useGpu: boolean,
    fallbackToCpu: boolean,
    batchSize: number,
    enableRobustness: boolean,
    tempDir: string,
    setActiveWorker: (worker: DuplicateCheckWorkerHandle | null) => void
  ): Promise<PythonWorkerOutput> {
    await ensureDir(tempDir)

    const inputPath = path.join(tempDir, `${model.id}.input.json`)
    const outputPath = path.join(tempDir, `${model.id}.output.json`)

    const payload = {
      model: sanitizeModelConfig(model),
      images: await Promise.all(
        items.map(async (item) => ({
          id: item.descriptor.id,
          path: await this.ensureTempPath(item, tempDir)
        }))
      ),
      useGpu,
      fallbackToCpu,
      batchSize,
      enableRobustness
    }

    await fs.writeFile(inputPath, JSON.stringify(payload), 'utf8')

    await runDuplicateCheckWorkerProcess(
      pythonCmd,
      [workerScriptPath, '--input', inputPath, '--output', outputPath],
      {
        cwd: path.dirname(workerScriptPath),
        env: createPortablePythonEnv(getBuildEnv().pathMap.data),
        setActiveWorker
      }
    )

    if (!(await pathExists(outputPath))) {
      throw new Error(`Visual model worker did not produce output for ${model.name}`)
    }

    return JSON.parse(await fs.readFile(outputPath, 'utf8')) as PythonWorkerOutput
  }

  private scoreMatch(
    query: PreparedImage,
    candidate: PreparedImage,
    methods: DuplicateCheckMethod[],
    req: DuplicateCheckRunReq,
    modelIds: string[]
  ): {
    level: DuplicateCheckMatchLevel | null
    reasons: string[]
    scores: DuplicateCheckScoreBundle
  } {
    const pHashDistance = hammingDistanceFromHex(query.pHash, candidate.pHash)
    const dHashDistance = hammingDistanceFromHex(query.dHash, candidate.dHash)
    const scores: DuplicateCheckScoreBundle = {
      sha256Equal: query.sha256 === candidate.sha256,
      pHashDistance,
      dHashDistance,
      visualSimilarityByModel: {},
      robustnessSimilarityByModel: {}
    }

    if (scores.sha256Equal && methods.includes('hash')) {
      return {
        level: 'exact',
        reasons: ['hash'],
        scores
      }
    }

    const highReasons = new Set<string>()
    const uncertainReasons = new Set<string>()

    if (methods.includes('hash')) {
      const minDistance = Math.min(pHashDistance, dHashDistance)
      if (minDistance <= req.hashDistance) {
        highReasons.add('hash')
      } else if (minDistance <= req.uncertainHashDistance) {
        uncertainReasons.add('hash')
      }
    }

    if (methods.includes('visual')) {
      for (const modelId of modelIds) {
        const queryEmbedding = query.embeddingsByModel[modelId]
        const candidateEmbedding = candidate.embeddingsByModel[modelId]
        if (!queryEmbedding || !candidateEmbedding) {
          continue
        }

        const similarity = cosineSimilarity(queryEmbedding, candidateEmbedding)
        scores.visualSimilarityByModel[modelId] = similarity
        if (similarity >= req.visualSimilarity) {
          highReasons.add('visual')
        } else if (similarity >= req.uncertainVisualSimilarity) {
          uncertainReasons.add('visual')
        }
      }
    }

    if (methods.includes('robust')) {
      for (const modelId of modelIds) {
        const queryEmbedding = query.robustEmbeddingsByModel[modelId]
        const candidateEmbedding = candidate.robustEmbeddingsByModel[modelId]
        if (!queryEmbedding || !candidateEmbedding) {
          continue
        }

        const similarity = cosineSimilarity(queryEmbedding, candidateEmbedding)
        scores.robustnessSimilarityByModel[modelId] = similarity
        if (similarity >= req.robustnessSimilarity) {
          highReasons.add('robust')
        } else if (similarity >= Math.max(req.robustnessSimilarity - 0.03, 0)) {
          uncertainReasons.add('robust')
        }
      }
    }

    if (highReasons.size > 0) {
      return {
        level: 'high',
        reasons: [...highReasons],
        scores
      }
    }

    if (uncertainReasons.size > 0) {
      return {
        level: 'uncertain',
        reasons: [...uncertainReasons],
        scores
      }
    }

    return {
      level: null,
      reasons: [],
      scores
    }
  }

  private sortMatches(matches: DuplicateCheckMatch[]): DuplicateCheckMatch[] {
    return [...matches].sort((left, right) => {
      const rightVisual = Math.max(0, ...Object.values(right.scores.visualSimilarityByModel || {}))
      const leftVisual = Math.max(0, ...Object.values(left.scores.visualSimilarityByModel || {}))
      if (rightVisual !== leftVisual) {
        return rightVisual - leftVisual
      }

      const rightRobust = Math.max(
        0,
        ...Object.values(right.scores.robustnessSimilarityByModel || {})
      )
      const leftRobust = Math.max(
        0,
        ...Object.values(left.scores.robustnessSimilarityByModel || {})
      )
      if (rightRobust !== leftRobust) {
        return rightRobust - leftRobust
      }

      const leftDistance = Math.min(
        left.scores.pHashDistance ?? Infinity,
        left.scores.dHashDistance ?? Infinity
      )
      const rightDistance = Math.min(
        right.scores.pHashDistance ?? Infinity,
        right.scores.dHashDistance ?? Infinity
      )
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance
      }

      return left.target.name.localeCompare(right.target.name)
    })
  }

  private shouldExcludeSelf(
    query: PreparedImage,
    candidate: PreparedImage,
    req: DuplicateCheckRunReq
  ): boolean {
    if (!req.excludeSelf) {
      return false
    }

    if (
      query.descriptor.itemId &&
      candidate.descriptor.itemId &&
      query.descriptor.canvasId &&
      candidate.descriptor.canvasId &&
      query.descriptor.canvasId === candidate.descriptor.canvasId &&
      query.descriptor.itemId === candidate.descriptor.itemId
    ) {
      return true
    }

    const queryPath = normalizeFilePath(query.descriptor.sourcePath)
    const candidatePath = normalizeFilePath(candidate.descriptor.sourcePath)
    return Boolean(queryPath && candidatePath && queryPath === candidatePath)
  }

  async runDuplicateCheck(
    req: DuplicateCheckRunReq,
    resp: ServerStreaming<DuplicateCheckRunEvent>
  ): Promise<void> {
    const startedAt = new Date().toISOString()
    const methods = Array.from(new Set(req.methods))
    if (methods.length === 0) {
      throw new Error('At least one duplicate check method must be selected')
    }

    const selectedModels = req.visualModels.filter(
      (model) => model.enabled && model.modelPath.trim()
    )
    if ((methods.includes('visual') || methods.includes('robust')) && selectedModels.length === 0) {
      throw new Error('视觉检查已启用，但未选择可用的 ONNX 模型')
    }

    const buildEnv = getBuildEnv()
    const config = getConfig()
    const duplicateSettings = config.plugin_config?.duplicateCheck
    const cacheRoot =
      duplicateSettings?.cacheDir?.trim() ||
      path.join(buildEnv.pathMap.data, 'duplicate-check-cache')
    const cache = req.enableCache ? new DuplicateCheckCacheStore(cacheRoot) : null
    const context: PreparedImageContext = {
      cache,
      cacheHitCount: 0,
      cacheMissCount: 0
    }

    const duplicateCheckTempRoot = resolveDuplicateCheckTempRoot()
    await fs.mkdir(duplicateCheckTempRoot, { recursive: true })
    const tempDir = await fs.mkdtemp(path.join(duplicateCheckTempRoot, 'magicpot-duplicate-check-'))
    const providerByModel: Record<string, string> = {}
    const warnings: string[] = []
    const skippedScopeImages: DuplicateCheckSkippedImage[] = []
    let currentPythonWorker: DuplicateCheckWorkerHandle | null = null

    resp.abortReceiver?.onAbort(() => {
      if (currentPythonWorker) {
        void currentPythonWorker.terminate()
      }
    })

    try {
      resp.onData({
        type: 'status',
        phase: 'prepare',
        message: '正在准备检查任务...'
      })

      const scopeImages =
        req.scope.type === 'folder'
          ? await listFolderFiles(
              req.scope.folderPath,
              req.scope.recursive,
              req.scope.imageExtensions
            )
          : req.scope.images

      resp.onData({
        type: 'status',
        phase: 'scan',
        message: '已整理检查范围',
        current: scopeImages.length,
        total: scopeImages.length,
        percent: 1
      })

      const totalHashImages = req.queries.length + scopeImages.length
      let hashedCount = 0
      const emitHashProgress = () => {
        resp.onData({
          type: 'status',
          phase: 'hash',
          message: '姝ｅ湪璁＄畻鍝堝笇鐗瑰緛...',
          current: hashedCount,
          total: totalHashImages,
          percent: totalHashImages > 0 ? hashedCount / totalHashImages : 1
        })
      }
      const preparedQueryImages = await mapWithConcurrency(
        req.queries,
        Math.max(1, req.maxConcurrency),
        async (image) => {
          const prepared = await this.prepareImage(image, context, {
            requireVisualPayload: selectedModels.length > 0
          }).catch((error) => {
            throw new Error(normalizePrepareImageErrorMessage(image, error))
          })
          hashedCount += 1
          resp.onData({
            type: 'status',
            phase: 'hash',
            message: '正在计算哈希特征...',
            current: hashedCount,
            total: totalHashImages,
            percent: totalHashImages > 0 ? hashedCount / totalHashImages : 1
          })
          return prepared
        }
      )

      const preparedScopeCandidates = await mapWithConcurrency(
        scopeImages,
        Math.max(1, req.maxConcurrency),
        async (image) => {
          try {
            return await this.prepareImage(image, context, {
              requireVisualPayload: selectedModels.length > 0
            })
          } catch (error) {
            const reason = normalizePrepareImageErrorMessage(image, error)
            warnings.push(`已跳过范围图片：${reason}`)
            skippedScopeImages.push({
              image: stripComparableData(image),
              reason
            })
            return null
          } finally {
            hashedCount += 1
            emitHashProgress()
          }
        }
      )

      const preparedScopeImages = preparedScopeCandidates.filter(
        (image): image is PreparedImage => image !== null
      )
      const preparedImages = [...preparedQueryImages, ...preparedScopeImages]

      if (selectedModels.length > 0) {
        const pythonCmd = resolvePythonCommand(selectedModels, req.useGpu)
        if (!pythonCmd) {
          throw new Error('未找到可用的 Python 环境，无法运行 ONNX 视觉模型')
        }

        const workerScriptPath = resolveWorkerScriptPath()
        if (!(await pathExists(workerScriptPath))) {
          throw new Error(`找不到视觉检查 Worker：${workerScriptPath}`)
        }

        for (let modelIndex = 0; modelIndex < selectedModels.length; modelIndex += 1) {
          const model = selectedModels[modelIndex]
          const missingImages = preparedImages.filter((image) => {
            const hasBase =
              Array.isArray(image.embeddingsByModel[model.id]) &&
              image.embeddingsByModel[model.id].length > 0
            const hasRobust =
              !methods.includes('robust') ||
              (Array.isArray(image.robustEmbeddingsByModel[model.id]) &&
                image.robustEmbeddingsByModel[model.id].length > 0)
            return !(hasBase && hasRobust)
          })

          if (missingImages.length === 0) {
            continue
          }

          resp.onData({
            type: 'status',
            phase: 'visual',
            message: `正在运行视觉模型：${model.name}`,
            current: modelIndex + 1,
            total: selectedModels.length,
            percent: selectedModels.length > 0 ? (modelIndex + 1) / selectedModels.length : 1,
            modelId: model.id
          })

          const output = await this.runVisualModelWorker(
            pythonCmd,
            workerScriptPath,
            model,
            missingImages,
            req.useGpu,
            req.fallbackToCpu,
            req.batchSize,
            methods.includes('robust'),
            tempDir,
            (worker) => {
              currentPythonWorker = worker
            }
          )

          providerByModel[model.id] = output.provider || 'CPUExecutionProvider'

          const resultById = new Map((output.items || []).map((item) => [item.id, item]))
          for (const image of missingImages) {
            const result = resultById.get(image.descriptor.id)
            if (
              !result ||
              result.error ||
              !Array.isArray(result.embedding) ||
              result.embedding.length === 0
            ) {
              continue
            }

            image.embeddingsByModel[model.id] = result.embedding
            if (Array.isArray(result.robustEmbedding) && result.robustEmbedding.length > 0) {
              image.robustEmbeddingsByModel[model.id] = result.robustEmbedding
            }

            if (cache) {
              await cache.upsertBlob(
                mergeBlobCacheEntry(await cache.getBlob(image.sha256), image, providerByModel)
              )
              if (image.descriptor.sourcePath) {
                const stats = await fs.stat(image.descriptor.sourcePath)
                await cache.upsertFile(
                  image.descriptor.sourcePath,
                  stats.size,
                  stats.mtimeMs,
                  image.sha256
                )
              }
            }
          }
        }
      }

      const queryResults: DuplicateCheckQueryResult[] = []
      let exactCount = 0
      let highCount = 0
      let uncertainCount = 0
      let matchedPairs = 0
      const modelIds = selectedModels.map((model) => model.id)
      const totalComparisons = preparedQueryImages.length * preparedScopeImages.length
      let completedComparisons = 0

      for (const query of preparedQueryImages) {
        const exactMatches: DuplicateCheckMatch[] = []
        const highMatches: DuplicateCheckMatch[] = []
        const uncertainMatches: DuplicateCheckMatch[] = []

        for (const candidate of preparedScopeImages) {
          completedComparisons += 1
          if (this.shouldExcludeSelf(query, candidate, req)) {
            continue
          }

          const scored = this.scoreMatch(query, candidate, methods, req, modelIds)
          if (!scored.level) {
            continue
          }

          const match: DuplicateCheckMatch = {
            level: scored.level,
            reasons: scored.reasons,
            target: stripComparableData(candidate.descriptor),
            scores: scored.scores
          }

          matchedPairs += 1

          if (scored.level === 'exact') {
            exactCount += 1
            exactMatches.push(match)
          } else if (scored.level === 'high') {
            highCount += 1
            highMatches.push(match)
          } else {
            uncertainCount += 1
            uncertainMatches.push(match)
          }
        }

        queryResults.push({
          query: stripComparableData(query.descriptor),
          exactMatches: this.sortMatches(exactMatches),
          highMatches: this.sortMatches(highMatches),
          uncertainMatches: this.sortMatches(uncertainMatches)
        })

        resp.onData({
          type: 'status',
          phase: 'match',
          message: '正在归并重复结果...',
          current: completedComparisons,
          total: totalComparisons,
          percent: totalComparisons > 0 ? completedComparisons / totalComparisons : 1
        })
      }

      const result: DuplicateCheckRunResult = {
        taskId: req.taskId,
        startedAt,
        finishedAt: new Date().toISOString(),
        scopeType: req.scope.type,
        scopeCount: preparedScopeImages.length,
        queryCount: preparedQueryImages.length,
        exactCount,
        highCount,
        uncertainCount,
        totalMatchCount: matchedPairs,
        cacheHitCount: context.cacheHitCount,
        cacheMissCount: context.cacheMissCount,
        providerByModel,
        warnings,
        skippedScopeImages,
        queryResults
      }

      await cache?.save()
      resp.onData({
        type: 'status',
        phase: 'done',
        message: '检查完成',
        current: result.totalMatchCount,
        total: result.totalMatchCount,
        percent: 1
      })
      resp.onData({
        type: 'complete',
        result
      })
    } finally {
      if (currentPythonWorker) {
        await currentPythonWorker.terminate()
      }
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures
      }
      currentPythonWorker = null
    }
  }
}
