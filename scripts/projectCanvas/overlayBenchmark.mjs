/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs/promises'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import {
  assertNonIntrusiveWindowPlacement,
  buildNonIntrusiveTestWindowEnv,
  resolveProjectCanvasArtifactRoot,
  resolveProjectCanvasBenchmarkRunId
} from './benchmarkPolicy.mjs'

const ELECTRON_LAUNCH_TIMEOUT_MS = 90000
const FIRST_WINDOW_TIMEOUT_MS = 90000
const HEALTH_TIMEOUT_MS = 120000
const STORE_DB_NAME = 'magicpot-canvas'
const STORE_DB_VERSION = 2
const STORE_NAME = 'canvas-items'
const BENCHMARK_RUN_ID = resolveProjectCanvasBenchmarkRunId('overlay-benchmark')
const NON_INTRUSIVE_TEST_WINDOW_ENV = buildNonIntrusiveTestWindowEnv(BENCHMARK_RUN_ID)
const BENCHMARK_ITEMS_PER_KIND = Math.max(
  12,
  Number.parseInt(process.env.MAGICPOT_OVERLAY_BENCHMARK_PER_KIND || '48', 10) || 48
)

const isFatalPageError = (message) => !/fetch failed|Pysssss is not installed/i.test(message)

async function writeSmokeConfig(userDataDir) {
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

  await fs.mkdir(userDataDir, { recursive: true })
  await fs.writeFile(path.join(userDataDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

async function waitForHealthyPage(page, fatalErrors) {
  await page.waitForFunction(() => Boolean(document.getElementById('root')), undefined, {
    timeout: HEALTH_TIMEOUT_MS
  })
  await page.waitForTimeout(1200)

  if (page.isClosed()) {
    throw new Error('Overlay benchmark window closed before becoming healthy.')
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || '')
  if (bodyText.includes('Renderer crashed') || bodyText.includes('Unexpected Application Error')) {
    throw new Error(`Renderer reported an unhealthy state: ${bodyText}`)
  }
  if (fatalErrors.length > 0) {
    throw new Error(`Overlay benchmark renderer emitted fatal errors: ${fatalErrors.join(' | ')}`)
  }
}

async function launchApp(userDataDir) {
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAGICPOT_USER_DATA_DIR: userDataDir,
      ...NON_INTRUSIVE_TEST_WINDOW_ENV
    },
    timeout: ELECTRON_LAUNCH_TIMEOUT_MS
  })
  const page = await app.firstWindow({ timeout: FIRST_WINDOW_TIMEOUT_MS })
  const fatalErrors = []

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

  await waitForHealthyPage(page, fatalErrors)
  return { app, page, fatalErrors }
}

async function readWindowPlacement(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) {
      throw new Error('Overlay benchmark expected a BrowserWindow instance.')
    }

    const bounds = mainWindow.getBounds()
    const primaryDisplay = screen.getPrimaryDisplay()
    const displays = screen.getAllDisplays().map((display) => ({
      id: display.id,
      workArea: display.workArea
    }))
    const windowWithOptionalSkipTaskbar = mainWindow
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
      primaryDisplayId: primaryDisplay.id,
      primaryWorkArea: primaryDisplay.workArea
    }
  })
}

async function navigateToHash(page, hash) {
  const appliedHash = await page.evaluate((nextHash) => {
    window.location.hash = nextHash
    return window.location.hash
  }, hash)
  if (appliedHash !== hash) {
    throw new Error(`Expected hash ${hash} but got ${appliedHash}`)
  }
  await page.waitForTimeout(200)
}

