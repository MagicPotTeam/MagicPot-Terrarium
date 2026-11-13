import path from 'node:path'
import { runSqlitePreviewWorker, type SqlitePreviewPort } from './sqlitePreviewWorker'

// Dedicated fixed utility entry only. The one scratch argument is supplied by MAIN's
// operation owner, not IPC/model input; no source database filename is accepted.
const port = (process as NodeJS.Process & { parentPort?: SqlitePreviewPort }).parentPort
const scratchRoot = process.argv[2]
if (process.type !== 'utility' || !port || process.argv.length !== 3 || !scratchRoot || !path.isAbsolute(scratchRoot)) process.exit(2)
process.on('uncaughtException', () => process.exit(2))
process.on('unhandledRejection', () => process.exit(2))
runSqlitePreviewWorker(port!, scratchRoot, code => process.exit(code))
