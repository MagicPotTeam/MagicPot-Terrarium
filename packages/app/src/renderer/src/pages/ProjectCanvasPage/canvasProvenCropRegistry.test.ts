import { describe, expect, it, vi } from 'vitest'

import {
  createCanvasProvenCropRegistry,
  getCanvasProvenCropKey,
  getCanvasProvenCropOutputSize,
  registerCanvasAgentSendProvenCrops
} from './canvasProvenCropRegistry'
import type { CanvasImageCropSource, CanvasImageItem, CanvasItem } from './types'

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

// An entry keeps its PNG and its key: both count against the byte budget.
const keyBytes = (item: CanvasImageItem) => getCanvasProvenCropKey(item)!.length * 2

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
    expect(registry.totalBytes).toBe(16 + keyBytes(item))
  })

  it('tells subscribers which item got an entry, and nothing after they unsubscribe', () => {
    const { registry } = createRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    registry.register(croppedItem(), png(), CROP_SIZE)
    expect(listener).toHaveBeenCalledExactlyOnceWith('image-1')
    expect(registry.register(croppedItem({ cropSource: undefined }), png(), CROP_SIZE)).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    registry.register(croppedItem({ id: 'image-2' }), png(), CROP_SIZE)
    expect(listener).toHaveBeenCalledTimes(1)
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
    expect(registry.totalBytes).toBe(20 + keyBytes(recropped))
    expect(registry.lookup(croppedItem())).toBeNull()
    expect(registry.lookup(recropped)).toEqual(second)
  })

  it('evicts the least recently used entries beyond the entry and byte bounds', () => {
    // Every key here has the same length (one-letter ids).
    const key = keyBytes(croppedItem({ id: 'a' }))
    const { registry, revoke } = createRegistry({ maxEntries: 2, maxBytes: 40 + 2 * key })
    const a = registry.register(croppedItem({ id: 'a' }), png(10), CROP_SIZE)
    const b = registry.register(croppedItem({ id: 'b' }), png(10), CROP_SIZE)
    expect(registry.lookup(croppedItem({ id: 'a' }))).toEqual(a)
    registry.register(croppedItem({ id: 'c' }), png(10), CROP_SIZE)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(b?.url)
    expect(registry.lookup(croppedItem({ id: 'b' }))).toBeNull()
    expect(registry.lookup(croppedItem({ id: 'a' }))).toEqual(a)

    registry.register(croppedItem({ id: 'd' }), png(35), CROP_SIZE)
    expect(registry.entryCount).toBe(1)
    expect(registry.totalBytes).toBe(35 + key)
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

  it('never keeps a copy of a long data: source in its key, and still tells sources apart (F2 part 5)', () => {
    const payload = 'A'.repeat(4 * 1024 * 1024)
    const longSrc = `data:image/png;base64,${payload}`
    const item = croppedItem({ src: longSrc })
    const key = getCanvasProvenCropKey(item)!
    expect(key.length).toBeLessThan(512)
    expect(key).not.toContain(payload.slice(0, 1024))
    // Another length, another head, tail or middle window: another key.
    for (const other of [
      `${longSrc}B`,
      `data:image/png;base64,B${payload.slice(1)}`,
      `${longSrc.slice(0, -1)}B`,
      // Other bytes differ throughout: here a 64 KiB block in the middle.
      `${longSrc.slice(0, 2 * 1024 * 1024)}${'B'.repeat(65536)}${longSrc.slice(2 * 1024 * 1024 + 65536)}`
    ]) {
      expect(other.length).toBeGreaterThan(2048)
      expect(getCanvasProvenCropKey(croppedItem({ src: other }))).not.toBe(key)
    }
    // A short source is part of the key as it is.
    expect(getCanvasProvenCropKey(croppedItem())).toContain('local-media:///C:/MagicPot/source.png')
    const { registry } = createRegistry()
    registry.register(item, png(), CROP_SIZE)
    expect(registry.totalBytes).toBe(16 + key.length * 2)
    expect(registry.lookup({ ...item, src: `${longSrc}` })).not.toBeNull()
    expect(registry.lookup({ ...item, src: `${longSrc.slice(0, -1)}B` })).toBeNull()
  })

  it('drops the entries of deleted, uncropped or re-cropped items, and keeps one whose record is landing', () => {
    const { registry, revoke } = createRegistry()
    const kept = croppedItem({ id: 'kept' })
    const deleted = croppedItem({ id: 'deleted' })
    const uncropped = croppedItem({ id: 'uncropped' })
    const recropped = croppedItem({ id: 'recropped' })
    const landing = croppedItem({ id: 'landing' })
    for (const item of [kept, deleted, uncropped, recropped, landing]) {
      registry.register(item, png(), CROP_SIZE)
    }
    const dropped = registry.prune([
      kept,
      { ...uncropped, crop: undefined, cropSource: undefined },
      { ...recropped, crop: { x: 0, y: 0, width: 100, height: 50 } },
      // Same crop, its record not committed yet.
      { ...landing, cropSource: undefined }
    ])
    expect(dropped).toBe(3)
    expect(revoke).toHaveBeenCalledTimes(3)
    expect(registry.entryCount).toBe(2)
    expect(registry.has(kept)).toBe(true)
    expect(registry.has(landing)).toBe(true)
    expect(registry.totalBytes).toBe(2 * 16 + keyBytes(kept) + keyBytes(landing))
  })

  it('hands out the registered PNG itself for the same crop only', () => {
    const { registry } = createRegistry()
    const item = croppedItem()
    const blob = png()
    registry.register(item, blob, CROP_SIZE)
    expect(registry.lookupPng({ ...item })).toEqual({
      blob,
      fileName: 'source.png',
      width: 60,
      height: 30
    })
    expect(registry.lookupPng({ ...item, crop: { x: 0, y: 0, width: 10, height: 10 } })).toBeNull()
    expect(registry.lookupPng({ ...item, cropSource: undefined })).toBeNull()
  })

  it('drops the entry of an item that shows another source, even before a new record (review of F2)', () => {
    const { registry, revoke } = createRegistry()
    const item = croppedItem()
    const entry = registry.register(item, png(), CROP_SIZE)
    // A src change drops the record; the entry for the old bytes goes too.
    expect(
      registry.prune([
        { ...item, src: 'local-media:///C:/MagicPot/other.png', cropSource: undefined }
      ])
    ).toBe(1)
    expect(revoke).toHaveBeenCalledExactlyOnceWith(entry!.url)
    expect(registry.entryCount).toBe(0)
  })

  it('never evicts the entry of a kept item: it refuses the new PNG instead (review of F2)', () => {
    // Two entries fit, plus the 8 KiB key allowance a check leaves for a third.
    const entryBytes = 10_000 + keyBytes(croppedItem({ id: 'a' }))
    const { registry, revoke } = createRegistry({ maxBytes: entryBytes * 2 + 8192 })
    const [a, b, c] = ['a', 'b', 'c'].map((id) => croppedItem({ id }))
    registry.register(a, png(10_000), CROP_SIZE)
    registry.register(b, png(10_000), CROP_SIZE)
    const both = new Set([a.id, b.id, c.id])
    expect(registry.canAddKeeping(10_000, both)).toBe(false)
    expect(registry.register(c, png(10_000), CROP_SIZE, { keep: both })).toBeNull()
    expect([a, b, c].map((item) => registry.has(item))).toEqual([true, true, false])
    expect(revoke).not.toHaveBeenCalled()

    // Only b kept: a (unkept, least recently used) makes room.
    const onlyB = new Set([b.id, c.id])
    expect(registry.canAddKeeping(10_000, onlyB)).toBe(true)
    expect(registry.register(c, png(10_000), CROP_SIZE, { keep: onlyB })).not.toBeNull()
    expect([a, b, c].map((item) => registry.has(item))).toEqual([false, true, true])
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('knows a crop that can never be kept: over the draw cap or with a PNG over the entry cap (review of F2)', () => {
    const { registry, create } = createRegistry({ maxEntryBytes: 64 })
    const item = croppedItem()
    expect(registry.isTooLarge(item)).toBe(false)
    expect(registry.register(item, png(65), CROP_SIZE)).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(registry.isTooLarge({ ...item })).toBe(true)
    // Only for exactly that crop.
    expect(registry.isTooLarge({ ...item, crop: { x: 0, y: 0, width: 60, height: 30 } })).toBe(
      false
    )
    expect(registry.isTooLarge({ ...item, id: 'image-2' })).toBe(false)

    const marked = croppedItem({ id: 'marked' })
    registry.markTooLarge(marked)
    expect(registry.isTooLarge(marked)).toBe(true)

    // 4097 x 4096 output pixels: above the draw cap, with or without a record.
    const huge = croppedItem({
      id: 'huge',
      sourceWidth: 5000,
      sourceHeight: 5000,
      crop: { x: 0, y: 0, width: 4097, height: 4096 },
      cropSource: { ...RECORD, width: 5000, height: 5000 }
    })
    expect(registry.isTooLarge(huge)).toBe(true)
    expect(registry.isTooLarge({ ...huge, cropSource: undefined })).toBe(true)
    expect(registry.isTooLarge({ ...huge, crop: { x: 0, y: 0, width: 4096, height: 4096 } })).toBe(
      false
    )

    registry.release()
    expect(registry.isTooLarge(item)).toBe(false)
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

describe('crops proven by an Agent send', () => {
  // base64 of the synthetic bytes 'crop-png'.
  const DRAWN = 'data:image/png;base64,Y3JvcC1wbmc='
  const sent = (
    item: CanvasImageItem,
    overrides: Partial<CanvasImageItem> = {}
  ): CanvasImageItem => {
    const { crop: _crop, cropSource: _cropSource, ...rest } = item
    return {
      ...rest,
      src: DRAWN,
      fileName: 'source.png',
      sizeBytes: 8,
      sourceWidth: 60,
      sourceHeight: 30,
      width: 60,
      height: 30,
      ...overrides
    }
  }

  it('keeps the drawn PNG of each proven crop of the selection, in order', () => {
    const { registry, create } = createRegistry()
    const a = croppedItem({ id: 'a' })
    const plain = croppedItem({ id: 'plain', crop: undefined, cropSource: undefined })
    const text = { id: 'note', type: 'text' } as unknown as CanvasItem
    expect(
      registerCanvasAgentSendProvenCrops(registry, [a, plain, text], [sent(a), plain, text])
    ).toBe(1)
    expect(create).toHaveBeenCalledOnce()
    const blob = create.mock.calls[0][0]
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe('crop-png'.length)
    expect(registry.lookup(a)).toEqual(
      expect.objectContaining({ width: 60, height: 30, sizeBytes: 8 })
    )
    expect(registry.lookup(plain)).toBeNull()
  })

  it.each([
    [
      'a prepared item that still has its crop',
      (item: CanvasImageItem) => ({ ...sent(item), crop: item.crop })
    ],
    [
      'a prepared item that is still the original',
      (item: CanvasImageItem) => sent(item, { src: item.src })
    ],
    ['a prepared item of another id', (item: CanvasImageItem) => sent(item, { id: 'other' })],
    [
      'a prepared item that is not a PNG data URL',
      (item: CanvasImageItem) => sent(item, { src: 'data:image/jpeg;base64,Y3JvcC1wbmc=' })
    ],
    [
      'a prepared item of another pixel size',
      (item: CanvasImageItem) => sent(item, { sourceWidth: 59 })
    ],
    [
      'a prepared item over the entry limit',
      (item: CanvasImageItem) => sent(item, { sizeBytes: 33 * 1024 * 1024 })
    ]
  ] as const)('keeps nothing for %s', (_label, prepare) => {
    const { registry, create } = createRegistry()
    const item = croppedItem()
    expect(registerCanvasAgentSendProvenCrops(registry, [item], [prepare(item)])).toBe(0)
    expect(create).not.toHaveBeenCalled()
  })

  it('marks a crop whose sent PNG is over the entry limit as too large to drag', () => {
    const { registry } = createRegistry()
    const item = croppedItem()
    expect(
      registerCanvasAgentSendProvenCrops(
        registry,
        [item],
        [sent(item, { sizeBytes: 33 * 1024 * 1024 })]
      )
    ).toBe(0)
    expect(registry.isTooLarge(item)).toBe(true)
  })

  it('keeps nothing when the prepared PNG is the original data: source itself (F2 part 6)', () => {
    // The original is a PNG data URL and the "prepared" item still carries it:
    // registering it would hand the whole original to a drag.
    const { registry, create } = createRegistry()
    const item = croppedItem({ src: DRAWN })
    expect(getCanvasProvenCropKey(item)).not.toBeNull()
    expect(registerCanvasAgentSendProvenCrops(registry, [item], [sent(item)])).toBe(0)
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps nothing for a crop without a usable record or for misaligned lists', () => {
    const { registry, create } = createRegistry()
    const unrecorded = croppedItem({ cropSource: undefined })
    expect(registerCanvasAgentSendProvenCrops(registry, [unrecorded], [sent(unrecorded)])).toBe(0)
    const item = croppedItem()
    expect(registerCanvasAgentSendProvenCrops(registry, [item], [])).toBe(0)
    expect(registerCanvasAgentSendProvenCrops(undefined, [item], [sent(item)])).toBe(0)
    expect(create).not.toHaveBeenCalled()
  })
})
