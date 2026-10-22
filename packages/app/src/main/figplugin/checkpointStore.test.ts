vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigPluginCheckpointStore } from './checkpointStore'
import { NOW, binding, context, record, ownedCodec } from './checkpointTestUtils'
const roots: string[] = []
const root = () => {
  const value = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-checkpoint-'))
  roots.push(value)
  return value
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
describe('encrypted checkpoint persistence', () => {
  it('is lazy, stores ciphertext only and reopens with exact scope and used rounds', () => {
    const dir = root(),
      codec = ownedCodec(),
      a = new FigPluginCheckpointStore(dir, codec, () => NOW),
      r = record()
    expect(a.find(binding, context)).toBeUndefined()
    expect(fs.readdirSync(dir)).toEqual([])
    a.save(r)
    a.consume(r, 1)
    const b = new FigPluginCheckpointStore(dir, codec, () => NOW + 1000)
    expect(b.find(binding, context)).toEqual({
      ...r,
      value: { ...r.value, correctionRoundsUsed: 1 }
    })
    const raw = fs.readFileSync(a.file).toString('utf8')
    for (const privateText of [
      'PRIVATE_OWNED',
      'owned-model',
      'owned-document',
      'sessionToken',
      'sessionId',
      '恢复点'
    ])
      expect(raw).not.toContain(privateText)
    expect(fs.readdirSync(dir)).toEqual(['accepted-checkpoints.sqlite'])
  })
  it('atomically refuses a stale competing claim and never refunds the three-round budget', () => {
    const dir = root(),
      codec = ownedCodec(),
      a = new FigPluginCheckpointStore(dir, codec, () => NOW),
      b = new FigPluginCheckpointStore(dir, codec, () => NOW),
      r = record()
    a.save(r)
    const stale = b.find(binding, context)!
    a.consume(r, 1)
    expect(() => b.consume(stale, 1)).toThrow('FIGPLUGIN_CHECKPOINT_UNAVAILABLE')
    for (let round = 2; round <= 3; round++) b.consume(b.find(binding, context)!, round)
    expect(() => a.consume(a.find(binding, context)!, 4)).toThrow()
    expect(b.find(binding, context)?.value.correctionRoundsUsed).toBe(3)
  })
  it('expiry removes data on access, does not extend TTL, and revoked entries stay removed after reopen', () => {
    const dir = root(),
      codec = ownedCodec()
    let now = NOW
    const a = new FigPluginCheckpointStore(dir, codec, () => now)
    a.save(record())
    now += 86400000
    expect(a.find(binding, context)).toBeUndefined()
    now = NOW
    expect(
      new FigPluginCheckpointStore(dir, codec, () => now).find(binding, context)
    ).toBeUndefined()
    a.save(record())
    a.removeWhere((r) => r.binding.pluginId === binding.pluginId)
    expect(
      new FigPluginCheckpointStore(dir, codec, () => now).find(binding, context)
    ).toBeUndefined()
  })
  it.each(['projectId', 'profileId', 'artifactSha256', 'generation'] as const)(
    'cannot recover across changed %s',
    (field) => {
      const a = new FigPluginCheckpointStore(root(), ownedCodec(), () => NOW)
      a.save(record())
      const changed = {
        ...binding,
        [field]:
          field === 'generation'
            ? 2
            : field.endsWith('Sha256') || field.endsWith('Revision')
              ? 'f'.repeat(64)
              : 'other'
      }
      expect(a.find(changed as typeof binding, context)).toBeUndefined()
    }
  )
  it('rejects a different host instance, replaced checkpoint and missing files instead of reusing grants', () => {
    const a = new FigPluginCheckpointStore(root(), ownedCodec(), () => NOW),
      r = record()
    a.save(r)
    expect(a.find(binding, { ...context, recoveryIdentity: '9'.repeat(32) })).toBeUndefined()
    a.save(record(8))
    expect(() => a.consume(r, 1)).toThrow()
    fs.unlinkSync(a.file)
    expect(() => a.consume(record(8), 1)).toThrow()
  })
  it('never falls back to plaintext and preserves a valid database after encryption failure', () => {
    const dir = root(),
      codec = ownedCodec(),
      a = new FigPluginCheckpointStore(dir, codec, () => NOW)
    const disabled = new FigPluginCheckpointStore(
      dir,
      { ...codec, available: () => false },
      () => NOW
    )
    expect(() => disabled.save(record())).toThrow()
    expect(fs.readdirSync(dir)).toEqual([])
    a.save(record())
    const before = fs.readFileSync(a.file)
    const bad = new FigPluginCheckpointStore(
      dir,
      {
        ...codec,
        encrypt: () => {
          throw new Error('OWNED_SECRET')
        }
      },
      () => NOW
    )
    expect(() => bad.consume(record(), 1)).toThrow('FIGPLUGIN_CHECKPOINT_UNAVAILABLE')
    expect(fs.readFileSync(a.file).equals(before)).toBe(true)
    expect(a.find(binding, context)?.value.correctionRoundsUsed).toBe(0)
  })
  it('rejects corrupted ciphertext without clearing the last file', () => {
    const dir = root(),
      codec = ownedCodec(),
      a = new FigPluginCheckpointStore(dir, codec, () => NOW)
    a.save(record())
    const db = new DatabaseSync(a.file)
    db.prepare('UPDATE checkpoints SET payload=?').run(Buffer.from('invalid'))
    db.close()
    const bad = fs.readFileSync(a.file)
    expect(() => a.find(binding, context)).toThrow()
    expect(fs.readFileSync(a.file).equals(bad)).toBe(true)
    expect(() =>
      new FigPluginCheckpointStore(dir, ownedCodec(), () => NOW).find(binding, context)
    ).toThrow()
  })
  it('rejects unknown payload fields, altered plan hashes and oversized/overlong retention records', () => {
    const a = new FigPluginCheckpointStore(root(), ownedCodec(), () => NOW)
    for (const change of [
      { sessionToken: 'SECRET' },
      { recoveryPlan: { ...record().recoveryPlan, steps: [] } },
      { value: { ...record().value, expiresAt: NOW + 86400001 } },
      { recoveryScope: { ...record().recoveryScope, recoveryIdentity: undefined } }
    ])
      expect(() => a.save({ ...record(), ...change } as never)).toThrow()
    expect(fs.existsSync(a.file)).toBe(false)
  })
  it('enforces sixteen checkpoints without evicting an accepted live result', () => {
    const a = new FigPluginCheckpointStore(root(), ownedCodec(), () => NOW)
    for (let i = 0; i < 16; i++) {
      const r = record(10 + i * 2)
      r.binding.projectId = r.value.projectId = `project-${i}`
      a.save(r)
    }
    const extra = record(90)
    extra.binding.projectId = extra.value.projectId = 'extra'
    expect(() => a.save(extra)).toThrow()
    expect(a.find({ ...binding, projectId: 'project-0' }, context)).toBeDefined()
  })
  it('rejects foreign schemas, oversized files and hardlinks without mutating their targets', () => {
    for (const kind of ['foreign', 'large', 'hardlink']) {
      const dir = root(),
        a = new FigPluginCheckpointStore(dir, ownedCodec(), () => NOW)
      if (kind === 'foreign') {
        const db = new DatabaseSync(a.file)
        db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('OWNED')")
        db.close()
      } else if (kind === 'large') fs.writeFileSync(a.file, Buffer.alloc(4 * 1024 * 1024 + 1))
      else {
        fs.writeFileSync(path.join(dir, 'target'), 'OWNED')
        fs.linkSync(path.join(dir, 'target'), a.file)
      }
      const before = fs.readFileSync(a.file)
      expect(() => a.save(record())).toThrow()
      expect(fs.readFileSync(a.file).equals(before)).toBe(true)
    }
  })
})

it('rebinds only the opaque per-process model revision for explicitly re-paired no-model recovery', () => {
  const a = new FigPluginCheckpointStore(root(), ownedCodec(), () => NOW)
  a.save(record())
  const fresh = { ...binding, profileRevision: 'f'.repeat(64) },
    restored = a.find(fresh, context)!
  expect(restored.binding).toEqual(fresh)
  a.consume(restored, 1)
  expect(a.find(fresh, context)?.value.correctionRoundsUsed).toBe(1)
})

it('a failed first encryption can be retried without an abandoned empty database', () => {
  const dir = root(),
    codec = ownedCodec()
  const failing = new FigPluginCheckpointStore(
    dir,
    {
      ...codec,
      encrypt: () => {
        throw new Error('OWNED')
      }
    },
    () => NOW
  )
  expect(() => failing.save(record())).toThrow()
  expect(fs.readdirSync(dir)).toEqual([])
  const store = new FigPluginCheckpointStore(dir, codec, () => NOW)
  store.save(record())
  expect(store.find(binding, context)?.value.correctionRoundsUsed).toBe(0)
})
