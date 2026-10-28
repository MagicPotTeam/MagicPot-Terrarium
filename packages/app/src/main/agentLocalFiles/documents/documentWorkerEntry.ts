import { runDocumentWorker, type DocumentWorkerPort } from './documentWorkerRuntime'

// Only the fixed Electron utility entry may own parentPort. No stdin/argv/URL fallback.
const port = (process as NodeJS.Process & { parentPort?: DocumentWorkerPort }).parentPort
if (process.type !== 'utility' || !port) process.exit(2)
process.on('uncaughtException', () => process.exit(2))
process.on('unhandledRejection', () => process.exit(2))
runDocumentWorker(port, (code) => process.exit(code))
