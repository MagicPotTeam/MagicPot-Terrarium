/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { _electron as electron } from 'playwright'
import {
  assessNonIntrusiveWindowPlacement,
  assertNonIntrusiveWindowPlacement,
  buildNonIntrusiveTestWindowEnv,
  resolveProjectCanvasArtifactRoot,
  resolveProjectCanvasBenchmarkRunId,
  sanitizeProjectCanvasRunId
} from './benchmarkPolicy.mjs'

function parseNonNegativeIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseFractionEnv(name, fallback) {
  const parsed = Number.parseFloat(process.env[name] || '')
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback
}

const ELECTRON_LAUNCH_TIMEOUT_MS = 90000
const FIRST_WINDOW_TIMEOUT_MS = 90000
const HEALTH_TIMEOUT_MS = 120000
const METRIC_WAIT_TIMEOUT_MS = Math.max(
  10000,
  Number.parseInt(process.env.MAGICPOT_REAL_BOARD_WAIT_MS || '180000', 10) || 180000
)
const BENCHMARK_RUN_ID = resolveProjectCanvasBenchmarkRunId('real-board-benchmark')
const NON_INTRUSIVE_TEST_WINDOW_ENV = buildNonIntrusiveTestWindowEnv(BENCHMARK_RUN_ID)
const REAL_BOARD_IMAGE_COUNT = Math.max(
  1,
  Number.parseInt(process.env.MAGICPOT_REAL_BOARD_IMAGE_COUNT || '300', 10) || 300
)
const REAL_BOARD_IMPORT_BATCH_SIZE = parseNonNegativeIntegerEnv(
  'MAGICPOT_REAL_BOARD_IMPORT_BATCH_SIZE',
  0
)
const REAL_BOARD_IMPORT_BATCH_SETTLE_MS = Math.max(
  0,
  parseNonNegativeIntegerEnv('MAGICPOT_REAL_BOARD_IMPORT_BATCH_SETTLE_MS', 500)
)
const REAL_BOARD_IMPORT_BATCH_WAIT_METRICS = /^(1|true|yes)$/i.test(
  `${process.env.MAGICPOT_REAL_BOARD_IMPORT_BATCH_WAIT_METRICS || ''}`.trim()
)
const REAL_BOARD_MODE = `${process.env.MAGICPOT_REAL_BOARD_MODE || 'mixed'}`.trim().toLowerCase()
const SUPPORTED_REAL_BOARD_MODES = new Set(['import', 'seeded-hires', 'mixed'])
const SUPPORTED_REAL_BOARD_CACHE_PASSES = new Set(['cold-cache', 'warm-cache'])
const REAL_BOARD_IMAGE_DIRS = `${process.env.MAGICPOT_REAL_BOARD_IMAGE_DIRS || ''}`.trim()
const REAL_BOARD_CORPUS_LABELS = `${process.env.MAGICPOT_REAL_BOARD_CORPUS_LABELS || ''}`.trim()
const REAL_BOARD_CACHE_PASSES = resolveRealBoardCachePasses({
  configuredValue: process.env.MAGICPOT_REAL_BOARD_CACHE_PASSES,
  scenarioMode: REAL_BOARD_MODE,
  hasConfiguredRealCorpus: Boolean(
    REAL_BOARD_IMAGE_DIRS || `${process.env.MAGICPOT_REAL_BOARD_IMAGE_DIR || ''}`.trim()
  )
})
const REAL_BOARD_ALLOW_REPEAT = /^(1|true|yes)$/i.test(
  `${process.env.MAGICPOT_REAL_BOARD_ALLOW_REPEAT || ''}`.trim()
)
const repeatMinUniqueFractionRaw = Number.parseFloat(
  process.env.MAGICPOT_REAL_BOARD_REPEAT_MIN_UNIQUE_FRACTION || '0.5'
)
const REAL_BOARD_REPEAT_MIN_UNIQUE_FRACTION = Math.min(
  1,
  Math.max(0, Number.isFinite(repeatMinUniqueFractionRaw) ? repeatMinUniqueFractionRaw : 0.5)
)
const REAL_BOARD_REPEAT_MIN_UNIQUE_IMAGE_COUNT = parseNonNegativeIntegerEnv(
  'MAGICPOT_REAL_BOARD_REPEAT_MIN_UNIQUE_IMAGE_COUNT',
  0
)
const REAL_BOARD_HOT_PATH_REACT_COMMIT_LIMIT = Math.max(
  0,
  Number.parseInt(process.env.MAGICPOT_REAL_BOARD_HOT_PATH_REACT_COMMIT_LIMIT || '2', 10) || 2
)
const REAL_BOARD_POST_IDLE_REACT_COMMIT_LIMIT = parseNonNegativeIntegerEnv(
  'MAGICPOT_REAL_BOARD_POST_IDLE_REACT_COMMIT_LIMIT',
  8
)
const REAL_BOARD_WARM_CACHE_GENERATED_LIMIT = parseNonNegativeIntegerEnv(
  'MAGICPOT_REAL_BOARD_WARM_CACHE_GENERATED_LIMIT',
  1
)
const realBoardFrameP95LimitRaw = Number.parseFloat(
  process.env.MAGICPOT_REAL_BOARD_FRAME_P95_LIMIT_MS || '24'
)
const REAL_BOARD_FRAME_P95_LIMIT_MS = Math.max(
  0,
  Number.isFinite(realBoardFrameP95LimitRaw) ? realBoardFrameP95LimitRaw : 24
)
const REAL_BOARD_BURST_MS = Math.max(
  100,
  Number.parseInt(process.env.MAGICPOT_REAL_BOARD_BURST_MS || '500', 10) || 500
)
const REAL_BOARD_PRESSURE_DURATION_MS = parseNonNegativeIntegerEnv(
  'MAGICPOT_REAL_BOARD_PRESSURE_DURATION_MS',
  0
)
const REAL_BOARD_PRESSURE_CONFIGURED = REAL_BOARD_PRESSURE_DURATION_MS > 0
const REAL_BOARD_PRESSURE_SAMPLE_INTERVAL_MS = Math.max(
  50,
  parseNonNegativeIntegerEnv('MAGICPOT_REAL_BOARD_PRESSURE_SAMPLE_INTERVAL_MS', 500)
)
const REAL_BOARD_PRESSURE_SUSTAINED_SAMPLE_COUNT = Math.max(
  3,
  parseNonNegativeIntegerEnv('MAGICPOT_REAL_BOARD_PRESSURE_SUSTAINED_SAMPLE_COUNT', 4)
)
const REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_BYTES = parseNonNegativeIntegerEnv(
  'MAGICPOT_REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_BYTES',
  16 * 1024 * 1024
)
const REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_COUNT = parseNonNegativeIntegerEnv(
  'MAGICPOT_REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_COUNT',
  32
)
const BENCHMARK_MEMORY_WATCHDOG_ENABLED = !/^(0|false|no)$/i.test(
  `${process.env.MAGICPOT_BENCHMARK_MEMORY_WATCHDOG || '1'}`.trim()
)
const BENCHMARK_MEMORY_SOFT_LIMIT_FRACTION = parseFractionEnv(
  'MAGICPOT_BENCHMARK_MEMORY_SOFT_LIMIT_FRACTION',
  0.75
)
const BENCHMARK_MEMORY_HARD_LIMIT_FRACTION = Math.max(
  BENCHMARK_MEMORY_SOFT_LIMIT_FRACTION,
  parseFractionEnv('MAGICPOT_BENCHMARK_MEMORY_HARD_LIMIT_FRACTION', 0.8)
)
const BENCHMARK_MEMORY_SAMPLE_INTERVAL_MS = Math.max(
  250,
  parseNonNegativeIntegerEnv('MAGICPOT_BENCHMARK_MEMORY_SAMPLE_INTERVAL_MS', 1000)
)
const BENCHMARK_MEMORY_SAMPLE_LIMIT = Math.max(
  10,
  parseNonNegativeIntegerEnv('MAGICPOT_BENCHMARK_MEMORY_SAMPLE_LIMIT', 120)
)
const REAL_BOARD_METRICS_SETTLE_MS = 370
const PROCESS_CLEANUP_TIMEOUT_MS = Math.max(
  2000,
  Number.parseInt(process.env.MAGICPOT_BENCHMARK_PROCESS_CLEANUP_TIMEOUT_MS || '10000', 10) || 10000
)
const REAL_BOARD_SOURCE_UPGRADE_WAIT_MS = Math.max(
  2000,
  Number.parseInt(process.env.MAGICPOT_REAL_BOARD_SOURCE_UPGRADE_WAIT_MS || '15000', 10) || 15000
)
const REAL_BOARD_TINY_ZOOM_ENABLED = !/^(0|false|no)$/i.test(
  `${process.env.MAGICPOT_REAL_BOARD_TINY_ZOOM_ENABLED || '1'}`.trim()
)
const REAL_BOARD_TINY_ZOOM_MIN_SCALE = Math.max(
  0.0001,
  Number.parseFloat(process.env.MAGICPOT_REAL_BOARD_TINY_ZOOM_MIN_SCALE || '0.0005') || 0.0005
)
const REAL_BOARD_TINY_ZOOM_MAX_SCALE = Math.max(
  REAL_BOARD_TINY_ZOOM_MIN_SCALE,
  Number.parseFloat(process.env.MAGICPOT_REAL_BOARD_TINY_ZOOM_MAX_SCALE || '0.0015') || 0.0015
)
const REAL_BOARD_TINY_ZOOM_TARGET_SCALE = Math.min(
  REAL_BOARD_TINY_ZOOM_MAX_SCALE,
  Math.max(
    REAL_BOARD_TINY_ZOOM_MIN_SCALE,
    Number.parseFloat(process.env.MAGICPOT_REAL_BOARD_TINY_ZOOM_TARGET_SCALE || '0.001') || 0.001
  )
)
const REAL_BOARD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE = Math.max(
  REAL_BOARD_TINY_ZOOM_MAX_SCALE,
  Number.parseFloat(
    process.env.MAGICPOT_REAL_BOARD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE || '0.15'
  ) || 0.15
)
const INTERACTION_SAMPLE_COUNT = Math.max(
  4,
  Number.parseInt(process.env.MAGICPOT_REAL_BOARD_SAMPLES || '12', 10) || 12
)
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
  '.ico',
  '.tif',
  '.tiff'
])
const SEEDED_HIRES_IMAGE_SIZE = 1536
const SEEDED_HIRES_BLOCK_SIZE = 64
const FORBIDDEN_CORPUS_PATH_SEGMENTS = new Set([
  '.magicpot-trash',
  'magicpot-dev-trash',
  'codex-trash'
])
const execFileAsync = promisify(execFile)

let crcTable = null