function createOverlayBenchmarkItems(perKind) {
  const items = []
  const visibleColumns = 6
  const cellWidth = 220
  const cellHeight = 150
  const offscreenBaseX = 4600
  const offscreenBaseY = 3400

  const pushItem = (item) => items.push(item)
  const createPosition = (index, offsetY, visible) =>
    visible
      ? {
          x: 24 + (index % visibleColumns) * cellWidth,
          y: offsetY + Math.floor(index / visibleColumns) * cellHeight
        }
      : {
          x: offscreenBaseX + (index % visibleColumns) * cellWidth,
          y: offscreenBaseY + offsetY + Math.floor(index / visibleColumns) * cellHeight
        }

  for (let index = 0; index < perKind; index += 1) {
    const visible = index < Math.ceil(perKind / 2)
    const htmlPosition = createPosition(index, 24, visible)
    pushItem({
      id: `html-${index}`,
      type: 'html',
      htmlData: `<div>Overlay ${index}</div>`,
      x: htmlPosition.x,
      y: htmlPosition.y,
      width: 180,
      height: 110,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: index,
      locked: false
    })

    const textPosition = createPosition(index, 260, visible)
    pushItem({
      id: `text-${index}`,
      type: 'text',
      text: `Overlay text ${index}`,
      fontSize: 18,
      fontFamily: 'system-ui, sans-serif',
      fill: '#f8fafc',
      x: textPosition.x,
      y: textPosition.y,
      width: 180,
      height: 72,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1000 + index,
      locked: false
    })

    const filePosition = createPosition(index, 496, visible)
    pushItem({
      id: `file-${index}`,
      type: 'file',
      src: `file:///overlay-${index}.md`,
      fileName: `overlay-${index}.md`,
      mimeType: 'text/markdown',
      fileKind: 'markdown',
      x: filePosition.x,
      y: filePosition.y,
      width: 220,
      height: 150,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 2000 + index,
      locked: false,
      editable: true,
      previewText: `Overlay file preview ${index}`
    })

    const annotationPosition = createPosition(index, 732, visible)
    pushItem({
      id: `annotation-${index}`,
      type: 'annotation',
      shape: 'rect',
      stroke: '#22c55e',
      fillOpacity: 0.2,
      strokeWidth: 2,
      label: `Anno ${index}`,
      x: annotationPosition.x,
      y: annotationPosition.y,
      width: 180,
      height: 110,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 3000 + index,
      locked: false
    })
  }

  return items
}

async function seedCanvasItems(page, canvasId, items) {
  await page.evaluate(
    async ({ canvasId: nextCanvasId, payload, dbName, dbVersion, storeName }) => {
      const openDb = () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(dbName, dbVersion)
          request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(storeName)) {
              db.createObjectStore(storeName)
            }
            if (!db.objectStoreNames.contains('canvas-blobs')) {
              db.createObjectStore('canvas-blobs')
            }
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })

      const db = await openDb()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).put(payload, nextCanvasId)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    {
      canvasId,
      payload: {
        items,
        groups: [],
        figmaBinding: null
      },
      dbName: STORE_DB_NAME,
      dbVersion: STORE_DB_VERSION,
      storeName: STORE_NAME
    }
  )
}

function getOverlayKindTotal(metrics) {
  return (
    metrics.htmlOverlayCount +
    metrics.fileOverlayCount +
    metrics.textOverlayCount +
    metrics.annotationOverlayCount
  )
}

function hasConsistentOverlayAccounting(metrics) {
  const overlayKindTotal = getOverlayKindTotal(metrics)
  return (
    metrics.overlayTotalCount === metrics.domOverlayCount &&
    metrics.overlayTotalCount === overlayKindTotal
  )
}

