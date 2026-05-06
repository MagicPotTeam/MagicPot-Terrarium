import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assessTestWindowPlacement,
  createTestUiRunId,
  resolveConfiguredDesktopPath,
  resolveTestArtifactRoot,
  sanitizeTestUiRunId
} from './testUiPolicy'

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const realFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

const runSmoke = process.env['RUN_ELECTRON_STARTUP_SMOKE'] === '1'
const smokeIt = runSmoke ? it : it.skip
const runCanvasInteractionSmoke = process.env['RUN_ELECTRON_CANVAS_SMOKE'] === '1'
const canvasSmokeIt = runSmoke && runCanvasInteractionSmoke ? it : it.skip
const SMOKE_ELECTRON_LAUNCH_TIMEOUT_MS = 90000
const SMOKE_FIRST_WINDOW_TIMEOUT_MS = 90000
const SMOKE_HEALTH_TIMEOUT_MS = 120000
const SMOKE_RELAUNCH_SETTLE_MS = 1000

function findSmokeWorkspaceRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url))
  while (current !== path.dirname(current)) {
    if (realFs.existsSync(path.join(current, 'package.json'))) {
      return current
    }
    current = path.dirname(current)
  }

  throw new Error('Unable to resolve the MagicPot workspace root for startup smoke.')
}

function getSmokeWorkspaceRoot(): string {
  return process.env['MAGICPOT_SMOKE_WORKSPACE_ROOT']?.trim() || findSmokeWorkspaceRoot()
}

function getSmokeDesktopPath(): string {
  return resolveConfiguredDesktopPath(path.join(os.homedir(), 'Desktop'))
}

function getSmokeArtifactRootOverride(): string | undefined {
  return (
    process.env['MAGICPOT_TEST_ARTIFACT_ROOT']?.trim() ||
    process.env['MAGICPOT_TEST_UI_ARTIFACT_ROOT']?.trim() ||
    undefined
  )
}

function getConfiguredSmokeRunId(): string | undefined {
  return (
    process.env['MAGICPOT_TEST_RUN_ID']?.trim() ||
    process.env['MAGICPOT_TEST_UI_RUN_ID']?.trim() ||
    undefined
  )
}

function buildSmokeWindowEnv(runId: string) {
  const artifactRootOverride = getSmokeArtifactRootOverride()
  return {
    MAGICPOT_TEST_UI_MODE: 'secondary-or-offscreen',
    MAGICPOT_TEST_WINDOW_MODE: 'secondary-or-offscreen',
    MAGICPOT_TEST_NO_FOCUS: '1',
    MAGICPOT_TEST_AUTOMATED_RUN: '1',
    MAGICPOT_TEST_RUN_ID: runId,
    ...(artifactRootOverride ? { MAGICPOT_TEST_ARTIFACT_ROOT: artifactRootOverride } : {})
  } as const
}

let currentSmokeRunId: string | null = null

async function waitForSmokeRelaunchSettle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SMOKE_RELAUNCH_SETTLE_MS))
}

function createSmokeTempRoot(runId: string): string {
  const artifactRoot = resolveTestArtifactRoot({
    desktopPath: getSmokeDesktopPath(),
    tempPath: os.tmpdir(),
    policy: {
      automatedRun: true,
      runId,
      artifactRootOverride: getSmokeArtifactRootOverride()
    }
  })

  realFs.mkdirSync(artifactRoot, { recursive: true })
  return realFs.mkdtempSync(path.join(artifactRoot, 'startup-smoke-'))
}

function expectSmokeArtifactLayout(tempRoot: string, runId: string): void {
  const artifactRoot = resolveTestArtifactRoot({
    desktopPath: getSmokeDesktopPath(),
    tempPath: os.tmpdir(),
    policy: {
      automatedRun: true,
      runId,
      artifactRootOverride: getSmokeArtifactRootOverride()
    }
  })

  const relativePath = path.relative(artifactRoot, tempRoot)
  expect(relativePath).toBeTruthy()
  expect(relativePath.startsWith('..')).toBe(false)
  expect(path.isAbsolute(relativePath)).toBe(false)
}

function initializeSmokeTempRoot(): string {
  currentSmokeRunId = sanitizeTestUiRunId(getConfiguredSmokeRunId(), createTestUiRunId())
  const tempRoot = createSmokeTempRoot(currentSmokeRunId)
  expectSmokeArtifactLayout(tempRoot, currentSmokeRunId)
  return tempRoot
}

function getCurrentSmokeRunId(): string {
  if (!currentSmokeRunId) {
    currentSmokeRunId = sanitizeTestUiRunId(getConfiguredSmokeRunId(), createTestUiRunId())
  }
  return currentSmokeRunId
}

type SmokeAppHandle = {
  app: ElectronApplication
  page: Page
  fatalErrors: string[]
}

type PersistedCanvasItem = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  scaleX: number
  scaleY: number
  rotation: number
  sourceWidth?: number
  sourceHeight?: number
  crop?: {
    x: number
    y: number
    width: number
    height: number
  }
  [key: string]: unknown
}

type PersistedCanvasPayload =
  | PersistedCanvasItem[]
  | {
      items?: PersistedCanvasItem[]
      [key: string]: unknown
    }

type ResizeHandlePoint = {
  x: number
  y: number
  cursor: string
}

type CanvasStageTransform = {
  x: number
  y: number
  scale: number
}

type PersistedCanvasImageTransition = {
  canvasId: string
  beforeImage: PersistedCanvasItem
  afterImage: PersistedCanvasItem
}

type CanvasCropBoxProbeDetail = {
  itemId: string
  active: boolean
  cropBox: {
    x: number
    y: number
    width: number
    height: number
  } | null
}

type CanvasTransformProbeDetail = {
  id: string
  attrs: {
    x: number
    y: number
    rotation: number
    scaleX: number
    scaleY: number
  }
}

type SmokeImportFileSpec = {
  filePath: string
  mimeType: string
}

function isFatalPageError(message: string): boolean {
  return !/fetch failed|Pysssss is not installed/i.test(message)
}