function formatByteCount(value) {
  if (!Number.isFinite(value) || value < 0) {
    return 'unknown'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let normalized = value
  let unitIndex = 0
  while (normalized >= 1024 && unitIndex < units.length - 1) {
    normalized /= 1024
    unitIndex += 1
  }
  return `${normalized.toFixed(unitIndex === 0 ? 0 : 2)}${units[unitIndex]}`
}

function formatPercentFraction(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unknown'
}

function readSystemMemorySnapshot(reason, activeElectronPids = [], currentOperation = null) {
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  const usedFraction = totalBytes > 0 ? usedBytes / totalBytes : 0
  const nodeMemory = process.memoryUsage()

  return {
    reason,
    capturedAt: new Date().toISOString(),
    totalBytes,
    freeBytes,
    usedBytes,
    usedFraction: Number(usedFraction.toFixed(6)),
    usedPercent: Number((usedFraction * 100).toFixed(2)),
    node: {
      rssBytes: nodeMemory.rss,
      heapTotalBytes: nodeMemory.heapTotal,
      heapUsedBytes: nodeMemory.heapUsed,
      externalBytes: nodeMemory.external,
      arrayBuffersBytes: nodeMemory.arrayBuffers
    },
    activeElectronPids,
    currentOperation
  }
}

class BenchmarkMemoryLimitError extends Error {
  constructor(limitType, snapshot, thresholds) {
    const limitFraction =
      limitType === 'hard' ? thresholds.hardLimitFraction : thresholds.softLimitFraction
    super(
      `Benchmark memory ${limitType} limit reached: system memory ${formatPercentFraction(
        snapshot.usedFraction
      )} used (${formatByteCount(snapshot.usedBytes)} / ${formatByteCount(
        snapshot.totalBytes
      )}), limit ${formatPercentFraction(limitFraction)}.`
    )
    this.name = 'BenchmarkMemoryLimitError'
    this.limitType = limitType
    this.snapshot = snapshot
    this.thresholds = thresholds
  }
}

class BenchmarkMemoryWatchdog {
  constructor({ enabled, softLimitFraction, hardLimitFraction, sampleIntervalMs, sampleLimit }) {
    this.enabled = enabled
    this.softLimitFraction = softLimitFraction
    this.hardLimitFraction = hardLimitFraction
    this.sampleIntervalMs = sampleIntervalMs
    this.sampleLimit = sampleLimit
    this.samples = []
    this.peak = null
    this.latest = null
    this.tripped = null
    this.timer = null
    this.currentOperation = null
    this.activeAppHandles = new Map()
    this.tripPromise = new Promise((resolve) => {
      this.resolveTrip = resolve
    })
  }

  get thresholds() {
    return {
      softLimitFraction: this.softLimitFraction,
      hardLimitFraction: this.hardLimitFraction,
      sampleIntervalMs: this.sampleIntervalMs
    }
  }

  getActiveElectronPids() {
    const pids = []
    for (const appHandle of this.activeAppHandles.keys()) {
      try {
        const pid = appHandle?.app?.process?.()?.pid
        if (Number.isInteger(pid) && pid > 0) {
          pids.push(pid)
        }
      } catch {
        // Process attribution is best-effort; the memory cap still uses system memory.
      }
    }
    return [...new Set(pids)]
  }

  start() {
    if (!this.enabled || this.timer) {
      return
    }
    this.capture('watchdog-start')
    this.timer = setInterval(() => {
      try {
        this.capture('watchdog-interval')
      } catch {
        // Never let watchdog telemetry hide the benchmark's real failure.
      }
    }, this.sampleIntervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
    this.capture('watchdog-stop')
  }

  registerAppHandle(appHandle, userDataDir) {
    if (appHandle) {
      this.activeAppHandles.set(appHandle, userDataDir)
      this.capture('register-electron-app')
    }
  }

  unregisterAppHandle(appHandle) {
    if (appHandle && this.activeAppHandles.delete(appHandle)) {
      this.capture('unregister-electron-app')
    }
  }

  capture(reason) {
    if (!this.enabled) {
      return null
    }

    const snapshot = readSystemMemorySnapshot(
      reason,
      this.getActiveElectronPids(),
      this.currentOperation
    )
    this.latest = snapshot
    if (!this.peak || snapshot.usedBytes > this.peak.usedBytes) {
      this.peak = snapshot
    }
    this.samples.push(snapshot)
    if (this.samples.length > this.sampleLimit) {
      this.samples.splice(0, this.samples.length - this.sampleLimit)
    }

    if (snapshot.usedFraction >= this.hardLimitFraction && this.tripped?.limitType !== 'hard') {
      this.trip('hard', snapshot)
    } else if (!this.tripped && snapshot.usedFraction >= this.softLimitFraction) {
      this.trip('soft', snapshot)
    }

    return snapshot
  }

  trip(limitType, snapshot) {
    const error = new BenchmarkMemoryLimitError(limitType, snapshot, this.thresholds)
    this.tripped = {
      limitType,
      snapshot,
      message: error.message
    }
    this.resolveTrip(error)

    if (limitType === 'hard') {
      this.forceCleanupActiveApps()
    }
  }

  forceCleanupActiveApps() {
    for (const [appHandle, userDataDir] of this.activeAppHandles.entries()) {
      let childProcessId = null
      try {
        const childProcess = appHandle?.app?.process?.()
        childProcessId = Number.isInteger(childProcess?.pid) ? childProcess.pid : null
        childProcess?.kill?.()
      } catch {
        // Fall through to process-tree cleanup.
      }

      void stopProcessTree(childProcessId).catch(() => {})
      if (userDataDir) {
        void stopResidualElectronProcesses(userDataDir).catch(() => {})
      }
    }
  }

  async guard(label, operation) {
    if (!this.enabled) {
      return operation()
    }

    const previousOperation = this.currentOperation
    this.currentOperation = label
    try {
      this.throwIfTripped(label)
      const operationPromise = Promise.resolve().then(operation)
      operationPromise.catch(() => {})
      return await Promise.race([
        operationPromise,
        this.waitForTrip().then((error) => {
          throw error
        })
      ])
    } finally {
      if (this.currentOperation === label) {
        this.currentOperation = previousOperation
      }
    }
  }

  waitForTrip() {
    return this.tripped
      ? Promise.resolve(
          new BenchmarkMemoryLimitError(
            this.tripped.limitType,
            this.tripped.snapshot,
            this.thresholds
          )
        )
      : this.tripPromise
  }

  throwIfTripped(label) {
    if (!this.enabled) {
      return
    }
    const snapshot = this.capture(label)
    if (this.tripped) {
      throw new BenchmarkMemoryLimitError(
        this.tripped.limitType,
        snapshot ?? this.tripped.snapshot,
        this.thresholds
      )
    }
  }

  getReport() {
    return {
      enabled: this.enabled,
      thresholds: this.thresholds,
      tripped: this.tripped,
      latest: this.latest,
      peak: this.peak,
      samples: this.samples
    }
  }
}

const BENCHMARK_MEMORY_WATCHDOG = new BenchmarkMemoryWatchdog({
  enabled: BENCHMARK_MEMORY_WATCHDOG_ENABLED,
  softLimitFraction: BENCHMARK_MEMORY_SOFT_LIMIT_FRACTION,
  hardLimitFraction: BENCHMARK_MEMORY_HARD_LIMIT_FRACTION,
  sampleIntervalMs: BENCHMARK_MEMORY_SAMPLE_INTERVAL_MS,
  sampleLimit: BENCHMARK_MEMORY_SAMPLE_LIMIT
})

function getCrcTable() {
  if (crcTable) {
    return crcTable
  }

  crcTable = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    crcTable[index] = value >>> 0
  }
  return crcTable
}

function crc32(buffer) {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBuffer.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return chunk
}

function buildSyntheticPngBuffer(width, height, seed) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1)
    raw[rowOffset] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 4
      const blockX = Math.floor(x / SEEDED_HIRES_BLOCK_SIZE)
      const blockY = Math.floor(y / SEEDED_HIRES_BLOCK_SIZE)
      const block =
        (Math.imul(blockX + 1, 73856093) ^
          Math.imul(blockY + 1, 19349663) ^
          Math.imul(seed + 1, 83492791)) >>>
        0
      raw[offset] = (block ^ (block >>> 11) ^ Math.imul(seed + 1, 2654435761)) & 0xff
      raw[offset + 1] = (block >>> 8) & 0xff
      raw[offset + 2] = (block >>> 16) & 0xff
      raw[offset + 3] = 255
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from(`MagicPotSeed\0${seed}`, 'utf8')),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    pngChunk('IEND')
  ])
}

async function writeSeededHiresImages(rootDir, count) {
  await fs.mkdir(rootDir, { recursive: true })
  const files = []
  for (let index = 0; index < count; index += 1) {
    if (index % 4 === 0) {
      BENCHMARK_MEMORY_WATCHDOG.throwIfTripped(`write-seeded-hires:${index}`)
    }
    const target = path.join(rootDir, `seeded-hires-${String(index + 1).padStart(4, '0')}.png`)
    await fs.writeFile(
      target,
      buildSyntheticPngBuffer(SEEDED_HIRES_IMAGE_SIZE, SEEDED_HIRES_IMAGE_SIZE, index + 1)
    )
    files.push(target)
  }
  return files
}

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
    throw new Error('Real board benchmark window closed before becoming healthy.')
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
    const text = message.text()
    if (/Maximum update depth exceeded/i.test(text)) {
      fatalErrors.push(`console:${message.type()}: ${text}`)
      return
    }
    if (message.type() !== 'error') {
      return
    }
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
      throw new Error('Real board benchmark expected a BrowserWindow instance.')
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
      minimized: mainWindow.isMinimized(),
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

function buildImportFileBatches(stagedImages) {
  const batchSize =
    REAL_BOARD_IMPORT_BATCH_SIZE > 0
      ? Math.min(REAL_BOARD_IMPORT_BATCH_SIZE, stagedImages.length)
      : stagedImages.length
  const batches = []
  for (let start = 0; start < stagedImages.length; start += batchSize) {
    batches.push(stagedImages.slice(start, start + batchSize))
  }
  return {
    enabled: batches.length > 1,
    batchSize,
    batchCount: batches.length,
    batches
  }
}

async function importBenchmarkImageFiles(page, stagedImages, scenarioName) {
  const plan = buildImportFileBatches(stagedImages)
  let importedCount = 0

  for (let batchIndex = 0; batchIndex < plan.batches.length; batchIndex += 1) {
    const batch = plan.batches[batchIndex]
    const batchLabel = `${scenarioName}:import-batch-${batchIndex + 1}-of-${plan.batchCount}`
    const importInput = await BENCHMARK_MEMORY_WATCHDOG.guard(`${batchLabel}:find-input`, () =>
      getCanvasImportInput(page)
    )
    await BENCHMARK_MEMORY_WATCHDOG.guard(`${batchLabel}:set-input-files`, () =>
      importInput.setInputFiles(batch, { timeout: 60000 })
    )
    importedCount += batch.length

    if (REAL_BOARD_IMPORT_BATCH_SETTLE_MS > 0) {
      await BENCHMARK_MEMORY_WATCHDOG.guard(`${batchLabel}:settle`, () =>
        page.waitForTimeout(REAL_BOARD_IMPORT_BATCH_SETTLE_MS)
      )
    }

    if (plan.enabled && REAL_BOARD_IMPORT_BATCH_WAIT_METRICS) {
      await BENCHMARK_MEMORY_WATCHDOG.guard(`${batchLabel}:wait-metrics`, () =>
        waitForBenchmarkMetrics(page, importedCount)
      )
    }
  }

  return {
    enabled: plan.enabled,
    configuredBatchSize: REAL_BOARD_IMPORT_BATCH_SIZE,
    waitForMetricsBetweenBatches: REAL_BOARD_IMPORT_BATCH_WAIT_METRICS,
    batchSize: plan.batchSize,
    batchCount: plan.batchCount,
    importedCount
  }
}

async function collectImageFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectImageFiles(absolutePath)))
      continue
    }

    if (entry.isFile() && SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolutePath)
    }
  }

  return files.sort((left, right) => left.localeCompare(right))
}

