import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')
import { recoveryImagesManifestContent } from '@shared/figplugin/hostImageRecovery'
import { FigPluginCheckpointStore } from './checkpointStore'
import { NOW, binding, context, hash, plan, record, ownedCodec } from './checkpointTestUtils'
import { inspectSessionAssetImage } from './sessionAssetImage'

const roots: string[] = []
const root = () => {
  const value = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-checkpoint-image-'))
  roots.push(value)
  return value
}
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

// A local 2x1 RGBA PNG keeps the persistence tests independent of a decoder or provider.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})
const pngChunk = (type: string, data: Buffer) => {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}
const pngHeader = Buffer.alloc(13)
pngHeader.writeUInt32BE(2)
pngHeader.writeUInt32BE(1, 4)
pngHeader[8] = 8
pngHeader[9] = 6
const imageBytes = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', pngHeader),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 255]))),
  pngChunk('IEND', Buffer.alloc(0))
])
const sourceAssetId = 'a'.repeat(32)
const imageSha256 = createHash('sha256').update(imageBytes).digest('hex')
const imagePlan = {
  ...plan,
  steps: [
    {
      command: 'image.fill' as const,
      targetId: 'owned-node',
      assetId: sourceAssetId,
      sha256: imageSha256,
      scaleMode: 'FILL' as const
    }
  ]
}
const manifestWithoutDigest = {
  version: 1 as const,
  sourcePlanSha256: hash(imagePlan),
  assets: [
    {
      assetId: sourceAssetId,
      sha256: imageSha256,
      mimeType: 'image/png' as const,
      sizeBytes: imageBytes.length,
      width: 2,
      height: 1
    }
  ],
  targets: [
    {
      command: 'image.fill' as const,
      targetId: 'owned-node',
      assetId: sourceAssetId,
      sha256: imageSha256,
      scaleMode: 'FILL' as const,
      acceptedEvidence: {
        kind: 'figma-image-fill' as const,
        sourceSha256: imageSha256,
        nativeImageHash: 'native-image-hash',
        fillsSha256: 'e'.repeat(64)
      }
    }
  ],
  manifestSha256: '0'.repeat(64)
}
const imageManifest = {
  ...manifestWithoutDigest,
  manifestSha256: createHash('sha256')
    .update(recoveryImagesManifestContent(manifestWithoutDigest))
    .digest('hex')
}

function imageRecord(seed = 30) {
  const base = record(seed)
  return {
    ...base,
    value: { ...base.value, planSha256: hash(imagePlan) },
    recoveryPlan: structuredClone(imagePlan),
    recoveryImages: structuredClone(imageManifest)
  }
}

function imageRows(file: string): Array<{ id: string; bytes: number }> {
  const db = new DatabaseSync(file)
  try {
    return db.prepare('SELECT id,length(payload) AS bytes FROM checkpoint_images').all() as Array<{
      id: string
      bytes: number
    }>
  } finally {
    db.close()
  }
}