async function writeSmokeConfig(userDataDir: string): Promise<void> {
  const config = {
    use_remote_comfyui: true,
    use_remote_llm: true,
    local_llm_server_config: {
      enable_server: false
    },
    chat_config: {
      enable: false
    },
    mcp_config: {
      client: {
        servers: []
      },
      server: {
        enabled: false
      }
    }
  }

  await realFsPromises.mkdir(userDataDir, { recursive: true })
  await realFsPromises.writeFile(
    path.join(userDataDir, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  )
}

function getWorkflowImagePath(): string {
  return path.join(
    getSmokeWorkspaceRoot(),
    'packages',
    'app',
    'src',
    'renderer',
    'src',
    'assets',
    'workflowImage.png'
  )
}

function getWorkflowVideoPath(): string {
  return path.join(
    getSmokeWorkspaceRoot(),
    'packages',
    'app',
    'src',
    'main',
    'testSupport',
    'fixtures',
    'projectCanvas',
    'projectCanvasSampleVideo.webm'
  )
}

async function launchSmokeApp(
  userDataDir: string,
  runId = getCurrentSmokeRunId()
): Promise<SmokeAppHandle> {
  const launchArgs = process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.']
  let lastError: unknown = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let app: ElectronApplication
    try {
      app = await electron.launch({
        args: launchArgs,
        cwd: getSmokeWorkspaceRoot(),
        env: {
          ...process.env,
          MAGICPOT_USER_DATA_DIR: userDataDir,
          ...buildSmokeWindowEnv(runId)
        },
        timeout: SMOKE_ELECTRON_LAUNCH_TIMEOUT_MS
      })
    } catch (error) {
      lastError = error
      if (attempt < 1) {
        await waitForSmokeRelaunchSettle()
      }
      continue
    }
    const page = await app.firstWindow({ timeout: SMOKE_FIRST_WINDOW_TIMEOUT_MS })
    const fatalErrors: string[] = []

    page.on('pageerror', (error) => {
      if (isFatalPageError(error.message)) {
        fatalErrors.push(`pageerror: ${error.message}`)
      }
    })
    page.on('console', (message) => {
      if (message.type() !== 'error') {
        return
      }
      const text = message.text()
      if (
        /Failed to fetch dynamically imported module/i.test(text) ||
        /Renderer crashed/i.test(text)
      ) {
        fatalErrors.push(`console: ${text}`)
      }
    })

    try {
      await waitForHealthyPage(page, fatalErrors)
      await expectNonIntrusiveWindowPlacement(app)
      return { app, page, fatalErrors }
    } catch (error) {
      lastError = error
      try {
        await app.close()
      } catch {
        // Ignore cleanup failures during retry.
      }
      if (attempt < 1) {
        await waitForSmokeRelaunchSettle()
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to launch a healthy smoke app window.')
}

async function expectNonIntrusiveWindowPlacement(app: ElectronApplication): Promise<void> {
  const placement = await app.evaluate(({ BrowserWindow, screen }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) {
      throw new Error('Startup smoke expected a BrowserWindow instance.')
    }

    const bounds = mainWindow.getBounds()
    const primaryDisplay = screen.getPrimaryDisplay()
    const displays = screen.getAllDisplays().map((display) => ({
      id: display.id,
      workArea: display.workArea
    }))
    const windowWithOptionalSkipTaskbar = mainWindow as typeof mainWindow & {
      isSkipTaskbar?: () => boolean
      isSkippedTaskbar?: () => boolean
      [key: symbol]: boolean | undefined
    }
    const appliedSkipTaskbar =
      windowWithOptionalSkipTaskbar[Symbol.for('magicpot.testWindowRuntime.skipTaskbar')]
    const skipTaskbar =
      typeof windowWithOptionalSkipTaskbar.isSkipTaskbar === 'function'
        ? windowWithOptionalSkipTaskbar.isSkipTaskbar()
        : typeof windowWithOptionalSkipTaskbar.isSkippedTaskbar === 'function'
          ? windowWithOptionalSkipTaskbar.isSkippedTaskbar()
          : typeof appliedSkipTaskbar === 'boolean'
            ? appliedSkipTaskbar
            : null

    return {
      bounds,
      displays,
      focusable: mainWindow.isFocusable(),
      focused: mainWindow.isFocused(),
      visible: mainWindow.isVisible(),
      skipTaskbar,
      primaryDisplayId: primaryDisplay.id
    }
  })

  const assessment = assessTestWindowPlacement({
    bounds: placement.bounds,
    displays: placement.displays,
    primaryDisplayId: placement.primaryDisplayId,
    policy: {
      hideWindow: !placement.visible,
      preferSecondaryDisplay: true,
      forceOffscreen: false
    }
  })

  if (placement.visible) {
    const hasSecondaryDisplay = placement.displays.some(
      (display) => display.id !== placement.primaryDisplayId
    )
    expect(assessment.shouldHideWindow).toBe(false)
    expect(assessment.expectedMode).toBe(hasSecondaryDisplay ? 'secondary-display' : 'offscreen')
    if (hasSecondaryDisplay) {
      expect(assessment.intersectingDisplayIds).not.toContain(placement.primaryDisplayId)
      expect(assessment.intersectingDisplayIds.length).toBeGreaterThan(0)
    } else {
      expect(assessment.intersectingDisplayIds).toHaveLength(0)
    }
  }

  expect(placement.focusable).toBe(false)
  expect(placement.focused).toBe(false)
  expect(placement.skipTaskbar).toBe(true)
}

async function waitForHealthyPage(page: Page, fatalErrors: string[]): Promise<void> {
  await page.waitForFunction(() => Boolean(document.getElementById('root')), undefined, {
    timeout: SMOKE_HEALTH_TIMEOUT_MS
  })
  await page.waitForTimeout(1200)

  expect(page.isClosed()).toBe(false)

  const bodyText = await page.evaluate(() => document.body?.innerText || '')
  expect(bodyText).not.toContain('Renderer crashed')
  expect(bodyText).not.toContain('Unexpected Application Error')
  expect(fatalErrors).toEqual([])
}

async function relaunchSmokeAppUntilHealthy(
  userDataDir: string,
  runId = getCurrentSmokeRunId()
): Promise<SmokeAppHandle> {
  let lastError: unknown = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForSmokeRelaunchSettle()
    const handle = await launchSmokeApp(userDataDir, runId)
    try {
      await waitForHealthyPage(handle.page, handle.fatalErrors)
      return handle
    } catch (error) {
      lastError = error
      try {
        await handle.app.close()
      } catch {
        // Ignore cleanup failures during retry.
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to relaunch a healthy smoke app window.')
}

async function navigateToHash(page: Page, hash: string): Promise<void> {
  const appliedHash = await page.evaluate((nextHash) => {
    window.location.hash = nextHash
    return window.location.hash
  }, hash)
  expect(appliedHash).toBe(hash)
  await page.waitForTimeout(150)
}

async function getCanvasImportInput(page: Page) {
  const stableImportInput = page.locator('input[data-testid="project-canvas-import-input"]').first()
  if ((await stableImportInput.count()) > 0) {
    await stableImportInput.waitFor({ state: 'attached', timeout: 60000 })
    return stableImportInput
  }

  const fallbackImportInput = page
    .locator('input[type="file"][accept*="image/*"][accept*="video/*"]')
    .first()
  await fallbackImportInput.waitFor({ state: 'attached', timeout: 60000 })
  return fallbackImportInput
}

function getSmokeImportMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.webm':
      return 'video/webm'
    case '.mp4':
      return 'video/mp4'
    default:
      return 'application/octet-stream'
  }
}

async function setCanvasImportFiles(page: Page, files: string | string[]): Promise<void> {
  const importFiles = (Array.isArray(files) ? files : [files]).map((filePath) => ({
    filePath,
    mimeType: getSmokeImportMimeType(filePath)
  }))
  let lastError: unknown = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await dispatchCanvasImportFilesWithPaths(page, importFiles)
      return
    } catch (error) {
      lastError = error
      await page.waitForTimeout(500)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to set canvas import files for the startup smoke.')
}

async function dispatchCanvasImportFilesWithPaths(
  page: Page,
  files: SmokeImportFileSpec[]
): Promise<void> {
  const importInput = await getCanvasImportInput(page)
  const selector = await importInput.evaluate((element) => {
    const htmlInput = element as HTMLInputElement
    if (!htmlInput.dataset.startupSmokeImportId) {
      htmlInput.dataset.startupSmokeImportId = `startup-smoke-import-${Math.random()
        .toString(36)
        .slice(2)}`
    }
    return `input[data-startup-smoke-import-id="${htmlInput.dataset.startupSmokeImportId}"]`
  })

  await page.evaluate(
    async ({ targetSelector, importFiles }) => {
      const input = document.querySelector(targetSelector) as HTMLInputElement | null
      if (!input) {
        throw new Error(`Unable to resolve startup smoke import input: ${targetSelector}`)
      }

      const runtimeWindow = window as typeof window & {
        api: {
          svcFs: {
            readFileFromPath(req: { fullPath: string }): Promise<{
              data: ArrayLike<number>
              filename: string
            }>
          }
        }
      }
      const transfer = new DataTransfer()
      for (const { fullPath, fileMimeType } of importFiles) {
        const response = await runtimeWindow.api.svcFs.readFileFromPath({ fullPath })
        const fileBytes = new Uint8Array(response.data as ArrayLike<number>)
        const file = new File([fileBytes], response.filename, { type: fileMimeType })
        Object.defineProperty(file, 'path', {
          configurable: true,
          enumerable: false,
          value: fullPath.replace(/\\/g, '/')
        })
        transfer.items.add(file)
      }

      Object.defineProperty(input, 'files', {
        configurable: true,
        value: transfer.files
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    {
      targetSelector: selector,
      importFiles: files.map((file) => ({
        fullPath: file.filePath,
        fileMimeType: file.mimeType
      }))
    }
  )
}

async function dispatchCanvasImportFileWithPath(
  page: Page,
  filePath: string,
  mimeType: string
): Promise<void> {
  await dispatchCanvasImportFilesWithPaths(page, [{ filePath, mimeType }])
}

async function getCanvasInteractionHostBounds(page: Page): Promise<{
  x: number
  y: number
  width: number
  height: number
}> {
  const bounds = await page.evaluate(() => {
    const stageRoot = document.querySelector(
      '[data-testid="project-canvas-stage-root"]'
    ) as HTMLElement | null
    if (stageRoot && stageRoot.isConnected) {
      const stageStyle = getComputedStyle(stageRoot)
      const stageRect = stageRoot.getBoundingClientRect()
      if (
        stageStyle.display !== 'none' &&
        stageStyle.visibility !== 'hidden' &&
        stageRect.width > 0 &&
        stageRect.height > 0
      ) {
        return {
          x: stageRect.left,
          y: stageRect.top,
          width: stageRect.width,
          height: stageRect.height
        }
      }
    }

    const stageHost = document.querySelector('.konvajs-content') as HTMLElement | null
    if (stageHost && stageHost.isConnected) {
      const stageStyle = getComputedStyle(stageHost)
      const stageRect = stageHost.getBoundingClientRect()
      if (
        stageStyle.display !== 'none' &&
        stageStyle.visibility !== 'hidden' &&
        stageRect.width > 0 &&
        stageRect.height > 0
      ) {
        return {
          x: stageRect.left,
          y: stageRect.top,
          width: stageRect.width,
          height: stageRect.height
        }
      }
    }

    const hosts = Array.from(document.querySelectorAll('div[tabindex="0"]')) as HTMLElement[]
    let bestBounds: { x: number; y: number; width: number; height: number } | null = null
    let bestArea = -1

    hosts.forEach((element) => {
      if (!element.isConnected || element.querySelectorAll('canvas').length === 0) {
        return
      }

      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') {
        return
      }

      const rect = element.getBoundingClientRect()
      const area = rect.width * rect.height
      if (rect.width <= 0 || rect.height <= 0 || area <= bestArea) {
        return
      }

      bestArea = area
      bestBounds = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      }
    })

    return bestBounds
  })

  if (!bounds) {
    throw new Error('Unable to resolve the canvas interaction host bounds for startup smoke.')
  }

  return bounds
}

async function getMultiSelectionTransformOverlayBounds(page: Page): Promise<{
  x: number
  y: number
  width: number
  height: number
}> {
  const bounds = await page
    .locator('[data-testid="project-canvas-multi-selection-transform-overlay"]')
    .boundingBox()

  if (!bounds) {
    throw new Error(
      'Unable to resolve the multi-selection transform overlay bounds for startup smoke.'
    )
  }

  return bounds
}

async function getMultiSelectionDragSurfaceBounds(page: Page): Promise<{
  x: number
  y: number
  width: number
  height: number
}> {
  const bounds = await page
    .locator('[data-canvas-multi-select-drag-surface="true"]')
    .first()
    .boundingBox()

  if (!bounds) {
    throw new Error('Unable to resolve a multi-selection drag surface for startup smoke.')
  }

  return bounds
}

async function getCanvasStageTransform(page: Page): Promise<CanvasStageTransform> {
  return page.evaluate(() => {
    const host = document.querySelector(
      '[data-testid="project-canvas-stage-root"]'
    ) as HTMLElement | null

    const x = Number(host?.dataset.stagePosX ?? 0)
    const y = Number(host?.dataset.stagePosY ?? 0)
    const scale = Number(host?.dataset.stageScale ?? 1)

    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      scale: Number.isFinite(scale) && Math.abs(scale) > 0.0001 ? scale : 1
    }
  })
}

async function clickCanvasHostCenter(page: Page): Promise<void> {
  const bounds = await getCanvasInteractionHostBounds(page)
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
}

async function clickCanvasHostPadding(
  page: Page,
  offset: { x: number; y: number } = { x: 24, y: 24 }
): Promise<void> {
  const bounds = await getCanvasInteractionHostBounds(page)
  await page.mouse.click(bounds.x + offset.x, bounds.y + offset.y)
}

function isCanvasPointInsideItem(
  point: { x: number; y: number },
  item: Pick<PersistedCanvasItem, 'x' | 'y' | 'width' | 'height' | 'scaleX' | 'scaleY'>,
  stageTransform: CanvasStageTransform
): boolean {
  const startX = stageTransform.x + item.x * stageTransform.scale
  const startY = stageTransform.y + item.y * stageTransform.scale
  const endX = stageTransform.x + (item.x + item.width * item.scaleX) * stageTransform.scale
  const endY = stageTransform.y + (item.y + item.height * item.scaleY) * stageTransform.scale
  const left = Math.min(startX, endX)
  const right = Math.max(startX, endX)
  const top = Math.min(startY, endY)
  const bottom = Math.max(startY, endY)

  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
}

async function clickCanvasBlankSpace(page: Page, items: PersistedCanvasItem[]): Promise<void> {
  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)
  const margin = 24
  const candidates = [
    { x: margin, y: margin },
    { x: bounds.width - margin, y: margin },
    { x: margin, y: bounds.height - margin },
    { x: bounds.width - margin, y: bounds.height - margin },
    { x: bounds.width / 2, y: margin },
    { x: bounds.width / 2, y: bounds.height - margin }
  ]

  const blankPoint =
    candidates.find((candidate) =>
      items.every((item) => !isCanvasPointInsideItem(candidate, item, stageTransform))
    ) ?? candidates[candidates.length - 1]!

  await page.mouse.click(bounds.x + blankPoint.x, bounds.y + blankPoint.y)
}

async function clickCanvasItemCenter(
  page: Page,
  item: PersistedCanvasItem,
  offset: { x?: number; y?: number } = {}
): Promise<void> {
  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)
  const centerX =
    bounds.x +
    stageTransform.x +
    (item.x + (item.width * item.scaleX) / 2) * stageTransform.scale +
    (offset.x ?? 0)
  const centerY =
    bounds.y +
    stageTransform.y +
    (item.y + (item.height * item.scaleY) / 2) * stageTransform.scale +
    (offset.y ?? 0)
  await page.mouse.click(centerX, centerY)
}

async function clickCanvasImageInteractionOverlay(
  page: Page,
  itemId: string,
  offset: { x?: number; y?: number } = {}
): Promise<boolean> {
  const overlay = page.locator(`[data-canvas-item-id="${itemId}"]`).first()
  if ((await overlay.count()) === 0) {
    return false
  }

  const box = await overlay.boundingBox()
  if (!box) {
    return false
  }

  const horizontalPadding = Math.min(12, Math.max(0, Math.floor(box.width / 4)))
  const verticalPadding = Math.min(12, Math.max(0, Math.floor(box.height / 4)))
  const minX = horizontalPadding
  const maxX = Math.max(minX, box.width - horizontalPadding)
  const minY = verticalPadding
  const maxY = Math.max(minY, box.height - verticalPadding)
  const targetX = Math.min(maxX, Math.max(minX, box.width / 2 + Math.round(offset.x ?? 0)))
  const targetY = Math.min(maxY, Math.max(minY, box.height / 2 + Math.round(offset.y ?? 0)))

  await page.mouse.click(box.x + targetX, box.y + targetY)
  return true
}

async function resolveCanvasBlankSelectionStartPoint(
  page: Page,
  bounds: { x: number; y: number; width: number; height: number },
  items: PersistedCanvasItem[],
  stageTransform: CanvasStageTransform,
  preferredCandidates: Array<{ x: number; y: number }>
): Promise<{ x: number; y: number }> {
  const margin = 12
  const clampedCandidates = preferredCandidates
    .map((candidate) => ({
      x: Math.min(bounds.width - margin, Math.max(margin, candidate.x)),
      y: Math.min(bounds.height - margin, Math.max(margin, candidate.y))
    }))
    .filter(
      (candidate, index, candidates) =>
        candidates.findIndex(
          (entry) => Math.abs(entry.x - candidate.x) < 0.5 && Math.abs(entry.y - candidate.y) < 0.5
        ) === index
    )

  for (const candidate of clampedCandidates) {
    if (items.some((item) => isCanvasPointInsideItem(candidate, item, stageTransform))) {
      continue
    }

    const probe = await page.evaluate(
      ({ screenX, screenY }) => {
        const target = document.elementFromPoint(screenX, screenY) as Element | null
        return {
          insideStageRoot: Boolean(target?.closest('[data-testid="project-canvas-stage-root"]')),
          hitsInteractiveOverlay: Boolean(
            target?.closest(
              [
                '[data-canvas-item-id]',
                '[data-project-canvas-crop-overlay="dom"]',
                '[data-canvas-crop-box]',
                '[data-canvas-crop-handle]',
                '.image-action-toolbar',
                '.blob-item-action-toolbar',
                '.file-item-action-toolbar',
                '.text-item-action-toolbar',
                '.selection-action-stack'
              ].join(',')
            )
          ),
          isStageLayerTarget: Boolean(
            target?.closest('[data-project-canvas-stage-event-layer="dom"]')
          )
        }
      },
      {
        screenX: bounds.x + candidate.x,
        screenY: bounds.y + candidate.y
      }
    )

    if (probe.insideStageRoot && !probe.hitsInteractiveOverlay) {
      return candidate
    }

    if (probe.isStageLayerTarget) {
      return candidate
    }
  }

  return clampedCandidates[0] ?? { x: margin, y: margin }
}