function splitEnvList(value) {
  return `${value || ''}`
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function splitFlexibleEnvList(value) {
  return `${value || ''}`
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function resolveRealBoardCachePasses({
  configuredValue,
  scenarioMode,
  hasConfiguredRealCorpus
}) {
  const configuredPasses = splitFlexibleEnvList(configuredValue).map((entry) =>
    sanitizeProjectCanvasRunId(entry, '').toLowerCase()
  )
  const defaultPasses =
    scenarioMode === 'seeded-hires' || !hasConfiguredRealCorpus
      ? ['cold-cache']
      : ['cold-cache', 'warm-cache']
  const candidatePasses = configuredPasses.length > 0 ? configuredPasses : defaultPasses
  const uniquePasses = []
  for (const cachePass of candidatePasses) {
    if (!SUPPORTED_REAL_BOARD_CACHE_PASSES.has(cachePass)) {
      throw new Error(
        `Unsupported MAGICPOT_REAL_BOARD_CACHE_PASSES entry=${cachePass}. Expected cold-cache and/or warm-cache.`
      )
    }
    if (!uniquePasses.includes(cachePass)) {
      uniquePasses.push(cachePass)
    }
  }

  if (uniquePasses.length === 0) {
    throw new Error('Real-board benchmark must run at least one cache pass.')
  }
  if (uniquePasses.includes('warm-cache') && !uniquePasses.includes('cold-cache')) {
    throw new Error('warm-cache real-board acceptance requires a preceding cold-cache pass.')
  }

  return uniquePasses
}

function isWarmCachePass(cachePass) {
  return cachePass === 'warm-cache'
}

function isSameOrInsidePath(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function validateRealCorpusRoot(rootDir) {
  const resolvedRoot = path.resolve(rootDir)
  const normalizedSegments = resolvedRoot
    .split(path.sep)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
  const workspaceRoot = path.resolve(process.cwd())

  if (normalizedSegments.some((segment) => FORBIDDEN_CORPUS_PATH_SEGMENTS.has(segment))) {
    throw new Error(
      `Refusing to use benchmark artifact/trash directory as a real-board corpus: ${resolvedRoot}`
    )
  }
  if (path.basename(resolvedRoot).toLowerCase() === 'baidusyncdisk') {
    throw new Error(
      `Refusing to use the broad BaiduSyncdisk root as a real-board corpus: ${resolvedRoot}`
    )
  }
  if (
    isSameOrInsidePath(workspaceRoot, resolvedRoot) ||
    isSameOrInsidePath(resolvedRoot, workspaceRoot)
  ) {
    throw new Error(
      `Refusing to use the MagicPot workspace as a real-board corpus: ${resolvedRoot}`
    )
  }

  return resolvedRoot
}

function summarizeNumberValues(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value) && value >= 0)
  if (finiteValues.length === 0) {
    return {
      min: 0,
      p50: 0,
      p95: 0,
      max: 0,
      total: 0
    }
  }

  return {
    min: Math.min(...finiteValues),
    p50: percentile(finiteValues, 50),
    p95: percentile(finiteValues, 95),
    max: Math.max(...finiteValues),
    total: finiteValues.reduce((total, value) => total + value, 0)
  }
}

function buildDefaultCorpusLabel(sourceImageDir) {
  return sanitizeProjectCanvasRunId(
    path.basename(path.resolve(sourceImageDir || 'seeded-hires')),
    'real-corpus'
  )
}

function parseCorpusConfigs() {
  if (REAL_BOARD_MODE === 'seeded-hires') {
    return [
      {
        corpusLabel: 'seeded-hires',
        sourceImageDir: null
      }
    ]
  }

  const configuredDirs = splitEnvList(REAL_BOARD_IMAGE_DIRS)
  if (configuredDirs.length === 0) {
    const singleDir = `${process.env.MAGICPOT_REAL_BOARD_IMAGE_DIR || ''}`.trim()
    if (!singleDir) {
      throw new Error(
        'MAGICPOT_REAL_BOARD_IMAGE_DIR or MAGICPOT_REAL_BOARD_IMAGE_DIRS is required for import/mixed real board benchmarks.'
      )
    }

    return [
      {
        corpusLabel: buildDefaultCorpusLabel(singleDir),
        sourceImageDir: validateRealCorpusRoot(singleDir)
      }
    ]
  }

  const configuredLabels = splitEnvList(REAL_BOARD_CORPUS_LABELS)
  if (configuredLabels.length > 0 && configuredLabels.length !== configuredDirs.length) {
    throw new Error(
      `MAGICPOT_REAL_BOARD_CORPUS_LABELS must have ${configuredDirs.length} entries; found ${configuredLabels.length}.`
    )
  }

  const seenLabels = new Set()
  return configuredDirs.map((configuredDir, index) => {
    const resolvedDir = validateRealCorpusRoot(configuredDir)
    const rawLabel = configuredLabels[index] || buildDefaultCorpusLabel(resolvedDir)
    const corpusLabel = sanitizeProjectCanvasRunId(rawLabel, `real-corpus-${index + 1}`)
    if (seenLabels.has(corpusLabel)) {
      throw new Error(`Duplicate real-board corpus label after sanitizing: ${corpusLabel}`)
    }
    seenLabels.add(corpusLabel)
    return {
      corpusLabel,
      sourceImageDir: resolvedDir
    }
  })
}

function getRequiredRealCorpusUniqueCount(scenarioMode, totalImageCount) {
  if (scenarioMode === 'seeded-hires') {
    return 0
  }
  if (scenarioMode === 'mixed') {
    return Math.ceil(totalImageCount / 2)
  }
  return totalImageCount
}

function getRepeatWorkloadMinimumUniqueCount(totalImageCount) {
  return Math.max(
    REAL_BOARD_REPEAT_MIN_UNIQUE_IMAGE_COUNT,
    Math.ceil(totalImageCount * REAL_BOARD_REPEAT_MIN_UNIQUE_FRACTION)
  )
}

function buildRepeatWorkloadAssessment({
  allowRepeat,
  benchmarkImageCount,
  benchmarkUniqueContentHashCount
}) {
  const repeatWorkload = Boolean(allowRepeat)
  const repeatMinUniqueImageCount = repeatWorkload
    ? getRepeatWorkloadMinimumUniqueCount(benchmarkImageCount)
    : 0
  const repeatUniqueImageCount = repeatWorkload ? benchmarkUniqueContentHashCount : null
  const repeatWorkloadAccepted =
    !repeatWorkload || benchmarkUniqueContentHashCount >= repeatMinUniqueImageCount

  return {
    repeatWorkload,
    repeatWorkloadAccepted,
    repeatSmokeRun: repeatWorkload && !repeatWorkloadAccepted,
    repeatMinUniqueFraction: repeatWorkload ? REAL_BOARD_REPEAT_MIN_UNIQUE_FRACTION : null,
    repeatMinUniqueImageCount,
    repeatUniqueImageCount,
    repeatBenchmarkImageCount: repeatWorkload ? benchmarkImageCount : null,
    repeatUniqueFraction:
      repeatWorkload && benchmarkImageCount > 0
        ? Number((benchmarkUniqueContentHashCount / benchmarkImageCount).toFixed(4))
        : null
  }
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function buildRealCorpusManifest(sourceDir, requiredUniqueCount, options = {}) {
  const sourceImages = await collectImageFiles(sourceDir)
  if (sourceImages.length === 0) {
    throw new Error(`Real-board corpus has no supported image files: ${sourceDir}`)
  }

  const extensionBreakdown = {}
  const byteSizes = []
  const imageHashes = new Map()
  for (let index = 0; index < sourceImages.length; index += 1) {
    if (index % 8 === 0) {
      BENCHMARK_MEMORY_WATCHDOG.throwIfTripped(`build-real-corpus-manifest:${index}`)
    }
    const sourceImage = sourceImages[index]
    const extension = path.extname(sourceImage).toLowerCase() || '<none>'
    extensionBreakdown[extension] = (extensionBreakdown[extension] || 0) + 1
    const stat = await fs.stat(sourceImage)
    byteSizes.push(stat.size)
    const hash = await hashFile(sourceImage)
    if (!imageHashes.has(hash)) {
      imageHashes.set(hash, sourceImage)
    }
  }

  const uniqueSourceImages = [...imageHashes.values()]
  if (uniqueSourceImages.length < requiredUniqueCount && !options.allowRepeat) {
    throw new Error(
      `Real-board corpus must contain at least ${requiredUniqueCount} unique image contents; found ${uniqueSourceImages.length} in ${sourceDir}. Set MAGICPOT_REAL_BOARD_ALLOW_REPEAT=1 only for smoke runs.`
    )
  }

  return {
    corpusRoot: sourceDir,
    candidateImageCount: sourceImages.length,
    uniqueContentHashCount: uniqueSourceImages.length,
    duplicateContentCount: Math.max(0, sourceImages.length - uniqueSourceImages.length),
    extensionBreakdown: Object.fromEntries(
      Object.entries(extensionBreakdown).sort(([left], [right]) => left.localeCompare(right))
    ),
    byteSize: summarizeNumberValues(byteSizes),
    uniqueSourceImages
  }
}

async function stageRealBoardImages(sourceDir, tempRoot, count, options = {}) {
  const sourceManifest =
    options.sourceManifest ??
    (await buildRealCorpusManifest(sourceDir, count, { allowRepeat: options.allowRepeat }))
  const uniqueSourceImages = sourceManifest.uniqueSourceImages
  if (uniqueSourceImages.length < count && !options.allowRepeat) {
    throw new Error(
      `Real-board corpus must contain at least ${count} unique image contents; found ${uniqueSourceImages.length}. Duplicate files with different names are not a valid real-board benchmark. Set MAGICPOT_REAL_BOARD_ALLOW_REPEAT=1 only for smoke runs.`
    )
  }

  const stagedDir = path.join(tempRoot, options.stageDirName || 'real-board-import')
  await fs.mkdir(stagedDir, { recursive: true })
  const stagedImages = []
  for (let index = 0; index < count; index += 1) {
    if (index % 16 === 0) {
      BENCHMARK_MEMORY_WATCHDOG.throwIfTripped(`stage-real-board-images:${index}`)
    }
    const source = options.allowRepeat
      ? uniqueSourceImages[index % uniqueSourceImages.length]
      : uniqueSourceImages[index]
    const extension = path.extname(source) || '.png'
    const target = path.join(
      stagedDir,
      `real-board-${String(index + 1).padStart(4, '0')}${extension}`
    )
    await fs.copyFile(source, target)
    stagedImages.push(target)
  }

  return {
    sourceImageCount: sourceManifest.candidateImageCount,
    uniqueImageCount: Math.min(uniqueSourceImages.length, count),
    uniqueContentHashCount: Math.min(uniqueSourceImages.length, count),
    stagedImages
  }
}

async function prepareBenchmarkImages({
  sourceImageDir,
  sourceManifest,
  tempRoot,
  count,
  scenarioMode
}) {
  if (scenarioMode === 'seeded-hires') {
    const generatedSourceDir = path.join(tempRoot, 'seeded-hires-source')
    await writeSeededHiresImages(generatedSourceDir, count)
    return stageRealBoardImages(generatedSourceDir, tempRoot, count, {
      allowRepeat: false,
      stageDirName: 'seeded-hires-import'
    })
  }

  if (!sourceImageDir) {
    throw new Error(
      'MAGICPOT_REAL_BOARD_IMAGE_DIR is required for import/mixed real board benchmarks. Use MAGICPOT_REAL_BOARD_MODE=seeded-hires for generated high-resolution fixtures.'
    )
  }

  if (scenarioMode === 'mixed') {
    const realCount = Math.ceil(count / 2)
    const seededCount = count - realCount
    const realImages = await stageRealBoardImages(
      path.resolve(sourceImageDir),
      tempRoot,
      realCount,
      {
        allowRepeat: REAL_BOARD_ALLOW_REPEAT,
        sourceManifest,
        stageDirName: 'real-board-import'
      }
    )
    const generatedSourceDir = path.join(tempRoot, 'mixed-seeded-hires-source')
    await writeSeededHiresImages(generatedSourceDir, seededCount)
    const seededImages =
      seededCount > 0
        ? await stageRealBoardImages(generatedSourceDir, tempRoot, seededCount, {
            allowRepeat: false,
            stageDirName: 'mixed-seeded-hires-import'
          })
        : {
            sourceImageCount: 0,
            uniqueImageCount: 0,
            uniqueContentHashCount: 0,
            stagedImages: []
          }

    return {
      sourceImageCount: realImages.sourceImageCount + seededImages.sourceImageCount,
      uniqueImageCount: realImages.uniqueImageCount + seededImages.uniqueImageCount,
      uniqueContentHashCount:
        realImages.uniqueContentHashCount + seededImages.uniqueContentHashCount,
      stagedImages: [...realImages.stagedImages, ...seededImages.stagedImages],
      mixedBreakdown: {
        realImageCount: realImages.stagedImages.length,
        seededHiresImageCount: seededImages.stagedImages.length
      }
    }
  }

  return stageRealBoardImages(path.resolve(sourceImageDir), tempRoot, count, {
    allowRepeat: REAL_BOARD_ALLOW_REPEAT,
    stageDirName: 'real-board-import'
  })
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  )
  return sorted[index]
}

function summarizeDurations(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value) && value >= 0)
  if (finiteValues.length === 0) {
    return {
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0
    }
  }

  return {
    p50: Number(percentile(finiteValues, 50).toFixed(4)),
    p95: Number(percentile(finiteValues, 95).toFixed(4)),
    p99: Number(percentile(finiteValues, 99).toFixed(4)),
    max: Number(Math.max(...finiteValues).toFixed(4))
  }
}

