import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
export const SQLITE_PREVIEW_ENTRY = 'out/sqlite-preview-worker/index.cjs'
/** Fixed installation asset verification; corruption detection, not code signing. */
export function verifySqlitePreviewAssets(appRoot: string): string {
  const manifest = JSON.parse(readFileSync(path.join(appRoot, 'out/sqlite-preview-worker/manifest.json'), 'utf8'))
  if (manifest?.protocol !== 'magicpot-sqlite-preview-assets/v1' || !Array.isArray(manifest.files) || manifest.files.length !== 1 ||
    manifest.files[0]?.path !== SQLITE_PREVIEW_ENTRY || !/^[a-f0-9]{64}$/.test(manifest.files[0]?.sha256)) throw new Error('SQLite preview assets unavailable.')
  const entry = path.join(appRoot, SQLITE_PREVIEW_ENTRY)
  if (createHash('sha256').update(readFileSync(entry)).digest('hex') !== manifest.files[0].sha256) throw new Error('SQLite preview assets unavailable.')
  return entry
}
