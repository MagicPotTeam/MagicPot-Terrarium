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
const history: LogEntry[] = []

function isBrokenConsoleStreamError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
}

export const addLogListener = (listener: LogListener) => {
  // Replay history
  history.forEach((entry) => {
    try {
      listener(entry)
    } catch (e) {
      console.error('Log replay error:', e)
    }
  })

  listeners.add(listener)
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
    message: message.data.map(formatArg).join(' '),
    timestamp: Date.now()
  }

  // Add to history
  history.push(entry)
  if (history.length > MAX_HISTORY) {
    history.shift()
  }

  listeners.forEach((listener) => {
    try {
      listener(entry)
    } catch (e) {
      console.error('Log listener error:', e)
    }
  })

  return message
})

console.log = log.log
console.debug = log.debug
console.info = log.info
console.warn = log.warn
console.error = log.error

export default log
