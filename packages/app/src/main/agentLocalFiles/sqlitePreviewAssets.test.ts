import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SQLITE_PREVIEW_ENTRY, verifySqlitePreviewAssets } from './sqlitePreviewAssets'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('fixed SQLite worker asset verification', () => {
  it('accepts only fixed entry bytes and refuses tampering or path substitution', () => {
    const root = mkdtempSync(path.resolve('../../.magicpot-trash/p5-sqlite-assets-')); roots.push(root)
    const folder = path.join(root, 'out/sqlite-preview-worker'); mkdirSync(folder, { recursive: true })
    const bytes = 'synthetic fixed worker fixture; never execute'
    writeFileSync(path.join(root, SQLITE_PREVIEW_ENTRY), bytes)
    const manifest = { protocol: 'magicpot-sqlite-preview-assets/v1', files: [{ path: SQLITE_PREVIEW_ENTRY, sha256: createHash('sha256').update(bytes).digest('hex') }] }
    const manifestFile = path.join(folder, 'manifest.json')
    writeFileSync(manifestFile, JSON.stringify(manifest))
    expect(verifySqlitePreviewAssets(root)).toBe(path.join(root, SQLITE_PREVIEW_ENTRY))
    writeFileSync(path.join(root, SQLITE_PREVIEW_ENTRY), 'changed')
    expect(() => verifySqlitePreviewAssets(root)).toThrow()
    manifest.files[0].path = '../other.cjs'
    writeFileSync(manifestFile, JSON.stringify(manifest))
    expect(() => verifySqlitePreviewAssets(root)).toThrow()
  })
})