async function getSelectionBoxDragPoints(
  page: Page,
  bounds: { x: number; y: number; width: number; height: number },
  items: PersistedCanvasItem[],
  stageTransform: CanvasStageTransform
): Promise<{ startX: number; startY: number; endX: number; endY: number }> {
  const minX = Math.min(...items.map((item) => stageTransform.x + item.x * stageTransform.scale))
  const minY = Math.min(...items.map((item) => stageTransform.y + item.y * stageTransform.scale))
  const maxX = Math.max(
    ...items.map(
      (item) => stageTransform.x + (item.x + item.width * item.scaleX) * stageTransform.scale
    )
  )
  const maxY = Math.max(
    ...items.map(
      (item) => stageTransform.y + (item.y + item.height * item.scaleY) * stageTransform.scale
    )
  )

  const candidateStartPoints = [
    { x: minX - 24, y: minY - 24 },
    { x: minX - 24, y: maxY + 24 },
    { x: maxX + 24, y: minY - 24 },
    { x: maxX + 24, y: maxY + 24 },
    { x: minX - 24, y: (minY + maxY) / 2 },
    { x: maxX + 24, y: (minY + maxY) / 2 },
    { x: (minX + maxX) / 2, y: minY - 24 },
    { x: (minX + maxX) / 2, y: maxY + 24 },
    { x: 24, y: 24 },
    { x: bounds.width - 24, y: 24 },
    { x: 24, y: bounds.height - 24 },
    { x: bounds.width - 24, y: bounds.height - 24 },
    { x: bounds.width / 2, y: 24 },
    { x: bounds.width / 2, y: bounds.height - 24 }
  ]

  const startPoint = await resolveCanvasBlankSelectionStartPoint(
    page,
    bounds,
    items,
    stageTransform,
    candidateStartPoints
  )

  const endCanvasX =
    startPoint.x <= (minX + maxX) / 2
      ? Math.min(bounds.width - 12, maxX + 24)
      : Math.max(12, minX - 24)
  const endCanvasY =
    startPoint.y <= (minY + maxY) / 2
      ? Math.min(bounds.height - 12, maxY + 24)
      : Math.max(12, minY - 24)

  return {
    startX: bounds.x + startPoint.x,
    startY: bounds.y + startPoint.y,
    endX: bounds.x + endCanvasX,
    endY: bounds.y + endCanvasY
  }
}

async function selectCanvasItemForImageToolbar(
  page: Page,
  item: PersistedCanvasItem
): Promise<void> {
  await waitForCanvasImageInteractionReady(page)
  const strongOffsetX = Math.max(16, Math.round(item.width * item.scaleX * 0.35))
  const strongOffsetY = Math.max(16, Math.round(item.height * item.scaleY * 0.35))
  const attemptOffsets = [
    { x: 0, y: 0 },
    { x: strongOffsetX, y: 0 },
    { x: -strongOffsetX, y: 0 },
    { x: 0, y: strongOffsetY },
    { x: 0, y: -strongOffsetY },
    { x: 8, y: 0 },
    { x: 0, y: 8 },
    { x: -8, y: 0 },
    { x: 0, y: -8 },
    { x: Math.max(12, Math.round(item.width * item.scaleX * 0.18)), y: 0 },
    { x: 0, y: Math.max(12, Math.round(item.height * item.scaleY * 0.18)) }
  ]
  let lastError: unknown = null

  for (const offset of attemptOffsets) {
    const clickedOverlay = await clickCanvasImageInteractionOverlay(page, item.id, offset)
    if (!clickedOverlay) {
      await clickCanvasItemCenter(page, item, offset)
    }
    try {
      await page.waitForSelector('.image-action-toolbar', { timeout: 5000 })
      return
    } catch (error) {
      lastError = error
    }
  }

  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)
  const { startX, startY, endX, endY } = await getSelectionBoxDragPoints(
    page,
    bounds,
    [item],
    stageTransform
  )

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(endX, endY, { steps: 8 })
  await page.mouse.up()

  try {
    await page.waitForSelector('.image-action-toolbar', { timeout: 5000 })
    return
  } catch (error) {
    lastError = error
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to select the canvas image item for toolbar interaction.')
}

async function readLiveBoundsLabel(page: Page): Promise<string> {
  return page.locator('#live-bounds-display').innerText()
}

async function waitForLiveBoundsLabelChange(
  page: Page,
  beforeLabel: string,
  timeout = 10000
): Promise<string> {
  await page.waitForFunction(
    ({ targetLabel }) => {
      const label = document.querySelector('#live-bounds-display')?.textContent?.trim() || ''
      return label.length > 0 && label !== targetLabel && /\d+\s*x\s*\d+/i.test(label)
    },
    { targetLabel: beforeLabel },
    { timeout }
  )

  return readLiveBoundsLabel(page)
}

async function openCanvasImageToolbar(page: Page): Promise<void> {
  try {
    await page.waitForSelector('.image-action-toolbar', { timeout: 2500 })
  } catch {
    await clickCanvasHostCenter(page)
    await page.waitForSelector('.image-action-toolbar', { timeout: 10000 })
  }

  await page.waitForSelector('.image-action-toolbar button', { timeout: 10000 })
}

async function waitForCanvasImageInteractionReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="project-canvas-stage-root"]', { timeout: 30000 })
  await page.waitForSelector('.project-canvas-webgl-layer', { timeout: 30000 })
  await page.waitForSelector('[data-project-canvas-stage-event-layer="dom"]', { timeout: 30000 })
  await page.waitForTimeout(500)
}

async function getCanvasCropButton(page: Page) {
  const classCropButton = page.locator('.image-action-toolbar .canvas-image-crop-button')
  return (await classCropButton.count()) > 0
    ? classCropButton.first()
    : page.locator('.image-action-toolbar button').nth(2)
}

async function waitForCanvasCropMode(page: Page, expectedActive: boolean): Promise<void> {
  await page.waitForFunction((active) => {
    const root = document.querySelector(
      '[data-testid="project-canvas-stage-root"]'
    ) as HTMLElement | null
    const hasCropOverlay = Boolean(
      document.querySelector('[data-project-canvas-crop-overlay="dom"]')
    )
    const isCropMode =
      root?.dataset.projectCanvasTool === 'crop-select' &&
      Boolean(root?.dataset.projectCanvasCroppingImageId) &&
      Boolean(root?.dataset.projectCanvasActiveCropImageId) &&
      hasCropOverlay

    return active ? isCropMode : !isCropMode
  }, expectedActive)
}

async function enterCanvasCropMode(page: Page): Promise<void> {
  await openCanvasImageToolbar(page)
  const cropButton = await getCanvasCropButton(page)
  await cropButton.click()
  await waitForCanvasCropMode(page, true)
}

async function verifyCanvasImageToolbarAndCropMode(page: Page): Promise<void> {
  await enterCanvasCropMode(page)
  await page.keyboard.press('Escape')
  await waitForCanvasCropMode(page, false)
}

async function findCanvasResizeHandlePoint(
  page: Page,
  item?: Pick<PersistedCanvasItem, 'x' | 'y' | 'width' | 'height' | 'scaleX' | 'scaleY'>
): Promise<ResizeHandlePoint> {
  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const scanLeft = Math.max(bounds.x + 24, centerX - 260)
  const scanRight = Math.min(bounds.x + bounds.width - 24, centerX + 260)
  const scanTop = Math.max(bounds.y + 24, centerY - 220)
  const scanBottom = Math.min(bounds.y + bounds.height - 24, centerY + 220)

  const readCursor = async (): Promise<string> =>
    page.evaluate(() => {
      const stageHost =
        (document.querySelector(
          '[data-testid="project-canvas-stage-root"]'
        ) as HTMLElement | null) ??
        (document.querySelector('.konvajs-content') as HTMLElement | null)
      if (!stageHost) {
        return 'auto'
      }

      const candidates = [
        stageHost.style.cursor,
        getComputedStyle(stageHost).cursor,
        document.body.style.cursor,
        getComputedStyle(document.body).cursor
      ]
      return candidates.find((value) => value && value !== 'auto' && value !== 'default') || 'auto'
    })

  const probe = async (clientX: number, clientY: number) => {
    await page.mouse.move(clientX, clientY)
    const cursor = await readCursor()
    return { x: clientX, y: clientY, cursor }
  }

  const isEdgeResizeCursor = (cursor: string) => cursor === 'ew-resize' || cursor === 'ns-resize'

  const findResizeCursorNearPoint = async (originX: number, originY: number) => {
    let fallbackHit: ResizeHandlePoint | null = null

    for (let y = originY - 20; y <= originY + 20; y += 4) {
      for (let x = originX - 20; x <= originX + 20; x += 4) {
        if (
          x <= bounds.x + 8 ||
          x >= bounds.x + bounds.width - 8 ||
          y <= bounds.y + 8 ||
          y >= bounds.y + bounds.height - 8
        ) {
          continue
        }
        const hit = await probe(x, y)
        if (isEdgeResizeCursor(hit.cursor)) {
          return hit
        }
        if (!fallbackHit && hit.cursor.includes('resize')) {
          fallbackHit = hit
        }
      }
    }

    return fallbackHit
  }

  let coarseHit: ResizeHandlePoint | null = null
  let fallbackHit: ResizeHandlePoint | null = null

  if (item) {
    const left = bounds.x + stageTransform.x + item.x * stageTransform.scale
    const top = bounds.y + stageTransform.y + item.y * stageTransform.scale
    const right = left + item.width * item.scaleX * stageTransform.scale
    const bottom = top + item.height * item.scaleY * stageTransform.scale
    const candidatePoints = [
      { x: right, y: top + (bottom - top) / 2 },
      { x: left + (right - left) / 2, y: bottom },
      { x: left, y: top + (bottom - top) / 2 },
      { x: left + (right - left) / 2, y: top }
    ]

    for (const point of candidatePoints) {
      const nearbyHit = await findResizeCursorNearPoint(point.x, point.y)
      if (nearbyHit) {
        return nearbyHit
      }
    }
  }

  for (let y = scanTop; y <= scanBottom && !coarseHit; y += 18) {
    for (let x = scanLeft; x <= scanRight; x += 18) {
      const hit = await probe(x, y)
      if (isEdgeResizeCursor(hit.cursor)) {
        coarseHit = hit
        break
      }
      if (!fallbackHit && hit.cursor.includes('resize')) {
        fallbackHit = hit
      }
    }
  }

  coarseHit = coarseHit || fallbackHit
  if (!coarseHit) {
    throw new Error('Unable to find a resize handle cursor on the Konva stage.')
  }

  let fineFallback: ResizeHandlePoint | null = null
  for (
    let y = Math.max(bounds.y + 8, coarseHit.y - 32);
    y <= Math.min(bounds.y + bounds.height - 8, coarseHit.y + 32);
    y += 4
  ) {
    for (
      let x = Math.max(bounds.x + 8, coarseHit.x - 32);
      x <= Math.min(bounds.x + bounds.width - 8, coarseHit.x + 32);
      x += 4
    ) {
      const hit = await probe(x, y)
      if (isEdgeResizeCursor(hit.cursor)) {
        return hit
      }
      if (!fineFallback && hit.cursor.includes('resize')) {
        fineFallback = hit
      }
    }
  }

  return fineFallback || coarseHit
}

async function installCanvasDragEndProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scopedWindow = window as typeof window & {
      __canvasDragEndCount?: number
      __canvasDragEndProbeInstalled?: boolean
    }

    scopedWindow.__canvasDragEndCount = 0
    if (scopedWindow.__canvasDragEndProbeInstalled) {
      return
    }

    window.addEventListener('canvas:drag-end', () => {
      scopedWindow.__canvasDragEndCount = (scopedWindow.__canvasDragEndCount || 0) + 1
    })
    scopedWindow.__canvasDragEndProbeInstalled = true
  })
}

async function waitForCanvasDragEnd(page: Page, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const scopedWindow = window as typeof window & { __canvasDragEndCount?: number }
        return (scopedWindow.__canvasDragEndCount || 0) > 0
      },
      undefined,
      { timeout }
    )
    return true
  } catch {
    return false
  }
}

async function installCanvasTransformEndProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scopedWindow = window as typeof window & {
      __canvasTransformEndProbeInstalled?: boolean
      __canvasTransformEndProbeLast?: CanvasTransformProbeDetail | null
    }

    scopedWindow.__canvasTransformEndProbeLast = null
    if (scopedWindow.__canvasTransformEndProbeInstalled) {
      return
    }

    window.addEventListener('canvas:transform-end', (event) => {
      scopedWindow.__canvasTransformEndProbeLast = (
        event as CustomEvent<CanvasTransformProbeDetail>
      ).detail
    })
    scopedWindow.__canvasTransformEndProbeInstalled = true
  })
}