function toFinitePressureValue(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function summarizePressureMetric(samples, key) {
  const values = samples
    .map((sample) => toFinitePressureValue(sample[key]))
    .filter((value) => value !== null)

  if (values.length === 0) {
    return {
      sampleCount: 0,
      first: null,
      last: null,
      min: null,
      p50: null,
      p95: null,
      max: null,
      delta: null
    }
  }

  const first = values[0]
  const last = values[values.length - 1]
  return {
    sampleCount: values.length,
    first,
    last,
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
    delta: last - first
  }
}

function getPressureSummaryMax(summary, key) {
  const value = summary[key]?.max
  return Number.isFinite(value) ? value : 0
}

function analyzeSustainedMonotonicGrowth(samples, key, threshold, minSampleCount) {
  const points = samples
    .map((sample) => ({
      index: sample.index,
      elapsedMs: sample.elapsedMs,
      value: toFinitePressureValue(sample[key])
    }))
    .filter((point) => point.value !== null)

  const emptyResult = {
    metric: key,
    breached: false,
    threshold,
    minSampleCount,
    maxGrowth: 0,
    sampleCount: points.length,
    runSampleCount: 0,
    start: null,
    end: null
  }

  if (points.length < minSampleCount) {
    return emptyResult
  }

  let bestRun = null
  let runStartIndex = 0
  const assessRun = (endIndex) => {
    const runSampleCount = endIndex - runStartIndex + 1
    if (runSampleCount < minSampleCount) {
      return
    }

    const start = points[runStartIndex]
    const end = points[endIndex]
    const growth = end.value - start.value
    if (!bestRun || growth > bestRun.maxGrowth) {
      bestRun = {
        maxGrowth: growth,
        runSampleCount,
        start,
        end
      }
    }
  }

  for (let index = 1; index < points.length; index += 1) {
    if (points[index].value < points[index - 1].value) {
      assessRun(index - 1)
      runStartIndex = index
    }
  }
  assessRun(points.length - 1)

  if (!bestRun) {
    return emptyResult
  }

  return {
    ...emptyResult,
    breached: bestRun.maxGrowth > threshold,
    maxGrowth: bestRun.maxGrowth,
    runSampleCount: bestRun.runSampleCount,
    start: bestRun.start,
    end: bestRun.end
  }
}

function buildPressureSummary(samples) {
  return {
    jsHeapBytes: summarizePressureMetric(samples, 'jsHeapBytes'),
    residentTextureBytes: summarizePressureMetric(samples, 'residentTextureBytes'),
    domNodeCount: summarizePressureMetric(samples, 'domNodeCount'),
    reactCommits: summarizePressureMetric(samples, 'reactCommits'),
    missingImageCount: summarizePressureMetric(samples, 'missingImageCount'),
    placeholderCount: summarizePressureMetric(samples, 'placeholderCount'),
    previewCount: summarizePressureMetric(samples, 'previewCount'),
    sourceCount: summarizePressureMetric(samples, 'sourceCount'),
    upgradePendingCount: summarizePressureMetric(samples, 'upgradePendingCount'),
    sourceUpgradeFailedImageCount: summarizePressureMetric(
      samples,
      'sourceUpgradeFailedImageCount'
    ),
    rightOcclusionPx: summarizePressureMetric(samples, 'rightOcclusionPx'),
    drawableRightMismatchPx: summarizePressureMetric(samples, 'drawableRightMismatchPx')
  }
}

function buildPressureGrowthAnalysis(samples) {
  const metricAnalyses = {
    jsHeapBytes: analyzeSustainedMonotonicGrowth(
      samples,
      'jsHeapBytes',
      REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_BYTES,
      REAL_BOARD_PRESSURE_SUSTAINED_SAMPLE_COUNT
    ),
    residentTextureBytes: analyzeSustainedMonotonicGrowth(
      samples,
      'residentTextureBytes',
      REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_BYTES,
      REAL_BOARD_PRESSURE_SUSTAINED_SAMPLE_COUNT
    ),
    domNodeCount: analyzeSustainedMonotonicGrowth(
      samples,
      'domNodeCount',
      REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_COUNT,
      REAL_BOARD_PRESSURE_SUSTAINED_SAMPLE_COUNT
    ),
    reactCommits: analyzeSustainedMonotonicGrowth(
      samples,
      'reactCommits',
      REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_COUNT,
      REAL_BOARD_PRESSURE_SUSTAINED_SAMPLE_COUNT
    )
  }
  const failures = Object.values(metricAnalyses).filter((analysis) => analysis.breached)

  return {
    breached: failures.length > 0,
    failures,
    metrics: metricAnalyses
  }
}

function buildPressureVisualFailures(pressure, fatalErrors) {
  const summary = pressure.summary
  const maximumUpdateDepthErrors = fatalErrors.filter((message) =>
    /Maximum update depth exceeded/i.test(message)
  ).length

  return {
    missingImages: getPressureSummaryMax(summary, 'missingImageCount'),
    placeholders: getPressureSummaryMax(summary, 'placeholderCount'),
    rightSideOcclusion:
      getPressureSummaryMax(summary, 'rightOcclusionPx') > 8 ||
      getPressureSummaryMax(summary, 'drawableRightMismatchPx') > 8,
    rightOcclusionPx: getPressureSummaryMax(summary, 'rightOcclusionPx'),
    drawableRightMismatchPx: getPressureSummaryMax(summary, 'drawableRightMismatchPx'),
    sourceUpgradeFailures: getPressureSummaryMax(summary, 'sourceUpgradeFailedImageCount'),
    maximumUpdateDepthErrors,
    sustainedMonotonicGrowth: pressure.sustainedMonotonicGrowth.breached,
    sustainedMonotonicGrowthFailures: pressure.sustainedMonotonicGrowth.failures
  }
}

function buildSourceTextureVisualFailures(highZoomUpgrade, finalMetrics) {
  const finalSourceUpgradeFailures = finalMetrics.webgl.sourceUpgradeFailedImageCount
  const highZoomSourceUpgradeFailures = highZoomUpgrade?.sourceUpgradeFailures ?? 0
  const sourceUpgradeFailures = Math.max(finalSourceUpgradeFailures, highZoomSourceUpgradeFailures)
  const highZoomProbeRan = Boolean(highZoomUpgrade)
  const residentCandidateImageCount =
    highZoomUpgrade?.afterZoom?.residentCandidateImageCount ??
    finalMetrics.webgl.residentCandidateImageCount
  const retainedSourceCount =
    highZoomUpgrade?.afterZoom?.sourceCount ?? finalMetrics.webgl.sourceCount
  const sourceUpgradeNotObserved =
    highZoomProbeRan && highZoomUpgrade.sourceUpgradeObserved !== true
  const sourceTextureRetentionFailure =
    highZoomProbeRan && residentCandidateImageCount > 0 && retainedSourceCount <= 0

  return {
    sourceUpgradeFailures,
    finalSourceUpgradeFailures,
    highZoomSourceUpgradeFailures,
    sourceUpgradeNotObserved,
    sourceTextureRetentionFailure,
    retainedSourceCount,
    residentCandidateImageCount
  }
}

async function readBenchmarkMetrics(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="project-canvas-stage-root"]')
    if (!(root instanceof HTMLElement)) {
      throw new Error('ProjectCanvas stage root not found.')
    }

    const snapshotText = root.dataset.projectCanvasMetricsSnapshot
    let snapshot = null
    try {
      snapshot = snapshotText ? JSON.parse(snapshotText) : null
    } catch {
      snapshot = null
    }
    const snapshotWebgl = snapshot?.webgl || null
    const snapshotThumbnailCache = snapshot?.thumbnailCache || snapshot?.thumbnails || null
    const hasOwn = (object, key) =>
      Boolean(object && Object.prototype.hasOwnProperty.call(object, key))
    const readNumberCandidate = (value) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    const readFirstNumber = (candidates, fallback = 0) => {
      for (const candidate of candidates) {
        const parsed = readNumberCandidate(candidate)
        if (parsed !== null) {
          return parsed
        }
      }
      return fallback
    }
    const hasPlaceholderCountMetric =
      hasOwn(snapshotWebgl, 'placeholderCount') ||
      hasOwn(snapshotWebgl, 'placeholderImageCount') ||
      root.dataset.projectCanvasWebglPlaceholderImageCount !== undefined ||
      root.dataset.projectCanvasPlaceholderImageCount !== undefined ||
      root.dataset.projectCanvasPlaceholderCount !== undefined
    const placeholderCount = hasPlaceholderCountMetric
      ? readFirstNumber([
          snapshotWebgl?.placeholderCount,
          snapshotWebgl?.placeholderImageCount,
          root.dataset.projectCanvasWebglPlaceholderImageCount,
          root.dataset.projectCanvasPlaceholderImageCount,
          root.dataset.projectCanvasPlaceholderCount
        ])
      : null
    const thumbnailCacheMetricAvailable =
      Boolean(snapshotThumbnailCache) ||
      root.dataset.projectCanvasThumbnailCount !== undefined ||
      root.dataset.projectCanvasThumbnailCacheHitCount !== undefined ||
      root.dataset.projectCanvasThumbnailCacheGeneratedCount !== undefined ||
      root.dataset.projectCanvasThumbnailCacheStaleCount !== undefined
    const summaryText = root.dataset.projectCanvasRenderSurfaceSummary || '{}'
    const visibleSummary = JSON.parse(summaryText)
    const totalItemCount = Number(
      root.dataset.projectCanvasTotalItemCount || visibleSummary.totalItems || '0'
    )
    const totalImageItemCount = Number(
      root.dataset.projectCanvasTotalImageItemCount || visibleSummary.imageItems || '0'
    )
    const visibleItemCount = Number(
      root.dataset.projectCanvasVisibleItemCount || visibleSummary.totalItems || '0'
    )
    const visibleImageItemCount = Number(
      root.dataset.projectCanvasVisibleImageItemCount || visibleSummary.imageItems || '0'
    )
    const summary = {
      ...visibleSummary,
      totalItems: totalItemCount,
      imageItems: totalImageItemCount,
      visibleItems: visibleItemCount,
      visibleImageItems: visibleImageItemCount
    }
    const webglCanvas = document.querySelector('.project-canvas-webgl-layer canvas')
    const overlayRoot = document.querySelector('[data-project-canvas-overlay-total-count]')
    const clientRect = root.getBoundingClientRect()
    const drawableRect =
      webglCanvas instanceof HTMLElement ? webglCanvas.getBoundingClientRect() : clientRect
    const usedJSHeapSize =
      typeof performance !== 'undefined' &&
      performance &&
      'memory' in performance &&
      typeof performance.memory?.usedJSHeapSize === 'number'
        ? performance.memory.usedJSHeapSize
        : null
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const rightOcclusionPx = Math.max(0, viewportWidth - clientRect.right)

    return {
      summary,
      itemCounts: {
        totalItemCount,
        totalImageItemCount,
        visibleItemCount,
        visibleImageItemCount
      },
      reactCommits: Number(root.dataset.projectCanvasReactCommitCount || '0'),
      domNodeCount: document.getElementsByTagName('*').length,
      jsHeapBytes: usedJSHeapSize,
      overlayMetrics: {
        overlayTotalCount: Number(overlayRoot?.dataset.projectCanvasOverlayTotalCount || '0'),
        domOverlayCount: Number(overlayRoot?.dataset.projectCanvasDomOverlayCount || '0'),
        mountedVideoOverlayCount: Number(
          overlayRoot?.dataset.projectCanvasMountedVideoOverlayCount || '0'
        )
      },
      webgl: {
        loadedImageCount: Number(root.dataset.projectCanvasWebglLoadedImageCount || '0'),
        failedImageCount: Number(root.dataset.projectCanvasWebglFailedImageCount || '0'),
        pendingImageCount: Number(root.dataset.projectCanvasWebglPendingImageCount || '0'),
        residentImageCount: Number(root.dataset.projectCanvasWebglResidentImageCount || '0'),
        residentCandidateImageCount: Number(
          root.dataset.projectCanvasWebglResidentCandidateImageCount || '0'
        ),
        viewportCulledImageCount: Number(
          root.dataset.projectCanvasWebglViewportCulledImageCount || '0'
        ),
        residentTextureBytes: Number(root.dataset.projectCanvasWebglResidentTextureBytes || '0'),
        residentTextureBudgetBytes: Number(
          root.dataset.projectCanvasWebglResidentTextureBudgetBytes || '0'
        ),
        missingImageCount: Number(root.dataset.projectCanvasWebglMissingImageCount || '0'),
        previewCount: Number(root.dataset.projectCanvasWebglUsingPreviewImageCount || '0'),
        sourceCount: Number(root.dataset.projectCanvasWebglUsingSourceImageCount || '0'),
        sourceUpgradeSuppressedImageCount: Number(
          root.dataset.projectCanvasWebglSourceUpgradeSuppressedImageCount || '0'
        ),
        sourceUpgradeablePreviewCount: Number(
          root.dataset.projectCanvasWebglSourceUpgradeablePreviewImageCount || '0'
        ),
        upgradePendingCount: Number(
          root.dataset.projectCanvasWebglSourceUpgradePendingImageCount || '0'
        ),
        sourceUpgradeFailedImageCount: Number(
          root.dataset.projectCanvasWebglSourceUpgradeFailedImageCount || '0'
        ),
        placeholderMetricAvailable: hasPlaceholderCountMetric,
        placeholderCount,
        renderCount: Number(root.dataset.projectCanvasWebglRenderCount || '0'),
        lastRenderDurationMs: Number(root.dataset.projectCanvasWebglLastRenderDurationMs || '0'),
        lastUpdateReason: root.dataset.projectCanvasWebglLastUpdateReason || '',
        hasWebglContext: Boolean(
          webglCanvas instanceof HTMLCanvasElement &&
          (webglCanvas.getContext('webgl2') || webglCanvas.getContext('webgl'))
        )
      },
      thumbnailCache: {
        metricAvailable: thumbnailCacheMetricAvailable,
        thumbnailCount: readFirstNumber([
          snapshotThumbnailCache?.thumbnailCount,
          snapshotThumbnailCache?.count,
          root.dataset.projectCanvasThumbnailCount
        ]),
        cacheHitCount: readFirstNumber([
          snapshotThumbnailCache?.cacheHitCount,
          snapshotThumbnailCache?.hitCount,
          snapshotThumbnailCache?.hits,
          root.dataset.projectCanvasThumbnailCacheHitCount
        ]),
        cacheGeneratedCount: readFirstNumber([
          snapshotThumbnailCache?.cacheGeneratedCount,
          snapshotThumbnailCache?.generatedCount,
          snapshotThumbnailCache?.generated,
          root.dataset.projectCanvasThumbnailCacheGeneratedCount
        ]),
        cacheStaleCount: readFirstNumber([
          snapshotThumbnailCache?.cacheStaleCount,
          snapshotThumbnailCache?.staleCount,
          snapshotThumbnailCache?.stale,
          root.dataset.projectCanvasThumbnailCacheStaleCount
        ])
      },
      viewport: {
        stageScale: Number(root.dataset.stageScale || '0'),
        stagePosX: Number(root.dataset.stagePosX || '0'),
        stagePosY: Number(root.dataset.stagePosY || '0'),
        clientRect: {
          x: Number(clientRect.x.toFixed(2)),
          y: Number(clientRect.y.toFixed(2)),
          width: Number(clientRect.width.toFixed(2)),
          height: Number(clientRect.height.toFixed(2)),
          right: Number(clientRect.right.toFixed(2)),
          bottom: Number(clientRect.bottom.toFixed(2))
        },
        drawableRect: {
          x: Number(drawableRect.x.toFixed(2)),
          y: Number(drawableRect.y.toFixed(2)),
          width: Number(drawableRect.width.toFixed(2)),
          height: Number(drawableRect.height.toFixed(2)),
          right: Number(drawableRect.right.toFixed(2)),
          bottom: Number(drawableRect.bottom.toFixed(2))
        },
        rightOcclusionPx: Number(rightOcclusionPx.toFixed(2))
      }
    }
  })
}

