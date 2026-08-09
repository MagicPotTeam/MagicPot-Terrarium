import { lstatSync, unlinkSync } from 'node:fs'
import { safeFileTestHooks } from './safe-file.ts'

process.env.NODE_ENV = 'test'

export const safeDeleteTestHooks = { beforeUnlink: undefined }

export function installSafeDeleteTestDelegate() {
  safeFileTestHooks.safeDelete = {
    inspect(request) {
      const stat = lstatSync(request.path, { bigint: true })
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('foreign')
      return { volumeSerial: stat.dev, fileIndex: stat.ino }
    },
    delete(request) {
      let stat
      try { stat = lstatSync(request.path, { bigint: true }) } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') return { status: 'deleted' }
        throw error
      }
      if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== request.identity.volumeSerial || stat.ino !== request.identity.fileIndex) return { status: 'deleted-foreign-preserved' }
      safeDeleteTestHooks.beforeUnlink?.(request)
      const current = lstatSync(request.path, { bigint: true })
      if (current.isSymbolicLink() || !current.isFile() || current.dev !== request.identity.volumeSerial || current.ino !== request.identity.fileIndex) return { status: 'deleted-foreign-preserved' }
      unlinkSync(request.path)
      return { status: 'deleted' }
    }
  }
}

export function resetSafeDeleteTestHooks() { safeDeleteTestHooks.beforeUnlink = undefined }
installSafeDeleteTestDelegate()
