import fs from 'node:fs'
import path from 'node:path'
import { vol } from 'memfs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const appListeners = new Map<string, (...args: unknown[]) => void>()
  return {
    appListeners,
    app: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => appListeners.set(event, listener)),
      getAppMetrics: vi.fn(() => []),
      getPath: vi.fn((name: string) => `/user-data/${name}`)
    },
    crashReporter: { start: vi.fn() },
    powerMonitor: { on: vi.fn() }
  }
})

vi.mock('electron', () => ({
  app: h.app,
  BrowserWindow: { getAllWindows: () => [] },
  crashReporter: h.crashReporter,
  powerMonitor: h.powerMonitor
}))

import { markAppQuitting, resetAppQuittingForTests } from './appQuitState'
import {
  appendProcessEventLine,
  createProcessDiagnostics,
  MAX_PROCESS_EVENT_LINES,
  pruneCrashDumps,
  startLocalCrashDumps,
  startProcessDiagnostics,
  type ProcessEventLine
} from './processDiagnostics'

const LOGS = '/user-data/logs'
const EVENTS = path.join(LOGS, 'process-events.jsonl')

const metric = (type: string, pid: number, workingSetKb: number, privateKb?: number) => ({
  type,
  pid,
  creationTime: 0,
  cpu: { percentCPUUsage: 1.234, idleWakeupsPerSecond: 0 },
  memory: {
    workingSetSize: workingSetKb,
    peakWorkingSetSize: workingSetKb * 2,
    ...(privateKb === undefined ? {} : { privateBytes: privateKb })
  }
})