async function runPressureSampling(page, durationMs, sampleIntervalMs) {
  const captured = await page.evaluate(
    async ({ requestedDurationMs, requestedSampleIntervalMs }) => {
      const target = document.querySelector('[data-testid="project-canvas-stage-root"]')
      if (!(target instanceof HTMLElement)) {
        throw new Error('ProjectCanvas stage root not found for pressure sampling.')
      }

      const readSample = (index, elapsedMs) => {
        const webglCanvas = document.querySelector('.project-canvas-webgl-layer canvas')
        const clientRect = target.getBoundingClientRect()
        const drawableRect =
          webglCanvas instanceof HTMLElement ? webglCanvas.getBoundingClientRect() : clientRect
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
        const usedJSHeapSize =
          typeof performance !== 'undefined' &&
          performance &&
          'memory' in performance &&
          typeof performance.memory?.usedJSHeapSize === 'number'
            ? performance.memory.usedJSHeapSize
            : null
        let snapshot = null
        try {
          snapshot = target.dataset.projectCanvasMetricsSnapshot
            ? JSON.parse(target.dataset.projectCanvasMetricsSnapshot)
            : null
        } catch {
          snapshot = null
        }
        const placeholderCount = Number(
          snapshot?.webgl?.placeholderCount ??
            snapshot?.webgl?.placeholderImageCount ??
            target.dataset.projectCanvasWebglPlaceholderImageCount ??
            '0'
        )

        return {
          index,
          elapsedMs: Number(elapsedMs.toFixed(2)),
          jsHeapBytes: usedJSHeapSize,
          residentTextureBytes: Number(
            target.dataset.projectCanvasWebglResidentTextureBytes || '0'
          ),
          domNodeCount: document.getElementsByTagName('*').length,
          reactCommits: Number(target.dataset.projectCanvasReactCommitCount || '0'),
          missingImageCount: Number(target.dataset.projectCanvasWebglMissingImageCount || '0'),
          placeholderCount,
          previewCount: Number(target.dataset.projectCanvasWebglUsingPreviewImageCount || '0'),
          sourceCount: Number(target.dataset.projectCanvasWebglUsingSourceImageCount || '0'),
          upgradePendingCount: Number(
            target.dataset.projectCanvasWebglSourceUpgradePendingImageCount || '0'
          ),
          sourceUpgradeFailedImageCount: Number(
            target.dataset.projectCanvasWebglSourceUpgradeFailedImageCount || '0'
          ),
          rightOcclusionPx: Number(Math.max(0, viewportWidth - clientRect.right).toFixed(2)),
          drawableRightMismatchPx: Number(
            Math.abs(clientRect.right - drawableRect.right).toFixed(2)
          )
        }
      }

      const samples = []
      const startedAt = performance.now()
      let nextSampleAt = requestedSampleIntervalMs
      let wheelEventCount = 0
      const pushSample = (elapsedMs) => {
        samples.push(readSample(samples.length, elapsedMs))
      }

      pushSample(0)
      await new Promise((resolve) => {
        const dispatchNextFrame = () => {
          const elapsedMs = performance.now() - startedAt
          if (elapsedMs >= requestedDurationMs) {
            pushSample(elapsedMs)
            resolve()
            return
          }

          const rect = target.getBoundingClientRect()
          const direction = wheelEventCount % 2 === 0 ? -1 : 1
          target.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
              deltaMode: WheelEvent.DOM_DELTA_PIXEL,
              deltaY: direction * 140
            })
          )
          wheelEventCount += 1

          if (elapsedMs >= nextSampleAt) {
            pushSample(elapsedMs)
            nextSampleAt += requestedSampleIntervalMs
          }
          window.requestAnimationFrame(dispatchNextFrame)
        }

        window.requestAnimationFrame(dispatchNextFrame)
      })

      return {
        durationMs: Math.round(performance.now() - startedAt),
        wheelEventCount,
        samples
      }
    },
    {
      requestedDurationMs: durationMs,
      requestedSampleIntervalMs: sampleIntervalMs
    }
  )
  const summary = buildPressureSummary(captured.samples)
  const sustainedMonotonicGrowth = buildPressureGrowthAnalysis(captured.samples)

  return {
    enabled: true,
    configuredDurationMs: durationMs,
    configuredSampleIntervalMs: sampleIntervalMs,
    durationMs: captured.durationMs,
    wheelEventCount: captured.wheelEventCount,
    sampleCount: captured.samples.length,
    thresholds: {
      rightOcclusionPx: 8,
      sustainedSampleCount: REAL_BOARD_PRESSURE_SUSTAINED_SAMPLE_COUNT,
      monotonicGrowthBytes: REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_BYTES,
      monotonicGrowthCount: REAL_BOARD_PRESSURE_MONOTONIC_GROWTH_THRESHOLD_COUNT
    },
    summary,
    sustainedMonotonicGrowth,
    samples: captured.samples
  }
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

        const webglCanvas = document.querySelector('.project-canvas-webgl-layer canvas')
        const hasWebglContext = Boolean(
          webglCanvas instanceof HTMLCanvasElement &&
          (webglCanvas.getContext('webgl2') || webglCanvas.getContext('webgl'))
        )
        const summaryText = root.dataset.projectCanvasRenderSurfaceSummary || '{}'
        const visibleSummary = JSON.parse(summaryText)
        const totalImageItemCount = Number(
          root.dataset.projectCanvasTotalImageItemCount || visibleSummary.imageItems || '0'
        )
        const loadedImageCount = Number(root.dataset.projectCanvasWebglLoadedImageCount || '0')
        const failedImageCount = Number(root.dataset.projectCanvasWebglFailedImageCount || '0')
        const pendingImageCount = Number(root.dataset.projectCanvasWebglPendingImageCount || '0')
        const residentCandidateImageCount = Number(
          root.dataset.projectCanvasWebglResidentCandidateImageCount || '0'
        )
        const viewportCulledImageCount = Number(
          root.dataset.projectCanvasWebglViewportCulledImageCount || '0'
        )
        const renderCount = Number(root.dataset.projectCanvasWebglRenderCount || '0')
        const settledResidentCandidates =
          loadedImageCount + failedImageCount >= Math.max(1, residentCandidateImageCount)
        return (
          hasWebglContext &&
          totalImageItemCount >= expectedCount &&
          loadedImageCount > 0 &&
          settledResidentCandidates &&
          pendingImageCount === 0 &&
          residentCandidateImageCount + viewportCulledImageCount > 0 &&
          renderCount > 0
        )
      },
      expectedImageCount,
      { timeout: METRIC_WAIT_TIMEOUT_MS }
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
      `Timed out waiting for real board metrics after ${METRIC_WAIT_TIMEOUT_MS}ms. Expected images: ${expectedImageCount}. Observed metrics: ${JSON.stringify(observedMetrics)}. ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return readBenchmarkMetrics(page)
}

async function readProjectCanvasStageBounds(page, reason) {
  const startedAt = Date.now()
  let lastBounds = null

  while (Date.now() - startedAt < 30000) {
    lastBounds = await page.evaluate(() => {
      const target = document.querySelector('[data-testid="project-canvas-stage-root"]')
      if (!(target instanceof HTMLElement)) {
        return null
      }

      const rect = target.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }
    })

    if (lastBounds && lastBounds.width > 0 && lastBounds.height > 0) {
      return lastBounds
    }

    await page.waitForTimeout(100)
  }

  throw new Error(
    `Unable to determine ProjectCanvas stage bounds for ${reason}. Last bounds: ${JSON.stringify(lastBounds)}.`
  )
}

async function runInteractionBenchmark(page, sampleCount) {
  const stageBounds = await readProjectCanvasStageBounds(page, 'the real board benchmark')

  const centerX = stageBounds.x + stageBounds.width / 2
  const centerY = stageBounds.y + stageBounds.height / 2
  await page.mouse.move(centerX, centerY)

  const samples = []
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = Date.now()
    await page.mouse.wheel(index % 2 === 0 ? 80 : -80, index % 2 === 0 ? -160 : 160)
    await page.waitForTimeout(180)
    const metrics = await readBenchmarkMetrics(page)
    samples.push({
      elapsedMs: Date.now() - startedAt,
      renderDurationMs: metrics.webgl.lastRenderDurationMs,
      reactCommits: metrics.reactCommits,
      domNodeCount: metrics.domNodeCount,
      residentTextureBytes: metrics.webgl.residentTextureBytes,
      missingImageCount: metrics.webgl.missingImageCount,
      placeholderCount: metrics.webgl.placeholderCount,
      previewCount: metrics.webgl.previewCount,
      sourceCount: metrics.webgl.sourceCount,
      upgradePendingCount: metrics.webgl.upgradePendingCount,
      rightOcclusionPx: metrics.viewport.rightOcclusionPx
    })
  }

  return {
    sampleCount: samples.length,
    frameTime: summarizeDurations(samples.map((sample) => sample.renderDurationMs)),
    wallTime: summarizeDurations(samples.map((sample) => sample.elapsedMs)),
    maxDomNodeCount: Math.max(...samples.map((sample) => sample.domNodeCount || 0)),
    maxResidentTextureBytes: Math.max(...samples.map((sample) => sample.residentTextureBytes || 0)),
    reactCommitDelta:
      samples.length > 1
        ? Math.max(...samples.map((sample) => sample.reactCommits)) -
          Math.min(...samples.map((sample) => sample.reactCommits))
        : 0,
    samples
  }
}

async function runContinuousInteractionBurst(page, durationMs) {
  const stageBounds = await readProjectCanvasStageBounds(page, 'interaction burst')

  const centerX = stageBounds.x + stageBounds.width / 2
  const centerY = stageBounds.y + stageBounds.height / 2
  await page.mouse.move(centerX, centerY)
  const before = await waitForBenchmarkQuiescence(page)
  const burst = await page.evaluate(
    async ({ clientX, clientY, requestedDurationMs }) => {
      const target = document.querySelector('[data-testid="project-canvas-stage-root"]')
      if (!(target instanceof HTMLElement)) {
        throw new Error('Unable to find ProjectCanvas stage root for interaction burst.')
      }

      const readImmediateSnapshot = () => {
        const webglCanvas = document.querySelector('.project-canvas-webgl-layer canvas')
        const clientRect = target.getBoundingClientRect()
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
        let snapshot = null
        try {
          snapshot = target.dataset.projectCanvasMetricsSnapshot
            ? JSON.parse(target.dataset.projectCanvasMetricsSnapshot)
            : null
        } catch {
          snapshot = null
        }
        const placeholderCount = Number(
          snapshot?.webgl?.placeholderCount ??
            snapshot?.webgl?.placeholderImageCount ??
            target.dataset.projectCanvasWebglPlaceholderImageCount ??
            '0'
        )
        return {
          reactCommits: Number(target.dataset.projectCanvasReactCommitCount || '0'),
          webglRenderCount: Number(target.dataset.projectCanvasWebglRenderCount || '0'),
          missingImageCount: Number(target.dataset.projectCanvasWebglMissingImageCount || '0'),
          placeholderCount,
          rightOcclusionPx: Number(Math.max(0, viewportWidth - clientRect.right).toFixed(2)),
          hasWebglCanvas: webglCanvas instanceof HTMLCanvasElement
        }
      }

      const startedAt = performance.now()
      let wheelEventCount = 0

      await new Promise((resolve) => {
        const dispatchNextWheel = () => {
          if (performance.now() - startedAt >= requestedDurationMs) {
            resolve()
            return
          }

          const direction = wheelEventCount % 2 === 0 ? -1 : 1
          target.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX,
              clientY,
              deltaMode: WheelEvent.DOM_DELTA_PIXEL,
              deltaY: direction * 120
            })
          )
          wheelEventCount += 1
          window.requestAnimationFrame(dispatchNextWheel)
        }

        dispatchNextWheel()
      })

      return {
        durationMs: Math.round(performance.now() - startedAt),
        wheelEventCount,
        immediateSnapshot: readImmediateSnapshot()
      }
    },
    {
      clientX: centerX,
      clientY: centerY,
      requestedDurationMs: durationMs
    }
  )

  const immediateAfter = burst.immediateSnapshot
  await page.waitForTimeout(320)
  const afterIdle = await readBenchmarkMetrics(page)

  return {
    durationMs: burst.durationMs,
    requestedDurationMs: durationMs,
    wheelEventCount: burst.wheelEventCount,
    beforeReactCommits: before.reactCommits,
    immediateReactCommits: immediateAfter.reactCommits,
    afterIdleReactCommits: afterIdle.reactCommits,
    hotPathReactCommits: Math.max(0, immediateAfter.reactCommits - before.reactCommits),
    postIdleReactCommits: Math.max(0, afterIdle.reactCommits - immediateAfter.reactCommits),
    beforeWebglRenderCount: before.webgl.renderCount,
    immediateWebglRenderCount: immediateAfter.webglRenderCount,
    afterIdleWebglRenderCount: afterIdle.webgl.renderCount,
    missingImagesAfterBurst: immediateAfter.missingImageCount,
    placeholdersAfterBurst: immediateAfter.placeholderCount,
    rightOcclusionPxAfterBurst: immediateAfter.rightOcclusionPx
  }
}

async function measureHighZoomUpgrade(page) {
  const beforeZoom = await readBenchmarkMetrics(page)
  const stageBounds = await readProjectCanvasStageBounds(page, 'high-zoom upgrade')

  await page.mouse.move(
    stageBounds.x + stageBounds.width / 2,
    stageBounds.y + stageBounds.height / 2
  )
  for (let index = 0; index < 16; index += 1) {
    await page.mouse.wheel(0, -220)
    await page.waitForTimeout(60)
  }

  const startedAt = Date.now()
  let upgradedMetrics = await readBenchmarkMetrics(page)
  let bestMetrics = upgradedMetrics
  let finalMetrics = upgradedMetrics
  const beforeSourceCount = beforeZoom.webgl.sourceCount
  while (Date.now() - startedAt < REAL_BOARD_SOURCE_UPGRADE_WAIT_MS) {
    await page.waitForTimeout(REAL_BOARD_METRICS_SETTLE_MS)
    upgradedMetrics = await readBenchmarkMetrics(page)
    finalMetrics = upgradedMetrics

    if (
      upgradedMetrics.webgl.sourceUpgradeablePreviewCount <
        bestMetrics.webgl.sourceUpgradeablePreviewCount ||
      (upgradedMetrics.webgl.sourceUpgradeablePreviewCount ===
        bestMetrics.webgl.sourceUpgradeablePreviewCount &&
        upgradedMetrics.webgl.sourceCount > bestMetrics.webgl.sourceCount)
    ) {
      bestMetrics = upgradedMetrics
    }

    const hasVisibleSourceCoverage =
      upgradedMetrics.webgl.residentCandidateImageCount > 0 &&
      upgradedMetrics.webgl.sourceCount >= upgradedMetrics.webgl.residentCandidateImageCount &&
      upgradedMetrics.webgl.previewCount === 0
    const hasObservedUpgradeProgress =
      upgradedMetrics.webgl.sourceCount > beforeSourceCount ||
      upgradedMetrics.webgl.previewCount < beforeZoom.webgl.previewCount ||
      hasVisibleSourceCoverage
    if (
      hasObservedUpgradeProgress &&
      upgradedMetrics.webgl.sourceUpgradeablePreviewCount === 0 &&
      upgradedMetrics.webgl.upgradePendingCount === 0 &&
      upgradedMetrics.webgl.pendingImageCount === 0
    ) {
      break
    }
  }
  upgradedMetrics = bestMetrics
  const hasVisibleSourceCoverage =
    upgradedMetrics.webgl.residentCandidateImageCount > 0 &&
    upgradedMetrics.webgl.sourceCount >= upgradedMetrics.webgl.residentCandidateImageCount &&
    upgradedMetrics.webgl.previewCount === 0
  const sourceUpgradeObserved =
    upgradedMetrics.webgl.sourceCount > beforeSourceCount ||
    upgradedMetrics.webgl.previewCount < beforeZoom.webgl.previewCount ||
    hasVisibleSourceCoverage
  const hasNoPendingOrPreviewImages =
    upgradedMetrics.webgl.sourceUpgradeablePreviewCount === 0 &&
    upgradedMetrics.webgl.upgradePendingCount === 0 &&
    upgradedMetrics.webgl.pendingImageCount === 0

  return {
    upgradeLatencyMs: Date.now() - startedAt,
    beforeZoom: beforeZoom.webgl,
    beforeZoomViewport: beforeZoom.viewport,
    afterZoom: upgradedMetrics.webgl,
    afterZoomViewport: upgradedMetrics.viewport,
    finalZoom: finalMetrics.webgl,
    finalZoomViewport: finalMetrics.viewport,
    sourceUpgradeObserved,
    sourceUpgradeFailures: upgradedMetrics.webgl.sourceUpgradeFailedImageCount,
    persistentBlurredImages:
      sourceUpgradeObserved || hasNoPendingOrPreviewImages
        ? upgradedMetrics.webgl.sourceUpgradeablePreviewCount
        : 1
  }
}

function getTinyZoomBandDistance(stageScale) {
  if (!Number.isFinite(stageScale)) {
    return Number.POSITIVE_INFINITY
  }
  if (
    stageScale >= REAL_BOARD_TINY_ZOOM_MIN_SCALE &&
    stageScale <= REAL_BOARD_TINY_ZOOM_MAX_SCALE
  ) {
    return 0
  }
  return Math.min(
    Math.abs(stageScale - REAL_BOARD_TINY_ZOOM_MIN_SCALE),
    Math.abs(stageScale - REAL_BOARD_TINY_ZOOM_MAX_SCALE)
  )
}

async function runTinyZoomAcceptanceProbe(page) {
  if (!REAL_BOARD_TINY_ZOOM_ENABLED) {
    return {
      enabled: false,
      passed: true,
      skipped: true
    }
  }

  const stageBounds = await readProjectCanvasStageBounds(page, 'tiny-zoom acceptance')
  const centerX = stageBounds.x + stageBounds.width / 2
  const centerY = stageBounds.y + stageBounds.height / 2
  await page.mouse.move(centerX, centerY)

  let metrics = await readBenchmarkMetrics(page)
  let bestMetrics = metrics
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const scale = metrics.viewport.stageScale
    if (getTinyZoomBandDistance(scale) === 0) {
      break
    }

    const rawDeltaY =
      (-Math.log(REAL_BOARD_TINY_ZOOM_TARGET_SCALE / Math.max(scale, 0.0001)) / Math.log(1.08)) *
      100
    const maxDeltaY =
      Math.abs(Math.log(Math.max(scale, 0.0001) / REAL_BOARD_TINY_ZOOM_TARGET_SCALE)) > 2
        ? 320
        : 120
    const wheelDeltaY = Math.max(-maxDeltaY, Math.min(maxDeltaY, rawDeltaY))
    await page.mouse.wheel(0, wheelDeltaY)
    await page.waitForTimeout(80)
    metrics = await readBenchmarkMetrics(page)
    if (
      getTinyZoomBandDistance(metrics.viewport.stageScale) <
      getTinyZoomBandDistance(bestMetrics.viewport.stageScale)
    ) {
      bestMetrics = metrics
    }
  }

  if (getTinyZoomBandDistance(metrics.viewport.stageScale) !== 0) {
    metrics = bestMetrics
  }

  const stageScale = metrics.viewport.stageScale
  const coordinateScale = Math.max(Math.abs(stageScale), 0.0001)
  const centerCanvasPoint = {
    x: Number(
      ((centerX - stageBounds.x - metrics.viewport.stagePosX) / coordinateScale).toFixed(2)
    ),
    y: Number(((centerY - stageBounds.y - metrics.viewport.stagePosY) / coordinateScale).toFixed(2))
  }
  const stageScaleReached =
    stageScale >= REAL_BOARD_TINY_ZOOM_MIN_SCALE && stageScale <= REAL_BOARD_TINY_ZOOM_MAX_SCALE
  const overviewSourceSuppressed =
    stageScale <= REAL_BOARD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE &&
    metrics.webgl.sourceCount === 0
  const coordinateMappingFinite =
    Number.isFinite(centerCanvasPoint.x) && Number.isFinite(centerCanvasPoint.y)

  return {
    enabled: true,
    minScale: REAL_BOARD_TINY_ZOOM_MIN_SCALE,
    maxScale: REAL_BOARD_TINY_ZOOM_MAX_SCALE,
    targetScale: REAL_BOARD_TINY_ZOOM_TARGET_SCALE,
    overviewSourceSuppressionMaxScale: REAL_BOARD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE,
    stageScale,
    stageScaleReached,
    sourceCountAtTinyZoom: metrics.webgl.sourceCount,
    placeholderCountAtTinyZoom: metrics.webgl.placeholderCount,
    coordinateMappingFinite,
    centerCanvasPoint,
    metrics,
    passed: stageScaleReached && overviewSourceSuppressed && coordinateMappingFinite
  }
}

async function waitForBenchmarkQuiescence(page, timeoutMs = 3000) {
  const startedAt = Date.now()
  let previous = await readBenchmarkMetrics(page)

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(REAL_BOARD_METRICS_SETTLE_MS)
    const next = await readBenchmarkMetrics(page)
    if (
      next.reactCommits === previous.reactCommits &&
      next.webgl.pendingImageCount === 0 &&
      next.webgl.upgradePendingCount === 0
    ) {
      return next
    }
    previous = next
  }

  return previous
}

function buildScenarioName(scenarioMode, imageCount, cachePass = null) {
  const baseName = `${sanitizeProjectCanvasRunId(scenarioMode, 'real-board')}-${imageCount}`
  return cachePass ? `${baseName}-${sanitizeProjectCanvasRunId(cachePass, 'cache-pass')}` : baseName
}

function toErrorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error)
}

function toShortErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function runWithTimeout(promise, timeoutMs) {
  let timeoutId
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms.`)),
          timeoutMs
        )
      })
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function stopProcessTree(processId) {
  if (process.platform !== 'win32' || !Number.isInteger(processId) || processId <= 0) {
    return
  }

  await execFileAsync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
    timeout: PROCESS_CLEANUP_TIMEOUT_MS,
    windowsHide: true
  })
}

