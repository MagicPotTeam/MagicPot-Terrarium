/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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
const BENCHMARK_RUN_ID = resolveProjectCanvasBenchmarkRunId('video-benchmark')
const NON_INTRUSIVE_TEST_WINDOW_ENV = buildNonIntrusiveTestWindowEnv(BENCHMARK_RUN_ID)
const BENCHMARK_VIDEO_COUNT = Math.max(
  16,
  Number.parseInt(process.env.MAGICPOT_VIDEO_BENCHMARK_COUNT || '24', 10) || 24
)
const PROJECT_CANVAS_VIDEO_FIXTURE_PATH = path.join(
  process.cwd(),
  'src',
  'main',
  'testSupport',
  'fixtures',
  'projectCanvas',
  'projectCanvasSampleVideo.webm'
)
const PROJECT_CANVAS_VIDEO_FIXTURE_URL = pathToFileURL(PROJECT_CANVAS_VIDEO_FIXTURE_PATH).href

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
    throw new Error('Video benchmark window closed before becoming healthy.')
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || '')
  if (bodyText.includes('Renderer crashed') || bodyText.includes('Unexpected Application Error')) {
    throw new Error(`Renderer reported an unhealthy state: ${bodyText}`)
  }
  if (fatalErrors.length > 0) {
    throw new Error(`Video benchmark renderer emitted fatal errors: ${fatalErrors.join(' | ')}`)
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
      throw new Error('Video benchmark expected a BrowserWindow instance.')
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

async function assertVideoFixtureExists() {
  try {
    await fs.access(PROJECT_CANVAS_VIDEO_FIXTURE_PATH)
  } catch {
    throw new Error(
      `Video benchmark fixture was not found at ${PROJECT_CANVAS_VIDEO_FIXTURE_PATH}.`
    )
  }
}

function createVideoBenchmarkItems(total, fixtureUrl, fixtureFileName) {
  const items = []
  const visibleColumns = 4
  const cellWidth = 360
  const cellHeight = 220
  const offscreenBaseX = 5200
  const offscreenBaseY = 3600
  const activeCandidateCutoff = Math.ceil(total * 0.4)
  const visiblePausedCutoff = Math.ceil(total * 0.65)
  const posterCutoff = Math.ceil(total * 0.82)
  let activeCandidateCount = 0
  let visiblePausedCount = 0
  let posterFrameCount = 0
  let unmountedCount = 0

  for (let index = 0; index < total; index += 1) {
    if (index < activeCandidateCutoff) {
      activeCandidateCount += 1
      items.push({
        id: `video-active-${index}`,
        type: 'video',
        src: fixtureUrl,
        fileName: fixtureFileName,
        x: 36 + (index % visibleColumns) * cellWidth,
        y: 40 + Math.floor(index / visibleColumns) * cellHeight,
        width: 320,
        height: 180,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: index,
        locked: false,
        playing: true,
        muted: true,
        volume: 0
      })
      continue
    }

    if (index < visiblePausedCutoff) {
      visiblePausedCount += 1
      const localIndex = index - activeCandidateCutoff
      items.push({
        id: `video-paused-${index}`,
        type: 'video',
        src: fixtureUrl,
        fileName: fixtureFileName,
        x: 36 + (localIndex % visibleColumns) * cellWidth,
        y: 560 + Math.floor(localIndex / visibleColumns) * cellHeight,
        width: 320,
        height: 180,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: index,
        locked: false,
        playing: false,
        muted: true,
        volume: 0
      })
      continue
    }

    if (index < posterCutoff) {
      posterFrameCount += 1
      const localIndex = index - visiblePausedCutoff
      items.push({
        id: `video-poster-${index}`,
        type: 'video',
        src: fixtureUrl,
        fileName: fixtureFileName,
        x: 36 + (localIndex % 8) * 92,
        y: 1080 + Math.floor(localIndex / 8) * 96,
        width: 40,
        height: 24,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: index,
        locked: false,
        playing: false,
        muted: true,
        volume: 0
      })
      continue
    }

    unmountedCount += 1
    const localIndex = index - posterCutoff
    items.push({
      id: `video-offscreen-${index}`,
      type: 'video',
      src: fixtureUrl,
      fileName: fixtureFileName,
      x: offscreenBaseX + (localIndex % visibleColumns) * cellWidth,
      y: offscreenBaseY + Math.floor(localIndex / visibleColumns) * cellHeight,
      width: 320,
      height: 180,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: index,
      locked: false,
      playing: Boolean(localIndex % 2),
      muted: true,
      volume: 0
    })
  }

  const maxActivePlaying = Math.min(activeCandidateCount, 4)
  return {
    items,
    budgetExpectations: {
      totalVideos: total,
      maxActivePlaying
    },
    seededLayout: {
      activeCandidateCount,
      visiblePausedCount: visiblePausedCount + Math.max(0, activeCandidateCount - maxActivePlaying),
      posterFrameCount,
      unmountedCount
    }
  }
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

function getMountedVideoModeCount(metrics) {
  return metrics.activePlayingCount + metrics.visiblePausedCount + metrics.posterFrameCount
}

function hasConsistentVideoAccounting(metrics, budgetExpectations) {
  const mountedVideoModeCount = getMountedVideoModeCount(metrics)
  return (
    metrics.totalVideos === budgetExpectations.totalVideos &&
    metrics.activePlayingOverlayCount === metrics.activePlayingCount &&
    metrics.visiblePausedOverlayCount === metrics.visiblePausedCount &&
    metrics.posterFrameOverlayCount === metrics.posterFrameCount &&
    metrics.mountedVideoOverlayCount === mountedVideoModeCount &&
    metrics.mountedOverlayNodeCount === metrics.mountedVideoOverlayCount &&
    mountedVideoModeCount + metrics.unmountedCount === metrics.totalVideos &&
    metrics.activePlayingCount <= budgetExpectations.maxActivePlaying
  )
}

async function readVideoMetrics(page) {
  return page.evaluate(() => {
    const overlayRoot = document.querySelector('[data-project-canvas-overlay-total-count]')
    const stageRoot = document.querySelector('[data-testid="project-canvas-stage-root"]')
    if (!(overlayRoot instanceof HTMLElement) || !(stageRoot instanceof HTMLElement)) {
      throw new Error('Video benchmark metrics roots were not found.')
    }

    const overlayNodes = Array.from(
      document.querySelectorAll('[data-canvas-overlay="video"][data-canvas-video-budget-mode]')
    )
    const modeCounts = overlayNodes.reduce(
      (counts, node) => {
        const mode = node.getAttribute('data-canvas-video-budget-mode')
        if (mode === 'active-playing') {
          counts.activePlayingCount += 1
        } else if (mode === 'visible-paused') {
          counts.visiblePausedCount += 1
        } else if (mode === 'poster-frame') {
          counts.posterFrameCount += 1
        }
        return counts
      },
      {
        activePlayingCount: 0,
        visiblePausedCount: 0,
        posterFrameCount: 0
      }
    )
    const mountedOverlayNodeCount = overlayNodes.length

    return {
      mountedVideoOverlayCount: Number(
        overlayRoot.dataset.projectCanvasMountedVideoOverlayCount || '0'
      ),
      totalVideos: Number(overlayRoot.dataset.projectCanvasVideoTotalCount || '0'),
      activePlayingCount: Number(overlayRoot.dataset.projectCanvasVideoActivePlayingCount || '0'),
      visiblePausedCount: Number(overlayRoot.dataset.projectCanvasVideoVisiblePausedCount || '0'),
      posterFrameCount: Number(overlayRoot.dataset.projectCanvasVideoPosterFrameCount || '0'),
      unmountedCount: Number(overlayRoot.dataset.projectCanvasVideoUnmountedCount || '0'),
      activePlayingOverlayCount: modeCounts.activePlayingCount,
      visiblePausedOverlayCount: modeCounts.visiblePausedCount,
      posterFrameOverlayCount: modeCounts.posterFrameCount,
      mountedOverlayNodeCount,
      stageScale: Number(stageRoot.dataset.stageScale || '0'),
      stagePosX: Number(stageRoot.dataset.stagePosX || '0'),
      stagePosY: Number(stageRoot.dataset.stagePosY || '0')
    }
  })
}

function scoreInitialVideoMetrics(metrics, budgetExpectations) {
  return (
    (metrics.totalVideos === budgetExpectations.totalVideos ? 200 : 0) +
    (metrics.activePlayingOverlayCount === metrics.activePlayingCount ? 80 : 0) +
    (metrics.visiblePausedOverlayCount === metrics.visiblePausedCount ? 80 : 0) +
    (metrics.posterFrameOverlayCount === metrics.posterFrameCount ? 80 : 0) +
    (metrics.mountedOverlayNodeCount === metrics.mountedVideoOverlayCount ? 80 : 0) +
    (getMountedVideoModeCount(metrics) + metrics.unmountedCount === metrics.totalVideos ? 120 : 0) +
    (metrics.activePlayingCount <= budgetExpectations.maxActivePlaying ? 80 : 0) +
    Math.min(metrics.mountedVideoOverlayCount, budgetExpectations.totalVideos)
  )
}

async function waitForVideoMetrics(page, budgetExpectations) {
  const deadline = Date.now() + 120000
  let lastMetrics = await readVideoMetrics(page)
  let bestMetrics = lastMetrics
  let bestScore = scoreInitialVideoMetrics(lastMetrics, budgetExpectations)

  while (Date.now() <= deadline) {
    if (
      hasConsistentVideoAccounting(lastMetrics, budgetExpectations) &&
      lastMetrics.mountedVideoOverlayCount > 0
    ) {
      return lastMetrics
    }

    await page.waitForTimeout(200)
    lastMetrics = await readVideoMetrics(page)
    const nextScore = scoreInitialVideoMetrics(lastMetrics, budgetExpectations)
    if (nextScore > bestScore) {
      bestScore = nextScore
      bestMetrics = lastMetrics
    }
  }

  throw new Error(
    `Video benchmark did not reach truthful initial accounting. Best metrics: ${JSON.stringify(bestMetrics)}. Last metrics: ${JSON.stringify(lastMetrics)}.`
  )
}

async function zoomIntoCanvas(page, steps = 4) {
  const stageRoot = page.locator('[data-testid="project-canvas-stage-root"]').first()
  const bounds = await stageRoot.boundingBox()
  if (!bounds) {
    throw new Error('Unable to determine ProjectCanvas stage bounds for the video benchmark.')
  }

  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  await page.mouse.move(centerX, centerY)

  for (let index = 0; index < steps; index += 1) {
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(120)
  }
}

function isVideoBudgetConverged(metrics, budgetExpectations, initialMountedCount) {
  return (
    hasConsistentVideoAccounting(metrics, budgetExpectations) &&
    metrics.activePlayingCount > 0 &&
    metrics.activePlayingCount <= budgetExpectations.maxActivePlaying &&
    metrics.activePlayingOverlayCount === metrics.activePlayingCount &&
    metrics.posterFrameCount > 0 &&
    metrics.unmountedCount > 0 &&
    metrics.mountedVideoOverlayCount > 0 &&
    metrics.mountedVideoOverlayCount < initialMountedCount
  )
}

function scoreVideoBudgetMetrics(metrics, budgetExpectations, initialMountedCount) {
  const mountedReduction = Math.max(0, initialMountedCount - metrics.mountedVideoOverlayCount)
  const activeHeadroom = Math.max(
    0,
    budgetExpectations.maxActivePlaying - Math.max(0, metrics.activePlayingCount)
  )

  return (
    Math.min(metrics.activePlayingCount, budgetExpectations.maxActivePlaying) * 100 -
    activeHeadroom * 10 +
    (metrics.posterFrameCount > 0 ? 60 : 0) +
    (metrics.unmountedCount > 0 ? 60 : 0) +
    (metrics.mountedVideoOverlayCount > 0 ? 30 : 0) +
    mountedReduction
  )
}

async function zoomUntilVideoBudgetConverges(page, budgetExpectations, initialMountedCount) {
  let attempts = 0
  let zoomSteps = 0
  let lastMetrics = await readVideoMetrics(page)
  let bestMetrics = lastMetrics
  let bestScore = scoreVideoBudgetMetrics(lastMetrics, budgetExpectations, initialMountedCount)

  while (attempts < 24) {
    if (isVideoBudgetConverged(lastMetrics, budgetExpectations, initialMountedCount)) {
      return {
        zoomSteps,
        metrics: lastMetrics
      }
    }

    await zoomIntoCanvas(page, 1)
    zoomSteps += 1
    attempts += 1
    await page.waitForTimeout(180)
    lastMetrics = await readVideoMetrics(page)
    const nextScore = scoreVideoBudgetMetrics(lastMetrics, budgetExpectations, initialMountedCount)
    if (nextScore > bestScore) {
      bestScore = nextScore
      bestMetrics = lastMetrics
    }
  }

  if (isVideoBudgetConverged(lastMetrics, budgetExpectations, initialMountedCount)) {
    return {
      zoomSteps,
      metrics: lastMetrics
    }
  }

  throw new Error(
    `Video benchmark expected a budget-diverse zoom state with active<=${budgetExpectations.maxActivePlaying}, poster>0, and unmounted>0, but best metrics were active=${bestMetrics.activePlayingCount}, poster=${bestMetrics.posterFrameCount}, unmounted=${bestMetrics.unmountedCount}, mounted=${bestMetrics.mountedVideoOverlayCount} at stage scale ${bestMetrics.stageScale}. Last metrics were active=${lastMetrics.activePlayingCount}, poster=${lastMetrics.posterFrameCount}, unmounted=${lastMetrics.unmountedCount}, mounted=${lastMetrics.mountedVideoOverlayCount} at stage scale ${lastMetrics.stageScale}.`
  )
}

let appHandle = null
let tempRoot = null
let artifactRoot = null

try {
  artifactRoot = resolveProjectCanvasArtifactRoot(BENCHMARK_RUN_ID)
  await fs.mkdir(artifactRoot, { recursive: true })
  tempRoot = await fs.mkdtemp(path.join(artifactRoot, 'magicpot-video-benchmark-'))
  await assertVideoFixtureExists()
  const userDataDir = path.join(tempRoot, 'user-data')
  await writeSmokeConfig(userDataDir)

  appHandle = await launchApp(userDataDir)
  const { page, fatalErrors } = appHandle
  const canvasId = `video-benchmark-${Date.now().toString(36)}`
  const { items, budgetExpectations, seededLayout } = createVideoBenchmarkItems(
    BENCHMARK_VIDEO_COUNT,
    PROJECT_CANVAS_VIDEO_FIXTURE_URL,
    path.basename(PROJECT_CANVAS_VIDEO_FIXTURE_PATH)
  )
  await seedCanvasItems(page, canvasId, items)
  await navigateToHash(page, `#/canvas?id=${canvasId}`)
  await waitForHealthyPage(page, fatalErrors)

  const initialVideoMetrics = await waitForVideoMetrics(page, budgetExpectations)
  const zoomedVideo = await zoomUntilVideoBudgetConverges(
    page,
    budgetExpectations,
    initialVideoMetrics.mountedVideoOverlayCount
  )
  const windowPlacement = await readWindowPlacement(appHandle.app)
  assertNonIntrusiveWindowPlacement(windowPlacement, 'Video benchmark')
  const payload = {
    benchmarkVideoCount: BENCHMARK_VIDEO_COUNT,
    videoFixturePath: PROJECT_CANVAS_VIDEO_FIXTURE_PATH,
    budgetExpectations,
    seededLayout,
    windowPlacement,
    initialVideoMetrics,
    zoomedVideoMetrics: zoomedVideo.metrics,
    zoomStepsApplied: zoomedVideo.zoomSteps
  }

  await fs.writeFile(
    path.join(artifactRoot, 'video-benchmark-report.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  )
  console.log(JSON.stringify(payload, null, 2))

  if (
    !hasConsistentVideoAccounting(initialVideoMetrics, budgetExpectations) ||
    initialVideoMetrics.totalVideos !== budgetExpectations.totalVideos ||
    initialVideoMetrics.mountedVideoOverlayCount + initialVideoMetrics.unmountedCount !==
      budgetExpectations.totalVideos ||
    initialVideoMetrics.activePlayingOverlayCount !== initialVideoMetrics.activePlayingCount ||
    initialVideoMetrics.visiblePausedOverlayCount !== initialVideoMetrics.visiblePausedCount ||
    initialVideoMetrics.posterFrameOverlayCount !== initialVideoMetrics.posterFrameCount ||
    initialVideoMetrics.mountedOverlayNodeCount !== initialVideoMetrics.mountedVideoOverlayCount ||
    !hasConsistentVideoAccounting(zoomedVideo.metrics, budgetExpectations) ||
    !isVideoBudgetConverged(
      zoomedVideo.metrics,
      budgetExpectations,
      initialVideoMetrics.mountedVideoOverlayCount
    )
  ) {
    process.exitCode = 1
  }
} catch (error) {
  if (artifactRoot) {
    try {
      await fs.writeFile(
        path.join(artifactRoot, 'video-benchmark-error.txt'),
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
      : `Unknown video benchmark error: ${String(error)}`
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
