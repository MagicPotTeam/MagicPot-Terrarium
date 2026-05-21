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
import { getQueue } from '../queue/taskQueue'
import { ComfyHttpCli } from '../comfy/http'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { Workflow, FileItem } from '@shared/comfy/types'
import { fileItemToValue } from '@shared/comfy/funcs'
import { waitPromptId, ComfyCliWrapper } from '../comfy/logic'
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

const runAppleScript = (appleScript: string, timeout = 10000) =>
  execFileAsync('osascript', ['-e', appleScript], { timeout })

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
// Whether a realtime generation job is currently in flight.
let isExecutingRealtimeGeneration: boolean = false
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
  ): Promise<LoadImageFromPhotoshopResp> => {
    const platform = os.platform()
    const tempDir = await getPhotoshopTempDir()
    const timestamp = Date.now()
    const outputPath = path.join(tempDir, `photoshop-export-${timestamp}.png`)

    try {
      if (platform === 'win32') {
        // Prefer file export on Windows to avoid clipboard PNG corruption.
        // Keep clipboard export as a compatibility fallback for edge cases.
        await this.exportFromPhotoshopWindowsWithFallback(outputPath)
      } else if (platform === 'darwin') {
        // macOS: use AppleScript to execute Photoshop JavaScript.
        await this.exportFromPhotoshopMac(outputPath)
      } else {
        throw new Error('Direct Photoshop reads are only supported on Windows and macOS.')
      }

      // Wait for the exported file to appear using a short adaptive polling strategy.
      // Start aggressively, then back off while the file is still being written.
      let fileExists = false
      let waitTime = 10 // Initial wait interval in milliseconds.
      const maxWaitTime = 5000 // Maximum total wait time in milliseconds.
      const startTime = Date.now()

      while (Date.now() - startTime < maxWaitTime) {
        try {
          // stat lets us check both existence and file size in one call.
          const stats = await fs.stat(outputPath)
          // A non-empty file is enough to treat the export as ready.
          if (stats.size > 0) {
            fileExists = true
            break
          }
        } catch {
          // The file is not ready yet; keep polling.
        }

        // Back off gradually while capping the polling interval.
        await new Promise((resolve) => setTimeout(resolve, waitTime))
        waitTime = Math.min(waitTime * 1.5, 200) // Cap the interval at 200ms.
      }

      if (!fileExists) {
        throw new Error(`Photoshop export failed: file was not created at ${outputPath}`)
      }

      // Read the exported image file.
      const imageData = await fs.readFile(outputPath)
      const fileName = `photoshop-export-${timestamp}.png`

      // Clean up the temporary file asynchronously so the response is not blocked.
      fs.unlink(outputPath).catch(() => {
        // Ignore cleanup failures because the export already succeeded.
      })

      return {
        image: new Uint8Array(imageData),
        fileName
      }
    } catch (error) {
      console.error('Failed to load image from Photoshop:', error)
      throw new Error(
        `Unable to read an image from Photoshop. Make sure Photoshop is running and a document is open.\nError details: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async exportFromPhotoshopWindowsWithFallback(outputPath: string): Promise<void> {
    try {
      await this.exportFromPhotoshopWindows(outputPath)
    } catch (directExportError) {
      console.warn(
        '[Photoshop] Direct file export failed, falling back to clipboard export:',
        directExportError
      )
      await this.exportFromPhotoshopWindowsViaClipboard(outputPath)
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

    const timestamp = Date.now()
    const tempDir = await getPhotoshopTempDir()
    const psScriptPath = path.join(tempDir, `ps-export-direct-${timestamp}.ps1`)
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
  private async exportFromPhotoshopWindowsViaClipboard(outputPath: string): Promise<void> {
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

    const timestamp = Date.now()
    const tempDir = await getPhotoshopTempDir()
    const jsxScriptPath = path.join(tempDir, `ps-clipboard-${timestamp}.jsx`)
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

    const psScriptPath = path.join(tempDir, `ps-clipboard-${timestamp}.ps1`)
    const psScriptWithBOM = '\uFEFF' + psScript
    await fs.writeFile(psScriptPath, psScriptWithBOM, 'utf8')

    try {
      const command = `powershell -ExecutionPolicy Bypass -File "${psScriptPath}"`
      console.log('[Photoshop] Running clipboard export script')

      const { stdout, stderr } = await execAsync(command, {
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024
      })

      if (stdout) {
        console.log('[Photoshop] PowerShell output:', stdout)
      }

      if (stderr && !stderr.includes('Warning') && stderr.trim().length > 0) {
        console.error('[Photoshop] PowerShell error:', stderr)
        throw new Error(stderr)
      }

      // Give the clipboard a brief moment to update before reading it.
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Read the image from the clipboard.
      const clipboardImage = clipboard.readImage()
      if (clipboardImage.isEmpty()) {
        throw new Error('No image data is available on the clipboard')
      }

      // Save the clipboard image as PNG.
      const pngBuffer = clipboardImage.toPNG()
      await fs.writeFile(outputPath, pngBuffer)
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
  private async exportFromPhotoshopWindows(outputPath: string): Promise<void> {
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
    const timestamp = Date.now()
    const tempDir = await getPhotoshopTempDir()
    const jsxScriptPath = path.join(tempDir, `ps-export-${timestamp}.jsx`)
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
      const psScriptPath = path.join(tempDir, `ps-script-${timestamp}.ps1`)
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
          maxBuffer: 10 * 1024 * 1024 // 10MB
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
  private async exportFromPhotoshopMac(outputPath: string): Promise<void> {
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
    const { stderr } = await runAppleScript(buildPhotoshopJavaScriptAppleScript(jsxScript))

    if (stderr) {
      throw new Error(stderr)
    }

    // Confirm that the export file was created.
    try {
      await fs.access(outputPath)
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
    const fileName = `photoshop-clipboard-${Date.now()}.png`

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
  ): Promise<StartRealtimeGenerationResp> => {
    try {
      // If realtime generation is already running, stop it before restarting.
      if (realtimeGenerationInterval) {
        this.stopRealtimeGeneration({})
      }

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
      // Reset the execution guard.
      isExecutingRealtimeGeneration = false
      // Clear cached renderer data.
      latestLoadedImage = null
      latestGeneratedResult = null

      // Start the polling loop.
      this.startRealtimeGenerationLoop()

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
  }

  /**
   * Stop realtime generation.
   */
  stopRealtimeGeneration = async (
    req: StopRealtimeGenerationReq
  ): Promise<StopRealtimeGenerationResp> => {
    if (realtimeGenerationInterval) {
      clearInterval(realtimeGenerationInterval)
      realtimeGenerationInterval = null
      realtimeGenerationConfig = null
      lastInputImageHash = null // Reset the last image hash.
      isExecutingRealtimeGeneration = false // Reset the execution guard.
      latestLoadedImage = null // Clear cached renderer data.
      latestGeneratedResult = null // Clear cached renderer data.
    }
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
  private startRealtimeGenerationLoop(): void {
    if (realtimeGenerationInterval) {
      return
    }

    realtimeGenerationInterval = setInterval(async () => {
      try {
        if (!realtimeGenerationConfig) {
          return
        }

        // Skip this tick if a generation job is already running.
        if (isExecutingRealtimeGeneration) {
          return
        }

        // Check the queue state first.
        const queueState = getQueue()
        const hasRunningOrPending = queueState.running.length > 0 || queueState.pending.length > 0

        if (hasRunningOrPending) {
          // Skip this tick while other work is running or queued.
          return
        }

        // The queue is idle, so run realtime generation now.
        await this.executeRealtimeGeneration()
      } catch (error) {
        console.error('[Realtime Generation] Execution failed:', error)
        // Keep the loop alive and try again on the next tick.
      }
    }, realtimeGenerationConfig?.pollInterval || 2000)
  }

  /**
   * Run one realtime generation pass.
   */
  private async executeRealtimeGeneration(): Promise<void> {
    if (!realtimeGenerationConfig) {
      return
    }

    // Guard against re-entrant execution.
    if (isExecutingRealtimeGeneration) {
      return
    }

    // Mark execution as in progress.
    isExecutingRealtimeGeneration = true

    const { workflowTemplate, imageInputSlot, outputNodeIds } = realtimeGenerationConfig

    try {
      // 1. Read the current image from Photoshop.
      console.log('[Realtime Generation] Reading image from Photoshop...')
      const psImage = await this.loadImageFromPhotoshop({})

      // 1.5 Compute a stable hash of the PNG payload and compare it to the last run.
      // Only hash core PNG chunks (IHDR + IDAT) so metadata changes do not trigger reruns.
      const imageHash = this.calculateImageHash(psImage.image)
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
        // Clear the execution guard so the next poll can run.
        isExecutingRealtimeGeneration = false
        return
      }

      if (lastInputImageHash !== null) {
        console.log(
          `[Realtime Generation] Input image changed. Previous hash: ${lastInputImageHash}, current hash: ${imageHash}`
        )
      } else {
        console.log(`[Realtime Generation] First image load. Hash: ${imageHash}`)
      }

      lastInputImageHash = imageHash
      console.log('[Realtime Generation] Starting generation...')

      // 2. Upload the image to ComfyUI.
      console.log('[Realtime Generation] Uploading image to ComfyUI...')
      const cli = new ComfyHttpCli()
      const fileItem = await cli.uploadImage(
        { filename: psImage.fileName, type: 'input' },
        psImage.image
      )

      if (!fileItem.filename) {
        throw new Error('Failed to upload image')
      }

      // 2.5 Cache the loaded image metadata for renderer updates.
      const imageValue = fileItemToValue(fileItem)
      // Convert array-style values to JSON so the renderer always receives a string.
      const imageValueStr = typeof imageValue === 'string' ? imageValue : JSON.stringify(imageValue)
      latestLoadedImage = {
        imageValue: imageValueStr,
        imageInputSlot
      }

      // 3. Build the workflow by cloning the template and injecting the image input.
      const workflow: Workflow = JSON.parse(JSON.stringify(workflowTemplate))
      setJsonPath(imageInputSlot, workflow, imageValue)

      // 4. Submit the workflow.
      console.log('[Realtime Generation] Submitting workflow...')
      const { prompt_id } = await cli.prompt({
        prompt: workflow,
        client_id: crypto.randomUUID()
      })

      // 5. Wait for generation to complete.
      console.log('[Realtime Generation] Waiting for generation to complete...')
      const cliWrapper: ComfyCliWrapper = {
        history: (promptId) => cli.history(promptId),
        view: (meta) => cli.view(meta)
      }

      const result = await waitPromptId(cliWrapper, prompt_id)

      if (result.status.status_str === 'error') {
        console.error('[Realtime Generation] Generation failed:', result.status)
        return
      }

      // 5.5 Cache the generated result for renderer updates.
      latestGeneratedResult = {
        promptId: prompt_id,
        history: result,
        outputNodeIds
      }

      // 6. Collect the generated images.
      console.log('[Realtime Generation] Collecting generated images...')
      const outputImages: FileItem[] = []
      for (const nodeId of outputNodeIds) {
        const nodeOutput = result.outputs[nodeId]
        if (nodeOutput?.images) {
          outputImages.push(...nodeOutput.images)
        }
      }

      if (outputImages.length === 0) {
        console.warn('[Realtime Generation] No output images were produced.')
        return
      }

      // 7. No need to re-read Photoshop after generation completes.
      // The input image was already read and hashed before the upload.
      // If the user does not modify Photoshop, the next poll will see the same hash and skip work.
      // The hash was already updated in step 1.5, so no extra bookkeeping is needed here.

      console.log('[Realtime Generation] Completed.')
    } catch (error) {
      console.error('[Realtime Generation] Execution failed:', error)
      // Swallow the error so the polling loop can keep running.
    } finally {
      // Always clear the execution guard.
      isExecutingRealtimeGeneration = false
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