async function stopResidualElectronProcesses(userDataDir) {
  if (process.platform !== 'win32' || !userDataDir) {
    return []
  }

  const escapedUserDataDir = userDataDir.replace(/'/g, "''")
  const command = [
    `$target='${escapedUserDataDir}'`,
    '$matches=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like "*$target*" }',
    '$ids=@()',
    'foreach ($match in $matches) { $ids += $match.ProcessId; if ($match.ParentProcessId) { $ids += $match.ParentProcessId } }',
    '$ids=$ids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique',
    'if ($ids) { foreach ($id in $ids) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch {} }; $ids -join "," }'
  ].join('; ')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      timeout: PROCESS_CLEANUP_TIMEOUT_MS,
      windowsHide: true
    }
  )

  return stdout
    .trim()
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((value) => Number.isFinite(value))
}

async function closeBenchmarkApp(appHandle, userDataDir) {
  if (!appHandle) {
    return
  }

  let childProcess = null
  let childProcessId = null
  try {
    childProcess = appHandle.app.process()
    childProcessId = Number.isInteger(childProcess?.pid) ? childProcess.pid : null
  } catch {
    // Fall back to user-data based cleanup below.
  }

  try {
    await runWithTimeout(appHandle.app.close(), PROCESS_CLEANUP_TIMEOUT_MS)
  } catch {
    // Fall back to process-level cleanup below.
  }

  try {
    if (childProcess && !childProcess.killed) {
      childProcess.kill()
    }
  } catch {
    // Residual process cleanup below still covers the benchmark user-data directory.
  }

  try {
    await stopProcessTree(childProcessId)
  } catch {
    // taskkill returns a non-zero status if Playwright already closed the process.
  }

  try {
    await stopResidualElectronProcesses(userDataDir)
  } catch {
    // Cleanup must not invalidate a benchmark report that has already been written.
  }
}

function buildWindowPlacementResult(windowPlacement, label) {
  const failures = []
  let assessment = null

  try {
    assessment = assessNonIntrusiveWindowPlacement(windowPlacement)
  } catch (error) {
    failures.push(`Unable to assess benchmark window placement: ${toShortErrorMessage(error)}`)
  }

  const hidden = windowPlacement?.visible === false
  const secondaryOrOffscreen = assessment?.isNonIntrusive === true
  if (!hidden && !secondaryOrOffscreen) {
    failures.push(
      'Benchmark could not confirm the GUI window was hidden, offscreen, or fully on a secondary display.'
    )
  }
  if (windowPlacement?.focusable !== false) {
    failures.push(`${label} should not allow the benchmark window to take focus.`)
  }
  if (windowPlacement?.focused !== false) {
    failures.push(`${label} unexpectedly focused the benchmark window.`)
  }
  if (windowPlacement?.skipTaskbar !== true) {
    failures.push(`${label} should keep benchmark windows off the taskbar.`)
  }

  try {
    assertNonIntrusiveWindowPlacement(windowPlacement, label)
  } catch (error) {
    failures.push(toShortErrorMessage(error))
  }

  return {
    assessment,
    confirmed: failures.length === 0,
    failures: [...new Set(failures)]
  }
}

function buildAcceptance({ finalMetrics, visualFailures, interactionBurst }) {
  const pressureFailures = visualFailures.pressure
  const acceptance = {
    hasWebglContext: Boolean(finalMetrics.webgl.hasWebglContext),
    noFailedImages: visualFailures.failedImages === 0,
    noSourceUpgradeFailures: visualFailures.sourceUpgradeFailures === 0,
    sourceUpgradeObserved: !visualFailures.sourceUpgradeNotObserved,
    sourceTexturesRetained: !visualFailures.sourceTextureRetentionFailure,
    noMissingImages: visualFailures.missingImages === 0,
    placeholderMetricAvailable: visualFailures.placeholderMetricAvailable === true,
    noPermanentPlaceholders: visualFailures.permanentPlaceholders === 0,
    noPersistentBlurredImages: visualFailures.persistentBlurredImages === 0,
    tinyZoomScaleReached:
      !visualFailures.tinyZoomEnabled || visualFailures.tinyZoomStageScaleReached === true,
    overviewSourceSuppressedAtTinyZoom:
      !visualFailures.tinyZoomEnabled ||
      visualFailures.overviewSourceSuppressionAtTinyZoom === true,
    tinyZoomCoordinateMappingFinite:
      !visualFailures.tinyZoomEnabled || visualFailures.tinyZoomCoordinateMappingFinite === true,
    warmCacheMetricsAvailable:
      !visualFailures.warmCacheRun || visualFailures.warmCacheMetricsAvailable === true,
    warmCacheHitsCoverImported:
      !visualFailures.warmCacheRun || visualFailures.warmCacheHitsCoverImported === true,
    warmCacheGeneratedNearZero:
      !visualFailures.warmCacheRun || visualFailures.warmCacheGeneratedNearZero === true,
    frameTimeP95WithinLimit: !visualFailures.frameTimeP95Overflow,
    noRightSideOcclusion: !visualFailures.rightSideOcclusion,
    hotPathReactCommitsWithinLimit: !visualFailures.hotPathReactCommitOverflow,
    postIdleReactCommitsWithinLimit: !visualFailures.postIdleReactCommitOverflow,
    noMaximumUpdateDepthErrors: visualFailures.maximumUpdateDepthErrors === 0,
    windowPlacementConfirmed: visualFailures.windowPlacementFailures.length === 0,
    repeatWorkloadAccepted: visualFailures.repeatWorkloadAccepted !== false,
    pressureSamplingEnabledWhenConfigured:
      !visualFailures.pressureSamplingConfigured || Boolean(pressureFailures),
    pressureSamplingCompleted:
      !visualFailures.pressureSamplingConfigured || !visualFailures.pressureSamplingIncomplete,
    hotPathReactCommitLimit: REAL_BOARD_HOT_PATH_REACT_COMMIT_LIMIT,
    hotPathReactCommits: interactionBurst.hotPathReactCommits,
    postIdleReactCommitLimit: REAL_BOARD_POST_IDLE_REACT_COMMIT_LIMIT,
    postIdleReactCommits: interactionBurst.postIdleReactCommits,
    ...(pressureFailures
      ? {
          noPressureMissingImages: pressureFailures.missingImages === 0,
          noPressurePermanentPlaceholders: pressureFailures.placeholders === 0,
          noPressureSourceUpgradeFailures: pressureFailures.sourceUpgradeFailures === 0,
          noPressureRightSideOcclusion: !pressureFailures.rightSideOcclusion,
          noPressureMaximumUpdateDepthErrors: pressureFailures.maximumUpdateDepthErrors === 0,
          noPressureSustainedMonotonicGrowth: !pressureFailures.sustainedMonotonicGrowth
        }
      : {})
  }
  const failureLabels = {
    hasWebglContext: 'WebGL context was not available.',
    noFailedImages: `${visualFailures.failedImages} image(s) failed to load.`,
    noSourceUpgradeFailures: `${visualFailures.sourceUpgradeFailures} source image upgrade(s) failed.`,
    sourceUpgradeObserved:
      'Source texture upgrade did not complete; no source upgrade progress was observed during the high-zoom probe.',
    sourceTexturesRetained: `Source texture retention failed: retained ${visualFailures.retainedSourceCount} source texture(s) for ${visualFailures.residentCandidateImageCount} resident candidate image(s).`,
    noMissingImages: `${visualFailures.missingImages} missing image(s) were reported by WebGL metrics.`,
    placeholderMetricAvailable:
      'ProjectCanvas benchmark metrics did not expose placeholderCount; refusing to treat missing placeholder telemetry as zero.',
    noPermanentPlaceholders: `${visualFailures.permanentPlaceholders ?? 'unknown'} permanent placeholder image(s) remained after preview generation settled.`,
    noPersistentBlurredImages: `${visualFailures.persistentBlurredImages} image(s) remained blurred after source upgrade.`,
    tinyZoomScaleReached: `Tiny-zoom probe did not reach ${REAL_BOARD_TINY_ZOOM_MIN_SCALE}-${REAL_BOARD_TINY_ZOOM_MAX_SCALE}; observed ${visualFailures.tinyZoomStageScale}.`,
    overviewSourceSuppressedAtTinyZoom: `Tiny-zoom overview still reported ${visualFailures.tinyZoomSourceCount ?? 'unknown'} source texture(s); expected 0 at scale <= ${REAL_BOARD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE}.`,
    tinyZoomCoordinateMappingFinite:
      'Tiny-zoom viewport coordinate mapping produced a non-finite canvas point.',
    warmCacheMetricsAvailable:
      'Warm-cache run did not expose thumbnail cache hit/generated/stale metrics.',
    warmCacheHitsCoverImported: `Warm-cache run reported ${visualFailures.warmCacheHitCount ?? 0} thumbnail cache hit(s) for ${visualFailures.benchmarkImageCount ?? 0} imported image(s).`,
    warmCacheGeneratedNearZero: `Warm-cache run generated ${visualFailures.warmCacheGeneratedCount ?? 0} thumbnail(s), above limit ${REAL_BOARD_WARM_CACHE_GENERATED_LIMIT}.`,
    frameTimeP95WithinLimit: `Frame time p95 ${visualFailures.frameTimeP95Ms}ms exceeded limit ${visualFailures.frameTimeP95LimitMs}ms.`,
    noRightSideOcclusion: `Right occlusion ${visualFailures.rightOcclusionPx}px or drawable mismatch ${visualFailures.drawableRightMismatchPx}px exceeded 8px.`,
    hotPathReactCommitsWithinLimit: `Hot path React commits ${interactionBurst.hotPathReactCommits} exceeded limit ${REAL_BOARD_HOT_PATH_REACT_COMMIT_LIMIT}.`,
    postIdleReactCommitsWithinLimit: `Deferred/post-idle React commits ${interactionBurst.postIdleReactCommits} exceeded limit ${REAL_BOARD_POST_IDLE_REACT_COMMIT_LIMIT}.`,
    noMaximumUpdateDepthErrors: 'Renderer logs contained Maximum update depth exceeded.',
    windowPlacementConfirmed:
      visualFailures.windowPlacementFailures.join(' ') ||
      'Benchmark window placement could not be confirmed as non-intrusive.',
    repeatWorkloadAccepted: `Repeat-heavy real workload requires at least ${
      visualFailures.repeatMinUniqueImageCount ?? 0
    } unique source image(s) for ${visualFailures.repeatBenchmarkImageCount ?? 0} benchmark item(s); found ${
      visualFailures.repeatUniqueImageCount ?? 0
    }. Lower MAGICPOT_REAL_BOARD_REPEAT_MIN_UNIQUE_FRACTION only for diagnostic smoke runs.`,
    pressureSamplingEnabledWhenConfigured:
      'Pressure sampling was configured but did not run in the real-board benchmark stress path.',
    pressureSamplingCompleted: `Pressure sampling was configured but captured only ${visualFailures.pressureSampleCount} sample(s).`,
    noPressureMissingImages: `${pressureFailures?.missingImages ?? 0} missing image(s) were observed during pressure sampling.`,
    noPressurePermanentPlaceholders: `${pressureFailures?.placeholders ?? 0} permanent placeholder image(s) were observed during pressure sampling.`,
    noPressureSourceUpgradeFailures: `${pressureFailures?.sourceUpgradeFailures ?? 0} source image upgrade failure(s) were observed during pressure sampling.`,
    noPressureRightSideOcclusion: `Pressure right occlusion ${pressureFailures?.rightOcclusionPx ?? 0}px or drawable mismatch ${pressureFailures?.drawableRightMismatchPx ?? 0}px exceeded 8px.`,
    noPressureMaximumUpdateDepthErrors:
      'Renderer logs contained Maximum update depth exceeded during pressure sampling.',
    noPressureSustainedMonotonicGrowth: `Pressure sampling observed sustained monotonic growth: ${(
      pressureFailures?.sustainedMonotonicGrowthFailures ?? []
    )
      .map((failure) => `${failure.metric} +${failure.maxGrowth}`)
      .join(', ')}.`
  }
  const failures = Object.entries(acceptance)
    .filter(([, value]) => typeof value === 'boolean')
    .filter(([, value]) => !value)
    .map(([key]) => failureLabels[key] || key)

  return {
    ...acceptance,
    failures,
    passed: failures.length === 0
  }
}

