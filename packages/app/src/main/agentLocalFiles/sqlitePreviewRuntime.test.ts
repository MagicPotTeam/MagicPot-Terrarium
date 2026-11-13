import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runOwnedSqliteSnapshotPreview } from './sqlitePreviewRuntime'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('owned SQLite snapshot runtime only', () => {
  it('reads only supplied owned snapshot using engine readonly and removes temporary copies on success/failure', () => {
    // Explicit owned fixture under project trash; never userData or a selected database.
    const base = path.resolve('../../.magicpot-trash')
    const root = mkdtempSync(path.join(base, 'p5-sqlite-owned-')); roots.push(root)
    const source = path.join(root, 'synthetic.sqlite')
    const db = new DatabaseSync(source)
    try { db.exec("CREATE TABLE fixture(id INTEGER,label TEXT); INSERT INTO fixture VALUES(1,'synthetic only')") }
    finally { db.close() }
    const bytes = readFileSync(source)
    const request = { version: 1, requestId: 'fixture', snapshotBase64: bytes.toString('base64'), table: 'fixture', columns: ['id', 'label'], limit: 10 }
    expect(runOwnedSqliteSnapshotPreview(request, root)).toMatchObject({ rows: [{ id: 1, label: 'synthetic only' }], source: 'supplied-standalone-snapshot', liveDatabaseConsistency: false, nativeWorkBounded: false })
    expect(readdirSync(root)).toEqual(['synthetic.sqlite'])
    expect(readFileSync(source)).toEqual(bytes)
    expect(() => runOwnedSqliteSnapshotPreview({ ...request, table: 'missing' }, root)).toThrow()
    expect(readdirSync(root)).toEqual(['synthetic.sqlite'])
  })
})
