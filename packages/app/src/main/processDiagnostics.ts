// packages/app/src/main/processDiagnostics.ts
// Records why a process of the app died, so that a report like "the window turned white" can be
// diagnosed afterwards: exit reason, exit code, the memory of every process during the last 30 s,
// free / total RAM and the last chat send stage the renderer reported.
//
// Everything stays on this PC: one bounded JSON-lines file under <userData>/logs and, for native
// crashes, local minidumps. Nothing is uploaded and nothing here contains message text, file
// names or paths.
import { app, BrowserWindow, crashReporter, powerMonitor, type ProcessMetric } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { isAppQuitting, isSessionEnding } from './appQuitState'
import { takeExpectedRendererExit } from './expectedRendererExits'
import {
  forgetChatSendStage,
  getLastChatSendStage,
  registerChatSendStageIpc
} from './chatSendStageBreadcrumbs'

export const PROCESS_EVENTS_FILE_NAME = 'process-events.jsonl'
export const MAX_PROCESS_EVENT_LINES = 200
const MAX_PROCESS_EVENTS_FILE_BYTES = 4 * 1024 * 1024
export const MAX_CRASH_DUMPS = 5
const METRICS_SAMPLE_INTERVAL_MS = 3_000
const METRICS_WINDOW_MS = 30_000
const LAG_PROBE_INTERVAL_MS = 1_000
const LAG_REPORT_THRESHOLD_MS = 3_000
const DUMP_PRUNE_DELAY_MS = 15_000

const KB_PER_MB = 1024
const BYTES_PER_MB = 1024 * 1024

export type ProcessMemorySample = {
  /** ms since the epoch */
  at: number
  processes: Array<{
    type: string
    pid: number
    /** Chromium's own label, e.g. 'GPU' or 'Network Service'; never user data. */
    name?: string
    workingSetMb: number
    peakWorkingSetMb: number
    /** Windows only */
    privateMb?: number
    cpuPercent: number
  }>
  /** pid of the renderer of each open window at sample time, by webContents id */
  windowRenderers: Record<string, number>
  mainHeapUsedMb: number
}

export type ProcessEventLine = {
  v: 1
  at: string
  kind: 'renderer-gone' | 'child-gone'
  processType: string
  name?: string
  reason: string
  exitCode: number
  webContentsId?: number
  /** pid the dead renderer had in the last sample, when known */
  lastKnownPid?: number
  /** Set when the app ended the process itself, e.g. the user chose to reload a hung window. */
  expected?: string
  /** True for a helper process the app starts itself (document text, SQLite preview, Bridge child). */
  appOwned?: true
  freeMemMb: number
  totalMemMb: number
  samples: ProcessMemorySample[]
  /** Last chat send stage reported by the renderer (counts and sizes only), when any. */
  lastSendStage: unknown
}

type ProcessDiagnosticsDeps = {
  now: () => number
  monotonicNow: () => number
  getAppMetrics: () => ProcessMetric[]
  getWindowRenderers: () => Record<string, number>
  mainHeapUsedBytes: () => number
  freeMem: () => number
  totalMem: () => number
  logsDir: () => string
  setInterval: (callback: () => void, ms: number) => { unref?: () => void }
  setTimeout: (callback: () => void, ms: number) => { unref?: () => void }
}

const roundMb = (value: number, divisor: number) => Math.round((value / divisor) * 10) / 10

function defaultWindowRenderers(): Record<string, number> {
  const renderers: Record<string, number> = {}
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    const pid = window.webContents.getOSProcessId()
    if (pid > 0) renderers[String(window.webContents.id)] = pid
  }
  return renderers
}

const defaultDeps = (): ProcessDiagnosticsDeps => ({
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  getAppMetrics: () => app.getAppMetrics(),
  getWindowRenderers: defaultWindowRenderers,
  mainHeapUsedBytes: () => process.memoryUsage().heapUsed,
  freeMem: () => os.freemem(),
  totalMem: () => os.totalmem(),
  logsDir: () => app.getPath('logs'),
  setInterval: (callback, ms) => setInterval(callback, ms),
  setTimeout: (callback, ms) => setTimeout(callback, ms)
})

