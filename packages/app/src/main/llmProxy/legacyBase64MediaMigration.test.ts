import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import {
  LegacyMediaMigrationError,
  migrateLegacyBase64MediaOnDemand
} from './legacyBase64MediaMigration'

function png(): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(1, 8)
  ihdr.writeUInt32BE(1, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  const iend = Buffer.alloc(12)
  iend.write('IEND', 4, 'ascii')
  return Buffer.from(Buffer.concat([signature, ihdr, iend]))
}

const legacyValue = `data:image/png;base64,${png().toString('base64')}`

describe('lazy legacy Base64 media migration', () => {
  let tempRoot = ''
  let authorizedRoot = ''
  let chatMediaRoot = ''

  beforeEach(async () => {
    tempRoot = await createNodeTestArtifactDir('legacy-base64-media-migration')
    authorizedRoot = path.join(tempRoot, 'userData', '.chat_media')
    chatMediaRoot = path.join(authorizedRoot, 'managed')
    await fs.mkdir(authorizedRoot, { recursive: true })
  })

  afterEach(async () => fs.rm(tempRoot, { recursive: true, force: true }))

  const migrate = (
    value: unknown,
    options: { maxBytes?: number; rollbackToken?: unknown; signal?: AbortSignal } = {}
  ) =>
    migrateLegacyBase64MediaOnDemand({
      value,
      authorizedRoot,
      chatMediaRoot,
      ...options
    })

  it('imports a detected legacy image through the managed store and preserves rollback data', async () => {
    const token = { persistenceKey: 'chat-1', attachmentIndex: 0 }
    const result = await migrate(legacyValue, { rollbackToken: token })

    expect(result.status).toBe('migrated')
    if (result.status !== 'migrated') throw new Error('Expected migration')
    expect(result.value).toMatchObject({
      version: 1,
      kind: 'managed',
      mimeType: 'image/png',
      sizeBytes: png().length,
      originalFileName: 'legacy-image.png'
    })
    expect(result.checkpoint).toEqual({ version: 1, rollbackToken: token })
    expect(result.checkpoint.rollbackToken).toBe(token)
    expect(await fs.readFile(result.imported.absolutePath)).toEqual(png())
  })

  it('is content-idempotent and treats an existing reference as already migrated', async () => {
    const first = await migrate(legacyValue)
    const second = await migrate(legacyValue)
    if (first.status !== 'migrated' || second.status !== 'migrated') {
      throw new Error('Expected migrations')
    }
    expect(second.value).toEqual(first.value)
    expect(second.imported.absolutePath).toBe(first.imported.absolutePath)

    await expect(migrate(first.value)).resolves.toEqual({
      status: 'already-migrated',
      value: first.value
    })
  })

  it('leaves unrelated persistence values untouched without creating the managed root', async () => {
    const value = { url: 'https://example.test/image.png' }
    await expect(migrate(value)).resolves.toEqual({ status: 'unchanged', value })
    await expect(fs.stat(chatMediaRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    'data:image/png;base64,not base64',
    'data:image/png;base64,AA=A',
    'data:image/png;base64,',
    'data:image/png;charset=utf-8;base64,AAAA'
  ])('rejects malformed legacy image data safely: %s', async (value) => {
    await expect(migrate(value)).rejects.toMatchObject({
      code: 'LEGACY_MEDIA_MALFORMED'
    } satisfies Partial<LegacyMediaMigrationError>)
    await expect(fs.stat(chatMediaRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsupported image media before importing', async () => {
    await expect(migrate('data:image/svg+xml;base64,PHN2Zy8+')).rejects.toMatchObject({
      code: 'LEGACY_MEDIA_UNSUPPORTED'
    } satisfies Partial<LegacyMediaMigrationError>)
    await expect(fs.stat(chatMediaRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects oversized payloads from encoded length before decoding or importing', async () => {
    await expect(migrate('data:image/png;base64,QUJDRA==', { maxBytes: 3 })).rejects.toMatchObject({
      code: 'LEGACY_MEDIA_TOO_LARGE'
    } satisfies Partial<LegacyMediaMigrationError>)
    await expect(fs.stat(chatMediaRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects immediately when the migration signal is already aborted', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled', 'AbortError')
    controller.abort(reason)

    await expect(migrate(legacyValue, { signal: controller.signal })).rejects.toBe(reason)
    await expect(fs.stat(chatMediaRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
