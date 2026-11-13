import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
import { mkdtempSync, rmSync, writeFileSync, linkSync } from 'node:fs'
import path from 'node:path'
import { readExplicitlySelectedSqliteSnapshot } from './sqliteSelectedSnapshot'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('dedicated explicit selected SQLite snapshot identity', () => {
  it('reads only bounded selected ordinary file and checks authority during the read', () => {
    const root = mkdtempSync(path.resolve('../../.magicpot-trash/p5-selected-sqlite-')); roots.push(root)
    const file = path.join(root, 'synthetic.db'), bytes = Buffer.alloc(100)
    bytes.write('SQLite format 3\0', 'binary'); writeFileSync(file, bytes)
    const check = vi.fn()
    expect(readExplicitlySelectedSqliteSnapshot(file, check)).toEqual(bytes)
    expect(check.mock.calls.length).toBeGreaterThan(1)
    expect(() => readExplicitlySelectedSqliteSnapshot(file, () => { throw new Error('scope stale') })).toThrow('scope stale')
    expect(() => readExplicitlySelectedSqliteSnapshot('relative.db', check)).toThrow()
    const linked = path.join(root, 'hardlink.db'); linkSync(file, linked)
    expect(() => readExplicitlySelectedSqliteSnapshot(linked, check)).toThrow('Linked')
  })
})
