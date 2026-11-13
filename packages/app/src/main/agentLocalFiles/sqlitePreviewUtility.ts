import { app, utilityProcess } from 'electron'
import { createSqlitePreviewSupervisor, type SqlitePreviewChild } from './sqlitePreviewSupervisor'
import { createSqlitePreviewScratchOwner } from './sqlitePreviewScratchOwner'
import { verifySqlitePreviewAssets } from './sqlitePreviewAssets'

type Options = {
  appRoot?: () => string; isReady?: () => boolean
  verifyAssets?: (root: string) => string
  fork?: (entry: string, args: string[], options: Electron.ForkOptions) => SqlitePreviewChild
}
/** Trusted MAIN-only factory. No IPC operation exposes these dependencies or scratchRoot.
 * Does not spawn until run; fixed verified entry, allowlisted environment, no user source path.
 * Utility isolation is fault containment, not an OS filesystem/network sandbox.
 */
export function createSqlitePreviewUtility(trustedPrivateRoot: string, options: Options = {}) {
  let owner: ReturnType<typeof createSqlitePreviewScratchOwner> | undefined
  const fork = options.fork ?? ((entry, args, settings) => utilityProcess.fork(entry, args, settings))
  const supervisor = createSqlitePreviewSupervisor(() => {
    if (!(options.isReady ?? (() => app.isReady()))()) throw new Error('SQLite utility unavailable before ready.')
    const entry = (options.verifyAssets ?? verifySqlitePreviewAssets)((options.appRoot ?? (() => app.getAppPath()))())
    owner = createSqlitePreviewScratchOwner(trustedPrivateRoot)
    const env: Record<string, string> = { LANG: 'C' }
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]!
    return fork(entry, [owner.directory], { env, stdio: 'pipe', serviceName: 'MagicPot SQLite preview' })
  }, () => { owner?.cleanupAfterExit(); owner = undefined })
  return Object.freeze({ run: supervisor.run, isOccupied: supervisor.isOccupied })
}