/** Keeps the memory samples of the last 30 s. One sample is a single native call plus a small object. */
export class ProcessMemoryRing {
  private samples: ProcessMemorySample[] = []

  constructor(private readonly deps: Pick<ProcessDiagnosticsDeps, 'now' | 'getAppMetrics' | 'getWindowRenderers' | 'mainHeapUsedBytes'>) {}

  sample(): void {
    let metrics: ProcessMetric[]
    let windowRenderers: Record<string, number> = {}
    try {
      metrics = this.deps.getAppMetrics()
    } catch {
      return
    }
    try {
      windowRenderers = this.deps.getWindowRenderers()
    } catch {
      // A window that is closing must not stop the sampling.
    }
    const at = this.deps.now()
    this.samples.push({
      at,
      processes: metrics.map((metric) => ({
        type: metric.type,
        pid: metric.pid,
        ...(metric.name ? { name: metric.name } : {}),
        // Electron reports these in KB.
        workingSetMb: roundMb(metric.memory.workingSetSize, KB_PER_MB),
        peakWorkingSetMb: roundMb(metric.memory.peakWorkingSetSize, KB_PER_MB),
        ...(typeof metric.memory.privateBytes === 'number'
          ? { privateMb: roundMb(metric.memory.privateBytes, KB_PER_MB) }
          : {}),
        cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10
      })),
      windowRenderers,
      mainHeapUsedMb: roundMb(this.deps.mainHeapUsedBytes(), BYTES_PER_MB)
    })
    this.samples = this.samples.filter((sample) => at - sample.at <= METRICS_WINDOW_MS)
  }

  snapshot(): ProcessMemorySample[] {
    return this.samples.slice()
  }
}

/**
 * Appends one line and keeps only the last MAX_PROCESS_EVENT_LINES lines. Deaths are rare, so
 * reading the small file back on each append is cheap; the file never grows without bound.
 */
export function appendProcessEventLine(filePath: string, line: ProcessEventLine): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  let existing: string[] = []
  try {
    const stat = fs.statSync(filePath)
    if (stat.size <= MAX_PROCESS_EVENTS_FILE_BYTES * 2) {
      existing = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    }
  } catch {
    existing = []
  }
  const lines = [...existing, JSON.stringify(line)]
  let kept = lines.slice(-MAX_PROCESS_EVENT_LINES)
  // Also bound the bytes (a line is a few KB; this only matters for a damaged file).
  while (kept.length > 1 && kept.reduce((total, entry) => total + entry.length + 1, 0) > MAX_PROCESS_EVENTS_FILE_BYTES) {
    kept = kept.slice(1)
  }
  const temporaryPath = `${filePath}.tmp`
  fs.writeFileSync(temporaryPath, `${kept.join('\n')}\n`, 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

/** Deletes all but the newest MAX_CRASH_DUMPS minidump files below the crash dump folder (files only). */
export function pruneCrashDumps(crashDumpsDir: string, keep = MAX_CRASH_DUMPS): number {
  const dumps: Array<{ file: string; mtimeMs: number }> = []
  const visit = (directory: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory() && depth < 3) visit(fullPath, depth + 1)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) {
        try {
          dumps.push({ file: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs })
        } catch {
          // Being written or already gone.
        }
      }
    }
  }
  visit(crashDumpsDir, 0)
  dumps.sort((left, right) => right.mtimeMs - left.mtimeMs)
  let removed = 0
  for (const dump of dumps.slice(keep)) {
    try {
      fs.unlinkSync(dump.file)
      removed += 1
    } catch {
      // Locked by the crash handler: the next prune takes it.
    }
  }
  return removed
}