async function waitForCanvasTransformEnd(
  page: Page,
  itemId: string,
  timeout = 5000
): Promise<CanvasTransformProbeDetail> {
  await page.waitForFunction(
    ({ targetId }) => {
      const scopedWindow = window as typeof window & {
        __canvasTransformEndProbeLast?: CanvasTransformProbeDetail | null
      }
      return scopedWindow.__canvasTransformEndProbeLast?.id === targetId
    },
    { targetId: itemId },
    { timeout }
  )

  return page.evaluate(() => {
    const scopedWindow = window as typeof window & {
      __canvasTransformEndProbeLast?: CanvasTransformProbeDetail | null
    }
    return scopedWindow.__canvasTransformEndProbeLast!
  })
}

async function installCanvasCropBoxProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scopedWindow = window as typeof window & {
      __canvasCropBoxProbeInstalled?: boolean
      __canvasCropBoxProbeLast?: CanvasCropBoxProbeDetail | null
    }

    scopedWindow.__canvasCropBoxProbeLast = null
    if (scopedWindow.__canvasCropBoxProbeInstalled) {
      return
    }

    window.addEventListener('canvas:crop-box-change', (event) => {
      scopedWindow.__canvasCropBoxProbeLast = (
        event as CustomEvent<CanvasCropBoxProbeDetail>
      ).detail
    })
    scopedWindow.__canvasCropBoxProbeInstalled = true
  })
}

async function readCanvasCropBoxProbe(page: Page): Promise<CanvasCropBoxProbeDetail | null> {
  return page.evaluate(() => {
    const scopedWindow = window as typeof window & {
      __canvasCropBoxProbeLast?: CanvasCropBoxProbeDetail | null
    }

    return scopedWindow.__canvasCropBoxProbeLast || null
  })
}

async function waitForCanvasCropBoxProbe(
  page: Page,
  itemId: string
): Promise<CanvasCropBoxProbeDetail> {
  try {
    await page.waitForFunction((expectedItemId) => {
      const scopedWindow = window as typeof window & {
        __canvasCropBoxProbeLast?: CanvasCropBoxProbeDetail | null
      }
      const detail = scopedWindow.__canvasCropBoxProbeLast
      return Boolean(detail?.active && detail.itemId === expectedItemId && detail.cropBox)
    }, itemId)
  } catch (error) {
    const debugState = await page.evaluate(() => {
      const root = document.querySelector(
        '[data-testid="project-canvas-stage-root"]'
      ) as HTMLElement | null
      const cropOverlay = document.querySelector(
        '[data-project-canvas-crop-overlay="dom"]'
      ) as HTMLElement | null
      const cropBox = document.querySelector('[data-canvas-crop-box]') as HTMLElement | null
      const interactionLayer = document.querySelector(
        '[data-project-canvas-image-interaction-layer="dom"]'
      ) as HTMLElement | null
      return {
        bodyText: document.body?.innerText || '',
        rootAttrs: root
          ? {
              tool: root.dataset.projectCanvasTool || '',
              croppingImageId: root.dataset.projectCanvasCroppingImageId || '',
              activeCropImageId: root.dataset.projectCanvasActiveCropImageId || '',
              summary: root.dataset.projectCanvasRenderSurfaceSummary || '',
              webglPrimaryImageCount: root.dataset.projectCanvasWebglPrimaryImageCount || '',
              fallbackImageCount: root.dataset.projectCanvasFallbackImageCount || '',
              cropExcludedImageCount: root.dataset.projectCanvasCropExcludedImageCount || '',
              webglInitialized: root.dataset.projectCanvasWebglInitialized || '',
              webglLoadedImageCount: root.dataset.projectCanvasWebglLoadedImageCount || '',
              webglPendingImageCount: root.dataset.projectCanvasWebglPendingImageCount || ''
            }
          : null,
        hasCropOverlay: Boolean(cropOverlay),
        hasCropBox: Boolean(cropBox),
        hasImageInteractionLayer: Boolean(interactionLayer)
      }
    })
    throw new Error(
      `Unable to observe an active crop box probe for ${itemId}. Debug state: ${JSON.stringify(debugState)}`,
      { cause: error }
    )
  }

  const detail = await readCanvasCropBoxProbe(page)
  if (!detail || !detail.active || detail.itemId !== itemId || !detail.cropBox) {
    throw new Error(`Unable to resolve the active crop box probe for ${itemId}.`)
  }

  return detail
}

function getCanvasCropBoxScreenCenter(
  bounds: { x: number; y: number; width: number; height: number },
  stageTransform: CanvasStageTransform,
  item: PersistedCanvasItem,
  seededCrop: NonNullable<PersistedCanvasItem['crop']>,
  cropBox: NonNullable<CanvasCropBoxProbeDetail['cropBox']>
): { x: number; y: number } {
  const outerScaleX = item.scaleX * (item.width / seededCrop.width)
  const outerScaleY = item.scaleY * (item.height / seededCrop.height)
  const localCenterX = cropBox.x - seededCrop.x + cropBox.width / 2
  const localCenterY = cropBox.y - seededCrop.y + cropBox.height / 2

  return {
    x: bounds.x + stageTransform.x + (item.x + localCenterX * outerScaleX) * stageTransform.scale,
    y: bounds.y + stageTransform.y + (item.y + localCenterY * outerScaleY) * stageTransform.scale
  }
}

async function flushCanvasPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'))
  })
  await page.waitForTimeout(200)
}

async function readPersistedCanvasItems(
  page: Page,
  storeKey: string
): Promise<PersistedCanvasItem[]> {
  return page.evaluate(async (targetKey) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const openRequest = indexedDB.open('magicpot-canvas', 2)
      openRequest.onsuccess = () => resolve(openRequest.result)
      openRequest.onerror = () => reject(openRequest.error)
    })

    try {
      const payload = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('canvas-items', 'readonly')
        const store = tx.objectStore('canvas-items')
        const request = store.get(targetKey)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

      const items = Array.isArray(payload)
        ? payload
        : ((payload as { items?: PersistedCanvasItem[] } | undefined)?.items ?? [])

      return items as PersistedCanvasItem[]
    } finally {
      db.close()
    }
  }, storeKey)
}

async function readPersistedCanvasPayload(
  page: Page,
  storeKey: string
): Promise<PersistedCanvasPayload | undefined> {
  return page.evaluate(async (targetKey) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const openRequest = indexedDB.open('magicpot-canvas', 2)
      openRequest.onsuccess = () => resolve(openRequest.result)
      openRequest.onerror = () => reject(openRequest.error)
    })

    try {
      return await new Promise<PersistedCanvasPayload | undefined>((resolve, reject) => {
        const tx = db.transaction('canvas-items', 'readonly')
        const store = tx.objectStore('canvas-items')
        const request = store.get(targetKey)
        request.onsuccess = () => resolve(request.result as PersistedCanvasPayload | undefined)
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  }, storeKey)
}

async function writePersistedCanvasPayload(
  page: Page,
  storeKey: string,
  payload: PersistedCanvasPayload
): Promise<void> {
  await page.evaluate(
    async ({ targetKey, nextPayload }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const openRequest = indexedDB.open('magicpot-canvas', 2)
        openRequest.onsuccess = () => resolve(openRequest.result)
        openRequest.onerror = () => reject(openRequest.error)
      })

      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('canvas-items', 'readwrite')
          const store = tx.objectStore('canvas-items')
          const request = store.put(nextPayload, targetKey)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
        })
      } finally {
        db.close()
      }
    },
    { targetKey: storeKey, nextPayload: payload }
  )
}

async function waitForPersistedCanvasItemCount(
  page: Page,
  storeKey: string,
  expectedCount: number
): Promise<PersistedCanvasItem[]> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const items = await readPersistedCanvasItems(page, storeKey)
    if (items.length >= expectedCount) {
      return items
    }
    await page.waitForTimeout(250)
  }

  throw new Error(`Timed out waiting for ${expectedCount} persisted canvas items for ${storeKey}.`)
}

async function verifyCanvasRoutePersistsRealImageTransform(
  page: Page,
  canvasId: string,
  baselineImage: PersistedCanvasItem
): Promise<PersistedCanvasItem> {
  const dragMultipliers = [1, 1.35, 1.7]
  let lastImage = baselineImage
  let lastCursor = 'unknown'

  for (const multiplier of dragMultipliers) {
    await selectCanvasItemForImageToolbar(page, lastImage)
    const beforeLiveBounds = await readLiveBoundsLabel(page)
    await installCanvasTransformEndProbe(page)
    const resizeHandle = await findCanvasResizeHandlePoint(page, lastImage)
    lastCursor = resizeHandle.cursor
    const baseDragDelta =
      resizeHandle.cursor === 'ew-resize'
        ? { x: 80, y: 0 }
        : resizeHandle.cursor === 'ns-resize'
          ? { x: 0, y: 60 }
          : { x: 80, y: 60 }
    const dragDelta = {
      x: Math.round(baseDragDelta.x * multiplier),
      y: Math.round(baseDragDelta.y * multiplier)
    }

    await page.mouse.move(resizeHandle.x, resizeHandle.y)
    await page.waitForTimeout(80)
    await page.mouse.down()
    await page.mouse.move(resizeHandle.x + dragDelta.x, resizeHandle.y + dragDelta.y, {
      steps: 18
    })
    await page.mouse.up()

    await waitForCanvasTransformEnd(page, lastImage.id, 3000).catch(() => null)
    await waitForLiveBoundsLabelChange(page, beforeLiveBounds, 2500).catch(() => null)
    await page.waitForTimeout(250)
    await flushCanvasPersistence(page)

    const afterItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
    const afterImage = afterItems.find((item) => item.id === baselineImage.id)
    expect(afterImage).toBeTruthy()
    expect(afterImage!.width).toBe(lastImage.width)
    expect(afterImage!.height).toBe(lastImage.height)
    expect(afterImage!.rotation).toBe(lastImage.rotation)

    if (afterImage!.scaleX !== lastImage.scaleX || afterImage!.scaleY !== lastImage.scaleY) {
      return afterImage!
    }

    lastImage = afterImage!
  }

  throw new Error(`Unable to persist an image transform. Last resize cursor: ${lastCursor}`)
}

async function performCanvasRouteRealImageTransform(
  page: Page,
  fatalErrors: string[]
): Promise<PersistedCanvasImageTransition> {
  const canvasId = 'tab-project-smoke-transform'
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  await setCanvasImportFiles(page, getWorkflowImagePath())

  await page.waitForFunction(() => document.body?.innerText.includes('82 x 82'))
  await page.waitForTimeout(800)
  await waitForCanvasImageInteractionReady(page)

  const beforeItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const beforeImage = beforeItems.find((item) => item.type === 'image')
  expect(beforeImage).toBeTruthy()

  const afterImage = await verifyCanvasRoutePersistsRealImageTransform(page, canvasId, beforeImage!)
  expect(fatalErrors).toEqual([])

  return {
    canvasId,
    beforeImage: beforeImage!,
    afterImage
  }
}

async function verifyCanvasRoutePersistsRealImageTransformOnly(
  page: Page,
  fatalErrors: string[]
): Promise<void> {
  await performCanvasRouteRealImageTransform(page, fatalErrors)
}

async function verifyCanvasRouteRestoresPersistedImageTransformAfterRelaunch(
  page: Page,
  fatalErrors: string[],
  canvasId: string,
  expectedImage: PersistedCanvasItem
): Promise<void> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)
  await waitForCanvasImageInteractionReady(page)

  const restoredItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const restoredImage = restoredItems.find((item) => item.id === expectedImage.id)
  expect(restoredImage).toBeTruthy()
  expect(restoredImage!.x).toBeCloseTo(expectedImage.x, 5)
  expect(restoredImage!.y).toBeCloseTo(expectedImage.y, 5)
  expect(restoredImage!.width).toBeCloseTo(expectedImage.width, 5)
  expect(restoredImage!.height).toBeCloseTo(expectedImage.height, 5)
  expect(restoredImage!.scaleX).toBeCloseTo(expectedImage.scaleX, 5)
  expect(restoredImage!.scaleY).toBeCloseTo(expectedImage.scaleY, 5)
  expect(restoredImage!.rotation).toBeCloseTo(expectedImage.rotation, 5)

  await selectCanvasItemForImageToolbar(page, restoredImage!)
  expect(fatalErrors).toEqual([])
}

