import fs, { constants } from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { FigPluginCheckpointStore, type CheckpointCodec } from './checkpointStore'

/** Electron 41 on Windows can encrypt before Chromium has saved its fresh profile key.
 * Read only this app's bounded sessionData/Local State; never write it, reveal the key or invent a
 * plaintext fallback. A missing/changed profile fails closed until the key is persisted.
 * This version-specific check must be reviewed when upgrading Electron's crypto adapter.
 */
export function windowsCheckpointKeyReady(): boolean {
  let fd: number | undefined
  try {
    const root = app.getPath('sessionData')
    const parent = fs.lstatSync(root, { bigint: true })
    if (!parent.isDirectory() || parent.isSymbolicLink()) return false
    const file = path.join(root, 'Local State')
    const before = fs.lstatSync(file, { bigint: true })
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > 4n * 1024n * 1024n
    )
      return false
    fd = fs.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(fd, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      return false
    const data = Buffer.alloc(Number(opened.size) + 1)
    let count = 0
    while (count < data.length) {
      const read = fs.readSync(fd, data, count, data.length - count, count)
      if (!read) break
      count += read
    }
    const after = fs.fstatSync(fd, { bigint: true })
    const linked = fs.lstatSync(file, { bigint: true })
    if (
      BigInt(count) !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      linked.ino !== before.ino ||
      linked.dev !== before.dev
    )
      return false
    const value = JSON.parse(data.subarray(0, count).toString('utf8'))
    return (
      typeof value?.os_crypt?.encrypted_key === 'string' &&
      value.os_crypt.encrypted_key.length > 0 &&
      value.os_crypt.encrypted_key.length < 65536
    )
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// This checkout uses Electron 41. Newer async safeStorage APIs need a separate migration.
// Never enable setUsePlainTextEncryption or silently use Linux's basic_text fallback.
export const checkpointCodec: CheckpointCodec = {
  available: () => {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux')
      return !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())
    if (process.platform === 'win32') {
      // Trigger initialization with non-sensitive fixed text before checking persistence.
      safeStorage.encryptString('MagicPot checkpoint key readiness')
      return windowsCheckpointKeyReady()
    }
    return true
  },
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data)
}
export const createCheckpointStore = (root: string): FigPluginCheckpointStore =>
  new FigPluginCheckpointStore(root, checkpointCodec)