/**
 * Starts Chromium's crash handler so that a native crash of any process leaves a minidump.
 * Must run before the app is ready.
 *
 * Privacy: uploadToServer is false, so dumps are NEVER sent anywhere; they stay in the local
 * <userData>/crashDumps folder, which is capped to the newest MAX_CRASH_DUMPS dumps. A dump holds
 * process memory (it can contain prompt text or image bytes), so it is only for a person who is
 * asked to look at this PC and chooses to share it.
 */
export function startLocalCrashDumps(): void {
  try {
    crashReporter.start({ uploadToServer: false, compress: true })
  } catch (error) {
    console.warn('[App] Local crash dumps could not be enabled', error)
  }
}

export type ProcessDiagnostics = {
  recordRendererGone: (webContentsId: number, details: { reason: string; exitCode: number }) => void
  recordChildGone: (details: { type: string; reason: string; exitCode: number; name?: string; serviceName?: string }) => void
  sampleNow: () => void
  checkMainLoopLag: () => void
  resetMainLoopLag: () => void
}

export type ProcessDiagnosticsOptions = Partial<ProcessDiagnosticsDeps> & {
  /** The last send-stage breadcrumb of a renderer, by webContents id. */
  lastSendStageFor?: (webContentsId: number | undefined) => unknown
  crashDumpsDir?: () => string
  /** The window whose page may report send-stage breadcrumbs; without it none is accepted. */
  getMainWindow?: () => BrowserWindow | null
}

// The quit was confirmed, an update is being installed or Windows is ending the session:
// processes that go away then are not deaths.
const isShuttingDown = (): boolean => isAppQuitting() || isSessionEnding()

// Helper processes the app starts with utilityProcess.fork all carry a 'MagicPot ...' service
// name. The app ends them itself on timeout or cancel (reported as 'killed'): not a death.
const isAppOwnedUtility = (details: { type: string; name?: string; serviceName?: string }): boolean =>
  details.type === 'Utility' &&
  [details.name, details.serviceName].some((name) => typeof name === 'string' && name.startsWith('MagicPot '))

export function createProcessDiagnostics(options: ProcessDiagnosticsOptions = {}): ProcessDiagnostics {
  const deps: ProcessDiagnosticsDeps = { ...defaultDeps(), ...options }
  const ring = new ProcessMemoryRing(deps)
  const lastSendStageFor = options.lastSendStageFor ?? getLastChatSendStage
  const crashDumpsDir = options.crashDumpsDir ?? (() => app.getPath('crashDumps'))
  let prunePending = false
  let lastLagTick = deps.monotonicNow()

  const schedulePrune = () => {
    if (prunePending) return
    prunePending = true
    // Give the crash handler time to finish writing the new dump.
    deps.setTimeout(() => {
      prunePending = false
      try {
        pruneCrashDumps(crashDumpsDir())
      } catch {
        // Never let housekeeping fail the app.
      }
    }, DUMP_PRUNE_DELAY_MS).unref?.()
  }

  const write = (line: Omit<ProcessEventLine, 'v' | 'at' | 'freeMemMb' | 'totalMemMb' | 'samples'>) => {
    try {
      // One fresh sample so that the line also shows the moment right after the death.
      ring.sample()
      appendProcessEventLine(path.join(deps.logsDir(), PROCESS_EVENTS_FILE_NAME), {
        v: 1,
        at: new Date(deps.now()).toISOString(),
        ...line,
        freeMemMb: roundMb(deps.freeMem(), BYTES_PER_MB),
        totalMemMb: roundMb(deps.totalMem(), BYTES_PER_MB),
        samples: ring.snapshot()
      })
    } catch (error) {
      console.warn('[App] Could not record the process event', error)
    }
    schedulePrune()
  }

  // When each renderer last died: a sample from before that belongs to the previous (dead) process.
  const lastRendererGoneAt = new Map<number, number>()
  const lastKnownPidOf = (webContentsId: number) => {
    const samples = ring.snapshot()
    const previousDeath = lastRendererGoneAt.get(webContentsId) ?? -Infinity
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      if (samples[index].at <= previousDeath) break
      const pid = samples[index].windowRenderers[String(webContentsId)]
      if (pid) return pid
    }
    return undefined
  }

  return {
    recordRendererGone(webContentsId, details) {
      // Taken even when nothing is written, so that it cannot name a later exit.
      const expected = takeExpectedRendererExit(webContentsId)
      if (details.reason === 'clean-exit' || isShuttingDown()) return
      const lastKnownPid = lastKnownPidOf(webContentsId)
      lastRendererGoneAt.set(webContentsId, deps.now())
      write({
        kind: 'renderer-gone',
        processType: 'renderer',
        reason: details.reason,
        exitCode: details.exitCode,
        webContentsId,
        ...(lastKnownPid ? { lastKnownPid } : {}),
        ...(expected ? { expected } : {}),
        lastSendStage: lastSendStageFor(webContentsId) ?? null
      })
    },
    recordChildGone(details) {
      if (details.reason === 'clean-exit' || isShuttingDown()) return
      const appOwned = isAppOwnedUtility(details)
      if (appOwned && details.reason === 'killed') return
      console.error('[App] Child process gone', {
        type: details.type,
        name: details.name,
        reason: details.reason,
        exitCode: details.exitCode
      })
      write({
        kind: 'child-gone',
        processType: details.type,
        ...(details.name || details.serviceName ? { name: details.name || details.serviceName } : {}),
        reason: details.reason,
        exitCode: details.exitCode,
        ...(appOwned ? { appOwned } : {}),
        lastSendStage: lastSendStageFor(undefined) ?? null
      })
    },
    sampleNow: () => ring.sample(),
    resetMainLoopLag() {
      lastLagTick = deps.monotonicNow()
    },
    checkMainLoopLag() {
      const tick = deps.monotonicNow()
      const lateBy = tick - lastLagTick - LAG_PROBE_INTERVAL_MS
      lastLagTick = tick
      if (lateBy > LAG_REPORT_THRESHOLD_MS) {
        // A blocked main process also whitens / freezes every window on Windows.
        console.warn('[App] Main process event loop was blocked', { lateByMs: Math.round(lateBy) })
      }
    }
  }
}