describe('encrypted checkpoint image persistence', () => {
  it('reopens exact source bytes and rejects binding, baseline, and manifest mismatches', () => {
    expect(inspectSessionAssetImage(imageBytes)).toEqual({
      mimeType: 'image/png',
      width: 2,
      height: 1
    })
    const directory = root()
    const codec = ownedCodec()
    const first = new FigPluginCheckpointStore(directory, codec, () => NOW)
    const saved = imageRecord()
    first.save(saved, [{ assetId: sourceAssetId, bytes: imageBytes }])

    const reopened = new FigPluginCheckpointStore(directory, codec, () => NOW)
    const opened = reopened.openRecoveryImages(
      binding,
      saved.value.baselineId,
      imageManifest.manifestSha256
    )
    expect(opened).toEqual([{ assetId: sourceAssetId, bytes: imageBytes }])
    opened[0].bytes.fill(0)
    expect(
      reopened.openRecoveryImages(binding, saved.value.baselineId, imageManifest.manifestSha256)[0]
        .bytes
    ).toEqual(imageBytes)
    expect(() =>
      reopened.openRecoveryImages(
        { ...binding, projectId: 'other' },
        saved.value.baselineId,
        imageManifest.manifestSha256
      )
    ).toThrow()
    expect(() =>
      reopened.openRecoveryImages(binding, 'f'.repeat(32), imageManifest.manifestSha256)
    ).toThrow()
    expect(() =>
      reopened.openRecoveryImages(binding, saved.value.baselineId, 'f'.repeat(64))
    ).toThrow()

    const raw = fs.readFileSync(first.file)
    expect(raw.includes(imageBytes)).toBe(false)
    for (const privateText of ['native-image-hash', 'owned-document', imageSha256])
      expect(raw.toString('utf8')).not.toContain(privateText)
  })

  it('migrates a legacy property-only database when the first image is accepted', () => {
    const directory = root()
    const codec = ownedCodec()
    const store = new FigPluginCheckpointStore(directory, codec, () => NOW)
    store.save(record())
    const before = new DatabaseSync(store.file)
    expect(before.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    before.close()

    const image = imageRecord(32)
    store.save(image, [{ assetId: sourceAssetId, bytes: imageBytes }])
    const after = new DatabaseSync(store.file)
    expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    expect(
      after.prepare("SELECT name FROM sqlite_schema WHERE name='checkpoint_images'").get()
    ).toBeDefined()
    after.close()
    expect(
      store.openRecoveryImages(binding, image.value.baselineId, imageManifest.manifestSha256)[0]
        .bytes
    ).toEqual(imageBytes)
  })

  it('rolls back image encryption failure and garbage-collects replaced ciphertext', () => {
    const directory = root()
    const codec = ownedCodec()
    const property = new FigPluginCheckpointStore(directory, codec, () => NOW)
    property.save(record())
    const before = fs.readFileSync(property.file)
    const failing = new FigPluginCheckpointStore(
      directory,
      {
        ...codec,
        encryptBytes: () => {
          throw new Error('PRIVATE-IMAGE-KEY-ERROR')
        }
      },
      () => NOW
    )
    expect(() =>
      failing.save(imageRecord(34), [{ assetId: sourceAssetId, bytes: imageBytes }])
    ).toThrow()
    expect(fs.readFileSync(property.file)).toEqual(before)
    expect(property.find(binding, context)?.value.baselineId).toBe(record().value.baselineId)

    const valid = new FigPluginCheckpointStore(directory, codec, () => NOW)
    const image = imageRecord(36)
    valid.save(image, [{ assetId: sourceAssetId, bytes: imageBytes }])
    expect(imageRows(valid.file)).toHaveLength(1)
    valid.save(record(38))
    expect(imageRows(valid.file)).toHaveLength(0)
    expect(() =>
      valid.openRecoveryImages(binding, image.value.baselineId, imageManifest.manifestSha256)
    ).toThrow()
  })

  it('rejects source hash, MIME, and dimension mismatches before changing an existing database', () => {
    const directory = root()
    const codec = ownedCodec()
    const store = new FigPluginCheckpointStore(directory, codec, () => NOW)
    store.save(record())
    const before = fs.readFileSync(store.file)

    expect(() =>
      store.save(imageRecord(40), [
        { assetId: sourceAssetId, bytes: Buffer.from(imageBytes).fill(0) }
      ])
    ).toThrow()

    for (const change of [{ mimeType: 'image/jpeg' as const }, { width: 1 }]) {
      const malformed = structuredClone(imageRecord(42))
      Object.assign(malformed.recoveryImages!.assets[0], change)
      malformed.recoveryImages!.manifestSha256 = createHash('sha256')
        .update(recoveryImagesManifestContent(malformed.recoveryImages!))
        .digest('hex')
      expect(() => store.save(malformed, [{ assetId: sourceAssetId, bytes: imageBytes }])).toThrow()
    }
    expect(fs.readFileSync(store.file)).toEqual(before)
    expect(store.find(binding, context)?.value.baselineId).toBe(record().value.baselineId)
  })

  it('fails closed when an encrypted blob disappears instead of returning partial bytes', () => {
    const directory = root()
    const codec = ownedCodec()
    const store = new FigPluginCheckpointStore(directory, codec, () => NOW)
    const image = imageRecord(44)
    store.save(image, [{ assetId: sourceAssetId, bytes: imageBytes }])
    const db = new DatabaseSync(store.file)
    db.exec('DELETE FROM checkpoint_images')
    db.close()
    expect(() =>
      store.openRecoveryImages(binding, image.value.baselineId, imageManifest.manifestSha256)
    ).toThrow()
    expect(() => store.find(binding, context)).toThrow()
  })

  it('cleans an unreferenced image row only during explicit cleanup and keeps referenced loss fail-closed', () => {
    const directory = root()
    const codec = ownedCodec()
    const store = new FigPluginCheckpointStore(directory, codec, () => NOW)
    const image = imageRecord(45)
    store.save(image, [{ assetId: sourceAssetId, bytes: imageBytes }])
    const orphanId = 'f'.repeat(32)
    const db = new DatabaseSync(store.file)
    db.prepare('INSERT INTO checkpoint_images(id,payload) VALUES(?,?)').run(
      orphanId,
      Buffer.from([7])
    )
    db.close()

    expect(() => store.find(binding, context)).toThrow('FIGPLUGIN_CHECKPOINT_UNAVAILABLE')
    expect(() =>
      store.openRecoveryImages(binding, image.value.baselineId, imageManifest.manifestSha256)
    ).toThrow('FIGPLUGIN_CHECKPOINT_UNAVAILABLE')
    expect(store.cleanupExpired()).toEqual({
      expiredRecordCount: 0,
      retainedRecordCount: 1,
      databasePresent: true
    })
    expect(imageRows(store.file)).toHaveLength(1)
    expect(store.find(binding, context)?.value.baselineId).toBe(image.value.baselineId)
    expect(
      store.openRecoveryImages(binding, image.value.baselineId, imageManifest.manifestSha256)[0]
        .bytes
    ).toEqual(imageBytes)

    const missing = new DatabaseSync(store.file)
    missing.exec('DELETE FROM checkpoint_images')
    missing.close()
    expect(() => store.cleanupExpired()).toThrow('FIGPLUGIN_CHECKPOINT_UNAVAILABLE')
  })

  it('deduplicates identical accepted source bytes across records and collects them after both expire', () => {
    const directory = root()
    const codec = ownedCodec()
    const store = new FigPluginCheckpointStore(directory, codec, () => NOW)
    const first = imageRecord(46)
    const second = imageRecord(48)
    second.binding.projectId = second.value.projectId = 'dedup-project'
    store.save(first, [{ assetId: sourceAssetId, bytes: imageBytes }])
    store.save(second, [{ assetId: sourceAssetId, bytes: imageBytes }])
    expect(imageRows(store.file)).toHaveLength(1)
    store.removeWhere((saved) => saved.value.baselineId === first.value.baselineId)
    expect(imageRows(store.file)).toHaveLength(1)
    store.removeWhere((saved) => saved.value.baselineId === second.value.baselineId)
    expect(imageRows(store.file)).toHaveLength(0)
  })
})
