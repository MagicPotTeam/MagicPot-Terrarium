import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryNativeWriteCoordinator,
  SqliteNativeWriteCoordinator,
  NATIVE_WRITE_MAX_RESERVATIONS,
  NATIVE_WRITE_DRAIN_MS,
  type NativeWriteReservation
} from './nativeWriteCoordinator'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const roots: string[] = []
const NOW = 1_900_000_000_000
const reservation = (seed = 1, expiresAt = NOW + 120_000): NativeWriteReservation => ({
  resourceKey: 'a'.repeat(64),
  actionId: seed.toString(16).padStart(32, '0'),
  fingerprint: seed.toString(16).padStart(64, '0'),
  expiresAt
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-owned-writes-'))
  roots.push(root)
  let now = NOW
  const store = () => new SqliteNativeWriteCoordinator(path.join(root, 'store'), () => now)
  return {
    root,
    store,
    setTime: (value: number) => {
      now = value
    }
  }
}
for (const mode of ['memory', 'sqlite'] as const)
  describe(`${mode} native document reservations`, () => {
    const make = () => {
      const f = fixture(),
        memory = new MemoryNativeWriteCoordinator(() => clock)
      let clock = NOW
      return {
        ...f,
        store: mode === 'memory' ? () => memory : f.store,
        setTime(value: number) {
          clock = value
          f.setTime(value)
        }
      }
    }
    it('permits one owner and exact duplicate, without extending or replacing its reservation', () => {
      const f = make(),
        a = f.store(),
        b = f.store()
      expect(a.reserve(reservation())).toBe(true)
      expect(b.reserve(reservation(2))).toBe(false)
      expect(b.reserve(reservation())).toBe(true)
      expect(b.reserve({ ...reservation(), expiresAt: NOW + 119000 })).toBe(false)
      expect(b.reserve({ ...reservation(), fingerprint: 'c'.repeat(64) })).toBe(false)
      expect(a.owns(reservation())).toBe(true)
      expect(b.owns(reservation(2))).toBe(false)
    })
    it('exact release permits next owner and stale/foreign release cannot free it', () => {
      const f = make(),
        a = f.store(),
        b = f.store()
      a.reserve(reservation())
      b.release(reservation(2))
      expect(b.reserve(reservation(2))).toBe(false)
      a.release(reservation())
      expect(b.reserve(reservation(2))).toBe(true)
      a.release(reservation())
      expect(a.reserve(reservation(3))).toBe(false)
    })
    it('allows another resource but prevents reusing an action ID for another resource', () => {
      const f = make(),
        a = f.store()
      a.reserve(reservation())
      expect(a.reserve({ ...reservation(), resourceKey: 'b'.repeat(64) })).toBe(false)
      expect(a.reserve({ ...reservation(2), resourceKey: 'b'.repeat(64) })).toBe(true)
    })
    it('holds after the authorization expires and only releases after the fixed drain interval', () => {
      const f = make(),
        a = f.store()
      a.reserve(reservation())
      f.setTime(NOW + 120001)
      expect(a.owns(reservation())).toBe(false)
      expect(a.reserve(reservation(2, NOW + 240000))).toBe(false)
      f.setTime(NOW + 120000 + NATIVE_WRITE_DRAIN_MS)
      expect(a.reserve(reservation(2, NOW + 240000))).toBe(true)
      expect(() => a.reserve(reservation())).toThrow()
    })
    it('does not evict a live reservation when capacity is exhausted', () => {
      const f = make(),
        a = f.store()
      for (let i = 1; i <= NATIVE_WRITE_MAX_RESERVATIONS; i++)
        expect(
          a.reserve({ ...reservation(i), resourceKey: i.toString(16).padStart(64, '0') })
        ).toBe(true)
      expect(a.reserve(reservation(1000))).toBe(false)
      expect(a.owns({ ...reservation(), resourceKey: (1).toString(16).padStart(64, '0') })).toBe(
        true
      )
    })
    it('refuses a backwards clock instead of expiring records early', () => {
      const f = make(),
        a = f.store()
      a.reserve(reservation())
      f.setTime(NOW - 1)
      expect(() => a.reserve(reservation(2))).toThrow()
      f.setTime(NOW)
      expect(a.owns(reservation())).toBe(true)
    })
    it.each([
      { expiresAt: NOW },
      { expiresAt: NOW + 120001 },
      { actionId: 'bad' },
      { resourceKey: 'a'.repeat(64) + '\n' },
      { sessionToken: 'PRIVATE' },
      { plan: 'PRIVATE' }
    ])('refuses unbounded or authority-bearing input %j', (extra) => {
      const f = make(),
        a = f.store()
      expect(() => a.reserve({ ...reservation(), ...extra })).toThrow()
    })
  })
describe('real disk persistence and failure boundaries', () => {
  it('is lazy, reopens after all objects are dropped, and persists no document content or credentials', () => {
    const f = fixture(),
      a = f.store()
    expect(a.owns(reservation())).toBe(false)
    a.release(reservation())
    expect(fs.existsSync(a.file)).toBe(false)
    a.reserve(reservation())
    expect(f.store().reserve(reservation(2))).toBe(false)
    const db = new DatabaseSync(a.file)
    const row = db.prepare('SELECT payload FROM reservations').get()!
    db.close()
    expect(Object.keys(JSON.parse(String(row.payload))[0]).sort()).toEqual([
      'acquiredAt',
      'actionId',
      'expiresAt',
      'fingerprint',
      'resourceKey'
    ])
  })
  it('does not let malformed storage become an empty unlocked database', () => {
    const f = fixture(),
      a = f.store()
    a.reserve(reservation())
    const db = new DatabaseSync(a.file)
    db.prepare('UPDATE reservations SET payload=?').run('[{"unknown":"PRIVATE"}]')
    db.close()
    const before = fs.readFileSync(a.file)
    expect(() => f.store().reserve(reservation(2))).toThrow(
      'FIGPLUGIN_WRITE_COORDINATION_UNAVAILABLE'
    )
    expect(fs.readFileSync(a.file).equals(before)).toBe(true)
  })
  it('refuses an unknown schema without altering the original file', () => {
    const f = fixture(),
      a = f.store()
    fs.mkdirSync(path.dirname(a.file))
    const db = new DatabaseSync(a.file)
    db.exec("CREATE TABLE owned (x TEXT); INSERT INTO owned VALUES ('PRIVATE')")
    db.close()
    const before = fs.readFileSync(a.file)
    expect(() => a.reserve(reservation())).toThrow()
    expect(fs.readFileSync(a.file).equals(before)).toBe(true)
  })
  it('refuses hardlinks and directory junctions without changing their targets', () => {
    const f = fixture(),
      a = f.store()
    a.reserve(reservation())
    const alias = path.join(f.root, 'alias')
    fs.linkSync(a.file, alias)
    const before = fs.readFileSync(alias)
    expect(() => a.reserve(reservation(2))).toThrow()
    expect(fs.readFileSync(alias).equals(before)).toBe(true)
    fs.unlinkSync(alias)
    const link = path.join(f.root, 'linked')
    fs.symlinkSync(path.dirname(a.file), link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() =>
      new SqliteNativeWriteCoordinator(link, () => NOW).reserve(reservation(2))
    ).toThrow()
    expect(a.owns(reservation())).toBe(true)
  })
  it('refuses oversized files and unsafe sidecars', () => {
    const f = fixture(),
      a = f.store()
    a.reserve(reservation())
    fs.writeFileSync(a.file + '-wal', 'OWNED')
    expect(() => a.reserve(reservation(2))).toThrow()
    fs.unlinkSync(a.file + '-wal')
    fs.truncateSync(a.file, 256 * 1024 + 1)
    expect(() => a.owns(reservation())).toThrow()
  })
  it('refuses a locked database, then preserves its owner after the lock is gone', () => {
    const f = fixture(),
      a = f.store()
    a.reserve(reservation())
    const db = new DatabaseSync(a.file)
    db.exec('BEGIN EXCLUSIVE')
    expect(() => f.store().reserve(reservation(2))).toThrow()
    db.exec('ROLLBACK')
    db.close()
    expect(a.owns(reservation())).toBe(true)
  })
})
