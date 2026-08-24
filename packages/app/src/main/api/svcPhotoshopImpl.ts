import {
  PhotoshopSvc,
  SendImageToPhotoshopReq,
  SendImageToPhotoshopResp,
  LoadImageFromPhotoshopReq,
  LoadImageFromPhotoshopResp,
  StartRealtimeGenerationReq,
  StartRealtimeGenerationResp,
  StopRealtimeGenerationReq,
  StopRealtimeGenerationResp,
  GetRealtimeGenerationStatusReq,
  GetRealtimeGenerationStatusResp
} from '@shared/api/svcPhotoshop'
import { app, clipboard, nativeImage } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { shell } from 'electron'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'
import { addTask, cancelTask, getQueue, getTask } from '../queue/taskQueue'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { Workflow, type ComfyHistory } from '@shared/comfy/types'
import { encodeDeferredComfyImageInputValue } from '@shared/comfy/deferredImages'
import * as crypto from 'crypto'
import * as zlib from 'zlib'
import { readTestUiEnv, resolveTestArtifactPath, resolveTestUiPolicy } from '../testUiPolicy'
import { normalizeLocalFilePath } from '../utils/localFileUrl'

const inflateAsync = promisify(zlib.inflate)
const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())

const escapeAppleScriptString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const buildPhotoshopJavaScriptAppleScript = (jsxScript: string): string =>
  [
    'tell application "Adobe Photoshop"',
    '  activate',
    `  do javascript "${escapeAppleScriptString(jsxScript)}"`,
    'end tell'
  ].join('\n')

const runAppleScript = (appleScript: string, timeout = 10000, signal?: AbortSignal) =>
  execFileAsync('osascript', ['-e', appleScript], { timeout, signal })

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IEND_CHUNK = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])

const hasCompletePngSignatureAndIend = async (
  filePath: string,
  signal?: AbortSignal
): Promise<boolean> => {
  let handle: fs.FileHandle | null = null
  try {
    signal?.throwIfAborted()
    handle = await fs.open(filePath, 'r')
    signal?.throwIfAborted()
    const stats = await handle.stat()
    signal?.throwIfAborted()
    if (stats.size < PNG_SIGNATURE.length + PNG_IEND_CHUNK.length) {
      return false
    }

    const signature = Buffer.alloc(PNG_SIGNATURE.length)
    const signatureRead = await handle.read(signature, 0, signature.length, 0)
    signal?.throwIfAborted()
    if (signatureRead.bytesRead !== signature.length || !signature.equals(PNG_SIGNATURE)) {
      return false
    }

    const iend = Buffer.alloc(PNG_IEND_CHUNK.length)
    const iendRead = await handle.read(iend, 0, iend.length, stats.size - iend.length)
    signal?.throwIfAborted()
    return iendRead.bytesRead === iend.length && iend.equals(PNG_IEND_CHUNK)
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return false
  } finally {
    if (handle) {
      await handle.close().catch(() => {})
    }
  }
}

const waitForCompletePhotoshopPngExport = async (
  outputPath: string,
  timeoutMs = 10000,
  signal?: AbortSignal
): Promise<void> => {
  let waitTime = 10
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    signal?.throwIfAborted()
    if (await hasCompletePngSignatureAndIend(outputPath, signal)) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      const timer = setTimeout(done, waitTime)
      const onAbort = (): void => {
        clearTimeout(timer)
        cleanup()
        reject(signal?.reason)
      }
      function cleanup(): void {
        signal?.removeEventListener('abort', onAbort)
      }
      function done(): void {
        cleanup()
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    waitTime = Math.min(waitTime * 1.5, 200)
  }
  signal?.throwIfAborted()

  let sizeDetails = ''
  try {
    const stats = await fs.stat(outputPath)
    signal?.throwIfAborted()
    sizeDetails = ` Last observed size: ${stats.size} bytes.`
  } catch {
    sizeDetails = ' The file does not exist.'
  }

  throw new Error(
    `Photoshop export failed: complete PNG was not created at ${outputPath}.${sizeDetails}`
  )
}

const getPhotoshopTempDir = async (): Promise<string> => {
  const tempDir = resolveTestArtifactPath({
    desktopPath: app.getPath('desktop'),
    tempPath: app.getPath('temp'),
    policy: testUiPolicy,
    segments: ['photoshop']
  })
  await fs.mkdir(tempDir, { recursive: true })
  return tempDir
}

const PHOTOSHOP_DEFERRED_INPUT_DIR = 'qapp-input-images'
const PHOTOSHOP_TASK_POLL_INTERVAL_MS = 100
const PHOTOSHOP_TASK_TIMEOUT_MS = 30 * 60 * 1000
const PHOTOSHOP_CANCEL_TIMEOUT_MS = 5000
const PHOTOSHOP_EXECUTION_DRAIN_TIMEOUT_MS = 5000
const PHOTOSHOP_EXPORT_QUARANTINE_TIMEOUT_MS = 5000
const PHOTOSHOP_LATE_CLEANUP_DELAYS_MS = [0, 1000, 20_000, 60_000] as const

const persistPhotoshopRealtimeInput = async (
  fileName: string,
  image: Uint8Array
): Promise<string> => {
  const requestedName = path.basename(fileName.trim())
  const requestedExtension = path.extname(requestedName)
  const extension = /^\.[a-zA-Z0-9]{1,10}$/.test(requestedExtension) ? requestedExtension : '.png'
  const requestedBaseName = requestedExtension
    ? requestedName.slice(0, -requestedExtension.length)
    : requestedName
  const baseName =
    requestedBaseName
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'photoshop-input'
  const outputDir = path.join(app.getPath('userData'), PHOTOSHOP_DEFERRED_INPUT_DIR)
  await fs.mkdir(outputDir, { recursive: true })
  const durableFileName = `${baseName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`
  const fullPath = path.join(outputDir, durableFileName)
  await fs.writeFile(fullPath, Buffer.from(image))
  return encodeDeferredComfyImageInputValue({
    fileName: requestedName || durableFileName,
    mimeType: 'image/png',
    filePath: fullPath,
    sizeBytes: image.byteLength
  })
}

const abortError = (): Error => {
  const error = new Error('Photoshop realtime generation was stopped')
  error.name = 'AbortError'
  return error
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason ?? abortError()
}

const raceWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })

const cancelPhotoshopTaskBounded = async (taskId: string, context: string): Promise<void> => {
  try {
    await raceWithTimeout(
      cancelTask(taskId),
      PHOTOSHOP_CANCEL_TIMEOUT_MS,
      `Timed out cancelling Photoshop realtime task ${taskId}`
    )
  } catch (error) {
    console.error(`[Realtime Generation] Failed to cancel ${context} task ${taskId}:`, error)
  }
}

const schedulePhotoshopTempCleanup = (filePath: string): void => {
  for (const delayMs of PHOTOSHOP_LATE_CLEANUP_DELAYS_MS) {
    const timer = setTimeout(() => void fs.unlink(filePath).catch(() => {}), delayMs)
    timer.unref?.()
  }
}

// Serialize every public and realtime Photoshop export bridge operation. The tail always settles so a
// failed caller cannot poison later exports, while callers still receive their own operation result.
let photoshopExportOperationTail: Promise<void> = Promise.resolve()
const withPhotoshopExportOperationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = photoshopExportOperationTail
  let release!: () => void
  photoshopExportOperationTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
  }
}

const racePhotoshopAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal)
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason ?? abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