async function seedPersistedCanvasTransformItem(
  page: Page,
  canvasId: string,
  targetItemId?: string
): Promise<{ beforeImage: PersistedCanvasItem; seededImage: PersistedCanvasItem }> {
  const payload = await readPersistedCanvasPayload(page, canvasId)
  const items = Array.isArray(payload) ? payload : (payload?.items ?? [])
  const beforeImage = items.find(
    (item) => item.type === 'image' && (!targetItemId || item.id === targetItemId)
  )

  if (!beforeImage) {
    throw new Error(`Unable to resolve a persisted image item for ${canvasId}.`)
  }

  const seededImage: PersistedCanvasItem = {
    ...beforeImage,
    x: beforeImage.x + 36,
    y: beforeImage.y + 24,
    scaleX: Number((beforeImage.scaleX * 1.45).toFixed(4)),
    scaleY: Number((beforeImage.scaleY * 0.78).toFixed(4))
  }

  const nextItems = items.map((item) => (item.id === beforeImage.id ? seededImage : item))
  const nextPayload = Array.isArray(payload) ? nextItems : { ...(payload ?? {}), items: nextItems }
  await writePersistedCanvasPayload(page, canvasId, nextPayload)

  return {
    beforeImage,
    seededImage
  }
}

async function prepareCanvasRouteWithPersistedTransformSeed(
  page: Page,
  fatalErrors: string[]
): Promise<{
  canvasId: string
  beforeImage: PersistedCanvasItem
  seededImage: PersistedCanvasItem
}> {
  const canvasId = 'tab-project-smoke-transform-restore'
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  await setCanvasImportFiles(page, getWorkflowImagePath())

  await page.waitForFunction(() => document.body?.innerText.includes('82 x 82'))
  await page.waitForTimeout(800)
  await waitForCanvasImageInteractionReady(page)

  await flushCanvasPersistence(page)
  await waitForPersistedCanvasItemCount(page, canvasId, 1)

  const { beforeImage, seededImage } = await seedPersistedCanvasTransformItem(page, canvasId)

  return {
    canvasId,
    beforeImage,
    seededImage
  }
}

async function seedPersistedCanvasCropItem(
  page: Page,
  canvasId: string,
  targetItemId?: string
): Promise<{ beforeImage: PersistedCanvasItem; seededImage: PersistedCanvasItem }> {
  const payload = await readPersistedCanvasPayload(page, canvasId)
  const items = Array.isArray(payload) ? payload : (payload?.items ?? [])
  const beforeImage = items.find(
    (item) => item.type === 'image' && (!targetItemId || item.id === targetItemId)
  )

  if (!beforeImage) {
    throw new Error(`Unable to resolve a persisted image item for ${canvasId}.`)
  }

  const sourceWidth = Math.max(1, Math.round(Number(beforeImage.sourceWidth ?? beforeImage.width)))
  const sourceHeight = Math.max(
    1,
    Math.round(Number(beforeImage.sourceHeight ?? beforeImage.height))
  )
  const cropX = Math.min(Math.max(6, Math.round(sourceWidth * 0.12)), Math.max(0, sourceWidth - 24))
  const cropY = Math.min(
    Math.max(6, Math.round(sourceHeight * 0.1)),
    Math.max(0, sourceHeight - 24)
  )
  const cropWidth = Math.max(24, sourceWidth - cropX * 2)
  const cropHeight = Math.max(24, sourceHeight - cropY * 2)
  const seededImage: PersistedCanvasItem = {
    ...beforeImage,
    x: beforeImage.x + cropX * beforeImage.scaleX,
    y: beforeImage.y + cropY * beforeImage.scaleY,
    width: cropWidth,
    height: cropHeight,
    crop: {
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight
    }
  }

  const nextItems = items.map((item) => (item.id === beforeImage.id ? seededImage : item))
  const nextPayload = Array.isArray(payload) ? nextItems : { ...(payload ?? {}), items: nextItems }
  await writePersistedCanvasPayload(page, canvasId, nextPayload)

  return {
    beforeImage,
    seededImage
  }
}

async function prepareCanvasRouteWithMultiSelectionCropSeed(
  page: Page,
  fatalErrors: string[],
  tempRoot: string
): Promise<{
  canvasId: string
  firstImage: PersistedCanvasItem
  targetImage: PersistedCanvasItem
  seededTargetImage: PersistedCanvasItem
}> {
  const canvasId = 'tab-project-smoke-multi-crop-switch'
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  const workflowCopyPath = await writeWorkflowImageCopy(tempRoot)
  await setCanvasImportFiles(page, [getWorkflowImagePath(), workflowCopyPath])

  await page.waitForTimeout(1200)
  await flushCanvasPersistence(page)

  const persistedItems = await waitForPersistedCanvasItemCount(page, canvasId, 2)
  const images = persistedItems
    .filter((item) => item.type === 'image')
    .sort((left, right) => left.x - right.x)

  expect(images).toHaveLength(2)

  const firstImage = images[0]!
  const targetImage = images[1]!
  const { seededImage: seededTargetImage } = await seedPersistedCanvasCropItem(
    page,
    canvasId,
    targetImage.id
  )

  return {
    canvasId,
    firstImage,
    targetImage,
    seededTargetImage
  }
}

async function prepareCanvasRouteWithPersistedCropSeed(
  page: Page,
  fatalErrors: string[]
): Promise<{
  canvasId: string
  beforeImage: PersistedCanvasItem
  seededImage: PersistedCanvasItem
}> {
  const canvasId = 'tab-project-smoke-crop'
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  await setCanvasImportFiles(page, getWorkflowImagePath())

  await page.waitForFunction(() => document.body?.innerText.includes('82 x 82'))
  await page.waitForTimeout(800)

  await flushCanvasPersistence(page)
  await waitForPersistedCanvasItemCount(page, canvasId, 1)

  const { beforeImage, seededImage } = await seedPersistedCanvasCropItem(page, canvasId)

  return {
    canvasId,
    beforeImage,
    seededImage
  }
}

async function verifySeededCanvasRoutePersistsRuntimeCropConfirmation(
  page: Page,
  fatalErrors: string[],
  canvasId: string,
  beforeImage: PersistedCanvasItem,
  seededImage: PersistedCanvasItem
): Promise<PersistedCanvasItem> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)
  await waitForCanvasImageInteractionReady(page)

  const restoredItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const restoredSeededImage =
    restoredItems.find((item) => item.id === beforeImage.id) ?? seededImage

  await selectCanvasItemForImageToolbar(page, restoredSeededImage)
  await installCanvasCropBoxProbe(page)
  await enterCanvasCropMode(page)
  const initialCropBoxProbe = await waitForCanvasCropBoxProbe(page, restoredSeededImage.id)

  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)

  const { x: startX, y: startY } = getCanvasCropBoxScreenCenter(
    bounds!,
    stageTransform,
    restoredSeededImage,
    seededImage.crop!,
    initialCropBoxProbe.cropBox!
  )
  const endX = startX + 40
  const endY = startY + 24

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(endX, endY, { steps: 10 })
  await page.mouse.up()

  await page.keyboard.press('Enter')
  await waitForCanvasCropMode(page, false)
  await clickCanvasBlankSpace(page, [restoredSeededImage])
  await flushCanvasPersistence(page)

  const afterItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const afterImage = afterItems.find((item) => item.id === beforeImage.id)
  expect(afterImage).toBeTruthy()
  expect(afterImage!.crop).toBeTruthy()
  expect(afterImage!.crop!.width).toBe(seededImage.crop!.width)
  expect(afterImage!.crop!.height).toBe(seededImage.crop!.height)
  expect(
    afterImage!.crop!.x !== seededImage.crop!.x || afterImage!.crop!.y !== seededImage.crop!.y
  ).toBe(true)
  expect(afterImage!.crop!.width).toBeLessThan(beforeImage.width)
  expect(afterImage!.crop!.height).toBeLessThan(beforeImage.height)
  expect(afterImage!.x !== seededImage.x || afterImage!.y !== seededImage.y).toBe(true)
  expect(fatalErrors).toEqual([])

  return afterImage!
}

async function verifyCanvasRouteRestoresPersistedCropAfterRelaunch(
  page: Page,
  fatalErrors: string[],
  canvasId: string,
  expectedImage: PersistedCanvasItem
): Promise<void> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)
  await waitForCanvasImageInteractionReady(page)

  const restoredItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const restoredImage = restoredItems.find((item) => item.id === expectedImage.id)
  expect(restoredImage).toBeTruthy()
  expect(restoredImage!.x).toBeCloseTo(expectedImage.x, 5)
  expect(restoredImage!.y).toBeCloseTo(expectedImage.y, 5)
  expect(restoredImage!.width).toBeCloseTo(expectedImage.width, 5)
  expect(restoredImage!.height).toBeCloseTo(expectedImage.height, 5)
  expect(restoredImage!.scaleX).toBeCloseTo(expectedImage.scaleX, 5)
  expect(restoredImage!.scaleY).toBeCloseTo(expectedImage.scaleY, 5)
  expect(restoredImage!.rotation).toBeCloseTo(expectedImage.rotation, 5)
  expect(restoredImage!.crop).toBeTruthy()
  expect(expectedImage.crop).toBeTruthy()
  expect(restoredImage!.crop!.x).toBeCloseTo(expectedImage.crop!.x, 5)
  expect(restoredImage!.crop!.y).toBeCloseTo(expectedImage.crop!.y, 5)
  expect(restoredImage!.crop!.width).toBeCloseTo(expectedImage.crop!.width, 5)
  expect(restoredImage!.crop!.height).toBeCloseTo(expectedImage.crop!.height, 5)

  await selectCanvasItemForImageToolbar(page, restoredImage!)
  await enterCanvasCropMode(page)
  await page.keyboard.press('Escape')
  await waitForCanvasCropMode(page, false)
  expect(fatalErrors).toEqual([])
}

async function verifyCanvasRouteSwitchesMultiSelectionTargetAndPersistsCrop(
  page: Page,
  fatalErrors: string[],
  canvasId: string,
  firstImage: PersistedCanvasItem,
  targetImage: PersistedCanvasItem,
  seededTargetImage: PersistedCanvasItem
): Promise<void> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)
  await waitForCanvasImageInteractionReady(page)

  const restoredItems = await waitForPersistedCanvasItemCount(page, canvasId, 2)
  const restoredFirstImage = restoredItems.find((item) => item.id === firstImage.id)
  const restoredTargetImage = restoredItems.find((item) => item.id === targetImage.id)

  expect(restoredFirstImage).toBeTruthy()
  expect(restoredTargetImage).toBeTruthy()

  await clickCanvasBlankSpace(page, restoredItems)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.waitForSelector('.selection-action-stack', { timeout: 10000 })
  await page.waitForFunction(
    (selector) => !document.querySelector(selector),
    '.image-action-toolbar',
    { timeout: 10000 }
  )

  await clickCanvasBlankSpace(page, restoredItems)
  await page.waitForFunction(
    (selector) => !document.querySelector(selector),
    '.selection-action-stack',
    { timeout: 10000 }
  )
  await selectCanvasItemForImageToolbar(page, restoredTargetImage!)
  await installCanvasCropBoxProbe(page)
  await enterCanvasCropMode(page)
  const initialCropBoxProbe = await waitForCanvasCropBoxProbe(page, restoredTargetImage!.id)

  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)
  const dragAttempts = [
    { x: 40, y: 24 },
    { x: 28, y: 20 },
    { x: -24, y: 18 },
    { x: 18, y: -16 }
  ]

  let cropBoxMoved = false
  for (const attempt of dragAttempts) {
    const currentProbe = (await readCanvasCropBoxProbe(page)) || initialCropBoxProbe
    const currentCropBox = currentProbe.cropBox || initialCropBoxProbe.cropBox
    const { x: startX, y: startY } = getCanvasCropBoxScreenCenter(
      bounds,
      stageTransform,
      restoredTargetImage!,
      seededTargetImage.crop!,
      currentCropBox!
    )

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + attempt.x, startY + attempt.y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(120)

    const afterProbe = await readCanvasCropBoxProbe(page)
    if (
      afterProbe?.active &&
      afterProbe.itemId === restoredTargetImage!.id &&
      afterProbe.cropBox &&
      (afterProbe.cropBox.x !== initialCropBoxProbe.cropBox!.x ||
        afterProbe.cropBox.y !== initialCropBoxProbe.cropBox!.y)
    ) {
      cropBoxMoved = true
      break
    }
  }

  expect(cropBoxMoved).toBe(true)

  await page.keyboard.press('Enter')
  await waitForCanvasCropMode(page, false)
  await clickCanvasBlankSpace(page, restoredItems)
  await flushCanvasPersistence(page)

  const afterItems = await waitForPersistedCanvasItemCount(page, canvasId, 2)
  const afterFirstImage = afterItems.find((item) => item.id === firstImage.id)
  const afterTargetImage = afterItems.find((item) => item.id === targetImage.id)

  expect(afterFirstImage).toBeTruthy()
  expect(afterTargetImage).toBeTruthy()
  expect(afterFirstImage!.x).toBeCloseTo(restoredFirstImage!.x, 5)
  expect(afterFirstImage!.y).toBeCloseTo(restoredFirstImage!.y, 5)
  expect(afterFirstImage!.crop).toEqual(restoredFirstImage!.crop)
  expect(afterTargetImage!.crop).toBeTruthy()
  expect(afterTargetImage!.crop!.width).toBe(seededTargetImage.crop!.width)
  expect(afterTargetImage!.crop!.height).toBe(seededTargetImage.crop!.height)
  expect(
    afterTargetImage!.crop!.x !== seededTargetImage.crop!.x ||
      afterTargetImage!.crop!.y !== seededTargetImage.crop!.y
  ).toBe(true)
  expect(
    afterTargetImage!.x !== seededTargetImage.x || afterTargetImage!.y !== seededTargetImage.y
  ).toBe(true)
  expect(fatalErrors).toEqual([])
}

