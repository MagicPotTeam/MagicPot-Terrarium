import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createOwnedDatabasePreview } from './ownedDatabasePreview'

describe('owned SQLite preview engine policy (memory fixture only)', () => {
  it('reads a bounded projection and denies write, attach, pragmas and functions at engine level', () => {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE TABLE fixture (id INTEGER, label TEXT); INSERT INTO fixture VALUES (1,'one'),(2,'two')")
    const preview = createOwnedDatabasePreview(db)
    try {
      expect(preview.readTable('fixture', ['id', 'label'], 1)).toMatchObject({ rows: [{ id: 1, label: 'one' }], truncated: true, nativeWorkBounded: false })
      for (const sql of ["INSERT INTO fixture VALUES (3,'three')", 'DELETE FROM fixture', "ATTACH ':memory:' AS other", 'PRAGMA user_version', 'SELECT randomblob(100)', 'CREATE TABLE denied(x)']) {
        expect(() => db.prepare(sql).all()).toThrow()
      }
      expect(() => preview.readTable('fixture;DROP', ['id'])).toThrow()
      expect(() => preview.readTable('fixture', ['id'], 101)).toThrow()
    } finally { preview.close() }
    expect(db.isOpen).toBe(false)
    expect(() => preview.readTable('fixture', ['id'])).toThrow()
  })
  it('rejects oversized returned values without claiming native work bound', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE fixture(label TEXT)')
    db.prepare('INSERT INTO fixture VALUES (?)').run('x'.repeat(4097))
    const preview = createOwnedDatabasePreview(db)
    try { expect(() => preview.readTable('fixture', ['label'])).toThrow('cell exceeds') }
    finally { preview.close() }
  })
})