const waitForPollInterval = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, PHOTOSHOP_TASK_POLL_INTERVAL_MS)
    const onAbort = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export const waitForQueuedPhotoshopTask = async (
  taskId: string,
  signal: AbortSignal,
  timeoutMs = PHOTOSHOP_TASK_TIMEOUT_MS
): Promise<{ history: ComfyHistory; promptId: string }> => {
  const deadline = Date.now() + timeoutMs
  while (true) {
    throwIfAborted(signal)
    // Read authoritative state before evaluating the deadline. A task that completed in the final
    // polling window must be consumed instead of being discarded as a timeout and resubmitted.
    const [status, task] = getTask(taskId)
    if (status === 'completed') {
      if (!task.result)
        throw new Error(`Photoshop realtime task completed without a result: ${taskId}`)
      const promptId = task.prompt_id || task.result.prompt?.[1]
      if (typeof promptId !== 'string' || !promptId) {
        throw new Error(`Photoshop realtime task completed without a Comfy prompt id: ${taskId}`)
      }
      return { history: task.result, promptId }
    }
    if (status === 'error') {
      throw new Error(`Photoshop realtime task failed: ${taskId}`)
    }
    if (status === 'unknown') {
      throw new Error(
        `Photoshop realtime task submission is ambiguous and requires manual resolution: ${taskId}`
      )
    }
    if (status === 'cancelled' || status === 'cancelling') {
      throw abortError()
    }
    if (status === null || task === null) {
      throw new Error(`Photoshop realtime task disappeared: ${taskId}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Photoshop realtime task timed out: ${taskId}`)
    }
    await waitForPollInterval(signal)
  }
}

// Realtime generation state.
let realtimeGenerationInterval: NodeJS.Timeout | null = null
let realtimeGenerationConfig: {
  workflowTemplate: Workflow
  imageInputSlot: string
  outputNodeIds: string[]
  pollInterval: number
} | null = null
// Hash of the last input image, used to detect changes.
let lastInputImageHash: string | null = null
// Session epoch and in-flight task state prevent stopped sessions from publishing late results.
let realtimeGenerationEpoch = 0
let currentRealtimeTaskId: string | null = null
let currentRealtimeAbortController: AbortController | null = null
let currentRealtimeExecution: Promise<void> | null = null
// The underlying Photoshop export/load is tracked separately from its abort race. A new session may
// not start another export until the previous underlying operation has actually settled.
let currentPhotoshopExportSettlement: Promise<void> | null = null
// Serialize lifecycle calls so concurrent start/start and start/stop transitions cannot interleave.
let realtimeLifecycleTail: Promise<void> = Promise.resolve()
const withRealtimeLifecycleLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = realtimeLifecycleTail
  let release!: () => void
  realtimeLifecycleTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
  }
}
// Most recently loaded image metadata for the renderer.
let latestLoadedImage: {
  imageValue: string
  imageInputSlot: string
} | null = null
// Most recently generated result for the renderer.
let latestGeneratedResult: {
  promptId: string
  history: import('@shared/comfy/types').ComfyHistory
  outputNodeIds: string[]
} | null = null

export class PhotoshopSvcImpl implements PhotoshopSvc {
  private async ensurePhotoshopIsRunning(platform: NodeJS.Platform): Promise<void> {
    if (platform === 'win32') {
      const isRunning = await this.isPhotoshopRunningWindows()
      if (!isRunning) {
        throw new Error('Photoshop is not running. Please open Photoshop and try again.')
      }
      return
    }

    if (platform === 'darwin') {
      const isRunning = await this.isPhotoshopRunningMac()
      if (!isRunning) {
        throw new Error('Photoshop is not running. Please open Photoshop and try again.')
      }
    }
  }

  private async isPhotoshopRunningWindows(): Promise<boolean> {
    try {
      await execAsync(
        'powershell -Command "if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"',
        {
          timeout: 5000
        }
      )
      return true
    } catch {
      return false
    }
  }

  private async isPhotoshopRunningMac(): Promise<boolean> {
    try {
      const { stdout } = await runAppleScript('application "Adobe Photoshop" is running', 5000)
      return stdout.trim().toLowerCase() === 'true'
    } catch {
      return false
    }
  }