function readLines(): Array<Record<string, any>> {
  return fs
    .readFileSync(EVENTS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function createClock() {
  let now = 1_700_000_000_000
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('processDiagnostics', () => {
  beforeEach(() => {
    vol.reset()
    h.appListeners.clear()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetAppQuittingForTests()
  })

  it('starts the crash handler without upload', () => {
    startLocalCrashDumps()
    expect(h.crashReporter.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ uploadToServer: false })
    )
    expect(h.crashReporter.start.mock.calls[0]?.[0]).not.toHaveProperty('submitURL')
  })

  it('writes one line per renderer death with reason, exit code, the last 30 s of samples, RAM and the last send stage', () => {
    const clock = createClock()
    let rendererKb = 400 * 1024
    const breadcrumb = { stage: 'request-built', imageCount: 8, imageBytes: 7_000_000, dataUrlCount: 8, dataUrlChars: 9_300_000 }
    const diagnostics = createProcessDiagnostics({
      now: clock.now,
      getAppMetrics: () => [metric('Browser', 10, 200 * 1024), metric('Tab', 11, rendererKb, rendererKb + 1024), metric('GPU', 12, 60 * 1024)] as never,
      getWindowRenderers: () => ({ '7': 11 }),
      mainHeapUsedBytes: () => 50 * 1024 * 1024,
      freeMem: () => 2 * 1024 ** 3,
      totalMem: () => 16 * 1024 ** 3,
      logsDir: () => LOGS,
      setTimeout: () => ({}),
      lastSendStageFor: (id) => (id === 7 ? breadcrumb : null)
    })
    for (let index = 0; index < 15; index += 1) {
      diagnostics.sampleNow()
      clock.advance(3_000)
      rendererKb += 100 * 1024
    }

    diagnostics.recordRendererGone(7, { reason: 'oom', exitCode: -536870904 })

    const [line] = readLines() as ProcessEventLine[] as Array<Record<string, any>>
    expect(line).toMatchObject({
      v: 1,
      kind: 'renderer-gone',
      processType: 'renderer',
      reason: 'oom',
      exitCode: -536870904,
      webContentsId: 7,
      lastKnownPid: 11,
      freeMemMb: 2048,
      totalMemMb: 16384,
      lastSendStage: breadcrumb
    })
    expect(new Date(line.at).getTime()).toBe(clock.now())
    // Only the last 30 s are kept (one sample every 3 s, plus the one taken at the death).
    expect(line.samples.length).toBeGreaterThanOrEqual(10)
    expect(line.samples.length).toBeLessThanOrEqual(11)
    expect(clock.now() - line.samples[0].at).toBeLessThanOrEqual(30_000)
    const lastTab = line.samples.at(-1).processes.find((process: { type: string }) => process.type === 'Tab')
    expect(lastTab).toMatchObject({ pid: 11, workingSetMb: 1900, privateMb: 1901, cpuPercent: 1.2 })
    expect(line.samples.at(-1).mainHeapUsedMb).toBe(50)
  })

  it('records GPU and utility deaths, ignores clean exits and everything while quitting', () => {
    const diagnostics = createProcessDiagnostics({ logsDir: () => LOGS, getAppMetrics: () => [], setTimeout: () => ({}) })

    diagnostics.recordChildGone({ type: 'Utility', reason: 'clean-exit', exitCode: 0, name: 'Document worker' })
    diagnostics.recordRendererGone(1, { reason: 'clean-exit', exitCode: 0 })
    expect(fs.existsSync(EVENTS)).toBe(false)

    diagnostics.recordChildGone({ type: 'GPU', reason: 'crashed', exitCode: 139 })
    diagnostics.recordChildGone({ type: 'Utility', reason: 'killed', exitCode: 9, serviceName: 'network.mojom.NetworkService', name: 'Network Service' })
    markAppQuitting()
    diagnostics.recordChildGone({ type: 'GPU', reason: 'killed', exitCode: 15 })
    diagnostics.recordRendererGone(1, { reason: 'killed', exitCode: 15 })

    expect(readLines().map(({ kind, processType, name, reason, exitCode }) => ({ kind, processType, name, reason, exitCode }))).toEqual([
      { kind: 'child-gone', processType: 'GPU', name: undefined, reason: 'crashed', exitCode: 139 },
      { kind: 'child-gone', processType: 'Utility', name: 'Network Service', reason: 'killed', exitCode: 9 }
    ])
  })

  it('wires app-level renderer and child deaths', () => {
    startProcessDiagnostics({ logsDir: () => LOGS, getAppMetrics: () => [], setInterval: () => ({}), setTimeout: () => ({}) })
    h.appListeners.get('render-process-gone')?.({}, { id: 3 }, { reason: 'crashed', exitCode: 5 })
    h.appListeners.get('child-process-gone')?.({}, { type: 'GPU', reason: 'oom', exitCode: 1 })
    expect(readLines().map((line) => [line.kind, line.reason, line.webContentsId])).toEqual([
      ['renderer-gone', 'crashed', 3],
      ['child-gone', 'oom', undefined]
    ])
  })

  it('keeps the file bounded to the last 200 lines', () => {
    const line = (index: number) => ({ v: 1, at: String(index), kind: 'child-gone', processType: 'GPU', reason: 'crashed', exitCode: index, freeMemMb: 1, totalMemMb: 2, samples: [], lastSendStage: null }) as ProcessEventLine
    for (let index = 0; index < MAX_PROCESS_EVENT_LINES + 25; index += 1) appendProcessEventLine(EVENTS, line(index))
    const lines = readLines()
    expect(lines).toHaveLength(MAX_PROCESS_EVENT_LINES)
    expect(lines[0].exitCode).toBe(25)
    expect(lines.at(-1)?.exitCode).toBe(MAX_PROCESS_EVENT_LINES + 24)
  })

  it('keeps only the newest five minidumps and never removes folders or other files', () => {
    const root = '/user-data/crashDumps'
    vol.mkdirSync(path.join(root, 'completed'), { recursive: true })
    vol.mkdirSync(path.join(root, 'reports'), { recursive: true })
    for (let index = 0; index < 8; index += 1) {
      const file = path.join(root, index % 2 ? 'reports' : 'completed', `dump-${index}.dmp`)
      vol.writeFileSync(file, 'x')
      vol.utimesSync(file, 1000 + index, 1000 + index)
    }
    vol.writeFileSync(path.join(root, 'settings.dat'), 'keep')

    expect(pruneCrashDumps(root)).toBe(3)

    const left = [...vol.readdirSync(path.join(root, 'completed')), ...vol.readdirSync(path.join(root, 'reports'))].sort()
    expect(left).toEqual(['dump-3.dmp', 'dump-4.dmp', 'dump-5.dmp', 'dump-6.dmp', 'dump-7.dmp'])
    expect(vol.existsSync(path.join(root, 'settings.dat'))).toBe(true)
  })

  it('logs a main-loop stall only when the 1 s probe fires more than 3 s late', () => {
    let tick = 0
    const warn = vi.mocked(console.warn)
    const diagnostics = createProcessDiagnostics({ monotonicNow: () => tick, logsDir: () => LOGS })
    tick += 1_000
    diagnostics.checkMainLoopLag()
    tick += 3_900
    diagnostics.checkMainLoopLag()
    expect(warn).not.toHaveBeenCalled()
    tick += 5_000
    diagnostics.checkMainLoopLag()
    expect(warn).toHaveBeenCalledExactlyOnceWith('[App] Main process event loop was blocked', { lateByMs: 4000 })
    // After a system sleep the baseline is reset instead of reporting a stall.
    tick += 600_000
    diagnostics.resetMainLoopLag()
    tick += 1_000
    diagnostics.checkMainLoopLag()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