async function writeAggregateReport(aggregateRoot, currentResults) {
  const aggregatePath = path.join(aggregateRoot, 'aggregate-report.json')
  let existingResults = []
  try {
    const existing = JSON.parse(await fs.readFile(aggregatePath, 'utf8'))
    if (Array.isArray(existing.results)) {
      existingResults = existing.results
    }
  } catch {
    existingResults = []
  }

  const resultKey = (result) =>
    `${result.corpusLabel || 'unknown'}:${result.scenarioMode || 'unknown'}:${result.cachePass || 'single'}:${result.benchmarkImageCount || REAL_BOARD_IMAGE_COUNT}`
  const currentKeys = new Set(currentResults.map(resultKey))
  const mergedResults = [
    ...existingResults.filter((result) => !currentKeys.has(resultKey(result))),
    ...currentResults
  ].sort((left, right) => resultKey(left).localeCompare(resultKey(right)))
  const passedResults = mergedResults.filter((result) => result.acceptance?.passed === true).length
  const failedResults = mergedResults.length - passedResults
  const aggregate = {
    runId: BENCHMARK_RUN_ID,
    generatedAt: new Date().toISOString(),
    artifactRoot: aggregateRoot,
    cachePasses: REAL_BOARD_CACHE_PASSES,
    resultCount: mergedResults.length,
    passedResults,
    failedResults,
    allPassed: mergedResults.length > 0 && failedResults === 0,
    memoryWatchdog: buildAggregateMemoryWatchdogReport(BENCHMARK_MEMORY_WATCHDOG.getReport()),
    results: mergedResults
  }

  await fs.writeFile(aggregatePath, JSON.stringify(aggregate, null, 2), 'utf8')
  return aggregate
}

function buildAggregateMemoryWatchdogReport(report) {
  if (!report) {
    return null
  }

  return {
    enabled: report.enabled,
    thresholds: report.thresholds,
    tripped: report.tripped,
    latest: report.latest,
    peak: report.peak,
    sampleCount: Array.isArray(report.samples) ? report.samples.length : 0
  }
}

function buildAggregateScenarioResult(payload) {
  const pressure = payload.pressure
  const finalMetrics = payload.finalMetrics ?? {}
  const webgl = finalMetrics.webgl ?? {}
  const overlayMetrics = finalMetrics.overlayMetrics ?? {}

  return {
    corpusLabel: payload.corpusLabel,
    corpusRoot: payload.corpusRoot,
    scenarioMode: payload.scenarioMode,
    cachePass: payload.cachePass ?? null,
    benchmarkImageCount: payload.benchmarkImageCount,
    scenarioRoot: payload.scenarioRoot,
    reportPath: payload.reportPath,
    corpus: payload.corpus,
    candidateImageCount: payload.candidateImageCount,
    uniqueContentHashCount: payload.uniqueContentHashCount,
    decodedImageCount: payload.decodedImageCount,
    skippedImageCount: payload.skippedImageCount,
    culledImageCount: payload.culledImageCount,
    allowRepeat: payload.allowRepeat ?? false,
    importBatching: payload.importBatching ?? null,
    isSmokeRun: payload.isSmokeRun ?? false,
    workloadKind:
      payload.workloadKind ?? (payload.allowRepeat ? 'repeat-heavy-real' : 'unique-real'),
    benchmarkUniqueImageCount: payload.benchmarkUniqueImageCount ?? null,
    benchmarkUniqueContentHashCount: payload.benchmarkUniqueContentHashCount ?? null,
    frameTime: payload.frameTime,
    hotPathReactCommits: payload.hotPathReactCommits,
    sourceUpgradeLatencyMs: payload.sourceUpgradeLatencyMs,
    sourceUpgradeFailures: payload.sourceUpgradeFailures,
    persistentPreviewCount: payload.persistentPreviewCount,
    metrics: {
      reactCommits: finalMetrics.reactCommits ?? payload.reactCommits ?? null,
      domNodeCount: finalMetrics.domNodeCount ?? payload.domNodeCount ?? null,
      jsHeapBytes: finalMetrics.jsHeapBytes ?? payload.jsHeapBytes ?? null,
      overlayTotalCount: overlayMetrics.overlayTotalCount ?? null,
      domOverlayCount: overlayMetrics.domOverlayCount ?? null,
      mountedVideoOverlayCount: overlayMetrics.mountedVideoOverlayCount ?? null,
      loadedImageCount: webgl.loadedImageCount ?? payload.webgl?.loadedImageCount ?? null,
      failedImageCount: webgl.failedImageCount ?? payload.webgl?.failedImageCount ?? null,
      missingImageCount: webgl.missingImageCount ?? payload.webgl?.missingImageCount ?? null,
      placeholderCount: webgl.placeholderCount ?? payload.webgl?.placeholderCount ?? null,
      placeholderMetricAvailable:
        webgl.placeholderMetricAvailable ?? payload.webgl?.placeholderMetricAvailable ?? false,
      residentImageCount: webgl.residentImageCount ?? payload.webgl?.residentImageCount ?? null,
      residentTextureBytes:
        webgl.residentTextureBytes ?? payload.webgl?.residentTextureBytes ?? null,
      residentTextureBudgetBytes:
        webgl.residentTextureBudgetBytes ?? payload.webgl?.residentTextureBudgetBytes ?? null,
      previewCount: webgl.previewCount ?? payload.webgl?.previewCount ?? null,
      sourceCount: webgl.sourceCount ?? payload.webgl?.sourceCount ?? null,
      sourceUpgradeSuppressedImageCount:
        webgl.sourceUpgradeSuppressedImageCount ??
        payload.webgl?.sourceUpgradeSuppressedImageCount ??
        null,
      sourceUpgradeablePreviewCount:
        webgl.sourceUpgradeablePreviewCount ?? payload.webgl?.sourceUpgradeablePreviewCount ?? null,
      upgradePendingCount: webgl.upgradePendingCount ?? payload.webgl?.upgradePendingCount ?? null,
      sourceUpgradeFailedImageCount:
        webgl.sourceUpgradeFailedImageCount ?? payload.webgl?.sourceUpgradeFailedImageCount ?? null
    },
    thumbnailCache: finalMetrics.thumbnailCache ?? payload.thumbnailCache ?? null,
    tinyZoomAcceptance: payload.tinyZoomAcceptance ?? null,
    ...(pressure
      ? {
          pressure: {
            enabled: true,
            configuredDurationMs: pressure.configuredDurationMs,
            configuredSampleIntervalMs: pressure.configuredSampleIntervalMs,
            durationMs: pressure.durationMs,
            sampleCount: pressure.sampleCount,
            summary: pressure.summary,
            sustainedMonotonicGrowth: pressure.sustainedMonotonicGrowth
          }
        }
      : {}),
    memoryWatchdog: buildAggregateMemoryWatchdogReport(payload.memoryWatchdog),
    visualFailures: payload.visualFailures,
    acceptance: payload.acceptance
  }
}