/**
 * Wires the recorder to the app once it is ready: renderer and child process deaths, the 3 s
 * memory sampler and the 1 s main-loop lag probe (both timers are unref'd and do no I/O).
 */
export function startProcessDiagnostics(options: ProcessDiagnosticsOptions = {}): ProcessDiagnostics {
  const deps: ProcessDiagnosticsDeps = { ...defaultDeps(), ...options }
  const diagnostics = createProcessDiagnostics(options)
  registerChatSendStageIpc(options.getMainWindow ?? (() => null))
  app.on('render-process-gone', (_event, webContents, details) => {
    diagnostics.recordRendererGone(webContents.id, details)
    // A later death of the reloaded page must not repeat this page's last stage.
    forgetChatSendStage(webContents.id)
  })
  app.on('child-process-gone', (_event, details) => {
    diagnostics.recordChildGone(details)
  })
  diagnostics.sampleNow()
  deps.setInterval(() => diagnostics.sampleNow(), METRICS_SAMPLE_INTERVAL_MS).unref?.()
  let suspended = false
  try {
    // A system sleep stops timers; that is not a blocked main process.
    powerMonitor.on('suspend', () => {
      suspended = true
    })
    powerMonitor.on('resume', () => {
      suspended = false
      diagnostics.resetMainLoopLag()
    })
  } catch {
    // powerMonitor is unavailable in some test runtimes.
  }
  deps.setInterval(() => {
    if (suspended) diagnostics.resetMainLoopLag()
    else diagnostics.checkMainLoopLag()
  }, LAG_PROBE_INTERVAL_MS).unref?.()
  deps.setTimeout(() => {
    try {
      pruneCrashDumps(options.crashDumpsDir?.() ?? app.getPath('crashDumps'))
    } catch {
      // Housekeeping only.
    }
  }, DUMP_PRUNE_DELAY_MS).unref?.()
  return diagnostics
}