async function waitForOverlayMetrics(page, expectedPerKind, expectedTotal) {
  await page.waitForFunction(
    (expected) => {
      const stageRoot = document.querySelector('[data-testid="project-canvas-stage-root"]')
      const overlayRoot = document.querySelector('[data-project-canvas-overlay-total-count]')
      if (!(stageRoot instanceof HTMLElement) || !(overlayRoot instanceof HTMLElement)) {
        return false
      }

      const domOverlayCount = Number(overlayRoot.dataset.projectCanvasDomOverlayCount || '0')
      const overlayTotalCount = Number(overlayRoot.dataset.projectCanvasOverlayTotalCount || '0')
      const htmlOverlayCount = Number(overlayRoot.dataset.projectCanvasHtmlOverlayCount || '0')
      const fileOverlayCount = Number(overlayRoot.dataset.projectCanvasFileOverlayCount || '0')
      const textOverlayCount = Number(overlayRoot.dataset.projectCanvasTextOverlayCount || '0')
      const annotationOverlayCount = Number(
        overlayRoot.dataset.projectCanvasAnnotationOverlayCount || '0'
      )
      const overlayKindTotal =
        htmlOverlayCount + fileOverlayCount + textOverlayCount + annotationOverlayCount

      return (
        domOverlayCount > 0 &&
        overlayTotalCount === domOverlayCount &&
        overlayTotalCount === overlayKindTotal &&
        overlayTotalCount === expected.expectedTotal &&
        htmlOverlayCount === expected.expectedPerKind &&
        fileOverlayCount === expected.expectedPerKind &&
        textOverlayCount === expected.expectedPerKind &&
        annotationOverlayCount === expected.expectedPerKind
      )
    },
    { expectedPerKind, expectedTotal },
    { timeout: 120000 }
  )

  return page.evaluate(() => {
    const stageRoot = document.querySelector('[data-testid="project-canvas-stage-root"]')
    const overlayRoot = document.querySelector('[data-project-canvas-overlay-total-count]')
    if (!(stageRoot instanceof HTMLElement) || !(overlayRoot instanceof HTMLElement)) {
      throw new Error('Overlay benchmark metrics roots were not found.')
    }

    return {
      overlayTotalCount: Number(overlayRoot.dataset.projectCanvasOverlayTotalCount || '0'),
      domOverlayCount: Number(overlayRoot.dataset.projectCanvasDomOverlayCount || '0'),
      htmlOverlayCount: Number(overlayRoot.dataset.projectCanvasHtmlOverlayCount || '0'),
      fileOverlayCount: Number(overlayRoot.dataset.projectCanvasFileOverlayCount || '0'),
      textOverlayCount: Number(overlayRoot.dataset.projectCanvasTextOverlayCount || '0'),
      annotationOverlayCount: Number(
        overlayRoot.dataset.projectCanvasAnnotationOverlayCount || '0'
      ),
      overlayKindTotalCount:
        Number(overlayRoot.dataset.projectCanvasHtmlOverlayCount || '0') +
        Number(overlayRoot.dataset.projectCanvasFileOverlayCount || '0') +
        Number(overlayRoot.dataset.projectCanvasTextOverlayCount || '0') +
        Number(overlayRoot.dataset.projectCanvasAnnotationOverlayCount || '0'),
      domNodeCount: document.getElementsByTagName('*').length,
      stageScale: Number(stageRoot.dataset.stageScale || '0'),
      stagePosX: Number(stageRoot.dataset.stagePosX || '0'),
      stagePosY: Number(stageRoot.dataset.stagePosY || '0')
    }
  })
}

async function zoomIntoCanvas(page, steps = 4) {
  const stageRoot = page.locator('[data-testid="project-canvas-stage-root"]').first()
  const bounds = await stageRoot.boundingBox()
  if (!bounds) {
    throw new Error('Unable to determine ProjectCanvas stage bounds for the overlay benchmark.')
  }

  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  await page.mouse.move(centerX, centerY)

  for (let index = 0; index < steps; index += 1) {
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(120)
  }
}

async function readOverlayMetrics(page) {
  return page.evaluate(() => {
    const overlayRoot = document.querySelector('[data-project-canvas-overlay-total-count]')
    const stageRoot = document.querySelector('[data-testid="project-canvas-stage-root"]')
    if (!(overlayRoot instanceof HTMLElement) || !(stageRoot instanceof HTMLElement)) {
      throw new Error('Overlay benchmark metrics roots were not found.')
    }

    return {
      overlayTotalCount: Number(overlayRoot.dataset.projectCanvasOverlayTotalCount || '0'),
      domOverlayCount: Number(overlayRoot.dataset.projectCanvasDomOverlayCount || '0'),
      htmlOverlayCount: Number(overlayRoot.dataset.projectCanvasHtmlOverlayCount || '0'),
      fileOverlayCount: Number(overlayRoot.dataset.projectCanvasFileOverlayCount || '0'),
      textOverlayCount: Number(overlayRoot.dataset.projectCanvasTextOverlayCount || '0'),
      annotationOverlayCount: Number(
        overlayRoot.dataset.projectCanvasAnnotationOverlayCount || '0'
      ),
      overlayKindTotalCount:
        Number(overlayRoot.dataset.projectCanvasHtmlOverlayCount || '0') +
        Number(overlayRoot.dataset.projectCanvasFileOverlayCount || '0') +
        Number(overlayRoot.dataset.projectCanvasTextOverlayCount || '0') +
        Number(overlayRoot.dataset.projectCanvasAnnotationOverlayCount || '0'),
      domNodeCount: document.getElementsByTagName('*').length,
      stageScale: Number(stageRoot.dataset.stageScale || '0'),
      stagePosX: Number(stageRoot.dataset.stagePosX || '0'),
      stagePosY: Number(stageRoot.dataset.stagePosY || '0')
    }
  })
}