async function runRealBoardScenarioPass({
  corpusConfig,
  cachePass,
  scenarioName,
  scenarioRoot,
  userDataDir,
  staged,
  corpusManifest
}) {
  let appHandle = null

  try {
    await fs.mkdir(scenarioRoot, { recursive: true })
    appHandle = await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioName}:launch-app`, () =>
      launchApp(userDataDir)
    )
    BENCHMARK_MEMORY_WATCHDOG.registerAppHandle(appHandle, userDataDir)
    const { page, fatalErrors } = appHandle
    await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioName}:navigate`, () =>
      navigateToHash(
        page,
        `#/canvas?id=real-board-benchmark-${sanitizeProjectCanvasRunId(cachePass, 'cache-pass')}`
      )
    )
    await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioName}:wait-healthy`, () =>
      waitForHealthyPage(page, fatalErrors)
    )

    const importPlan = await importBenchmarkImageFiles(page, staged.stagedImages, scenarioName)
    await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioName}:post-import-settle`, () =>
      page.waitForTimeout(3000)
    )

    const initialMetrics = await BENCHMARK_MEMORY_WATCHDOG.guard(
      `${scenarioName}:wait-benchmark-metrics`,
      () => waitForBenchmarkMetrics(page, staged.stagedImages.length)
    )
    const interactionBurst = await BENCHMARK_MEMORY_WATCHDOG.guard(
      `${scenarioName}:interaction-burst`,
      () => runContinuousInteractionBurst(page, REAL_BOARD_BURST_MS)
    )
    const interactionBenchmark = await BENCHMARK_MEMORY_WATCHDOG.guard(
      `${scenarioName}:interaction-benchmark`,
      () => runInteractionBenchmark(page, INTERACTION_SAMPLE_COUNT)
    )
    const highZoomUpgrade =
      REAL_BOARD_MODE === 'import'
        ? null
        : await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioName}:high-zoom-upgrade`, () =>
            measureHighZoomUpgrade(page)
          )
    const pressure = REAL_BOARD_PRESSURE_CONFIGURED
      ? await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioName}:pressure-sampling`, () =>
          runPressureSampling(
            page,
            REAL_BOARD_PRESSURE_DURATION_MS,
            REAL_BOARD_PRESSURE_SAMPLE_INTERVAL_MS
          )
        )
      : null
    const tinyZoomAcceptance = await BENCHMARK_MEMORY_WATCHDOG.guard(
      `${scenarioName}:tiny-zoom-acceptance`,
      () => runTinyZoomAcceptanceProbe(page)
    )
    const finalMetrics =
      tinyZoomAcceptance.metrics ??
      (await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioName}:read-final-metrics`, () =>
        readBenchmarkMetrics(page)
      ))
    const windowPlacement = await BENCHMARK_MEMORY_WATCHDOG.guard(
      `${scenarioName}:read-window-placement`,
      () => readWindowPlacement(appHandle.app)
    )
    const windowPlacementResult = buildWindowPlacementResult(
      windowPlacement,
      `Real board benchmark (${corpusConfig.corpusLabel}/${scenarioName})`
    )
    const screenshotPath = path.join(scenarioRoot, 'real-board-screenshot.png')
    await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioName}:screenshot`, () =>
      page.screenshot({ path: screenshotPath, fullPage: false })
    )

    const drawableRightMismatchPx = Math.abs(
      finalMetrics.viewport.clientRect.right - finalMetrics.viewport.drawableRect.right
    )
    const sourceTextureFailures = buildSourceTextureVisualFailures(highZoomUpgrade, finalMetrics)
    const repeatWorkloadAssessment = buildRepeatWorkloadAssessment({
      allowRepeat: REAL_BOARD_ALLOW_REPEAT,
      benchmarkImageCount: staged.stagedImages.length,
      benchmarkUniqueContentHashCount: staged.uniqueContentHashCount
    })
    const visualFailures = {
      benchmarkImageCount: staged.stagedImages.length,
      cachePass,
      missingImages: finalMetrics.webgl.missingImageCount,
      placeholderMetricAvailable: finalMetrics.webgl.placeholderMetricAvailable,
      permanentPlaceholders: finalMetrics.webgl.placeholderCount,
      corruptedBlocks: 0,
      persistentBlurredImages: highZoomUpgrade?.persistentBlurredImages ?? 0,
      tinyZoomEnabled: tinyZoomAcceptance.enabled === true,
      tinyZoomStageScaleReached: tinyZoomAcceptance.stageScaleReached === true,
      tinyZoomStageScale: tinyZoomAcceptance.stageScale ?? null,
      tinyZoomSourceCount: tinyZoomAcceptance.sourceCountAtTinyZoom ?? null,
      overviewSourceSuppressionAtTinyZoom:
        tinyZoomAcceptance.enabled !== true ||
        (tinyZoomAcceptance.stageScale <= REAL_BOARD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE &&
          tinyZoomAcceptance.sourceCountAtTinyZoom === 0),
      tinyZoomCoordinateMappingFinite: tinyZoomAcceptance.coordinateMappingFinite !== false,
      warmCacheRun: isWarmCachePass(cachePass),
      warmCacheMetricsAvailable:
        !isWarmCachePass(cachePass) || finalMetrics.thumbnailCache.metricAvailable === true,
      warmCacheHitCount: finalMetrics.thumbnailCache.cacheHitCount,
      warmCacheGeneratedCount: finalMetrics.thumbnailCache.cacheGeneratedCount,
      warmCacheHitsCoverImported:
        !isWarmCachePass(cachePass) ||
        finalMetrics.thumbnailCache.cacheHitCount >= staged.stagedImages.length,
      warmCacheGeneratedNearZero:
        !isWarmCachePass(cachePass) ||
        finalMetrics.thumbnailCache.cacheGeneratedCount <= REAL_BOARD_WARM_CACHE_GENERATED_LIMIT,
      frameTimeP95Ms: interactionBenchmark.frameTime.p95,
      frameTimeP95Overflow:
        REAL_BOARD_IMAGE_COUNT <= 300 &&
        REAL_BOARD_FRAME_P95_LIMIT_MS > 0 &&
        interactionBenchmark.frameTime.p95 > REAL_BOARD_FRAME_P95_LIMIT_MS,
      frameTimeP95LimitMs: REAL_BOARD_IMAGE_COUNT <= 300 ? REAL_BOARD_FRAME_P95_LIMIT_MS : null,
      rightSideOcclusion: finalMetrics.viewport.rightOcclusionPx > 8 || drawableRightMismatchPx > 8,
      rightOcclusionPx: finalMetrics.viewport.rightOcclusionPx,
      drawableRightMismatchPx: Number(drawableRightMismatchPx.toFixed(2)),
      failedImages: finalMetrics.webgl.failedImageCount,
      ...sourceTextureFailures,
      hotPathReactCommitOverflow:
        interactionBurst.hotPathReactCommits > REAL_BOARD_HOT_PATH_REACT_COMMIT_LIMIT,
      postIdleReactCommitOverflow:
        interactionBurst.postIdleReactCommits > REAL_BOARD_POST_IDLE_REACT_COMMIT_LIMIT,
      maximumUpdateDepthErrors: fatalErrors.filter((message) =>
        /Maximum update depth exceeded/i.test(message)
      ).length,
      windowPlacementFailures: windowPlacementResult.failures,
      ...repeatWorkloadAssessment,
      pressureSamplingConfigured: REAL_BOARD_PRESSURE_CONFIGURED,
      pressureSamplingIncomplete:
        REAL_BOARD_PRESSURE_CONFIGURED && (pressure?.sampleCount ?? 0) < 2,
      pressureSampleCount: pressure?.sampleCount ?? 0,
      ...(pressure ? { pressure: buildPressureVisualFailures(pressure, fatalErrors) } : {})
    }
    const acceptance = buildAcceptance({ finalMetrics, visualFailures, interactionBurst })
    const decodedImageCount =
      initialMetrics.itemCounts?.totalImageItemCount ?? initialMetrics.webgl.loadedImageCount
    const culledImageCount = Math.max(
      initialMetrics.webgl.viewportCulledImageCount,
      decodedImageCount - (initialMetrics.itemCounts?.visibleImageItemCount ?? decodedImageCount)
    )
    const skippedImageCount = 0
    const corpus = {
      label: corpusConfig.corpusLabel,
      root: corpusConfig.sourceImageDir,
      candidateImageCount: corpusManifest?.candidateImageCount ?? staged.sourceImageCount,
      uniqueContentHashCount:
        corpusManifest?.uniqueContentHashCount ?? staged.uniqueContentHashCount,
      decodedImageCount,
      skippedImageCount
    }
    const payload = {
      corpusLabel: corpusConfig.corpusLabel,
      corpusRoot: corpusConfig.sourceImageDir,
      corpus,
      scenarioMode: REAL_BOARD_MODE,
      cachePass,
      benchmarkImageCount: staged.stagedImages.length,
      candidateImageCount: corpusManifest?.candidateImageCount ?? staged.sourceImageCount,
      decodedImageCount,
      skippedImageCount,
      culledImageCount,
      extensionBreakdown: corpusManifest?.extensionBreakdown ?? {},
      byteSize: corpusManifest?.byteSize ?? null,
      sourceImageCount: staged.sourceImageCount,
      uniqueSourceImageCount:
        corpusManifest?.uniqueContentHashCount ?? staged.uniqueContentHashCount,
      uniqueImageCount: corpusManifest?.uniqueContentHashCount ?? staged.uniqueImageCount,
      uniqueContentHashCount:
        corpusManifest?.uniqueContentHashCount ?? staged.uniqueContentHashCount,
      benchmarkUniqueImageCount: staged.uniqueImageCount,
      benchmarkUniqueContentHashCount: staged.uniqueContentHashCount,
      duplicateContentCount: corpusManifest?.duplicateContentCount ?? 0,
      mixedBreakdown: staged.mixedBreakdown ?? null,
      allowRepeat: REAL_BOARD_ALLOW_REPEAT,
      importBatching: importPlan,
      isSmokeRun: repeatWorkloadAssessment.repeatSmokeRun,
      workloadKind: REAL_BOARD_ALLOW_REPEAT
        ? repeatWorkloadAssessment.repeatWorkloadAccepted
          ? 'repeat-heavy-real'
          : 'repeat-smoke'
        : 'unique-real',
      scenarioRoot,
      windowPlacement,
      windowPlacementAssessment: windowPlacementResult.assessment,
      frameTime: interactionBenchmark.frameTime,
      hotPathReactCommits: interactionBurst.hotPathReactCommits,
      interactionBurst,
      reactCommits: finalMetrics.reactCommits,
      domNodeCount: finalMetrics.domNodeCount,
      jsHeapBytes: finalMetrics.jsHeapBytes,
      webgl: {
        residentImageCount: finalMetrics.webgl.residentImageCount,
        residentTextureBytes: finalMetrics.webgl.residentTextureBytes,
        residentTextureBudgetBytes: finalMetrics.webgl.residentTextureBudgetBytes,
        missingImageCount: finalMetrics.webgl.missingImageCount,
        placeholderMetricAvailable: finalMetrics.webgl.placeholderMetricAvailable,
        placeholderCount: finalMetrics.webgl.placeholderCount,
        previewCount: finalMetrics.webgl.previewCount,
        sourceCount: finalMetrics.webgl.sourceCount,
        sourceUpgradeSuppressedImageCount: finalMetrics.webgl.sourceUpgradeSuppressedImageCount,
        sourceUpgradeablePreviewCount: finalMetrics.webgl.sourceUpgradeablePreviewCount,
        upgradePendingCount: finalMetrics.webgl.upgradePendingCount,
        sourceUpgradeFailedImageCount: finalMetrics.webgl.sourceUpgradeFailedImageCount,
        loadedImageCount: finalMetrics.webgl.loadedImageCount,
        failedImageCount: finalMetrics.webgl.failedImageCount
      },
      thumbnailCache: finalMetrics.thumbnailCache,
      viewport: finalMetrics.viewport,
      visualFailures,
      acceptance,
      initialMetrics,
      finalMetrics,
      tinyZoomAcceptance,
      highZoomUpgrade,
      ...(pressure ? { pressure } : {}),
      memoryWatchdog: BENCHMARK_MEMORY_WATCHDOG.getReport(),
      sourceUpgradeLatencyMs: highZoomUpgrade?.upgradeLatencyMs ?? null,
      sourceUpgradeFailures: visualFailures.sourceUpgradeFailures,
      persistentPreviewCount:
        highZoomUpgrade?.persistentBlurredImages ?? finalMetrics.webgl.previewCount,
      interactionBenchmark,
      screenshotPath
    }

    const reportPath = path.join(scenarioRoot, 'real-board-benchmark-report.json')
    await fs.writeFile(reportPath, JSON.stringify(payload, null, 2), 'utf8')
    console.log(JSON.stringify(payload, null, 2))
    return buildAggregateScenarioResult({ ...payload, reportPath })
  } catch (error) {
    await fs.mkdir(scenarioRoot, { recursive: true })
    const errorPath = path.join(scenarioRoot, 'real-board-benchmark-error.txt')
    await fs.writeFile(errorPath, toErrorMessage(error), 'utf8')
    console.error(toErrorMessage(error))
    return {
      corpusLabel: corpusConfig.corpusLabel,
      corpusRoot: corpusConfig.sourceImageDir,
      scenarioMode: REAL_BOARD_MODE,
      cachePass,
      benchmarkImageCount: REAL_BOARD_IMAGE_COUNT,
      scenarioRoot,
      errorPath,
      memoryWatchdog: BENCHMARK_MEMORY_WATCHDOG.getReport(),
      acceptance: {
        passed: false,
        failures: [error instanceof Error ? error.message : String(error)],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  } finally {
    await closeBenchmarkApp(appHandle, userDataDir)
    BENCHMARK_MEMORY_WATCHDOG.unregisterAppHandle(appHandle)
  }
}

async function runRealBoardScenario(corpusConfig, aggregateRoot) {
  const scenarioBaseName = buildScenarioName(REAL_BOARD_MODE, REAL_BOARD_IMAGE_COUNT)
  const scenarioBaseRoot = path.join(aggregateRoot, corpusConfig.corpusLabel, scenarioBaseName)

  try {
    BENCHMARK_MEMORY_WATCHDOG.throwIfTripped(`${scenarioBaseName}:start`)
    await fs.mkdir(scenarioBaseRoot, { recursive: true })
    const tempRoot = await fs.mkdtemp(path.join(scenarioBaseRoot, 'magicpot-real-board-benchmark-'))
    const userDataDir = path.join(tempRoot, 'user-data')
    await writeSmokeConfig(userDataDir)

    const requiredRealUniqueCount = getRequiredRealCorpusUniqueCount(
      REAL_BOARD_MODE,
      REAL_BOARD_IMAGE_COUNT
    )
    const corpusManifest = corpusConfig.sourceImageDir
      ? await BENCHMARK_MEMORY_WATCHDOG.guard(`${scenarioBaseName}:build-corpus-manifest`, () =>
          buildRealCorpusManifest(corpusConfig.sourceImageDir, requiredRealUniqueCount, {
            allowRepeat: REAL_BOARD_ALLOW_REPEAT
          })
        )
      : null
    if (corpusManifest) {
      await fs.writeFile(
        path.join(scenarioBaseRoot, 'corpus-manifest.json'),
        JSON.stringify(
          {
            ...corpusManifest,
            uniqueSourceImages: undefined
          },
          null,
          2
        ),
        'utf8'
      )
    }

    const staged = await BENCHMARK_MEMORY_WATCHDOG.guard(
      `${scenarioBaseName}:prepare-benchmark-images`,
      () =>
        prepareBenchmarkImages({
          sourceImageDir: corpusConfig.sourceImageDir,
          sourceManifest: corpusManifest,
          tempRoot,
          count: REAL_BOARD_IMAGE_COUNT,
          scenarioMode: REAL_BOARD_MODE
        })
    )
    const results = []
    for (const cachePass of REAL_BOARD_CACHE_PASSES) {
      const scenarioName = buildScenarioName(REAL_BOARD_MODE, REAL_BOARD_IMAGE_COUNT, cachePass)
      const scenarioRoot = path.join(scenarioBaseRoot, cachePass)
      results.push(
        await runRealBoardScenarioPass({
          corpusConfig,
          cachePass,
          scenarioName,
          scenarioRoot,
          userDataDir,
          staged,
          corpusManifest
        })
      )
    }

    return results
  } catch (error) {
    await fs.mkdir(scenarioBaseRoot, { recursive: true })
    const errorPath = path.join(scenarioBaseRoot, 'real-board-benchmark-error.txt')
    await fs.writeFile(errorPath, toErrorMessage(error), 'utf8')
    console.error(toErrorMessage(error))
    return [
      {
        corpusLabel: corpusConfig.corpusLabel,
        corpusRoot: corpusConfig.sourceImageDir,
        scenarioMode: REAL_BOARD_MODE,
        cachePass: null,
        benchmarkImageCount: REAL_BOARD_IMAGE_COUNT,
        scenarioRoot: scenarioBaseRoot,
        errorPath,
        memoryWatchdog: BENCHMARK_MEMORY_WATCHDOG.getReport(),
        acceptance: {
          passed: false,
          failures: [error instanceof Error ? error.message : String(error)],
          error: error instanceof Error ? error.message : String(error)
        }
      }
    ]
  }
}

async function main() {
  const aggregateRoot = path.join(resolveProjectCanvasArtifactRoot(BENCHMARK_RUN_ID), 'real-board')
  BENCHMARK_MEMORY_WATCHDOG.start()

  try {
    if (!SUPPORTED_REAL_BOARD_MODES.has(REAL_BOARD_MODE)) {
      throw new Error(
        `Unsupported MAGICPOT_REAL_BOARD_MODE=${REAL_BOARD_MODE}. Expected import, seeded-hires, or mixed.`
      )
    }

    await fs.mkdir(aggregateRoot, { recursive: true })
    const corpusConfigs = parseCorpusConfigs()
    const results = []
    for (const corpusConfig of corpusConfigs) {
      results.push(...(await runRealBoardScenario(corpusConfig, aggregateRoot)))
    }
    const aggregate = await writeAggregateReport(aggregateRoot, results)
    console.log(JSON.stringify(aggregate, null, 2))

    if (!aggregate.allPassed) {
      process.exitCode = 1
    }
  } catch (error) {
    await fs.mkdir(aggregateRoot, { recursive: true })
    await fs.writeFile(
      path.join(aggregateRoot, 'real-board-benchmark-error.txt'),
      toErrorMessage(error),
      'utf8'
    )
    console.error(toErrorMessage(error))
    process.exitCode = 1
  } finally {
    BENCHMARK_MEMORY_WATCHDOG.stop()
    try {
      await fs.mkdir(aggregateRoot, { recursive: true })
      await fs.writeFile(
        path.join(aggregateRoot, 'memory-watchdog-report.json'),
        JSON.stringify(BENCHMARK_MEMORY_WATCHDOG.getReport(), null, 2),
        'utf8'
      )
    } catch {
      // The benchmark result is already represented by the aggregate or error report.
    }
  }
}

const isDirectRun =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  await main()
}

export {
  buildAcceptance,
  buildAggregateScenarioResult,
  buildPressureVisualFailures,
  buildRepeatWorkloadAssessment,
  buildSourceTextureVisualFailures,
  main
}
