import log from 'electron-log/renderer'

// Forward renderer info/warn/error logs to the main-process log stream so
// the in-app terminal can show normal runtime progress instead of only errors.
log.transports.ipc.level = 'info'

console.log = log.log
console.debug = log.debug
console.info = log.info
console.warn = log.warn

// Filter the known MUI v7 Menu Fragment warning because it does not affect runtime behavior.
const originalError = log.error.bind(log)
let lastMaximumDepthDiagnosticAt = 0
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes("Menu component doesn't accept a Fragment")) {
    return
  }

  if (
    args.some((arg) => typeof arg === 'string' && arg.includes('Maximum update depth exceeded'))
  ) {
    const now = Date.now()
    if (now - lastMaximumDepthDiagnosticAt > 1000) {
      lastMaximumDepthDiagnosticAt = now
      originalError(
        '[renderer] Maximum update depth diagnostic stack',
        new Error('Maximum update depth diagnostic').stack
      )
    }
  }

  originalError(...args)
}

export default log