async function zoomUntilOverlayCull(page, totalSeededItems) {
  let attempts = 0
  let lastMetrics = await readOverlayMetrics(page)
  const hasObservedOverlayCull = (metrics) =>
    hasConsistentOverlayAccounting(metrics) &&
    metrics.overlayTotalCount > 0 &&
    metrics.overlayTotalCount < totalSeededItems

  while (attempts < 6) {
    if (hasObservedOverlayCull(lastMetrics)) {
      return {
        zoomSteps: attempts * 4,
        metrics: lastMetrics
      }
    }

    await zoomIntoCanvas(page)
    attempts += 1
    await page.waitForTimeout(240)
    lastMetrics = await readOverlayMetrics(page)
  }

  if (hasObservedOverlayCull(lastMetrics)) {
    return {
      zoomSteps: attempts * 4,
      metrics: lastMetrics
    }
  }

  throw new Error(
    `Overlay benchmark expected viewport culling after zoom but still saw ${lastMetrics.overlayTotalCount}/${totalSeededItems} mounted overlays at stage scale ${lastMetrics.stageScale}.`
  )
}

let appHandle = null
let tempRoot = null
let artifactRoot = null

try {
  artifactRoot = resolveProjectCanvasArtifactRoot(BENCHMARK_RUN_ID)
  await fs.mkdir(artifactRoot, { recursive: true })
  tempRoot = await fs.mkdtemp(path.join(artifactRoot, 'magicpot-overlay-benchmark-'))
  const userDataDir = path.join(tempRoot, 'user-data')
  await writeSmokeConfig(userDataDir)

  appHandle = await launchApp(userDataDir)
  const { page, fatalErrors } = appHandle
  const canvasId = `overlay-benchmark-${Date.now().toString(36)}`
  const items = createOverlayBenchmarkItems(BENCHMARK_ITEMS_PER_KIND)
  await seedCanvasItems(page, canvasId, items)
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  const initialOverlayMetrics = await waitForOverlayMetrics(
    page,
    BENCHMARK_ITEMS_PER_KIND,
    items.length
  )
  const zoomedOverlay = await zoomUntilOverlayCull(page, items.length)
  const windowPlacement = await readWindowPlacement(appHandle.app)
  assertNonIntrusiveWindowPlacement(windowPlacement, 'Overlay benchmark')
  const payload = {
    itemsPerKind: BENCHMARK_ITEMS_PER_KIND,
    totalSeededItems: items.length,
    windowPlacement,
    initialOverlayMetrics,
    zoomedOverlayMetrics: zoomedOverlay.metrics,
    zoomStepsApplied: zoomedOverlay.zoomSteps
  }

  await fs.writeFile(
    path.join(artifactRoot, 'overlay-benchmark-report.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  )
  console.log(JSON.stringify(payload, null, 2))

  if (
    !hasConsistentOverlayAccounting(initialOverlayMetrics) ||
    initialOverlayMetrics.overlayTotalCount !== items.length ||
    initialOverlayMetrics.htmlOverlayCount !== BENCHMARK_ITEMS_PER_KIND ||
    initialOverlayMetrics.fileOverlayCount !== BENCHMARK_ITEMS_PER_KIND ||
    initialOverlayMetrics.textOverlayCount !== BENCHMARK_ITEMS_PER_KIND ||
    initialOverlayMetrics.annotationOverlayCount !== BENCHMARK_ITEMS_PER_KIND ||
    !hasConsistentOverlayAccounting(zoomedOverlay.metrics) ||
    zoomedOverlay.metrics.overlayTotalCount <= 0 ||
    zoomedOverlay.metrics.overlayTotalCount >= items.length
  ) {
    process.exitCode = 1
  }
} catch (error) {
  if (artifactRoot) {
    try {
      await fs.writeFile(
        path.join(artifactRoot, 'overlay-benchmark-error.txt'),
        error instanceof Error ? error.stack || error.message : String(error),
        'utf8'
      )
    } catch {
      // Ignore artifact persistence failures.
    }
  }
  console.error(
    error instanceof Error
      ? error.stack || error.message
      : `Unknown overlay benchmark error: ${String(error)}`
  )
  process.exitCode = 1
} finally {
  if (appHandle?.app) {
    try {
      await appHandle.app.close()
    } catch {
      // Ignore cleanup failures.
    }
  }
  if (tempRoot) {
    try {
      await fs.rm(tempRoot, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures.
    }
  }
}
