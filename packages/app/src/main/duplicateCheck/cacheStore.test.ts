import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DuplicateCheckCacheStore, type CachedBlobFeatureEntry } from './cacheStore'

const blob = (sha256: string, updatedAt: string): CachedBlobFeatureEntry => ({
  sha256,
  width: 1,
  height: 1,
  dHash: '',
  pHash: '',
  embeddings: {},
  updatedAt
})

describe('DuplicateCheckCacheStore', () => {
  let root: string

  beforeEach(async () => {
    await fs.mkdir('/tmp', { recursive: true })
    root = await fs.mkdtemp(path.join('/tmp', 'magicpot-cache-store-'))
  })

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  it('serializes concurrent saves and leaves a complete JSON file', async () => {
    const store = new DuplicateCheckCacheStore(root)
    await store.upsertBlob(blob('first', '2024-01-01T00:00:00.000Z'))
    const firstSave = store.save()
    await store.upsertBlob(blob('second', '2024-01-02T00:00:00.000Z'))
    await Promise.all([firstSave, store.save()])

    const persisted = JSON.parse(
      await fs.readFile(path.join(root, 'duplicate-check-cache.json'), 'utf8')
    )
    expect(Object.keys(persisted.blobs)).toEqual(expect.arrayContaining(['first', 'second']))
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('bounds persisted blob history to the newest 5000 unreferenced entries', async () => {
    const store = new DuplicateCheckCacheStore(root)
    for (let index = 0; index < 5002; index += 1) {
      await store.upsertBlob(blob(`blob-${index}`, new Date(index * 1000).toISOString()))
    }
    await store.save()

    const persisted = JSON.parse(
      await fs.readFile(path.join(root, 'duplicate-check-cache.json'), 'utf8')
    )
    expect(Object.keys(persisted.blobs)).toHaveLength(5000)
    expect(persisted.blobs['blob-0']).toBeUndefined()
    expect(persisted.blobs['blob-5001']).toBeDefined()
  })
})