  /**
   * Send an image to Photoshop.
   * The image is written to a temporary file and inserted into the current Photoshop document.
   */
  sendImageToPhotoshop = async (
    req: SendImageToPhotoshopReq
  ): Promise<SendImageToPhotoshopResp> => {
    try {
      const platform = os.platform()
      await this.ensurePhotoshopIsRunning(platform)
      const tempDir = await getPhotoshopTempDir()
      const fileName = req.fileName || `comfyui-image-${Date.now()}.png`
      const tempFilePath = path.join(tempDir, fileName)

      // Read image data from the provided URL or path.
      let imageData: Buffer
      if (req.imageUrl.startsWith('data:')) {
        // Handle data URLs.
        const base64Data = req.imageUrl.split(',')[1]
        imageData = Buffer.from(base64Data, 'base64')
      } else if (req.imageUrl.startsWith('blob:')) {
        // Blob URLs only exist in the renderer process.
        // They must be converted before the request reaches the main process.
        // Expect a base64 data URL or a real file path at this layer.
        throw new Error(
          'Blob URLs must be converted to base64 in the renderer before calling this API.'
        )
      } else if (req.imageUrl.startsWith('file://')) {
        // Handle file URLs.
        imageData = await fs.readFile(normalizeLocalFilePath(req.imageUrl))
      } else {
        // Fall back to treating the value as a file path.
        imageData = await fs.readFile(req.imageUrl)
      }

      // Persist the image to a temporary file.
      await fs.writeFile(tempFilePath, imageData)

      // Use a platform-specific bridge to send the image to Photoshop.
      if (platform === 'win32') {
        await this.addImageToPhotoshopWindows(tempFilePath)
      } else if (platform === 'darwin') {
        await this.addImageToPhotoshopMac(tempFilePath)
      } else {
        // On Linux and other unsupported platforms, just open the exported file.
        await shell.openPath(tempFilePath)
      }

      return {
        success: true,
        filePath: tempFilePath
      }
    } catch (error) {
      console.error('Failed to send image to Photoshop:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Windows: insert the image into the current Photoshop document as a new layer.
   */
  private async addImageToPhotoshopWindows(imagePath: string): Promise<void> {
    const normalizedPath = imagePath.replace(/\\/g, '/')
    const timestamp = Date.now()
    const tempDir = await getPhotoshopTempDir()

    const jsxScript = [
      'try {',
      '  var file = new File("' + normalizedPath + '");',
      '  if (!file.exists) {',
      '    throw new Error("Image file not found: ' + normalizedPath + '");',
      '  }',
      '  var targetDoc = null;',
      '  if (app.documents.length > 0) {',
      '    targetDoc = app.activeDocument;',
      '  }',
      '  var imageDoc = app.open(file);',
      '  var imageWidth = imageDoc.width;',
      '  var imageHeight = imageDoc.height;',
      '  var imageResolution = imageDoc.resolution;',
      '  imageDoc.selection.selectAll();',
      '  imageDoc.selection.copy();',
      '  imageDoc.close(SaveOptions.DONOTSAVECHANGES);',
      '  if (!targetDoc) {',
      '    targetDoc = app.documents.add(imageWidth, imageHeight, imageResolution, "MagicPot Export", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);',
      '  }',
      '  app.activeDocument = targetDoc;',
      '  targetDoc.paste();',
      '  if (targetDoc.activeLayer) {',
      '    targetDoc.activeLayer.name = "新图层1";',
      '  }',
      '  app.bringToFront();',
      '} catch (e) {',
      '  throw new Error("Photoshop script failed: " + e.message);',
      '}'
    ].join('\n')

    const jsxScriptPath = path.join(tempDir, `ps-add-image-${timestamp}.jsx`)
    await fs.writeFile(jsxScriptPath, jsxScript, 'utf8')

    try {
      await fs.access(jsxScriptPath)
      console.log('[Photoshop] JSX script created:', jsxScriptPath)

      const escapedJsxPath = jsxScriptPath.replace(/'/g, "''")
      const psScript = [
        '$ErrorActionPreference = "Stop"',
        'try {',
        '  $ps = New-Object -ComObject Photoshop.Application',
        '  if ($null -eq $ps) {',
        '    throw "Cannot connect to Photoshop. Please ensure Photoshop is running."',
        '  }',
        `  $jsxPath = '${escapedJsxPath}'`,
        '  if (-not (Test-Path $jsxPath)) {',
        '    throw "JSX file not found: $jsxPath"',
        '  }',
        '  $jsxContent = Get-Content -Path $jsxPath -Raw -Encoding UTF8',
        '  $result = $ps.DoJavaScript($jsxContent)',
        '  if ($result -ne $null -and $result.ToString() -ne "") {',
        '    Write-Host "Photoshop returned: $result"',
        '  }',
        '} catch {',
        '  $errorMsg = $_.Exception.Message',
        '  Write-Error "PowerShell execution failed: $errorMsg"',
        '  exit 1',
        '}'
      ].join('\n')

      const psScriptPath = path.join(tempDir, `ps-script-${timestamp}.ps1`)
      const psScriptWithBOM = '\uFEFF' + psScript
      await fs.writeFile(psScriptPath, psScriptWithBOM, 'utf8')

      const command = `powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`
      const { stdout, stderr } = await execAsync(command, {
        timeout: 20000,
        maxBuffer: 10 * 1024 * 1024
      })

      if (stdout) {
        console.log('[Photoshop] PowerShell output:', stdout)
      }

      if (stderr && !stderr.includes('Warning') && stderr.trim().length > 0) {
        console.error('[Photoshop] PowerShell error:', stderr)
        throw new Error(stderr)
      }
    } finally {
      try {
        await fs.unlink(jsxScriptPath)
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
  /**
   * macOS: insert the image into the current Photoshop document as a new layer.
   */
  private async addImageToPhotoshopMac(imagePath: string): Promise<void> {
    const escapedPath = imagePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const jsxScript = [
      'try {',
      '  var file = new File("' + escapedPath + '");',
      '  if (!file.exists) {',
      '    throw new Error("Image file not found");',
      '  }',
      '  var targetDoc = null;',
      '  if (app.documents.length > 0) {',
      '    targetDoc = app.activeDocument;',
      '  }',
      '  var imageDoc = app.open(file);',
      '  var imageWidth = imageDoc.width;',
      '  var imageHeight = imageDoc.height;',
      '  var imageResolution = imageDoc.resolution;',
      '  imageDoc.selection.selectAll();',
      '  imageDoc.selection.copy();',
      '  imageDoc.close(SaveOptions.DONOTSAVECHANGES);',
      '  if (!targetDoc) {',
      '    targetDoc = app.documents.add(imageWidth, imageHeight, imageResolution, "MagicPot Export", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);',
      '  }',
      '  app.activeDocument = targetDoc;',
      '  targetDoc.paste();',
      '  if (targetDoc.activeLayer) {',
      '    targetDoc.activeLayer.name = "新图层1";',
      '  }',
      '  app.bringToFront();',
      '} catch (e) {',
      '  throw new Error("Photoshop script failed: " + e.message);',
      '}'
    ].join('\n')

    const { stderr } = await runAppleScript(buildPhotoshopJavaScriptAppleScript(jsxScript))

    if (stderr) {
      throw new Error(stderr)
    }
  }
  /**
   * Load an image from Photoshop.
   * Read the current active document directly instead of relying on copy and paste.
   */
  loadImageFromPhotoshop = async (
    req: LoadImageFromPhotoshopReq
  ): Promise<LoadImageFromPhotoshopResp> =>
    withPhotoshopExportOperationLock(() => this.loadImageFromPhotoshopInternal(req))

  private async loadRealtimeImageFromPhotoshop(
    req: LoadImageFromPhotoshopReq,
    signal: AbortSignal
  ): Promise<LoadImageFromPhotoshopResp> {
    return await withPhotoshopExportOperationLock(() =>
      this.loadImageFromPhotoshopInternal(req, signal)
    )
  }

  private async loadImageFromPhotoshopInternal(
    req: LoadImageFromPhotoshopReq,
    signal?: AbortSignal
  ): Promise<LoadImageFromPhotoshopResp> {
    signal?.throwIfAborted()
    const platform = os.platform()
    const tempDir = await getPhotoshopTempDir()
    signal?.throwIfAborted()
    const exportNonce = crypto.randomUUID()
    let outputPath = path.join(tempDir, `photoshop-export-${exportNonce}.png`)
    const cleanupPaths = new Set<string>([outputPath])

    try {
      if (platform === 'win32') {
        // Prefer file export on Windows to avoid clipboard PNG corruption.
        // Keep clipboard export as a compatibility fallback for edge cases.
        outputPath = await this.exportFromPhotoshopWindowsWithFallback(outputPath, signal)
        cleanupPaths.add(outputPath)
      } else if (platform === 'darwin') {
        // macOS: use AppleScript to execute Photoshop JavaScript.
        await this.exportFromPhotoshopMac(outputPath, signal)
      } else {
        throw new Error('Direct Photoshop reads are only supported on Windows and macOS.')
      }

      // Wait for Photoshop to finish writing the PNG before the renderer builds a preview.
      // A non-empty file can still be incomplete on slow restarts or large documents.
      await waitForCompletePhotoshopPngExport(outputPath, 10000, signal)

      // Read the exported image file.
      const imageData = await fs.readFile(outputPath, signal ? { signal } : undefined)
      signal?.throwIfAborted()
      const fileName = path.basename(outputPath)

      return {
        image: new Uint8Array(imageData),
        fileName
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      console.error('Failed to load image from Photoshop:', error)
      throw new Error(
        `Unable to read an image from Photoshop. Make sure Photoshop is running and a document is open.\nError details: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      for (const cleanupPath of cleanupPaths) schedulePhotoshopTempCleanup(cleanupPath)
    }
  }

  private async exportFromPhotoshopWindowsWithFallback(
    directOutputPath: string,
    signal?: AbortSignal
  ): Promise<string> {
    try {
      await this.exportFromPhotoshopWindows(directOutputPath, signal)
      return directOutputPath
    } catch (directExportError) {
      if (signal?.aborted) throw signal.reason
      console.warn(
        '[Photoshop] Direct file export failed, falling back to clipboard export:',
        directExportError
      )
      const fallbackOutputPath = path.join(
        path.dirname(directOutputPath),
        `photoshop-export-fallback-${crypto.randomUUID()}.png`
      )
      await this.exportFromPhotoshopWindowsViaClipboard(fallbackOutputPath, signal)
      // A dispatched direct export may still write late. It uses a separate path and therefore cannot
      // overwrite the authoritative fallback bytes selected by this invocation.
      schedulePhotoshopTempCleanup(directOutputPath)
      return fallbackOutputPath
    }
  }

  /**
   * Windows: export an image from Photoshop through COM without using JSX scripts.
   * Export the selection when one exists, otherwise export the whole document.
   */
  private async exportFromPhotoshopWindowsDirect(outputPath: string): Promise<void> {
    // Use COM directly to avoid script execution and window flashing.
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      'try {',
      '  $ps = New-Object -ComObject Photoshop.Application',
      '  if ($null -eq $ps) {',
      '    throw "Cannot connect to Photoshop. Please ensure Photoshop is running."',
      '  }',
      '  ',
      '  if ($ps.Application.Documents.Count -eq 0) {',
      '    throw "No documents are open in Photoshop."',
      '  }',
      '  ',
      '  $doc = $ps.Application.ActiveDocument',
      '  ',
      '  # Check whether the document currently has a selection',
      '  $hasSelection = $false',
      '  try {',
      '    $bounds = $doc.Selection.Bounds',
      '    $width = $bounds[2] - $bounds[0]',
      '    $height = $bounds[3] - $bounds[1]',
      '    $hasSelection = $width -gt 0 -and $height -gt 0',
      '  } catch {',
      '    $hasSelection = $false',
      '  }',
      '  ',
      '  # Export directly without creating a temporary Photoshop document.',
      '  $file = New-Object -ComObject Scripting.FileSystemObject',
      `  $outputFile = $file.GetFile("${outputPath.replace(/\\/g, '\\\\')}")`,
      '  ',
      '  if ($hasSelection) {',
      '    # When a selection exists, copy it to the clipboard first.',
      '    .Selection.Copy(True)  # True copies the merged visible result.',
      '    # Then export the current selection.',
      '    # Export requires an active selection when one exists.',
      '    $doc.Export($outputFile, 2, 0)  # 2 = ExportType.SaveForWeb, 0 = PNG',
      '  } else {',
      '    # Export the entire document when there is no selection.',
      '    $doc.Export($outputFile, 2, 0)',
      '  }',
      '} catch {',
      '  $errorMsg = $_.Exception.Message',
      '  Write-Error "PowerShell execution failed: $errorMsg"',
      '  exit 1',
      '}'
    ].join('\n')

    const tempDir = await getPhotoshopTempDir()
    const psScriptPath = path.join(tempDir, `ps-export-direct-${crypto.randomUUID()}.ps1`)
    const psScriptWithBOM = '\uFEFF' + psScript
    await fs.writeFile(psScriptPath, psScriptWithBOM, 'utf8')

    try {
      const command = `powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`
      console.log('[Photoshop] Running direct export command for:', outputPath)

      const { stdout, stderr } = await execAsync(command, {
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024
      })

      if (stdout) {
        console.log('[Photoshop] PowerShell output:', stdout)
      }

      if (stderr && !stderr.includes('Warning') && stderr.trim().length > 0) {
        console.error('[Photoshop] PowerShell error:', stderr)
        throw new Error(stderr)
      }
    } finally {
      try {
        await fs.unlink(psScriptPath)
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  /**
   * Windows: read an image from Photoshop through the clipboard bridge.
   * Read the selection when one exists, otherwise read the whole document.
   */
  private async exportFromPhotoshopWindowsViaClipboard(
    outputPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    // Use Photoshop JavaScript here because COM copy has edge cases with locked backgrounds.
    const jsxScript = [
      'try {',
      '  app.displayDialogs = DialogModes.NO;',
      '  if (app.documents.length === 0) {',
      '    throw new Error("No documents are open in Photoshop.");',
      '  }',
      '  var doc = app.activeDocument;',
      '  ',
      '  // Check whether the document currently has a selection.',
      '  var hasSelection = false;',
      '  try {',
      '    var bounds = doc.selection.bounds;',
      '    var width = bounds[2] - bounds[0];',
      '    var height = bounds[3] - bounds[1];',
      '    hasSelection = width > 0 && height > 0;',
      '  } catch (e) {',
      '    hasSelection = false;',
      '  }',
      '  ',
      '  // Select the whole document when there is no active selection.',
      '  if (!hasSelection) {',
      '    doc.selection.selectAll();',
      '  }',
      '  ',
      '  // Try a merged copy first, then fall back to a normal copy.',
      '  var copySuccess = false;',
      '  try {',
      '    // A merged copy works best for multi-layer documents.',
      '    doc.selection.copy(true);',
      '    copySuccess = true;',
      '  } catch (e) {',
      '    // Fall back to a normal copy for cases like a locked background layer.',
      '    try {',
      '      doc.selection.copy();',
      '      copySuccess = true;',
      '    } catch (e2) {',
      '      // If normal copy also fails, check for a single background layer.',
      '      if (doc.layers.length === 1 && doc.layers[0].isBackgroundLayer) {',
      '        // Copy pixels from the background layer directly.',
      '        doc.activeLayer = doc.layers[0];',
      '        doc.selection.copy();',
      '        copySuccess = true;',
      '      }',
      '    }',
      '  }',
      '  ',
      '  if (!copySuccess) {',
      '    throw new Error("Cannot copy image from Photoshop. Please ensure there is content to copy.");',
      '  }',
      '  ',
      '  "Image copied to clipboard";',
      '} catch (e) {',
      '  throw new Error("Photoshop script failed: " + e.message);',
      '}'
    ].join('\n')

    const clipboardNonce = crypto.randomUUID()
    const tempDir = await getPhotoshopTempDir()
    const jsxScriptPath = path.join(tempDir, `ps-clipboard-${clipboardNonce}.jsx`)
    await fs.writeFile(jsxScriptPath, jsxScript, 'utf8')

    // Use PowerShell to ask Photoshop to execute the JavaScript payload.
    const escapedJsxPath = jsxScriptPath.replace(/'/g, "''")
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      'try {',
      '  $ps = New-Object -ComObject Photoshop.Application',
      '  if ($null -eq $ps) {',
      '    throw "Cannot connect to Photoshop. Please ensure Photoshop is running."',
      '  }',
      `  $jsxPath = '${escapedJsxPath}'`,
      '  if (-not (Test-Path $jsxPath)) {',
      '    throw "JSX file not found: $jsxPath"',
      '  }',
      '  $jsxContent = Get-Content -Path $jsxPath -Raw -Encoding UTF8',
      '  $result = $ps.DoJavaScript($jsxContent)',
      '  Write-Host "Image copied to clipboard"',
      '} catch {',
      '  $errorMsg = $_.Exception.Message',
      '  Write-Error "PowerShell execution failed: $errorMsg"',
      '  exit 1',
      '}'
    ].join('\n')

    const psScriptPath = path.join(tempDir, `ps-clipboard-${clipboardNonce}.ps1`)
    const psScriptWithBOM = '\uFEFF' + psScript
    await fs.writeFile(psScriptPath, psScriptWithBOM, 'utf8')

    try {
      const command = `powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`
      console.log('[Photoshop] Running clipboard export script')

      const { stdout, stderr } = await execAsync(command, {
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
        signal
      })

      if (stdout) {
        console.log('[Photoshop] PowerShell output:', stdout)
      }

      if (stderr && !stderr.includes('Warning') && stderr.trim().length > 0) {
        console.error('[Photoshop] PowerShell error:', stderr)
        throw new Error(stderr)
      }

      // Give the clipboard a brief moment to update before reading it.
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        const timer = setTimeout(done, 100)
        const onAbort = (): void => {
          clearTimeout(timer)
          cleanup()
          reject(signal?.reason)
        }
        function cleanup(): void {
          signal?.removeEventListener('abort', onAbort)
        }
        function done(): void {
          cleanup()
          resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      signal?.throwIfAborted()

      // Read the image from the clipboard.
      const clipboardImage = clipboard.readImage()
      if (clipboardImage.isEmpty()) {
        throw new Error('No image data is available on the clipboard')
      }

      // Save the clipboard image as PNG.
      const pngBuffer = clipboardImage.toPNG()
      await fs.writeFile(outputPath, pngBuffer, signal ? { signal } : undefined)
      signal?.throwIfAborted()
      console.log('[Photoshop] Saved image from clipboard to:', outputPath)
    } finally {
      // Clean up temporary files.
      try {
        await fs.unlink(psScriptPath)
      } catch {
        // Ignore cleanup failures.
      }
      try {
        await fs.unlink(jsxScriptPath)
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  /**
   * Windows: export the current document by running Photoshop JavaScript through COM.
   * Export the selection when one exists, otherwise export the whole document.
   * @deprecated Prefer exportFromPhotoshopWindowsViaClipboard to avoid window flashing.
   */
  private async exportFromPhotoshopWindows(
    outputPath: string,
    signal?: AbortSignal
  ): Promise<void> {
    // Normalize the path for Photoshop JavaScript by using forward slashes.
    const normalizedPath = outputPath.replace(/\\/g, '/')

    // Build the Photoshop JavaScript payload.
    // Photoshop JavaScript expects forward slashes in file paths.
    const jsxScript = [
      'try {',
      '  // Disable dialogs to reduce UI flashing.',
      '  app.displayDialogs = DialogModes.NO;',
      '  ',
      '  if (app.documents.length === 0) {',
      '    throw new Error("No documents are open in Photoshop.");',
      '  }',
      '  var doc = app.activeDocument;',
      '  var hasSelection = false;',
      '  try {',
      '    // Check whether the document currently has a valid selection.',
      '    var sel = doc.selection;',
      '    if (sel && sel.bounds) {',
      '      var bounds = sel.bounds;',
      '      // Treat the selection as valid only when width and height are greater than 0.',
      '      var width = bounds[2] - bounds[0];',
      '      var height = bounds[3] - bounds[1];',
      '      hasSelection = width > 0 && height > 0;',
      '    }',
      '  } catch (e) {',
      '    hasSelection = false;',
      '  }',
      '  ',
      '  var exportDoc = doc;',
      '  var tempDoc = null;',
      '  var originalSelection = null;',
      '  ',
      '  if (hasSelection) {',
      '    // If a selection exists, copy and paste it into a temporary document.',
      '    // Preserve the original active document and selection bounds.',
      '    var originalDoc = app.activeDocument;',
      '    try {',
      '      originalSelection = doc.selection.bounds;',
      '    } catch (e) {',
      '      // Ignore selection snapshot errors.',
      '    }',
      '    ',
      '    // Read the selection bounds.',
      '    var bounds = doc.selection.bounds;',
      '    var width = Math.round(bounds[2] - bounds[0]);',
      '    var height = Math.round(bounds[3] - bounds[1]);',
      '    ',
      '    // Copy the selected content, merged across visible layers.',
      '    doc.selection.copy(true);',
      '    ',
      '    // Create a temporary document with a transparent background.',
      '    // Creating the temp document makes it active, so switch back right away.',
      '    tempDoc = app.documents.add(width, height, doc.resolution, "TempExport", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);',
      '    ',
      '    // Switch back to the original document first.',
      '    app.activeDocument = originalDoc;',
      '    ',
      '    // Then paste into the temporary document.',
      '    app.activeDocument = tempDoc;',
      '    tempDoc.paste();',
      '    ',
      '    // Restore the original document again.',
      '    app.activeDocument = originalDoc;',
      '    ',
      '    // Export from the temporary document.',
      '    exportDoc = tempDoc;',
      '  }',
      '  ',
      `  var file = new File("${normalizedPath}");`,
      '  var pngOptions = new PNGSaveOptions();',
      '  pngOptions.compression = 0;',
      '  ',
      '  // Ensure the temporary document is active before saving.',
      '  if (tempDoc) {',
      '    app.activeDocument = tempDoc;',
      '  }',
      '  ',
      '  exportDoc.saveAs(file, pngOptions, true, Extension.LOWERCASE);',
      '  ',
      '  // Restore the original active document.',
      '  if (tempDoc && originalDoc) {',
      '    try {',
      '      app.activeDocument = originalDoc;',
      '    } catch (e) {',
      '      // Ignore restoration errors.',
      '    }',
      '  }',
      '  ',
      '  // Close the temporary document immediately.',
      '  if (tempDoc) {',
      '    tempDoc.close(SaveOptions.DONOTSAVECHANGES);',
      '  }',
      '} catch (e) {',
      '  throw new Error("Photoshop script failed: " + e.message);',
      '}'
    ].join('\n')

    // Save the JavaScript payload to a temporary file.
    const tempDir = await getPhotoshopTempDir()
    const jsxScriptPath = path.join(tempDir, `ps-export-${crypto.randomUUID()}.jsx`)
    await fs.writeFile(jsxScriptPath, jsxScript, 'utf8')

    // Use stat to confirm that the file was created successfully.
    try {
      const stats = await fs.stat(jsxScriptPath)
      if (stats.size === 0) {
        throw new Error(`JSX file is empty: ${jsxScriptPath}`)
      }
      console.log('[Photoshop] JSX script created:', jsxScriptPath)
    } catch (error) {
      if (error instanceof Error && error.message.includes('JSX file is empty')) {
        throw error
      }
      throw new Error(`Unable to create JSX file: ${jsxScriptPath}`)
    }

    try {
      // Use PowerShell and COM to execute Photoshop JavaScript.
      // Escape the JSX path for safe use inside PowerShell.
      // Prefer simple quoting rules here to avoid path parsing bugs.
      const escapedJsxPath = jsxScriptPath.replace(/'/g, "''")

      // Keep these error messages in English to avoid encoding issues.
      const psScript = [
        '$ErrorActionPreference = "Stop"',
        'try {',
        '  $ps = New-Object -ComObject Photoshop.Application',
        '  if ($null -eq $ps) {',
        '    throw "Cannot connect to Photoshop. Please ensure Photoshop is running."',
        '  }',
        `  $jsxPath = '${escapedJsxPath}'`,
        '  if (-not (Test-Path $jsxPath)) {',
        '    throw "JSX file not found: $jsxPath"',
        '  }',
        '  $jsxContent = Get-Content -Path $jsxPath -Raw -Encoding UTF8',
        '  $result = $ps.DoJavaScript($jsxContent)',
        '  if ($result -ne $null -and $result.ToString() -ne "") {',
        '    Write-Host "Photoshop returned: $result"',
        '  }',
        '} catch {',
        '  $errorMsg = $_.Exception.Message',
        '  Write-Error "PowerShell execution failed: $errorMsg"',
        '  exit 1',
        '}'
      ].join('\n')

      // Save the PowerShell payload to a temporary file.
      // Use UTF-8 with BOM so Windows PowerShell reads the file reliably.
      const psScriptPath = path.join(tempDir, `ps-script-${crypto.randomUUID()}.ps1`)
      const psScriptWithBOM = '\uFEFF' + psScript // Prefix with a UTF-8 BOM.
      await fs.writeFile(psScriptPath, psScriptWithBOM, 'utf8')

      // Use stat to confirm that the file was created successfully.
      try {
        const stats = await fs.stat(psScriptPath)
        if (stats.size === 0) {
          throw new Error(`PowerShell script file is empty: ${psScriptPath}`)
        }
        console.log('[Photoshop] PowerShell script created:', psScriptPath)
      } catch (error) {
        if (error instanceof Error && error.message.includes('PowerShell script file is empty')) {
          throw error
        }
        throw new Error(`Unable to create PowerShell script file: ${psScriptPath}`)
      }

      // Keep verbose script output limited to development builds.
      if (process.env.NODE_ENV === 'development') {
        console.log('[Photoshop] Generated PowerShell script:')
        console.log(psScript)
        console.log('[Photoshop] JSX script path:', jsxScriptPath)
      }

      try {
        const command = `powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`
        console.log('[Photoshop] Running PowerShell export command for:', outputPath)

        const { stdout, stderr } = await execAsync(command, {
          timeout: 15000, // 15 seconds is enough for the export command in normal cases.
          maxBuffer: 10 * 1024 * 1024, // 10MB
          signal
        })

        if (stdout) {
          console.log('[Photoshop] PowerShell output:', stdout)
        }

        if (stderr && !stderr.includes('Warning') && stderr.trim().length > 0) {
          console.error('[Photoshop] PowerShell error:', stderr)
          throw new Error(stderr)
        }
      } finally {
        // Clean up the temporary PowerShell script file.
        try {
          await fs.unlink(psScriptPath)
        } catch {
          // Ignore cleanup failures.
        }
      }
    } finally {
      // Clean up the temporary JSX script file.
      try {
        await fs.unlink(jsxScriptPath)
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  /**
   * macOS: export the current document by running Photoshop JavaScript through AppleScript.
   * Export the selection when one exists, otherwise export the whole document.
   */
  private async exportFromPhotoshopMac(outputPath: string, signal?: AbortSignal): Promise<void> {
    // Escape special characters in the output path.
    const escapedPath = outputPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const jsxScript = [
      'try {',
      '  // Disable dialogs to reduce UI flashing.',
      '  app.displayDialogs = DialogModes.NO;',
      '  ',
      '  if (app.documents.length === 0) {',
      '    throw new Error("No documents are open in Photoshop.");',
      '  }',
      '  var doc = app.activeDocument;',
      '  var hasSelection = false;',
      '  try {',
      '    // Check whether the document currently has a valid selection.',
      '    var sel = doc.selection;',
      '    if (sel && sel.bounds) {',
      '      var bounds = sel.bounds;',
      '      // Treat the selection as valid only when width and height are greater than 0.',
      '      var width = bounds[2] - bounds[0];',
      '      var height = bounds[3] - bounds[1];',
      '      hasSelection = width > 0 && height > 0;',
      '    }',
      '  } catch (e) {',
      '    hasSelection = false;',
      '  }',
      '  ',
      '  var exportDoc = doc;',
      '  var tempDoc = null;',
      '  var originalDoc = null;',
      '  ',
      '  if (hasSelection) {',
      '    // If a selection exists, copy and paste it into a temporary document.',
      '    // Preserve the original active document.',
      '    originalDoc = app.activeDocument;',
      '    ',
      '    // Read the selection bounds.',
      '    var bounds = doc.selection.bounds;',
      '    var width = Math.round(bounds[2] - bounds[0]);',
      '    var height = Math.round(bounds[3] - bounds[1]);',
      '    ',
      '    // Copy the selected content, merged across visible layers.',
      '    doc.selection.copy(true);',
      '    ',
      '    // Create a temporary document with a transparent background.',
      '    // Creating the temp document makes it active, so switch back right away.',
      '    tempDoc = app.documents.add(width, height, doc.resolution, "TempExport", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);',
      '    ',
      '    // Switch back to the original document first.',
      '    app.activeDocument = originalDoc;',
      '    ',
      '    // Then paste into the temporary document.',
      '    app.activeDocument = tempDoc;',
      '    tempDoc.paste();',
      '    ',
      '    // Restore the original document again.',
      '    app.activeDocument = originalDoc;',
      '    ',
      '    // Export from the temporary document.',
      '    exportDoc = tempDoc;',
      '  }',
      '  ',
      `  var file = new File("${escapedPath}");`,
      '  var pngOptions = new PNGSaveOptions();',
      '  pngOptions.compression = 0;',
      '  ',
      '  // Ensure the temporary document is active before saving.',
      '  if (tempDoc) {',
      '    app.activeDocument = tempDoc;',
      '  }',
      '  ',
      '  exportDoc.saveAs(file, pngOptions, true, Extension.LOWERCASE);',
      '  ',
      '  // Restore the original active document.',
      '  if (tempDoc && originalDoc) {',
      '    try {',
      '      app.activeDocument = originalDoc;',
      '    } catch (e) {',
      '      // Ignore restoration errors.',
      '    }',
      '  }',
      '  ',
      '  // Close the temporary document immediately.',
      '  if (tempDoc) {',
      '    tempDoc.close(SaveOptions.DONOTSAVECHANGES);',
      '  }',
      '} catch (e) {',
      '  throw new Error("Photoshop script failed: " + e.message);',
      '}'
    ].join('\n')

    // Use osascript to invoke Photoshop.
    const { stderr } = await runAppleScript(
      buildPhotoshopJavaScriptAppleScript(jsxScript),
      10000,
      signal
    )

    if (stderr) {
      throw new Error(stderr)
    }

    // Confirm that the export file was created.
    try {
      await fs.access(outputPath)
      signal?.throwIfAborted()
    } catch {
      throw new Error('Photoshop export failed: file was not created')
    }
  }

  /**
   * Read an image from the clipboard as a fallback.
   */
  private async loadFromClipboard(): Promise<LoadImageFromPhotoshopResp> {
    const clipboardImage = clipboard.readImage()

    if (clipboardImage.isEmpty()) {
      throw new Error('No image is available on the clipboard')
    }

    const pngBuffer = clipboardImage.toPNG()
    const fileName = `photoshop-clipboard-${crypto.randomUUID()}.png`

    return {
      image: new Uint8Array(pngBuffer),
      fileName
    }
  }

  /**
   * Start realtime generation.
   */
  startRealtimeGeneration = async (
    req: StartRealtimeGenerationReq
  ): Promise<StartRealtimeGenerationResp> =>
    withRealtimeLifecycleLock(async () => {
      try {
        // Fully stop and drain the old session before installing the replacement session.
        await this.stopRealtimeGenerationUnlocked({})

        // Parse the workflow template.
        const workflowTemplate: Workflow = JSON.parse(req.workflowTemplate)
        const pollInterval = req.pollInterval || 2000

        // Persist the runtime configuration.
        realtimeGenerationConfig = {
          workflowTemplate,
          imageInputSlot: req.imageInputSlot,
          outputNodeIds: req.outputNodeIds,
          pollInterval
        }

        // Reset the last image hash so the first pass always runs.
        lastInputImageHash = null
        const epoch = ++realtimeGenerationEpoch
        // Clear cached renderer data.
        latestLoadedImage = null
        latestGeneratedResult = null

        if (currentPhotoshopExportSettlement) {
          try {
            await raceWithTimeout(
              currentPhotoshopExportSettlement,
              PHOTOSHOP_EXPORT_QUARANTINE_TIMEOUT_MS,
              'A previous Photoshop export is still running; realtime generation remains quarantined.'
            )
          } catch (error) {
            realtimeGenerationConfig = null
            throw error
          }
        }

        // Start the polling loop.
        this.startRealtimeGenerationLoop(epoch)

        return {
          success: true
        }
      } catch (error) {
        console.error('Failed to start realtime generation:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })

  /**
   * Stop realtime generation.
   */
  stopRealtimeGeneration = async (
    req: StopRealtimeGenerationReq
  ): Promise<StopRealtimeGenerationResp> =>
    withRealtimeLifecycleLock(() => this.stopRealtimeGenerationUnlocked(req))

  private async stopRealtimeGenerationUnlocked(
    req: StopRealtimeGenerationReq
  ): Promise<StopRealtimeGenerationResp> {
    ++realtimeGenerationEpoch
    if (realtimeGenerationInterval) clearInterval(realtimeGenerationInterval)
    realtimeGenerationInterval = null
    realtimeGenerationConfig = null
    lastInputImageHash = null
    latestLoadedImage = null
    latestGeneratedResult = null

    const taskId = currentRealtimeTaskId
    currentRealtimeAbortController?.abort()
    if (taskId) await cancelPhotoshopTaskBounded(taskId, 'active')
    if (currentRealtimeExecution) {
      try {
        await raceWithTimeout(
          currentRealtimeExecution.catch(() => {}),
          PHOTOSHOP_EXECUTION_DRAIN_TIMEOUT_MS,
          'Timed out draining the stopped Photoshop realtime execution'
        )
      } catch (error) {
        // The epoch is already invalidated. Leave the old execution quarantined from publication and
        // return rather than allowing a broken queue or mock to block lifecycle calls forever.
        console.error('[Realtime Generation] Failed to drain stopped execution:', error)
      }
    }
    currentRealtimeTaskId = null
    currentRealtimeAbortController = null
    currentRealtimeExecution = null

    return {
      success: true
    }
  }

  /**
   * Get realtime generation status.
   */
  getRealtimeGenerationStatus = async (
    req: GetRealtimeGenerationStatusReq
  ): Promise<GetRealtimeGenerationStatusResp> => {
    const result: GetRealtimeGenerationStatusResp = {
      isRunning: realtimeGenerationInterval !== null
    }

    // Return the latest loaded image once, then clear the cache.
    if (latestLoadedImage) {
      result.latestLoadedImage = latestLoadedImage
      latestLoadedImage = null // Clear the cache to avoid duplicate updates.
    }

    // Return the latest generated result once, then clear the cache.
    if (latestGeneratedResult) {
      result.latestGeneratedResult = latestGeneratedResult
      latestGeneratedResult = null // Clear the cache to avoid duplicate updates.
    }

    return result
  }

  /**
   * Start the realtime generation loop.
   */
  private startRealtimeGenerationLoop(epoch: number): void {
    if (realtimeGenerationInterval) {
      return
    }

    realtimeGenerationInterval = setInterval(async () => {
      try {
        if (!realtimeGenerationConfig || epoch !== realtimeGenerationEpoch) return

        // Skip this tick if a generation job is already running.
        if (currentRealtimeExecution) return

        // Check the queue state first.
        const queueState = getQueue()
        const hasCapacityBlockingTask =
          queueState.running.length > 0 ||
          queueState.pending.length > 0 ||
          queueState.cancelling.length > 0 ||
          queueState.unknown.length > 0

        if (hasCapacityBlockingTask) {
          // Unknown/cancelling work still owns logical ComfyUI capacity. Do not enqueue behind an
          // unresolved task merely because it is absent from the running/pending presentation lists.
          return
        }

        // The queue is idle, so run realtime generation now.
        const execution = this.executeRealtimeGeneration(epoch)
        currentRealtimeExecution = execution
        await execution
        if (currentRealtimeExecution === execution) currentRealtimeExecution = null
      } catch (error) {
        console.error('[Realtime Generation] Execution failed:', error)
        // Keep the loop alive and try again on the next tick.
      }
    }, realtimeGenerationConfig?.pollInterval || 2000)
  }

  private publishCompletedRealtimeTask(args: {
    history: ComfyHistory
    promptId: string
    outputNodeIds: string[]
    imageHash: string
    epoch: number
    signal: AbortSignal
  }): boolean {
    const { history, promptId, outputNodeIds, imageHash, epoch, signal } = args
    if (epoch !== realtimeGenerationEpoch || signal.aborted) return false
    if (history.status.status_str === 'error') return false
    const hasOutputImages = outputNodeIds.some((nodeId) => history.outputs[nodeId]?.images?.length)
    // An authoritative completion always locks the input hash, including empty output sets.
    lastInputImageHash = imageHash
    if (!hasOutputImages) {
      console.warn('[Realtime Generation] No output images were produced.')
      return false
    }
    latestGeneratedResult = { promptId, history, outputNodeIds }
    return true
  }

  /**
   * Run one realtime generation pass.
   */
  private async executeRealtimeGeneration(epoch: number): Promise<void> {
    const config = realtimeGenerationConfig
    if (!config || epoch !== realtimeGenerationEpoch) return
    const abortController = new AbortController()
    currentRealtimeAbortController = abortController
    const { signal } = abortController
    const { workflowTemplate, imageInputSlot, outputNodeIds } = config
    let queuedTaskId: string | null = null
    let attemptImageHash: string | null = null

    try {
      // 1. Read the current image from Photoshop.
      console.log('[Realtime Generation] Reading image from Photoshop...')
      const underlyingExport = this.loadRealtimeImageFromPhotoshop({}, signal)
      const exportSettlement = underlyingExport.then(
        () => undefined,
        () => undefined
      )
      currentPhotoshopExportSettlement = exportSettlement
      void exportSettlement.finally(() => {
        if (currentPhotoshopExportSettlement === exportSettlement) {
          currentPhotoshopExportSettlement = null
        }
      })
      const psImage = await racePhotoshopAbort(underlyingExport, signal)
      throwIfAborted(signal)
      if (epoch !== realtimeGenerationEpoch) return

      // 1.5 Compute a stable hash of the PNG payload and compare it to the last run.
      // Only hash core PNG chunks (IHDR + IDAT) so metadata changes do not trigger reruns.
      const imageHash = this.calculateImageHash(psImage.image)
      attemptImageHash = imageHash
      const imageSize = psImage.image.length

      // Try to extract image dimensions from the PNG header for debug logging.
      let imageInfo = `size: ${imageSize} bytes`
      try {
        // PNG files start with an 8-byte signature, followed by the IHDR chunk.
        // Width and height are stored at byte offsets 16 and 20 in the PNG header.
        if (psImage.image.length >= 24) {
          const buffer = Buffer.from(psImage.image)
          const width = buffer.readUInt32BE(16)
          const height = buffer.readUInt32BE(20)
          imageInfo += `, dimensions: ${width}x${height}`
        }
      } catch (error) {
        // Ignore PNG parsing errors and keep logging the file size only.
      }

      console.log(`[Realtime Generation] Image info: ${imageInfo}, hash: ${imageHash}`)

      if (lastInputImageHash === imageHash) {
        console.log('[Realtime Generation] Input image is unchanged; skipping generation.')
        return
      }

      if (lastInputImageHash !== null) {
        console.log(
          `[Realtime Generation] Input image changed. Previous hash: ${lastInputImageHash}, current hash: ${imageHash}`
        )
      } else {
        console.log(`[Realtime Generation] First image load. Hash: ${imageHash}`)
      }

      console.log('[Realtime Generation] Starting generation...')

      // 2. Persist a deferred input. The task queue uploads it only after acquiring a destination
      // lease, so preprocessing, upload, submission, polling, and output routing stay on one host.
      console.log('[Realtime Generation] Persisting deferred image input...')
      const imageValue = await racePhotoshopAbort(
        persistPhotoshopRealtimeInput(psImage.fileName, psImage.image),
        signal
      )

      // 2.5 Cache the durable deferred value for renderer updates.
      throwIfAborted(signal)
      if (epoch !== realtimeGenerationEpoch) return
      latestLoadedImage = {
        imageValue,
        imageInputSlot
      }

      // 3. Build the workflow by cloning the template and injecting the deferred image input.
      const workflow: Workflow = JSON.parse(JSON.stringify(workflowTemplate))
      setJsonPath(imageInputSlot, workflow, imageValue)

      // 4. Submit through the ordinary queue. It is the sole authority for instance leasing,
      // submission ambiguity, cancellation, and immutable output-route capture.
      console.log('[Realtime Generation] Queueing workflow...')
      const taskId = addTask({
        id: '',
        type: 'comfy_prompt',
        client_id: crypto.randomUUID(),
        created_at: Date.now(),
        prompt_id: null,
        payload: workflow,
        result: null
      })
      queuedTaskId = taskId
      currentRealtimeTaskId = taskId

      // 5. Wait for the queue's authoritative terminal result.
      console.log('[Realtime Generation] Waiting for generation to complete...')
      const { history: result, promptId } = await waitForQueuedPhotoshopTask(taskId, signal)
      if (epoch !== realtimeGenerationEpoch || signal.aborted) return

      console.log('[Realtime Generation] Collecting generated images...')
      this.publishCompletedRealtimeTask({
        history: result,
        promptId,
        outputNodeIds,
        imageHash,
        epoch,
        signal
      })

      // 7. No need to re-read Photoshop after generation completes.
      // The input image was already read and hashed before the upload.
      // If the user does not modify Photoshop, the next poll will see the same hash and skip work.
      // The hash was already updated in step 1.5, so no extra bookkeeping is needed here.

      console.log('[Realtime Generation] Completed.')
    } catch (error) {
      const wasAborted = error instanceof Error && error.name === 'AbortError'
      if (!wasAborted && queuedTaskId) {
        let authoritativeTerminal = false
        let publishedCompletion = false
        try {
          let [taskStatus, task] = getTask(queuedTaskId)
          if (taskStatus === 'pending' || taskStatus === 'running' || taskStatus === 'cancelling') {
            await cancelPhotoshopTaskBounded(queuedTaskId, 'timed-out/non-terminal')
            ;[taskStatus, task] = getTask(queuedTaskId)
          }
          if (
            taskStatus === 'completed' &&
            task?.result &&
            attemptImageHash &&
            epoch === realtimeGenerationEpoch &&
            !signal.aborted
          ) {
            const promptId = task.prompt_id || task.result.prompt?.[1]
            if (typeof promptId === 'string' && promptId) {
              publishedCompletion = this.publishCompletedRealtimeTask({
                history: task.result,
                promptId,
                outputNodeIds,
                imageHash: attemptImageHash,
                epoch,
                signal
              })
              // Empty successful output also authoritatively locks the hash in the publish helper.
              authoritativeTerminal = true
            }
          } else if (taskStatus === 'error' || taskStatus === 'cancelled') {
            authoritativeTerminal = true
          }
        } catch (reconciliationError) {
          console.error(
            `[Realtime Generation] Failed to reconcile task ${queuedTaskId}:`,
            reconciliationError
          )
        } finally {
          if (
            attemptImageHash &&
            epoch === realtimeGenerationEpoch &&
            !signal.aborted &&
            !authoritativeTerminal &&
            !publishedCompletion
          ) {
            // Once submission exists, any state that cannot be authoritatively classified must be
            // fail-closed. This prevents the next tick from duplicating a possibly-live remote task.
            lastInputImageHash = attemptImageHash
          }
        }
      }
      if (!wasAborted) {
        console.error('[Realtime Generation] Execution failed:', error)
      }
      // Swallow the error so the polling loop can keep running.
    } finally {
      if (currentRealtimeAbortController === abortController) {
        currentRealtimeAbortController = null
      }
      if (currentRealtimeTaskId === queuedTaskId) currentRealtimeTaskId = null
    }
  }

  /**
   * Check whether the image is effectively empty (transparent or a single flat color).
   */
  private async isImageEmpty(imageData: Uint8Array): Promise<boolean> {
    try {
      const buffer = Buffer.from(imageData)
      if (buffer.length < 24) {
        return true // The file is too small to be a valid image.
      }

      // Read image dimensions and PNG color metadata.
      const width = buffer.readUInt32BE(16)
      const height = buffer.readUInt32BE(20)
      const bitDepth = buffer.readUInt8(24)
      const colorType = buffer.readUInt8(25)

      // Zero width or height should be treated as an empty image.
      if (width === 0 || height === 0) {
        return true
      }

      // Collect all IDAT chunk payloads.
      let offset = 8
      const idatChunks: Buffer[] = []

      while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break

        const chunkLength = buffer.readUInt32BE(offset)
        const chunkType = buffer.toString('ascii', offset + 4, offset + 8)

        if (chunkType === 'IDAT') {
          const chunkData = buffer.slice(offset + 8, offset + 8 + chunkLength)
          idatChunks.push(chunkData)
        }

        // Stop when the IEND chunk is reached.
        if (chunkType === 'IEND') {
          break
        }

        offset += 8 + chunkLength + 4
      }

      // No IDAT chunks means there is no image data.
      if (idatChunks.length === 0) {
        return true
      }

      // Merge and inflate all IDAT chunks.
      const combinedIdat = Buffer.concat(idatChunks)
      const decompressed = await inflateAsync(combinedIdat)

      // Calculate the byte length of each scanline.
      // Every PNG scanline starts with one filter byte.
      let bytesPerPixel = 1
      if (colorType === 2) {
        // RGB
        bytesPerPixel = 3
      } else if (colorType === 6) {
        // RGBA
        bytesPerPixel = 4
      } else if (colorType === 3) {
        // Indexed color
        bytesPerPixel = 1
      } else if (colorType === 0) {
        // Grayscale
        bytesPerPixel = 1
      } else if (colorType === 4) {
        // Grayscale + alpha
        bytesPerPixel = 2
      }

      const bytesPerRow = width * bytesPerPixel
      const expectedSize = height * (1 + bytesPerRow) // One filter byte per row.

      // If the inflated data is far smaller than expected, treat it as empty.
      if (decompressed.length < expectedSize * 0.1) {
        return true
      }

      // Check whether all pixels are the same value (transparent or a flat color).
      // Skip the filter byte and inspect only the pixel payload.
      let firstPixel: number[] | null = null
      let allSame = true

      for (let y = 0; y < height && allSame; y++) {
        const rowOffset = y * (1 + bytesPerRow) + 1 // Skip the filter byte.
        for (let x = 0; x < width && allSame; x++) {
          const pixelOffset = rowOffset + x * bytesPerPixel
          if (pixelOffset + bytesPerPixel > decompressed.length) {
            break
          }

          const pixel: number[] = []
          for (let i = 0; i < bytesPerPixel; i++) {
            pixel.push(decompressed[pixelOffset + i])
          }

          if (firstPixel === null) {
            firstPixel = pixel
          } else {
            // Compare the current pixel with the first one.
            for (let i = 0; i < bytesPerPixel; i++) {
              if (pixel[i] !== firstPixel[i]) {
                allSame = false
                break
              }
            }
          }
        }
      }

      // If every pixel matches, treat common flat fills as empty.
      if (allSame && firstPixel !== null) {
        // Detect transparent, black, or white fills.
        if (bytesPerPixel === 4) {
          // RGBA
          if (firstPixel[3] === 0) {
            return true // Fully transparent.
          }
          // Black (0, 0, 0, 255)
          if (
            firstPixel[0] === 0 &&
            firstPixel[1] === 0 &&
            firstPixel[2] === 0 &&
            firstPixel[3] === 255
          ) {
            return true
          }
          // White (255, 255, 255, 255)
          if (
            firstPixel[0] === 255 &&
            firstPixel[1] === 255 &&
            firstPixel[2] === 255 &&
            firstPixel[3] === 255
          ) {
            return true
          }
        } else if (bytesPerPixel === 2) {
          // Grayscale + alpha
          if (firstPixel[1] === 0) {
            return true // Fully transparent.
          }
          // Black (0, 255) or white (255, 255)
          if (firstPixel[0] === 0 || firstPixel[0] === 255) {
            return true
          }
        } else if (bytesPerPixel === 1) {
          // Grayscale or indexed color
          // Black (0) or white (255)
          if (firstPixel[0] === 0 || firstPixel[0] === 255) {
            return true
          }
        } else if (bytesPerPixel === 3) {
          // RGB
          // Black (0, 0, 0) or white (255, 255, 255)
          if (
            (firstPixel[0] === 0 && firstPixel[1] === 0 && firstPixel[2] === 0) ||
            (firstPixel[0] === 255 && firstPixel[1] === 255 && firstPixel[2] === 255)
          ) {
            return true
          }
        }
      }

      return false
    } catch (error) {
      // If parsing fails, fall back to treating the image as non-empty.
      console.warn('[Realtime Generation] Failed to determine whether the image is empty:', error)
      return false
    }
  }

  /**
   * Calculate a stable image hash from core PNG chunks only.
   * This avoids false positives when metadata changes but pixels do not.
   */
  private calculateImageHash(imageData: Uint8Array): string {
    try {
      const buffer = Buffer.from(imageData)
      const chunks: Buffer[] = []
      let offset = 8 // Skip the 8-byte PNG signature.

      // Parse PNG chunks.
      while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break

        const chunkLength = buffer.readUInt32BE(offset)
        const chunkType = buffer.toString('ascii', offset + 4, offset + 8)

        // Only keep core chunks: IHDR (header) and IDAT (pixel data).
        // Ignore metadata chunks such as tEXt, tIME, iTXt, zTXt, tRNS, gAMA, cHRM, sRGB, iCCP, and pHYs.
        if (chunkType === 'IHDR' || chunkType === 'IDAT') {
          // Hash the chunk type and payload, but ignore the length and CRC fields.
          const chunkData = buffer.slice(offset + 4, offset + 8 + chunkLength)
          chunks.push(chunkData)
        }

        // Move to the next chunk: length + type + data + CRC.
        offset += 8 + chunkLength + 4
      }

      // Hash every retained chunk in sequence.
      const hash = crypto.createHash('md5')
      for (const chunk of chunks) {
        hash.update(chunk)
      }
      return hash.digest('hex')
    } catch (error) {
      // If parsing fails, fall back to hashing the full file.
      console.warn(
        '[Realtime Generation] PNG parsing failed; falling back to a full-file hash.',
        error
      )
      return crypto.createHash('md5').update(imageData).digest('hex')
    }
  }
}
