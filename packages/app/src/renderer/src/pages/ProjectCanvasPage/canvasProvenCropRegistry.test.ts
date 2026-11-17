import { describe, expect, it, vi } from 'vitest'

import {
  createCanvasProvenCropRegistry,
  getCanvasProvenCropKey,
  getCanvasProvenCropOutputSize
} from './canvasProvenCropRegistry'
import type { CanvasImageCropSource, CanvasImageItem } from './types'

// Synthetic record and PNG bytes; nothing is read or decoded.
const RECORD: CanvasImageCropSource = {
  version: 1,
  origin: 'confirm',
  width: 200,
  height: 100,
  sizeBytes: 9000,
  sha256: 'ab'.repeat(32)
}

function croppedItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'local-media:///C:/MagicPot/source.png',
    fileName: 'source.jpg',
    sourceWidth: 200,
    sourceHeight: 100,
    x: 0,
    y: 0,
    width: 50,
    height: 25,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    crop: { x: 20, y: 10, width: 60, height: 30 },
    cropSource: RECORD,
    ...overrides
  }
}

function png(bytes = 16): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/png' })
}

function createRegistry(limits: Parameters<typeof createCanvasProvenCropRegistry>[0] = {}) {
  let next = 0
  const create = vi.fn((_blob: Blob) => `blob:magicpot-canvas/crop-${++next}`)
  const revoke = vi.fn()
  return { registry: createCanvasProvenCropRegistry(limits, { create, revoke }), create, revoke }
}

const CROP_SIZE = { width: 60, height: 30 }

describe('canvas proven crop registry', () => {
  it('registers the drawn PNG of a recorded crop and finds it for the same item', () => {
    const { registry, create } = createRegistry()
    const item = croppedItem()
    const blob = png()
    const entry = registry.register(item, blob, CROP_SIZE)
    expect(entry).toEqual({
      url: 'blob:magicpot-canvas/crop-1',
      fileName: 'source.png',
      mimeType: 'image/png',
      sizeBytes: 16,
      width: 60,
      height: 30
    })
    expect(create).toHaveBeenCalledExactlyOnceWith(blob)
    expect(registry.lookup({ ...item })).toEqual(entry)
    expect(registry.entryCount).toBe(1)
    expect(registry.totalBytes).toBe(16)
  })

  it.each([
    ['no record', { cropSource: undefined }],
    ['a malformed record', { cropSource: { ...RECORD, sha256: 'not-a-hash' } }],
    ['size hints that disagree with the record', { sourceWidth: 100 }],
    ['a crop outside the record', { crop: { x: 190, y: 0, width: 60, height: 30 } }],
    ['no crop', { crop: undefined }]
  ] as const)('refuses an item with %s and creates no URL', (_label, overrides) => {
    const { registry, create } = createRegistry()
    const item = croppedItem(overrides as Partial<CanvasImageItem>)
    expect(getCanvasProvenCropKey(item)).toBeNull()
    expect(registry.register(item, png(), CROP_SIZE)).toBeNull()
    expect(registry.lookup(item)).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['a PNG of another pixel size', png(), { width: 61, height: 30 }],
    ['a non-PNG blob', new Blob(['x'], { type: 'image/jpeg' }), CROP_SIZE],
    ['an empty blob', new Blob([], { type: 'image/png' }), CROP_SIZE],
    ['a blob over the entry limit', png(65), CROP_SIZE]
  ] as const)('refuses %s', (_label, blob, size) => {
    const { registry, create } = createRegistry({ maxEntryBytes: 64 })
    expect(registry.register(croppedItem(), blob, size)).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(registry.entryCount).toBe(0)
  })

  it('refuses when no object URL can be created', () => {
    const registry = createCanvasProvenCropRegistry(
      {},
      {
        create: () => {
          throw new Error('no blob URLs here')
        },
        revoke: vi.fn()
      }
    )
    expect(registry.register(croppedItem(), png(), CROP_SIZE)).toBeNull()
    expect(registry.entryCount).toBe(0)
  })

  it.each([
    ['source', { src: 'local-media:///C:/MagicPot/other.png' }],
    ['crop', { crop: { x: 21, y: 10, width: 60, height: 30 } }],
    ['record hash', { cropSource: { ...RECORD, sha256: 'cd'.repeat(32) } }],
    ['record byte size', { cropSource: { ...RECORD, sizeBytes: 9001 } }],
    ['item id', { id: 'image-2' }]
  ] as const)('does not find an entry once the %s changed', (_label, overrides) => {
    const { registry } = createRegistry()
    registry.register(croppedItem(), png(), CROP_SIZE)
    expect(registry.lookup(croppedItem(overrides as Partial<CanvasImageItem>))).toBeNull()
    expect(registry.lookup(croppedItem())).not.toBeNull()
  })

  it('keeps one entry per item and revokes the URL it replaces', () => {
    const { registry, revoke } = createRegistry()
    const first = registry.register(croppedItem(), png(), CROP_SIZE)
    const recropped = croppedItem({ crop: { x: 0, y: 0, width: 100, height: 50 } })
    const second = registry.register(recropped, png(20), { width: 100, height: 50 })
    expect(revoke).toHaveBeenCalledExactlyOnceWith(first?.url)
    expect(registry.entryCount).toBe(1)
    expect(registry.totalBytes).toBe(20)
    expect(registry.lookup(croppedItem())).toBeNull()
    expect(registry.lookup(recropped)).toEqual(second)
  })

  it('evicts the least recently used entries beyond the entry and byte bounds', () => {
    const { registry, revoke } = createRegistry({ maxEntries: 2, maxBytes: 40 })
    const a = registry.register(croppedItem({ id: 'a' }), png(10), CROP_SIZE)
    const b = registry.register(croppedItem({ id: 'b' }), png(10), CROP_SIZE)
    expect(registry.lookup(croppedItem({ id: 'a' }))).toEqual(a)
    registry.register(croppedItem({ id: 'c' }), png(10), CROP_SIZE)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(b?.url)
    expect(registry.lookup(croppedItem({ id: 'b' }))).toBeNull()
    expect(registry.lookup(croppedItem({ id: 'a' }))).toEqual(a)

    registry.register(croppedItem({ id: 'd' }), png(35), CROP_SIZE)
    expect(registry.entryCount).toBe(1)
    expect(registry.totalBytes).toBe(35)
    expect(registry.lookup(croppedItem({ id: 'd' }))).not.toBeNull()
    expect(revoke).toHaveBeenCalledTimes(3)
  })

  it('revokes every URL on release and stays usable afterwards', () => {
    const { registry, revoke } = createRegistry()
    const a = registry.register(croppedItem({ id: 'a' }), png(), CROP_SIZE)
    const b = registry.register(croppedItem({ id: 'b' }), png(), CROP_SIZE)
    registry.release()
    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual([a?.url, b?.url].sort())
    expect(registry.entryCount).toBe(0)
    expect(registry.totalBytes).toBe(0)
    expect(registry.lookup(croppedItem({ id: 'a' }))).toBeNull()
    expect(registry.register(croppedItem({ id: 'a' }), png(), CROP_SIZE)).not.toBeNull()
  })

  it('draws at the crop size normalized against the record', () => {
    expect(getCanvasProvenCropOutputSize(croppedItem())).toEqual(CROP_SIZE)
    expect(
      getCanvasProvenCropOutputSize(
        croppedItem({ crop: { x: 0.4, y: 0, width: 99.6, height: 50.4 } })
      )
    ).toEqual({ width: 100, height: 50 })
  })
})
