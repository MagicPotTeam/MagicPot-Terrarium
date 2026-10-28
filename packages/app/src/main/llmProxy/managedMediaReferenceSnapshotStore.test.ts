import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Snapshot persistence verifies the real filesystem's canonical-path and
// atomic-rename behavior; the node test suite otherwise installs memfs.
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import {
  MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES,
  MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE,
  MANAGED_MEDIA_REFERENCE_SNAPSHOT_SCHEMA,
  MANAGED_MEDIA_REFERENCE_SNAPSHOT_MAX_FUTURE_SKEW_MS,
  MANAGED_MEDIA_REFERENCE_SNAPSHOT_TEMP_TTL_MS,
  MANAGED_MEDIA_REFERENCE_SNAPSHOT_TTL_MS,
  cleanupManagedMediaReferenceSnapshotTemps,
  loadManagedMediaReferenceSnapshot,
  persistManagedMediaReferenceSnapshot
} from './managedMediaReferenceSnapshotStore'

const idA = 'a'.repeat(64)
const idB = 'b'.repeat(64)

describe('managed media reference snapshot store', () => {
  const roots: string[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('writes an atomic, sorted, content-free snapshot and restores it', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-snapshot-'))
    )
    roots.push(root)

    await persistManagedMediaReferenceSnapshot(
      {
        complete: true,
        chatMediaRoot: root,
        referencedMediaIds: [idB, idA, idA],
        referenceCounts: { [idA]: 2, [idB]: 1 }
      },
      123
    )

    const raw = await fs.readFile(path.join(root, MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE), 'utf8')
    expect(JSON.parse(raw)).toEqual({
      schema: MANAGED_MEDIA_REFERENCE_SNAPSHOT_SCHEMA,
      complete: true,
      chatMediaRoot: root,
      referencedMediaIds: [idA, idB],
      referenceCounts: { [idA]: 2, [idB]: 1 },
      persistedAt: 123
    })
    const restored = await loadManagedMediaReferenceSnapshot(root, 123)
    expect(restored).toEqual({
      complete: true,
      chatMediaRoot: root,
      referencedMediaIds: [idA, idB],
      referenceCounts: { [idA]: 2, [idB]: 1 },
      persistedAt: 123
    })
    expect(raw).not.toContain('task')
    expect(raw).not.toContain('absolute')
  })

  it('fails closed for malformed, mismatched, and symlink snapshots', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-snapshot-'))
    )
    roots.push(root)
    const target = path.join(root, MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE)
    const valid = {
      schema: MANAGED_MEDIA_REFERENCE_SNAPSHOT_SCHEMA,
      complete: true,
      chatMediaRoot: root,
      referencedMediaIds: [idA],
      referenceCounts: { [idA]: 1 },
      persistedAt: 1
    }

    await fs.writeFile(target, JSON.stringify({ ...valid, referencedMediaIds: ['invalid'] }))
    await expect(loadManagedMediaReferenceSnapshot(root)).resolves.toBeUndefined()
    await fs.writeFile(target, JSON.stringify({ ...valid, chatMediaRoot: path.dirname(root) }))
    await expect(loadManagedMediaReferenceSnapshot(root)).resolves.toBeUndefined()

    const outside = path.join(path.dirname(root), 'outside-snapshot.json')
    await fs.writeFile(outside, JSON.stringify(valid))
    await fs.rm(target)
    try {
      await fs.symlink(outside, target, 'file')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return
      throw error
    }
    await expect(loadManagedMediaReferenceSnapshot(root)).resolves.toBeUndefined()
    await fs.rm(outside, { force: true })
  })

  it('does not read an oversized restart snapshot into memory', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-snapshot-'))
    )
    roots.push(root)
    const target = path.join(root, MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE)
    await fs.writeFile(target, Buffer.alloc(MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES + 1, 0x7b))

    await expect(loadManagedMediaReferenceSnapshot(root)).resolves.toBeUndefined()
  })

  it('rejects expired and implausibly future restart baselines', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-snapshot-'))
    )
    roots.push(root)
    const target = path.join(root, MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE)
    const valid = {
      schema: MANAGED_MEDIA_REFERENCE_SNAPSHOT_SCHEMA,
      complete: true,
      chatMediaRoot: root,
      referencedMediaIds: [idA],
      referenceCounts: { [idA]: 1 }
    }

    await fs.writeFile(target, JSON.stringify({ ...valid, persistedAt: 1_000 }))
    await expect(
      loadManagedMediaReferenceSnapshot(root, 1_000 + MANAGED_MEDIA_REFERENCE_SNAPSHOT_TTL_MS + 1)
    ).resolves.toBeUndefined()

    await fs.writeFile(
      target,
      JSON.stringify({
        ...valid,
        persistedAt: 10_000 + MANAGED_MEDIA_REFERENCE_SNAPSHOT_MAX_FUTURE_SKEW_MS + 1
      })
    )
    await expect(loadManagedMediaReferenceSnapshot(root, 10_000)).resolves.toBeUndefined()
  })

  it('rejects invalid persistence timestamps before writing', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-snapshot-'))
    )
    roots.push(root)
    await expect(
      persistManagedMediaReferenceSnapshot(
        { complete: true, chatMediaRoot: root, referencedMediaIds: [idA] },
        -1
      )
    ).rejects.toThrow('Snapshot time')
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('removes the temporary file when the atomic write fails', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-snapshot-'))
    )
    roots.push(root)
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'))

    await expect(
      persistManagedMediaReferenceSnapshot({
        complete: true,
        chatMediaRoot: root,
        referencedMediaIds: [idA]
      })
    ).rejects.toThrow('disk full')
    await expect(fs.readdir(root)).resolves.toEqual([])
  })

  it('removes only stale bounded snapshot temp files and preserves fresh or oversized entries', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-snapshot-'))
    )
    roots.push(root)
    const now = Date.now()
    const stale = path.join(
      root,
      `${MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE}.00000000-0000-4000-8000-000000000001.tmp`
    )
    const fresh = path.join(
      root,
      `${MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE}.00000000-0000-4000-8000-000000000002.tmp`
    )
    const oversized = path.join(
      root,
      `${MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE}.00000000-0000-4000-8000-000000000003.tmp`
    )
    await fs.writeFile(stale, 'stale')
    await fs.writeFile(fresh, 'fresh')
    await fs.writeFile(oversized, Buffer.alloc(MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES + 1))
    const staleDate = new Date(now - MANAGED_MEDIA_REFERENCE_SNAPSHOT_TEMP_TTL_MS - 1)
    await fs.utimes(stale, staleDate, staleDate)
    await fs.utimes(oversized, staleDate, staleDate)

    await expect(cleanupManagedMediaReferenceSnapshotTemps(root, now)).resolves.toEqual({
      scanned: 3,
      deleted: 1,
      retained: 1,
      skipped: 1
    })
    await expect(fs.access(stale)).rejects.toThrow()
    await expect(fs.readFile(fresh, 'utf8')).resolves.toBe('fresh')
    await expect(fs.stat(oversized)).resolves.toMatchObject({
      size: MAX_MANAGED_MEDIA_REFERENCE_SNAPSHOT_BYTES + 1
    })
  })

  it('runs stale temp maintenance before loading a restart snapshot', async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-snapshot-'))
    )
    roots.push(root)
    const now = Date.now()
    const stale = path.join(
      root,
      `${MANAGED_MEDIA_REFERENCE_SNAPSHOT_FILE}.00000000-0000-4000-8000-000000000004.tmp`
    )
    await fs.writeFile(stale, 'stale')
    const staleDate = new Date(now - MANAGED_MEDIA_REFERENCE_SNAPSHOT_TEMP_TTL_MS - 1)
    await fs.utimes(stale, staleDate, staleDate)

    await expect(loadManagedMediaReferenceSnapshot(root, now)).resolves.toBeUndefined()
    await expect(fs.access(stale)).rejects.toThrow()
  })
})
