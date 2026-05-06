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
const BENCHMARK_METRIC_WAIT_TIMEOUT_MS = Math.max(
  10000,
  Number.parseInt(process.env.MAGICPOT_WEBGL_BENCHMARK_WAIT_MS || '120000', 10) || 120000
)
const BENCHMARK_RUN_ID = resolveProjectCanvasBenchmarkRunId('webgl-benchmark')
const NON_INTRUSIVE_TEST_WINDOW_ENV = buildNonIntrusiveTestWindowEnv(BENCHMARK_RUN_ID)
const BENCHMARK_IMAGE_COUNT = Math.max(
  4,
  Number.parseInt(process.env.MAGICPOT_WEBGL_BENCHMARK_IMAGES || '12', 10) || 12
)
const BENCHMARK_INTERACTION_SAMPLE_COUNT = Math.max(
  4,
  Number.parseInt(process.env.MAGICPOT_WEBGL_BENCHMARK_SAMPLES || '8', 10) || 8
)

const isFatalPageError = (message) => !/fetch failed|Pysssss is not installed/i.test(message)

const getWorkflowImagePath = () =>
  path.join(process.cwd(), 'src', 'renderer', 'src', 'assets', 'workflowImage.png')

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
    throw new Error('Benchmark window closed before becoming healthy.')
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || '')
  if (bodyText.includes('Renderer crashed') || bodyText.includes('Unexpected Application Error')) {
    throw new Error(`Renderer reported an unhealthy state: ${bodyText}`)
  }
  if (fatalErrors.length > 0) {
    throw new Error(`Benchmark renderer emitted fatal errors: ${fatalErrors.join(' | ')}`)
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
      throw new Error('WebGL benchmark expected a BrowserWindow instance.')
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

async function getCanvasImportInput(page) {
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

async function writeBenchmarkImages(tempRoot, count) {
  const source = getWorkflowImagePath()
  const paths = []
  for (let index = 0; index < count; index += 1) {
    const targetPath = path.join(
      tempRoot,
      `webgl-benchmark-${String(index + 1).padStart(2, '0')}.png`
    )
    await fs.copyFile(source, targetPath)
    paths.push(targetPath)
  }
  return paths
}

async function waitForBenchmarkMetrics(page, expectedImageCount) {
  await page.waitForSelector('.project-canvas-webgl-layer', { timeout: 60000 })
  try {
    await page.waitForFunction(
      (expectedCount) => {
        const root = document.querySelector('[data-testid="project-canvas-stage-root"]')
        if (!(root instanceof HTMLElement)) {
          return false
        }

        const snapshotText = root.dataset.projectCanvasMetricsSnapshot
        let snapshot = null
        try {
          snapshot = snapshotText ? JSON.parse(snapshotText) : null
        } catch {
          snapshot = null
        }

        const summaryText = root.dataset.projectCanvasRenderSurfaceSummary
        if (!snapshot && !summaryText) {
          return false
        }

        let summary
        try {
          summary = snapshot?.renderSurface || JSON.parse(summaryText)
        } catch {
          return false
        }

        const webglMetrics = snapshot?.webgl || null
        const loadedImageCount = Number(
          webglMetrics?.loadedImageCount ?? root.dataset.projectCanvasWebglLoadedImageCount ?? '0'
        )
        const residentCandidateImageCount = Number(
          webglMetrics?.residentCandidateImageCount ??
            root.dataset.projectCanvasWebglResidentCandidateImageCount ??
            '0'
        )
        const viewportCulledImageCount = Number(
          webglMetrics?.viewportCulledImageCount ??
            root.dataset.projectCanvasWebglViewportCulledImageCount ??
            '0'
        )
        const residentLimit = Number(
          webglMetrics?.residentLimit ?? root.dataset.projectCanvasWebglResidentLimit ?? '0'
        )
        const residentBudgetState =
          webglMetrics?.residentBudgetState || root.dataset.projectCanvasWebglResidentBudgetState || ''
        const renderCount = Number(
          webglMetrics?.renderCount ?? root.dataset.projectCanvasWebglRenderCount ?? '0'
        )
        const lastRenderDurationMs = Number(
          webglMetrics?.lastRenderDurationMs ??
            root.dataset.projectCanvasWebglLastRenderDurationMs ??
            ''
        )
        const webglCanvas = document.querySelector('.project-canvas-webgl-layer canvas')
        const expectedResidentCount =
          residentLimit > 0 ? Math.min(expectedCount, residentLimit) : expectedCount
        const expectedNonResidentProxyCount = Math.max(0, expectedCount - expectedResidentCount)
        const observedNonResidentProxyCount =
          Number(summary.budgetDowngradedImageItems || '0') +
          Number(summary.fallbackImageItems || '0')
        const hasWebglContext = Boolean(
          webglCanvas instanceof HTMLCanvasElement &&
          (webglCanvas.getContext('webgl2') || webglCanvas.getContext('webgl'))
        )

        return (
          hasWebglContext &&
          summary.webglImageItems >= expectedResidentCount &&
          observedNonResidentProxyCount === expectedNonResidentProxyCount &&
          loadedImageCount >= expectedResidentCount &&
          residentCandidateImageCount + viewportCulledImageCount === expectedCount &&
          ['available', 'full', 'count-full', 'texture-full'].includes(residentBudgetState) &&
          renderCount > 0 &&
          Number.isFinite(lastRenderDurationMs) &&
          lastRenderDurationMs > 0
        )
      },
      expectedImageCount,
      { timeout: BENCHMARK_METRIC_WAIT_TIMEOUT_MS }
    )
  } catch (error) {
    let observedMetrics = null
    try {
      observedMetrics = await readBenchmarkMetrics(page)
    } catch (metricsError) {
      observedMetrics = {
        error: metricsError instanceof Error ? metricsError.message : String(metricsError)
      }
    }

    throw new Error(
      `Timed out waiting for WebGL benchmark metrics after ${BENCHMARK_METRIC_WAIT_TIMEOUT_MS}ms. Expected images: ${expectedImageCount}. Observed metrics: ${JSON.stringify(observedMetrics)}. ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return readBenchmarkMetrics(page)
}

export function readProjectCanvasBenchmarkMetricsFromDomSnapshot(snapshotInput) {
  const { rootDataset, overlayDataset = {}, domNodeCount = 0, hasWebglContext = false } =
    snapshotInput
  const snapshotText = rootDataset.projectCanvasMetricsSnapshot
  let snapshot = null
  try {
    snapshot = snapshotText ? JSON.parse(snapshotText) : null
  } catch {
    snapshot = null
  }

  const summaryText = rootDataset.projectCanvasRenderSurfaceSummary || '{}'
  const summary = snapshot?.renderSurface || JSON.parse(summaryText)
  const webglMetrics = snapshot?.webgl || null
  const viewportMetrics = snapshot?.viewport || null

  return {
    summary,
    overlayMetrics: {
      overlayTotalCount: Number(overlayDataset.projectCanvasOverlayTotalCount || '0'),
      domOverlayCount: Number(overlayDataset.projectCanvasDomOverlayCount || '0'),
      canvas3DOverlayCount: Number(overlayDataset.projectCanvasCanvas3dOverlayCount || '0'),
      mountedVideoOverlayCount: Number(
        overlayDataset.projectCanvasMountedVideoOverlayCount || '0'
      ),
      htmlOverlayCount: Number(overlayDataset.projectCanvasHtmlOverlayCount || '0'),
      fileOverlayCount: Number(overlayDataset.projectCanvasFileOverlayCount || '0'),
      textOverlayCount: Number(overlayDataset.projectCanvasTextOverlayCount || '0'),
      annotationOverlayCount: Number(
        overlayDataset.projectCanvasAnnotationOverlayCount || '0'
      )
    },
    stageScale: Number(viewportMetrics?.scale ?? rootDataset.stageScale ?? '0'),
    stagePosX: Number(viewportMetrics?.x ?? rootDataset.stagePosX ?? '0'),
    stagePosY: Number(viewportMetrics?.y ?? rootDataset.stagePosY ?? '0'),
    reactCommits: Number(snapshot?.reactCommits ?? rootDataset.projectCanvasReactCommitCount ?? '0'),
    loadedImageCount: Number(
      webglMetrics?.loadedImageCount ?? rootDataset.projectCanvasWebglLoadedImageCount ?? '0'
    ),
    pendingImageCount: Number(
      webglMetrics?.pendingImageCount ?? rootDataset.projectCanvasWebglPendingImageCount ?? '0'
    ),
    failedImageCount: Number(
      webglMetrics?.failedImageCount ?? rootDataset.projectCanvasWebglFailedImageCount ?? '0'
    ),
    spriteCount: Number(
      webglMetrics?.spriteCount ?? rootDataset.projectCanvasWebglSpriteCount ?? '0'
    ),
    residentImageCount: Number(
      webglMetrics?.residentImageCount ?? rootDataset.projectCanvasWebglResidentImageCount ?? '0'
    ),
    residentCandidateImageCount: Number(
      webglMetrics?.residentCandidateImageCount ??
        rootDataset.projectCanvasWebglResidentCandidateImageCount ??
        '0'
    ),
    viewportCulledImageCount: Number(
      webglMetrics?.viewportCulledImageCount ??
        rootDataset.projectCanvasWebglViewportCulledImageCount ??
        '0'
    ),
    residentLimit: Number(
      webglMetrics?.residentLimit ?? rootDataset.projectCanvasWebglResidentLimit ?? '0'
    ),
    residentRemainingCapacity: Number(
      webglMetrics?.residentRemainingCapacity ??
        rootDataset.projectCanvasWebglResidentRemainingCapacity ??
        '0'
    ),
    residentBudgetState:
      webglMetrics?.residentBudgetState || rootDataset.projectCanvasWebglResidentBudgetState || '',
    residentTextureBytes: Number(
      webglMetrics?.residentTextureBytes ?? rootDataset.projectCanvasWebglResidentTextureBytes ?? '0'
    ),
    residentTextureBudgetBytes: Number(
      webglMetrics?.residentTextureBudgetBytes ??
        rootDataset.projectCanvasWebglResidentTextureBudgetBytes ??
        '0'
    ),
    missingImageCount: Number(
      webglMetrics?.missingImageCount ?? rootDataset.projectCanvasWebglMissingImageCount ?? '0'
    ),
    previewImageCount: Number(
      webglMetrics?.usingPreviewImageCount ??
        rootDataset.projectCanvasWebglUsingPreviewImageCount ??
        '0'
    ),
    sourceImageCount: Number(
      webglMetrics?.usingSourceImageCount ??
        rootDataset.projectCanvasWebglUsingSourceImageCount ??
        '0'
    ),
    sourceUpgradePendingImageCount: Number(
      webglMetrics?.sourceUpgradePendingImageCount ??
        rootDataset.projectCanvasWebglSourceUpgradePendingImageCount ??
        '0'
    ),
    sourceUpgradeFailedImageCount: Number(
      webglMetrics?.sourceUpgradeFailedImageCount ??
        rootDataset.projectCanvasWebglSourceUpgradeFailedImageCount ??
        '0'
    ),
    renderCount: Number(
      webglMetrics?.renderCount ?? rootDataset.projectCanvasWebglRenderCount ?? '0'
    ),
    lastRenderDurationMs: Number(
      webglMetrics?.lastRenderDurationMs ??
        rootDataset.projectCanvasWebglLastRenderDurationMs ??
        '0'
    ),
    lastUpdateReason:
      webglMetrics?.lastUpdateReason || rootDataset.projectCanvasWebglLastUpdateReason || '',
    domNodeCount,
    hasWebglContext
  }
}

async function readBenchmarkMetrics(page) {
  const snapshotInput = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="project-canvas-stage-root"]')
    if (!(root instanceof HTMLElement)) {
      throw new Error('ProjectCanvas stage root not found.')
    }

    const webglCanvas = document.querySelector('.project-canvas-webgl-layer canvas')
    const overlayRoot = document.querySelector('[data-project-canvas-overlay-total-count]')

    return {
      rootDataset: { ...root.dataset },
      overlayDataset: overlayRoot instanceof HTMLElement ? { ...overlayRoot.dataset } : {},
      domNodeCount: document.getElementsByTagName('*').length,
      hasWebglContext: Boolean(
        webglCanvas instanceof HTMLCanvasElement &&
        (webglCanvas.getContext('webgl2') || webglCanvas.getContext('webgl'))
      )
    }
  })
  return readProjectCanvasBenchmarkMetricsFromDomSnapshot(snapshotInput)
}

function getViewportCullUniverseCount(candidateMetrics) {
  return Math.max(
    Number(candidateMetrics?.summary?.imageItems || '0'),
    Number(candidateMetrics?.residentCandidateImageCount || '0') +
      Number(candidateMetrics?.viewportCulledImageCount || '0')
  )
}

function hasObservedViewportCull(candidateMetrics, totalImageCount) {
  const viewportCullUniverseCount = getViewportCullUniverseCount(candidateMetrics)
  const expectedUniverseCount =
    viewportCullUniverseCount > 0
      ? Math.min(totalImageCount, viewportCullUniverseCount)
      : totalImageCount
  return (
    candidateMetrics.viewportCulledImageCount > 0 &&
    candidateMetrics.residentCandidateImageCount < expectedUniverseCount &&
    candidateMetrics.residentCandidateImageCount + candidateMetrics.viewportCulledImageCount ===
      expectedUniverseCount
  )
}

function selectPreferredViewportCullMetrics(currentBestMetrics, candidateMetrics, totalImageCount) {
  if (!currentBestMetrics) {
    return candidateMetrics
  }

  const bestHasCull = hasObservedViewportCull(currentBestMetrics, totalImageCount)
  const candidateHasCull = hasObservedViewportCull(candidateMetrics, totalImageCount)
  if (candidateHasCull && !bestHasCull) {
    return candidateMetrics
  }
  if (bestHasCull && !candidateHasCull) {
    return currentBestMetrics
  }

  if (candidateMetrics.viewportCulledImageCount !== currentBestMetrics.viewportCulledImageCount) {
    return candidateMetrics.viewportCulledImageCount > currentBestMetrics.viewportCulledImageCount
      ? candidateMetrics
      : currentBestMetrics
  }

  if (
    candidateMetrics.residentCandidateImageCount !== currentBestMetrics.residentCandidateImageCount
  ) {
    return candidateMetrics.residentCandidateImageCount <
      currentBestMetrics.residentCandidateImageCount
      ? candidateMetrics
      : currentBestMetrics
  }

  if (candidateMetrics.renderCount !== currentBestMetrics.renderCount) {
    return candidateMetrics.renderCount > currentBestMetrics.renderCount
      ? candidateMetrics
      : currentBestMetrics
  }

  return candidateMetrics.lastRenderDurationMs < currentBestMetrics.lastRenderDurationMs
    ? candidateMetrics
    : currentBestMetrics
}

async function waitForViewportCullObservation(page, previousRenderCount, totalImageCount) {
  try {
    await page.waitForFunction(
      (expectedRenderCount) => {
        const root = document.querySelector('[data-testid="project-canvas-stage-root"]')
        return (
          root instanceof HTMLElement &&
          Number(root.dataset.projectCanvasWebglRenderCount || '0') > expectedRenderCount
        )
      },
      previousRenderCount,
      { timeout: 10000 }
    )
  } catch {
    // Keep polling below so slower build-mode updates still have a chance to settle.
  }

  const deadline = Date.now() + 2000
  let observedMetrics = await readBenchmarkMetrics(page)
  let bestMetrics = observedMetrics
  while (Date.now() <= deadline) {
    if (hasObservedViewportCull(observedMetrics, totalImageCount)) {
      return {
        metrics: observedMetrics,
        bestMetrics
      }
    }

    await page.waitForTimeout(120)
    observedMetrics = await readBenchmarkMetrics(page)
    bestMetrics = selectPreferredViewportCullMetrics(bestMetrics, observedMetrics, totalImageCount)
  }

  return {
    metrics: observedMetrics,
    bestMetrics
  }
}

async function zoomUntilViewportCull(page, totalImageCount) {
  const stageRoot = page.locator('[data-testid="project-canvas-stage-root"]').first()
  const stageBounds = await stageRoot.boundingBox()
  if (!stageBounds) {
    throw new Error('Unable to determine ProjectCanvas stage bounds for the culling benchmark.')
  }

  const centerX = stageBounds.x + stageBounds.width / 2
  const centerY = stageBounds.y + stageBounds.height / 2
  await page.mouse.move(centerX, centerY)

  let metrics = await readBenchmarkMetrics(page)
  let bestMetrics = metrics
  let zoomStepsApplied = 0

  for (let round = 0; round < 6; round += 1) {
    if (hasObservedViewportCull(metrics, totalImageCount)) {
      return {
        metrics,
        zoomStepsApplied
      }
    }

    const previousRenderCount = metrics.renderCount
    for (let step = 0; step < 4; step += 1) {
      await page.mouse.wheel(0, -120)
      zoomStepsApplied += 1
    }

    const observation = await waitForViewportCullObservation(
      page,
      previousRenderCount,
      totalImageCount
    )
    metrics = observation.metrics
    bestMetrics = selectPreferredViewportCullMetrics(
      bestMetrics,
      observation.bestMetrics,
      totalImageCount
    )
    if (hasObservedViewportCull(bestMetrics, totalImageCount)) {
      return {
        metrics: bestMetrics,
        zoomStepsApplied
      }
    }
  }

  if (hasObservedViewportCull(metrics, totalImageCount)) {
    return {
      metrics,
      zoomStepsApplied
    }
  }

  if (hasObservedViewportCull(bestMetrics, totalImageCount)) {
    return {
      metrics: bestMetrics,
      zoomStepsApplied
    }
  }

  throw new Error(
    `WebGL benchmark did not observe viewport image culling after adaptive zoom. Best metrics: ${JSON.stringify(bestMetrics)}`
  )
}

async function runInteractionBenchmark(page, sampleCount) {
  const stageRoot = page.locator('[data-testid="project-canvas-stage-root"]').first()
  const stageBounds = await stageRoot.boundingBox()
  if (!stageBounds) {
    throw new Error('Unable to determine ProjectCanvas stage bounds for the interaction benchmark.')
  }

  const centerX = stageBounds.x + stageBounds.width / 2
  const centerY = stageBounds.y + stageBounds.height / 2
  await page.mouse.move(centerX, centerY)

  const samples = []
  let previousRenderCount = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="project-canvas-stage-root"]')
    return root instanceof HTMLElement
      ? Number(root.dataset.projectCanvasWebglRenderCount || '0')
      : 0
  })

  for (let index = 0; index < sampleCount; index += 1) {
    await page.mouse.wheel(0, index % 2 === 0 ? -120 : 120)
    await page.waitForFunction(
      (expectedRenderCount) => {
        const root = document.querySelector('[data-testid="project-canvas-stage-root"]')
        return (
          root instanceof HTMLElement &&
          Number(root.dataset.projectCanvasWebglRenderCount || '0') > expectedRenderCount
        )
      },
      previousRenderCount,
      { timeout: 10000 }
    )
    await page.waitForTimeout(100)

    const sample = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="project-canvas-stage-root"]')
      if (!(root instanceof HTMLElement)) {
        throw new Error('ProjectCanvas stage root not found during the interaction benchmark.')
      }

      return {
        renderCount: Number(root.dataset.projectCanvasWebglRenderCount || '0'),
        stageScale: Number(root.dataset.stageScale || '0'),
        stagePosX: Number(root.dataset.stagePosX || '0'),
        stagePosY: Number(root.dataset.stagePosY || '0'),
        lastRenderDurationMs: Number(root.dataset.projectCanvasWebglLastRenderDurationMs || '0'),
        lastUpdateReason: root.dataset.projectCanvasWebglLastUpdateReason || '',
        domNodeCount: document.getElementsByTagName('*').length,
        residentTextureBytes: Number(root.dataset.projectCanvasWebglResidentTextureBytes || '0')
      }
    })

    previousRenderCount = sample.renderCount
    samples.push(sample)
  }

  const renderDurations = samples
    .map((sample) => sample.lastRenderDurationMs)
    .filter((duration) => Number.isFinite(duration) && duration > 0)

  if (renderDurations.length === 0) {
    throw new Error('Interaction benchmark did not collect any valid WebGL render durations.')
  }

  const averageRenderDurationMs =
    renderDurations.reduce((total, value) => total + value, 0) / renderDurations.length
  const sortedRenderDurations = [...renderDurations].sort((left, right) => left - right)
  const percentileRenderDuration = (percentile) => {
    const index = Math.min(
      sortedRenderDurations.length - 1,
      Math.max(0, Math.ceil((percentile / 100) * sortedRenderDurations.length) - 1)
    )
    return sortedRenderDurations[index]
  }
  const maxRenderDurationMs = Math.max(...renderDurations)
  const minRenderDurationMs = Math.min(...renderDurations)
  const steadyStateFps =
    averageRenderDurationMs > 0 ? Number((1000 / averageRenderDurationMs).toFixed(2)) : 0

  return {
    sampleCount: samples.length,
    averageRenderDurationMs: Number(averageRenderDurationMs.toFixed(4)),
    p50RenderDurationMs: Number(percentileRenderDuration(50).toFixed(4)),
    p95RenderDurationMs: Number(percentileRenderDuration(95).toFixed(4)),
    p99RenderDurationMs: Number(percentileRenderDuration(99).toFixed(4)),
    maxRenderDurationMs: Number(maxRenderDurationMs.toFixed(4)),
    minRenderDurationMs: Number(minRenderDurationMs.toFixed(4)),
    maxDomNodeCount: Math.max(...samples.map((sample) => sample.domNodeCount || 0)),
    maxResidentTextureBytes: Math.max(...samples.map((sample) => sample.residentTextureBytes || 0)),
    steadyStateFps,
    samples
  }
}

export async function runWebglBenchmark() {
let appHandle = null
let tempRoot = null
let artifactRoot = null

try {
  artifactRoot = resolveProjectCanvasArtifactRoot(BENCHMARK_RUN_ID)
  await fs.mkdir(artifactRoot, { recursive: true })
  tempRoot = await fs.mkdtemp(path.join(artifactRoot, 'magicpot-webgl-benchmark-'))
  const userDataDir = path.join(tempRoot, 'user-data')
  await writeSmokeConfig(userDataDir)

  appHandle = await launchApp(userDataDir)
  const { page, fatalErrors } = appHandle
  await navigateToHash(page, '#/canvas?id=webgl-benchmark')
  await waitForHealthyPage(page, fatalErrors)

  const benchmarkImages = await writeBenchmarkImages(tempRoot, BENCHMARK_IMAGE_COUNT)
  const importInput = await getCanvasImportInput(page)
  await importInput.setInputFiles(benchmarkImages, { timeout: 30000 })
  await page.waitForTimeout(2500)

  const metrics = await waitForBenchmarkMetrics(page, benchmarkImages.length)
  const cullingBenchmark = await zoomUntilViewportCull(page, benchmarkImages.length)
  const interactionBenchmark = await runInteractionBenchmark(
    page,
    BENCHMARK_INTERACTION_SAMPLE_COUNT
  )
  const windowPlacement = await readWindowPlacement(appHandle.app)
  assertNonIntrusiveWindowPlacement(windowPlacement, 'WebGL benchmark')
  const payload = {
    benchmarkImageCount: benchmarkImages.length,
    windowPlacement,
    ...metrics,
    zoomedMetrics: cullingBenchmark.metrics,
    zoomStepsApplied: cullingBenchmark.zoomStepsApplied,
    initialLoadDerivedFps:
      metrics.lastRenderDurationMs > 0
        ? Number((1000 / metrics.lastRenderDurationMs).toFixed(2))
        : 0,
    interactionBenchmark
  }

  await fs.writeFile(
    path.join(artifactRoot, 'webgl-benchmark-report.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  )
  console.log(JSON.stringify(payload, null, 2))

  if (
    !metrics.hasWebglContext ||
    metrics.summary.webglImageItems <
      Math.min(benchmarkImages.length, metrics.residentLimit || benchmarkImages.length) ||
    Number(metrics.summary.budgetDowngradedImageItems || 0) + metrics.summary.fallbackImageItems !==
      Math.max(0, benchmarkImages.length - (metrics.residentLimit || benchmarkImages.length)) ||
    payload.zoomedMetrics.viewportCulledImageCount <= 0 ||
    payload.zoomedMetrics.residentCandidateImageCount >=
      getViewportCullUniverseCount(payload.zoomedMetrics) ||
    payload.zoomedMetrics.residentCandidateImageCount +
      payload.zoomedMetrics.viewportCulledImageCount !==
      getViewportCullUniverseCount(payload.zoomedMetrics) ||
    interactionBenchmark.steadyStateFps <= 60
  ) {
    process.exitCode = 1
  }
} catch (error) {
  if (artifactRoot) {
    try {
      await fs.writeFile(
        path.join(artifactRoot, 'webgl-benchmark-error.txt'),
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
      : `Unknown benchmark error: ${String(error)}`
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWebglBenchmark()
}
