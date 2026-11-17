import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import { resolveEarlyPortableUserDataDirectory } from '../config/portablePaths'

export type LogEntry = {
  level: string
  message: string
  timestamp: number
}

type LogListener = (entry: LogEntry) => void
const listeners: Set<LogListener> = new Set()
const MAX_HISTORY = 1000
// One entry of the replayed history (and of every live stream to the renderer)
// keeps at most this many UTF-16 code units: without a cap a single logged data
// URL or request body stays in main's memory for the next 999 entries. The
// renderer shows at most 16 Ki characters per entry as well (utils/logText.ts).
// The file transport is not affected: it still receives the whole message.
export const MAX_LOG_HISTORY_ENTRY_CHARACTERS = 16 * 1024
const LOG_HISTORY_TRUNCATION = '[log truncated]'
const history: LogEntry[] = []

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Keep the head and the tail of an oversized log message. The cuts never fall
 * between the two halves of a surrogate pair, so no character is split into a
 * lone surrogate (which would become U+FFFD on the way to the renderer).
 */
export function capLogHistoryMessage(
  message: string,
  limit = MAX_LOG_HISTORY_ENTRY_CHARACTERS
): string {
  if (message.length <= limit) return message
  const marker = ` ${LOG_HISTORY_TRUNCATION} `
  const budget = Math.max(0, limit - marker.length)
  let headEnd = Math.ceil(budget / 2)
  let tailStart = message.length - (budget - headEnd)
  if (headEnd > 0 && isHighSurrogate(message.charCodeAt(headEnd - 1))) headEnd -= 1
  if (tailStart < message.length && isLowSurrogate(message.charCodeAt(tailStart))) tailStart += 1
  return message.slice(0, headEnd) + marker + message.slice(tailStart)
}
let reportingListenerError = false

function reportListenerError(prefix: string, error: unknown): void {
  // console.error is itself routed through the hook below. Guard the report so
  // a broken stream listener cannot recursively report its own failure forever.
  if (reportingListenerError) return
  reportingListenerError = true
  try {
    console.error(prefix, error)
  } catch {
    // Logging must not turn a listener failure into another uncaught failure.
  } finally {
    reportingListenerError = false
  }
}

function isBrokenConsoleStreamError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
}

export const addLogListener = (listener: LogListener) => {
  let replayFailed = false
  // Replay history
  history.forEach((entry) => {
    try {
      listener(entry)
    } catch (e) {
      replayFailed = true
      reportListenerError('Log replay error:', e)
    }
  })

  // Do not retain a listener that already failed while replaying history.
  if (!replayFailed) listeners.add(listener)
  return () => listeners.delete(listener)
}

function configurePortableLogPath(): void {
  const logPath = path.join(resolveEarlyPortableUserDataDirectory(), 'logs', 'main.log')
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  log.transports.file.resolvePathFn = () => logPath
}

configurePortableLogPath()

// Initialize the logger
log.initialize()

const originalConsoleWriteFn =
  typeof log.transports.console.writeFn === 'function'
    ? log.transports.console.writeFn.bind(log.transports.console)
    : null
let consoleTransportDisabled = process.env['MAGICPOT_MCP_STDIO_SERVER'] === '1'

export const setConsoleTransportEnabled = (enabled: boolean): void => {
  consoleTransportDisabled = !enabled
}

if (originalConsoleWriteFn) {
  log.transports.console.writeFn = (payload) => {
    if (consoleTransportDisabled) return

    try {
      originalConsoleWriteFn(payload)
    } catch (error) {
      if (isBrokenConsoleStreamError(error)) {
        // Dev runs can outlive the launching shell. When stdout/stderr disappears,
        // trying to mirror logs to the console can trap the app in an EPIPE loop.
        consoleTransportDisabled = true
        return
      }

      throw error
    }
  }
}

// Hook into electron-log
log.hooks.push((message, transport) => {
  if (transport !== log.transports.console) return message

  // 简易处理：尝试将对象转换为字符串，避免 [object Object]
  const formatArg = (arg: unknown): string => {
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    }
    return String(arg)
  }

  const entry: LogEntry = {
    level: message.level,
    message: capLogHistoryMessage(message.data.map(formatArg).join(' ')),
    timestamp: Date.now()
  }

  // Add to history
  history.push(entry)
  if (history.length > MAX_HISTORY) {
    history.shift()
  }

  // Iterate over a snapshot: a listener can fail or unsubscribe reentrantly
  // while another listener is handling the same entry.
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    try {
      listener(entry)
    } catch (e) {
      // A stream whose onData throws is no longer usable (usually because its
      // MessagePort has closed). Remove it before reporting the failure so the
      // report itself cannot be delivered back to the broken listener.
      listeners.delete(listener)
      reportListenerError('Log listener error:', e)
    }
  }

  return message
})

console.log = log.log
console.debug = log.debug
console.info = log.info
console.warn = log.warn
console.error = log.error

export default log