function expectBuiltStartupArtifacts(): void {
  // Vitest's node setup mocks fs with memfs, so disk preflight checks here can
  // produce false negatives. Let the real Electron launch surface missing build
  // artifacts instead of failing before startup.
}

async function verifyCanvasRouteSupportsImageIntake(
  page: Page,
  fatalErrors: string[]
): Promise<void> {
  await navigateToHash(page, '#/canvas?id=tab-project-smoke')
  await waitForHealthyPage(page, fatalErrors)

  await setCanvasImportFiles(page, getWorkflowImagePath())

  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText || ''
      return bodyText.includes('82 x 82')
    },
    { timeout: 60000 }
  )
  await page.waitForTimeout(800)

  const persistedItems = await waitForPersistedCanvasItemCount(page, 'tab-project-smoke', 1)
  const bodyText = await page.locator('body').innerText()
  expect(bodyText).toContain('82 x 82')
  expect(persistedItems.some((item) => item.type === 'image')).toBe(true)
  expect(fatalErrors).toEqual([])
}

async function waitForCanvasVideoOverlayReady(
  page: Page,
  itemId: string,
  expectedTotalVideos = 1,
  expectedSrcFragment = 'projectCanvasSampleVideo.webm'
): Promise<void> {
  try {
    await page.waitForFunction(
      ({ targetItemId, totalVideos, srcFragment }) => {
        const overlayRoot = document.querySelector(
          '[data-project-canvas-video-total-count]'
        ) as HTMLElement | null
        const overlay = document.querySelector(
          `[data-canvas-overlay="video"][data-canvas-item-id="${targetItemId}"]`
        ) as HTMLElement | null
        const video = overlay?.querySelector('video') as HTMLVideoElement | null

        if (!overlayRoot || !overlay || !video) {
          return false
        }

        const total = Number(overlayRoot.dataset.projectCanvasVideoTotalCount || '0')
        const mounted = Number(overlayRoot.dataset.projectCanvasMountedVideoOverlayCount || '0')
        const unmounted = Number(overlayRoot.dataset.projectCanvasVideoUnmountedCount || '0')
        const accounted =
          Number(overlayRoot.dataset.projectCanvasVideoActivePlayingCount || '0') +
          Number(overlayRoot.dataset.projectCanvasVideoVisiblePausedCount || '0') +
          Number(overlayRoot.dataset.projectCanvasVideoPosterFrameCount || '0')
        const budgetMode = overlay.dataset.canvasVideoBudgetMode || ''
        const source = video.currentSrc || video.getAttribute('src') || ''

        return (
          total === totalVideos &&
          mounted === totalVideos &&
          unmounted === 0 &&
          accounted === totalVideos &&
          (budgetMode === 'visible-paused' || budgetMode === 'active-playing') &&
          source.includes(srcFragment)
        )
      },
      {
        targetItemId: itemId,
        totalVideos: expectedTotalVideos,
        srcFragment: expectedSrcFragment
      },
      { timeout: 60000 }
    )
  } catch (error) {
    const debugState = await page.evaluate((targetItemId) => {
      const overlayRoot = document.querySelector(
        '[data-project-canvas-video-total-count]'
      ) as HTMLElement | null
      const overlay = document.querySelector(
        `[data-canvas-overlay="video"][data-canvas-item-id="${targetItemId}"]`
      ) as HTMLElement | null
      const video = overlay?.querySelector('video') as HTMLVideoElement | null

      return {
        overlayRootDataset: overlayRoot ? { ...overlayRoot.dataset } : null,
        overlayDataset: overlay ? { ...overlay.dataset } : null,
        hasVideo: Boolean(video),
        videoSrc: video?.getAttribute('src') ?? null,
        currentSrc: video?.currentSrc ?? null,
        readyState: video?.readyState ?? null,
        networkState: video?.networkState ?? null,
        videoWidth: video?.videoWidth ?? null,
        videoHeight: video?.videoHeight ?? null
      }
    }, itemId)
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Canvas video overlay did not become ready for item ${itemId}: ${cause}. State: ${JSON.stringify(debugState)}`
    )
  }
}

async function verifyCanvasRouteSupportsVideoIntake(
  page: Page,
  fatalErrors: string[]
): Promise<{ canvasId: string; videoItem: PersistedCanvasItem }> {
  const canvasId = 'tab-project-smoke-video'
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  await dispatchCanvasImportFileWithPath(page, getWorkflowVideoPath(), 'video/webm')
  await page.waitForTimeout(800)

  const persistedItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const persistedVideo = persistedItems.find((item) => item.type === 'video')
  expect(persistedVideo).toBeTruthy()

  await waitForCanvasVideoOverlayReady(page, persistedVideo!.id)
  expect(fatalErrors).toEqual([])

  return {
    canvasId,
    videoItem: persistedVideo!
  }
}

async function verifyCanvasRouteRestoresPersistedVideoAfterRelaunch(
  page: Page,
  fatalErrors: string[],
  canvasId: string,
  expectedVideo: PersistedCanvasItem
): Promise<void> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  const restoredItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const restoredVideo = restoredItems.find((item) => item.id === expectedVideo.id)
  expect(restoredVideo).toBeTruthy()
  expect(restoredVideo!.type).toBe('video')
  expect(restoredVideo!.x).toBeCloseTo(expectedVideo.x, 5)
  expect(restoredVideo!.y).toBeCloseTo(expectedVideo.y, 5)
  expect(restoredVideo!.width).toBeCloseTo(expectedVideo.width, 5)
  expect(restoredVideo!.height).toBeCloseTo(expectedVideo.height, 5)

  await waitForCanvasVideoOverlayReady(page, restoredVideo!.id)
  expect(fatalErrors).toEqual([])
}

async function performCanvasRouteRealImageDrag(
  page: Page,
  fatalErrors: string[]
): Promise<PersistedCanvasImageTransition> {
  const canvasId = 'tab-project-smoke-drag'
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  await setCanvasImportFiles(page, getWorkflowImagePath())

  await page.waitForFunction(() => document.body?.innerText.includes('82 x 82'))
  await page.waitForTimeout(800)

  await verifyCanvasImageToolbarAndCropMode(page)
  await page.waitForTimeout(200)

  const beforeItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const beforeImage = beforeItems.find((item) => item.type === 'image')
  expect(beforeImage).toBeTruthy()

  await flushCanvasPersistence(page)

  const bounds = await getCanvasInteractionHostBounds(page)

  const startX = bounds!.x + bounds!.width / 2
  const startY = bounds!.y + bounds!.height / 2
  const endX = startX + 120
  const endY = startY + 80

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(endX, endY, { steps: 12 })
  await page.mouse.up()

  await flushCanvasPersistence(page)

  const afterItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const afterImage = afterItems.find((item) => item.id === beforeImage!.id)
  expect(afterImage).toBeTruthy()
  expect(afterImage!.width).toBe(beforeImage!.width)
  expect(afterImage!.height).toBe(beforeImage!.height)
  expect(afterImage!.scaleX).toBe(beforeImage!.scaleX)
  expect(afterImage!.scaleY).toBe(beforeImage!.scaleY)
  expect(afterImage!.rotation).toBe(beforeImage!.rotation)
  expect(afterImage!.x !== beforeImage!.x || afterImage!.y !== beforeImage!.y).toBe(true)
  expect(fatalErrors).toEqual([])

  return {
    canvasId,
    beforeImage: beforeImage!,
    afterImage: afterImage!
  }
}

async function verifyCanvasRoutePersistsRealImageDrag(
  page: Page,
  fatalErrors: string[]
): Promise<void> {
  await performCanvasRouteRealImageDrag(page, fatalErrors)
}

async function verifyCanvasRouteRestoresPersistedImageDragAfterRelaunch(
  page: Page,
  fatalErrors: string[],
  canvasId: string,
  expectedImage: PersistedCanvasItem
): Promise<void> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)
  await waitForCanvasImageInteractionReady(page)

  const restoredItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const restoredImage = restoredItems.find((item) => item.id === expectedImage.id)
  expect(restoredImage).toBeTruthy()
  expect(restoredImage!.x).toBeCloseTo(expectedImage.x, 5)
  expect(restoredImage!.y).toBeCloseTo(expectedImage.y, 5)
  expect(restoredImage!.width).toBeCloseTo(expectedImage.width, 5)
  expect(restoredImage!.height).toBeCloseTo(expectedImage.height, 5)
  expect(restoredImage!.scaleX).toBeCloseTo(expectedImage.scaleX, 5)
  expect(restoredImage!.scaleY).toBeCloseTo(expectedImage.scaleY, 5)
  expect(restoredImage!.rotation).toBeCloseTo(expectedImage.rotation, 5)

  await selectCanvasItemForImageToolbar(page, restoredImage!)
  expect(fatalErrors).toEqual([])
}

async function writeWorkflowImageCopy(tempRoot: string): Promise<string> {
  const copyPath = path.join(tempRoot, 'workflow-image-copy.png')
  realFs.copyFileSync(getWorkflowImagePath(), copyPath)
  if (!realFs.existsSync(copyPath)) {
    throw new Error(`Failed to materialize workflow image copy at ${copyPath}`)
  }
  return copyPath
}

async function shiftClickCanvasItemCenter(
  page: Page,
  item: PersistedCanvasItem,
  offset: { x?: number; y?: number } = {}
): Promise<void> {
  await page.keyboard.down('Shift')
  try {
    await clickCanvasItemCenter(page, item, offset)
  } finally {
    await page.keyboard.up('Shift')
  }
}

async function extendSelectionToCanvasItem(page: Page, item: PersistedCanvasItem): Promise<void> {
  const attemptOffsets = [
    { x: 0, y: 0 },
    { x: 8, y: 0 },
    { x: 0, y: 8 },
    { x: -8, y: 0 },
    { x: 0, y: -8 },
    { x: Math.max(12, Math.round(item.width * item.scaleX * 0.18)), y: 0 },
    { x: 0, y: Math.max(12, Math.round(item.height * item.scaleY * 0.18)) }
  ]
  let lastError: unknown = null

  for (const offset of attemptOffsets) {
    await shiftClickCanvasItemCenter(page, item, offset)
    try {
      await page.waitForSelector('.selection-action-stack', { timeout: 5000 })
      return
    } catch (error) {
      lastError = error
    }
  }

  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)
  const { startX, startY, endX, endY } = await getSelectionBoxDragPoints(
    page,
    bounds,
    [item],
    stageTransform
  )

  await page.keyboard.down('Shift')
  try {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 8 })
    await page.mouse.up()
  } finally {
    await page.keyboard.up('Shift')
  }

  try {
    await page.waitForSelector('.selection-action-stack', { timeout: 5000 })
    return
  } catch (error) {
    lastError = error
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to extend the canvas selection to the requested item.')
}

async function boxSelectCanvasItems(
  page: Page,
  items: PersistedCanvasItem[],
  additiveSelection = false
): Promise<void> {
  if (items.length === 0) {
    throw new Error('boxSelectCanvasItems requires at least one canvas item.')
  }

  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)
  const { startX, startY, endX, endY } = await getSelectionBoxDragPoints(
    page,
    bounds,
    items,
    stageTransform
  )

  if (additiveSelection) {
    await page.keyboard.down('Shift')
  }

  try {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 10 })
    await page.mouse.up()
  } finally {
    if (additiveSelection) {
      await page.keyboard.up('Shift')
    }
  }
}

async function readCanvasSelectionRectState(page: Page): Promise<{
  display: string
  width: number
  height: number
  left: string
  top: string
} | null> {
  return page.evaluate(() => {
    const selectionRect = document.querySelector(
      '[data-canvas-selection-rect="svg"]'
    ) as SVGSVGElement | null

    if (!selectionRect) {
      return null
    }

    return {
      display: selectionRect.style.display || getComputedStyle(selectionRect).display,
      width: Number(selectionRect.getAttribute('width') ?? 0),
      height: Number(selectionRect.getAttribute('height') ?? 0),
      left: selectionRect.style.left,
      top: selectionRect.style.top
    }
  })
}

async function readCanvasMarqueeDebugState(page: Page): Promise<{
  selectionRect: {
    display: string
    width: number
    height: number
    left: string
    top: string
  } | null
  overlayPresent: boolean
  overlayDisplay: string | null
  stageEventLayerPresent: boolean
  stageRoot: {
    stageScale: string | null
    stagePosX: string | null
    stagePosY: string | null
    debugPhase: string | null
    debugTool: string | null
    debugSelectionWidth: string | null
    debugSelectionHeight: string | null
    containsSelectionRect: boolean | null
  } | null
  activeToolbarLabels: string[]
}> {
  return page.evaluate(() => {
    const selectionRect = document.querySelector(
      '[data-canvas-selection-rect="svg"]'
    ) as SVGSVGElement | null
    const overlay = document.querySelector(
      '[data-project-canvas-scene-overlay="dom"]'
    ) as HTMLElement | null
    const stageEventLayer = document.querySelector(
      '[data-project-canvas-stage-event-layer="dom"]'
    ) as HTMLElement | null
    const stageRoot = document.querySelector(
      '[data-testid="project-canvas-stage-root"]'
    ) as HTMLElement | null
    const activeToolbarLabels = Array.from(
      document.querySelectorAll('button.MuiIconButton-colorPrimary')
    )
      .map((element) => element.getAttribute('aria-label') || element.textContent || '')
      .filter(Boolean)

    return {
      selectionRect: selectionRect
        ? {
            display: selectionRect.style.display || getComputedStyle(selectionRect).display,
            width: Number(selectionRect.getAttribute('width') ?? 0),
            height: Number(selectionRect.getAttribute('height') ?? 0),
            left: selectionRect.style.left,
            top: selectionRect.style.top
          }
        : null,
      overlayPresent: Boolean(overlay),
      overlayDisplay: overlay ? getComputedStyle(overlay).display : null,
      stageEventLayerPresent: Boolean(stageEventLayer),
      stageRoot: stageRoot
        ? {
            stageScale: stageRoot.dataset.stageScale ?? null,
            stagePosX: stageRoot.dataset.stagePosX ?? null,
            stagePosY: stageRoot.dataset.stagePosY ?? null,
            debugPhase: stageRoot.dataset.canvasDebugPhase ?? null,
            debugTool: stageRoot.dataset.canvasDebugTool ?? null,
            debugSelectionWidth: stageRoot.dataset.canvasDebugSelectionWidth ?? null,
            debugSelectionHeight: stageRoot.dataset.canvasDebugSelectionHeight ?? null,
            containsSelectionRect: selectionRect ? stageRoot.contains(selectionRect) : null
          }
        : null,
      activeToolbarLabels
    }
  })
}

async function readCanvasPointerHitDebugState(
  page: Page,
  points: Array<{ x: number; y: number }>
): Promise<Array<{ x: number; y: number; target: string | null; insideStageRoot: boolean }>> {
  return page.evaluate((inputPoints) => {
    return inputPoints.map((point) => {
      const target = document.elementFromPoint(point.x, point.y) as HTMLElement | null
      if (!target) {
        return { ...point, target: null, insideStageRoot: false }
      }

      return {
        ...point,
        insideStageRoot: Boolean(target.closest('[data-testid="project-canvas-stage-root"]')),
        target:
          target.getAttribute('data-project-canvas-stage-event-layer') ||
          target.getAttribute('data-project-canvas-scene-overlay') ||
          target.getAttribute('data-project-canvas-proxy-layer') ||
          target.getAttribute('data-testid') ||
          target.getAttribute('aria-label') ||
          target.className ||
          target.tagName
      }
    })
  }, points)
}

async function installCanvasMarqueeTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stageRoot = document.querySelector(
      '[data-testid="project-canvas-stage-root"]'
    ) as HTMLElement | null
    const stageEventLayer = document.querySelector(
      '[data-project-canvas-stage-event-layer="dom"]'
    ) as HTMLElement | null
    const selectionRect = document.querySelector(
      '[data-canvas-selection-rect="svg"]'
    ) as SVGSVGElement | null

    const targetWindow = window as Window & {
      __canvasMarqueeTrace?: Array<Record<string, unknown>>
      __canvasMarqueeObserver?: MutationObserver
    }
    const trace: Array<Record<string, unknown>> = []
    const pushTrace = (entry: Record<string, unknown>) => {
      trace.push(entry)
      if (trace.length > 80) {
        trace.shift()
      }
    }

    targetWindow.__canvasMarqueeTrace = trace
    targetWindow.__canvasMarqueeObserver?.disconnect()

    const describeTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) {
        return null
      }

      return (
        target.getAttribute('data-project-canvas-stage-event-layer') ||
        target.getAttribute('data-project-canvas-scene-overlay') ||
        target.getAttribute('data-project-canvas-proxy-layer') ||
        target.getAttribute('data-testid') ||
        target.getAttribute('aria-label') ||
        target.className ||
        target.tagName
      )
    }

    const installListener = (node: EventTarget | null, label: string, types: string[]) => {
      if (!node) {
        return
      }

      for (const type of types) {
        node.addEventListener(
          type,
          (event) => {
            const mouseEvent = event as MouseEvent
            pushTrace({
              label,
              type,
              buttons: mouseEvent.buttons,
              button: mouseEvent.button,
              clientX: mouseEvent.clientX,
              clientY: mouseEvent.clientY,
              target: describeTarget(mouseEvent.target)
            })
          },
          true
        )
      }
    }

    installListener(stageRoot, 'stage-root', [
      'mousedown',
      'mousemove',
      'mouseup',
      'mouseleave',
      'pointerdown',
      'pointermove',
      'pointerup'
    ])
    installListener(stageEventLayer, 'stage-layer', [
      'mousedown',
      'mousemove',
      'mouseup',
      'mouseleave',
      'pointerdown',
      'pointermove',
      'pointerup'
    ])
    installListener(window, 'window', [
      'mousedown',
      'mousemove',
      'mouseup',
      'pointerdown',
      'pointermove',
      'pointerup'
    ])
    installListener(document, 'document', [
      'mousedown',
      'mousemove',
      'mouseup',
      'pointerdown',
      'pointermove',
      'pointerup'
    ])

    if (selectionRect) {
      targetWindow.__canvasMarqueeObserver = new MutationObserver(() => {
        pushTrace({
          label: 'selection-rect',
          type: 'mutation',
          display: selectionRect.style.display || getComputedStyle(selectionRect).display,
          width: selectionRect.getAttribute('width'),
          height: selectionRect.getAttribute('height'),
          left: selectionRect.style.left,
          top: selectionRect.style.top
        })
      })
      targetWindow.__canvasMarqueeObserver.observe(selectionRect, {
        attributes: true,
        attributeFilter: ['style', 'width', 'height']
      })
    }
  })
}

async function readCanvasMarqueeTrace(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const targetWindow = window as Window & {
      __canvasMarqueeTrace?: Array<Record<string, unknown>>
    }
    return targetWindow.__canvasMarqueeTrace ?? []
  })
}

async function readCanvasInteractionTrace(page: Page): Promise<{
  interaction: Array<Record<string, unknown>>
  dom: Array<Record<string, unknown>>
  pointerBridge: Array<Record<string, unknown>>
}> {
  return page.evaluate(() => {
    const targetWindow = window as Window & {
      __canvasInteractionTrace?: Array<Record<string, unknown>>
      __canvasSelectionRectDomTrace?: Array<Record<string, unknown>>
      __canvasStagePointerBridgeTrace?: Array<Record<string, unknown>>
    }
    return {
      interaction: targetWindow.__canvasInteractionTrace ?? [],
      dom: targetWindow.__canvasSelectionRectDomTrace ?? [],
      pointerBridge: targetWindow.__canvasStagePointerBridgeTrace ?? []
    }
  })
}

async function selectAllCanvasItems(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.waitForSelector('.selection-action-stack', { timeout: 10000 })
}

async function activateCanvasMultiSelection(
  page: Page,
  items: PersistedCanvasItem[]
): Promise<void> {
  if (items.length === 0) {
    throw new Error('activateCanvasMultiSelection requires at least one canvas item.')
  }

  const strategies: Array<() => Promise<void>> = [
    async () => {
      await clickCanvasBlankSpace(page, items)
      await boxSelectCanvasItems(page, items)
    },
    async () => {
      await selectCanvasItemForImageToolbar(page, items[0]!)
      await selectAllCanvasItems(page)
    },
    async () => {
      await clickCanvasBlankSpace(page, items)
      await selectAllCanvasItems(page)
    }
  ]

  let lastError: unknown = null

  for (const strategy of strategies) {
    try {
      await strategy()
      await page.waitForFunction(
        () =>
          !document.querySelector('.image-action-toolbar') ||
          Boolean(document.querySelector('.selection-action-stack')),
        { timeout: 10000 }
      )
      await page.waitForSelector(
        '[data-testid="project-canvas-multi-selection-transform-overlay"]',
        {
          timeout: 10000
        }
      )
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to activate multi-selection on the canvas route.')
}

async function verifyCanvasRouteSupportsRealMultiSelection(
  page: Page,
  fatalErrors: string[],
  tempRoot: string
): Promise<void> {
  const canvasId = 'tab-project-smoke-multi'
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  const workflowCopyPath = await writeWorkflowImageCopy(tempRoot)
  await setCanvasImportFiles(page, [getWorkflowImagePath(), workflowCopyPath])

  await page.waitForTimeout(1200)
  await flushCanvasPersistence(page)

  const items = await waitForPersistedCanvasItemCount(page, canvasId, 2)
  const images = items
    .filter((item) => item.type === 'image')
    .sort((left, right) => left.x - right.x)

  expect(images).toHaveLength(2)

  await selectCanvasItemForImageToolbar(page, images[0]!)

  await selectAllCanvasItems(page)
  await page.waitForFunction(
    (selector) => !document.querySelector(selector),
    '.image-action-toolbar',
    { timeout: 10000 }
  )

  expect(await page.locator('.selection-action-stack .generate-action-button').count()).toBe(1)
  expect(await page.locator('.selection-action-stack .group-action-button').count()).toBe(1)

  await page.waitForFunction(
    (selector) => !document.querySelector(selector),
    '.image-action-toolbar',
    { timeout: 10000 }
  )

  await clickCanvasBlankSpace(page, images)
  await page.waitForFunction(
    (selector) => !document.querySelector(selector),
    '.selection-action-stack',
    { timeout: 10000 }
  )

  await selectCanvasItemForImageToolbar(page, images[0]!)

  expect(fatalErrors).toEqual([])
}

async function verifyCanvasRouteDisplaysRealMarqueeDuringSelectionDrag(
  page: Page,
  fatalErrors: string[],
  tempRoot: string
): Promise<void> {
  const canvasId = 'tab-project-smoke-marquee'
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  await setCanvasImportFiles(page, [getWorkflowImagePath(), await writeWorkflowImageCopy(tempRoot)])

  await waitForCanvasImageInteractionReady(page)
  await page.waitForTimeout(1200)
  await flushCanvasPersistence(page)

  const items = await waitForPersistedCanvasItemCount(page, canvasId, 2)
  const images = items
    .filter((item) => item.type === 'image')
    .sort((left, right) => left.x - right.x)

  expect(images).toHaveLength(2)

  const bounds = await getCanvasInteractionHostBounds(page)
  const stageTransform = await getCanvasStageTransform(page)
  const { startX, startY, endX, endY } = await getSelectionBoxDragPoints(
    page,
    bounds,
    images,
    stageTransform
  )
  const probeX = startX + (endX - startX) * 0.55
  const probeY = startY + (endY - startY) * 0.55

  await installCanvasMarqueeTrace(page)
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(probeX, probeY, { steps: 8 })

  try {
    await page.waitForFunction(() => {
      const selectionRect = document.querySelector(
        '[data-canvas-selection-rect="svg"]'
      ) as SVGSVGElement | null
      if (!selectionRect) {
        return false
      }

      const width = Number(selectionRect.getAttribute('width') ?? 0)
      const height = Number(selectionRect.getAttribute('height') ?? 0)
      return selectionRect.style.display !== 'none' && width > 2 && height > 2
    })
  } catch (error) {
    const debugState = await readCanvasMarqueeDebugState(page)
    const pointerTargets = await readCanvasPointerHitDebugState(page, [
      { x: startX, y: startY },
      { x: probeX, y: probeY },
      { x: endX, y: endY }
    ])
    const marqueeTrace = await readCanvasMarqueeTrace(page)
    const interactionTrace = await readCanvasInteractionTrace(page)
    throw new Error(
      `Timed out waiting for marquee selection rect during real drag. ${JSON.stringify({
        debugState,
        interactionTrace,
        marqueeTrace,
        pointerTargets,
        dragPoints: { startX, startY, probeX, probeY, endX, endY }
      })}`,
      { cause: error instanceof Error ? error : undefined }
    )
  }

  const selectionRectState = await readCanvasSelectionRectState(page)
  expect(selectionRectState).not.toBeNull()
  expect(selectionRectState?.display).not.toBe('none')
  expect(selectionRectState?.width ?? 0).toBeGreaterThan(2)
  expect(selectionRectState?.height ?? 0).toBeGreaterThan(2)

  await page.mouse.move(endX, endY, { steps: 8 })
  await page.mouse.up()

  await page.waitForSelector('.selection-action-stack', { timeout: 10000 })
  expect(fatalErrors).toEqual([])
}

async function performCanvasRouteRealMultiSelectionDrag(
  page: Page,
  fatalErrors: string[],
  tempRoot: string,
  canvasId = 'tab-project-smoke-multi-drag'
): Promise<{
  canvasId: string
  beforeImages: PersistedCanvasItem[]
  afterImages: PersistedCanvasItem[]
}> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  const workflowCopyPath = await writeWorkflowImageCopy(tempRoot)
  await setCanvasImportFiles(page, [getWorkflowImagePath(), workflowCopyPath])

  await waitForCanvasImageInteractionReady(page)
  await page.waitForTimeout(1200)
  await flushCanvasPersistence(page)

  const beforeItems = await waitForPersistedCanvasItemCount(page, canvasId, 2)
  const images = beforeItems
    .filter((item) => item.type === 'image')
    .sort((left, right) => left.x - right.x)

  expect(images).toHaveLength(2)

  let currentImages = images
  const dragAttempts = [
    { x: 96, y: 60 },
    { x: 128, y: 72 },
    { x: 148, y: 84 }
  ]
  let lastDeltaSummary = ''

  for (const dragDelta of dragAttempts) {
    await activateCanvasMultiSelection(page, currentImages)

    await installCanvasDragEndProbe(page)

    await getMultiSelectionTransformOverlayBounds(page)
    const dragSurfaceBounds = await getMultiSelectionDragSurfaceBounds(page)
    const startX = dragSurfaceBounds.x + dragSurfaceBounds.width / 2
    const startY = dragSurfaceBounds.y + dragSurfaceBounds.height / 2

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + dragDelta.x, startY + dragDelta.y, { steps: 12 })
    await page.mouse.up()

    await waitForCanvasDragEnd(page)
    await page.waitForTimeout(150)
    await flushCanvasPersistence(page)

    const afterItems = await waitForPersistedCanvasItemCount(page, canvasId, 2)
    const afterImages = afterItems
      .filter((item) => item.type === 'image')
      .sort((left, right) => left.x - right.x)

    expect(afterImages).toHaveLength(2)

    const primaryDeltaX = afterImages[1]!.x - currentImages[1]!.x
    const primaryDeltaY = afterImages[1]!.y - currentImages[1]!.y
    const secondaryDeltaX = afterImages[0]!.x - currentImages[0]!.x
    const secondaryDeltaY = afterImages[0]!.y - currentImages[0]!.y
    lastDeltaSummary = JSON.stringify({
      primaryDeltaX,
      primaryDeltaY,
      secondaryDeltaX,
      secondaryDeltaY
    })

    if (
      (primaryDeltaX !== 0 || primaryDeltaY !== 0) &&
      primaryDeltaX === secondaryDeltaX &&
      primaryDeltaY === secondaryDeltaY
    ) {
      expect(fatalErrors).toEqual([])
      return {
        canvasId,
        beforeImages: images,
        afterImages
      }
    }

    currentImages = afterImages
  }

  throw new Error(`Unable to persist a multi-selection drag. Last deltas: ${lastDeltaSummary}`)
}

async function verifyCanvasRoutePersistsRealMultiSelectionDrag(
  page: Page,
  fatalErrors: string[],
  tempRoot: string
): Promise<void> {
  await performCanvasRouteRealMultiSelectionDrag(page, fatalErrors, tempRoot)
}

async function verifyCanvasRouteRestoresPersistedMultiSelectionDragAfterRelaunch(
  page: Page,
  fatalErrors: string[],
  canvasId: string,
  expectedImages: PersistedCanvasItem[]
): Promise<void> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)
  await waitForCanvasImageInteractionReady(page)

  const restoredItems = await waitForPersistedCanvasItemCount(page, canvasId, expectedImages.length)
  const restoredImages = restoredItems
    .filter((item) => item.type === 'image')
    .sort((left, right) => left.x - right.x)

  expect(restoredImages).toHaveLength(expectedImages.length)
  expect(restoredImages.map((item) => ({ id: item.id, x: item.x, y: item.y }))).toEqual(
    expectedImages.map((item) => ({ id: item.id, x: item.x, y: item.y }))
  )

  await selectCanvasItemForImageToolbar(page, restoredImages[0]!)
  expect(fatalErrors).toEqual([])
}

async function verifyCanvasRouteRestoresPersistedImageTransformSeedAfterRelaunch(
  page: Page,
  fatalErrors: string[],
  canvasId: string,
  beforeImage: PersistedCanvasItem,
  expectedImage: PersistedCanvasItem
): Promise<void> {
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)
  await waitForCanvasImageInteractionReady(page)

  const restoredItems = await waitForPersistedCanvasItemCount(page, canvasId, 1)
  const restoredImage = restoredItems.find((item) => item.id === expectedImage.id)
  expect(restoredImage).toBeTruthy()
  expect(restoredImage!.x).toBeCloseTo(expectedImage.x, 5)
  expect(restoredImage!.y).toBeCloseTo(expectedImage.y, 5)
  expect(restoredImage!.scaleX).toBeCloseTo(expectedImage.scaleX, 5)
  expect(restoredImage!.scaleY).toBeCloseTo(expectedImage.scaleY, 5)
  expect(restoredImage!.rotation).toBeCloseTo(expectedImage.rotation, 5)
  expect(restoredImage!.scaleX).not.toBeCloseTo(beforeImage.scaleX, 5)
  expect(restoredImage!.scaleY).not.toBeCloseTo(beforeImage.scaleY, 5)

  await selectCanvasItemForImageToolbar(page, restoredImage!)
  expect(fatalErrors).toEqual([])
}

describe('electron startup smoke', () => {
  let tempRoot: string | null = null
  let appHandle: SmokeAppHandle | null = null

  afterEach(async () => {
    if (appHandle) {
      await appHandle.app.close()
      appHandle = null
    }
    tempRoot = null
    currentSmokeRunId = null
  }, 60000)

  smokeIt(
    'launches and opens the core routes without renderer crash',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      await navigateToHash(appHandle.page, '#/canvas?id=tab-project-smoke')
      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      await getCanvasImportInput(appHandle.page)
      expect(appHandle.fatalErrors).toEqual([])
    },
    300000
  )

  canvasSmokeIt(
    'restores persisted single-image drag positions after relaunch',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      const { canvasId, afterImage } = await performCanvasRouteRealImageDrag(
        appHandle.page,
        appHandle.fatalErrors
      )

      await appHandle.app.close()
      appHandle = await relaunchSmokeAppUntilHealthy(userDataDir)
      await verifyCanvasRouteRestoresPersistedImageDragAfterRelaunch(
        appHandle.page,
        appHandle.fatalErrors,
        canvasId,
        afterImage
      )
    },
    300000
  )

  canvasSmokeIt(
    'imports a real video fixture and restores the native video overlay path after relaunch',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      const { canvasId, videoItem } = await verifyCanvasRouteSupportsVideoIntake(
        appHandle.page,
        appHandle.fatalErrors
      )

      await appHandle.app.close()
      appHandle = await relaunchSmokeAppUntilHealthy(userDataDir)
      await verifyCanvasRouteRestoresPersistedVideoAfterRelaunch(
        appHandle.page,
        appHandle.fatalErrors,
        canvasId,
        videoItem
      )
    },
    300000
  )

  canvasSmokeIt(
    'restores persisted transformed image state after relaunch',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      const { canvasId, beforeImage, seededImage } =
        await prepareCanvasRouteWithPersistedTransformSeed(appHandle.page, appHandle.fatalErrors)

      await appHandle.app.close()
      appHandle = await relaunchSmokeAppUntilHealthy(userDataDir)
      await verifyCanvasRouteRestoresPersistedImageTransformSeedAfterRelaunch(
        appHandle.page,
        appHandle.fatalErrors,
        canvasId,
        beforeImage,
        seededImage
      )
    },
    300000
  )

  canvasSmokeIt(
    'persists crop confirmation through the runtime crop overlay',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      const { canvasId, beforeImage, seededImage } = await prepareCanvasRouteWithPersistedCropSeed(
        appHandle.page,
        appHandle.fatalErrors
      )

      await appHandle.app.close()
      appHandle = await relaunchSmokeAppUntilHealthy(userDataDir)
      await verifySeededCanvasRoutePersistsRuntimeCropConfirmation(
        appHandle.page,
        appHandle.fatalErrors,
        canvasId,
        beforeImage,
        seededImage
      )
    },
    300000
  )

  canvasSmokeIt(
    'restores persisted crop state after relaunch',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      const { canvasId, beforeImage, seededImage } = await prepareCanvasRouteWithPersistedCropSeed(
        appHandle.page,
        appHandle.fatalErrors
      )

      await appHandle.app.close()
      appHandle = await relaunchSmokeAppUntilHealthy(userDataDir)
      const confirmedImage = await verifySeededCanvasRoutePersistsRuntimeCropConfirmation(
        appHandle.page,
        appHandle.fatalErrors,
        canvasId,
        beforeImage,
        seededImage
      )

      await appHandle.app.close()
      appHandle = await relaunchSmokeAppUntilHealthy(userDataDir)
      await verifyCanvasRouteRestoresPersistedCropAfterRelaunch(
        appHandle.page,
        appHandle.fatalErrors,
        canvasId,
        confirmedImage
      )
    },
    300000
  )

  canvasSmokeIt(
    'switches from multi-selection back to a target image and persists crop on that image only',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      const { canvasId, firstImage, targetImage, seededTargetImage } =
        await prepareCanvasRouteWithMultiSelectionCropSeed(
          appHandle.page,
          appHandle.fatalErrors,
          tempRoot
        )

      await appHandle.app.close()
      appHandle = await relaunchSmokeAppUntilHealthy(userDataDir)
      await verifyCanvasRouteSwitchesMultiSelectionTargetAndPersistsCrop(
        appHandle.page,
        appHandle.fatalErrors,
        canvasId,
        firstImage,
        targetImage,
        seededTargetImage
      )
    },
    300000
  )

  canvasSmokeIt(
    'supports real multi-selection and single-selection fallback on the canvas route',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      await verifyCanvasRouteSupportsRealMultiSelection(
        appHandle.page,
        appHandle.fatalErrors,
        tempRoot
      )
    },
    300000
  )

  canvasSmokeIt(
    'renders the marquee selection rect during a real canvas drag',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      await verifyCanvasRouteDisplaysRealMarqueeDuringSelectionDrag(
        appHandle.page,
        appHandle.fatalErrors,
        tempRoot
      )
    },
    300000
  )

  canvasSmokeIt(
    'persists real multi-selection drag on the canvas route',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      await verifyCanvasRoutePersistsRealMultiSelectionDrag(
        appHandle.page,
        appHandle.fatalErrors,
        tempRoot
      )
    },
    300000
  )

  canvasSmokeIt(
    'restores persisted multi-selection drag positions after relaunch',
    async () => {
      expectBuiltStartupArtifacts()

      tempRoot = initializeSmokeTempRoot()
      const userDataDir = path.join(tempRoot, 'userData')
      await writeSmokeConfig(userDataDir)

      appHandle = await launchSmokeApp(userDataDir)

      await waitForHealthyPage(appHandle.page, appHandle.fatalErrors)
      const { canvasId, afterImages } = await performCanvasRouteRealMultiSelectionDrag(
        appHandle.page,
        appHandle.fatalErrors,
        tempRoot
      )

      await appHandle.app.close()
      appHandle = await relaunchSmokeAppUntilHealthy(userDataDir)
      await verifyCanvasRouteRestoresPersistedMultiSelectionDragAfterRelaunch(
        appHandle.page,
        appHandle.fatalErrors,
        canvasId,
        afterImages
      )
    },
    300000
  )
})
