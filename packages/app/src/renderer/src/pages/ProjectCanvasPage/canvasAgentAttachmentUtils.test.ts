import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCanvasAgentAttachments,
  buildCanvasImageAttachment,
  buildCanvasImageCropSourceMetadata,
  canvasPngDataUrlToBlob,
  drawVerifiedCanvasImageCropPng,
  buildCanvasProvenCropSnapshotItemsSync,
  materializeCanvasAgentAttachmentItems,
  materializeCanvasAgentAttachmentItemsSync,
  prepareCanvasAgentCropDelivery
} from './canvasAgentAttachmentUtils'
import type { CanvasImageCropSource, CanvasImageItem, CanvasModel3DItem } from './types'

function imageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'source-image',
    type: 'image',
    src: 'local-media:///original/full-frame.png',
    fileName: 'full-frame.png',
    sourceFile: new Blob(['original-bytes'], { type: 'image/png' }),
    sourceWidth: 4000,
    sourceHeight: 3000,
    width: 400,
    height: 300,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    x: 0,
    y: 0,
    zIndex: 1,
    locked: false,
    thumbnailSet: {
      version: 1,
      cacheKey: 'tile-cache-key',
      sourceIdentity: {
        version: 1,
        kind: 'session-blob',
        sourceKey: 'tile-source',
        sizeBytes: 12,
        mimeType: 'image/png',
        cacheKey: 'tile-identity'
      },
      createdAt: '0',
      updatedAt: '0',
      levels: [
        {
          maxSide: 256,
          src: 'local-media:///cache/tile-256.webp',
          filename: 'tile-256.webp',
          mimeType: 'image/webp',
          width: 256,
          height: 192,
          sizeBytes: 1024
        }
      ]
    },
    ...overrides
  }
}

function modelItem(): CanvasModel3DItem {
  return {
    id: 'model-source',
    type: 'model3d',
    src: 'local-media:///original/model.glb',
    fileName: 'model.glb',
    sourceFile: new Blob(['original-model'], { type: 'model/gltf-binary' }),
    width: 320,
    height: 240,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    x: 0,
    y: 0
  }
}

describe('canvas agent crop fallback on a synthetic source', () => {
  const original = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAACaUlEQVR42u3TMQ0AAAjAsPk3DTYI6TEHa9XoTqNTZUpABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABIkAAESCACBBABAggAgQQYwIiQAARIIAIEEAECCACRIAAIkAAESCACBBABIgAAUSAACJAABEggAgQmRIQAQKIAAFEgAAiQAARIAIEEAECiAABRIAAIkAECCACBBABAogAAUSACBBABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABIkAAESCACBBABAggAkSAACJAABEggAgQQAQIIAJEgAAiQAARIIAIEEAEiAABRIAAIkAAESCACBABAogAAUSAACJAABEggJgSEAECiAABRIAAIkAAESACBBABAogAAUSAACJABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAABxJiACBBABAggAgQQAQKIABEggAgQQAQIIAIEEAEiQAARIIAIEEAECCACRKYERIAAIkAAESCACBBABIgAAUSAACJAABEggAgQAQKIAAFEgAAiQAARIAIEEAECiAABRIAAIkAAESACBBABAogAAUSAACJABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABAogAESCACBBABAggAgQQASJAABEggAgQQAQIIAJEgAAiQAARIIAIEEAECCCmBESAACJAABEggAgQQASIAAFEgAAiQAARIIAIEAECiAABRIAAIkAAESACBBABAogAAUSAACJAADEmIAIEEAECiAABRIAAIkAECCACBBAB8rEFA6mDSMjZmAIAAAAASUVORK5CYII='
  // Signature change (backlog item 26, owner decision 2): crops are drawn only
  // from evidence of their recorded bytes. The fixture gains the record of the
  // data: source's own bytes (a 200x200 PNG), and the synthetic Image decodes
  // only an object URL of the bytes that were read, never the original URL.
  const originalBytes = Buffer.from(original.slice(original.indexOf(',') + 1), 'base64')
  const record: CanvasImageCropSource = {
    version: 1, origin: 'confirm', width: 200, height: 200, sizeBytes: originalBytes.byteLength,
    sha256: createHash('sha256').update(originalBytes).digest('hex')
  }
  const objectUrlBlobs = new Map<string, Blob>()
  beforeEach(() => {
    objectUrlBlobs.clear()
    let next = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
      const url = `blob:attachment-fixture-${++next}`
      objectUrlBlobs.set(url, blob as Blob)
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })
  const decodesReadBytes = (value: string) => objectUrlBlobs.get(value)?.size === originalBytes.byteLength
  const makeItem = (crop: CanvasImageItem['crop'], known = false) => imageItem({
    src: original, sourceFile: undefined, sourceWidth: known ? 200 : undefined,
    sourceHeight: known ? 200 : undefined, image: undefined, width: 100, height: 100,
    thumbnailSet: undefined, crop, cropSource: record
  })
  const crop = { x: 0, y: 0, width: 100, height: 100 }
  it('keeps the original for an uncropped source', async () => {
    const result = await materializeCanvasAgentAttachmentItems([makeItem(undefined)])
    expect(buildCanvasAgentAttachments(result)[0]?.url).toBe(original)
  })
  it('exports a known 200x200 source crop using synthetic canvas drawing', async () => {
    const draw = vi.fn()
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as ReturnType<HTMLCanvasElement['getContext']>)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,c3ludGhldGljLWNyb3A=')
    vi.stubGlobal('Image', class {
      naturalWidth = 200; naturalHeight = 200; onload: (() => void) | null = null; onerror: (() => void) | null = null
      set src(value: string) { queueMicrotask(() => (decodesReadBytes(value) ? this.onload : this.onerror)?.()) }
    })
    try {
      const result = await materializeCanvasAgentAttachmentItems([makeItem(crop, true)])
      expect(buildCanvasAgentAttachments(result)[0]?.url).toBe('data:image/png;base64,c3ludGhldGljLWNyb3A=')
      expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 100, 0, 0, 100, 100)
    } finally { getContext.mockRestore(); toDataURL.mockRestore(); vi.unstubAllGlobals() }
  })
  it('does not treat stale thumbnail dimensions as a full original crop (async)', async () => {
    // No real decoder or pixel identity is exercised: Image and drawing are synthetic.
    const thumbnail = { width: 100, height: 100 } as unknown as CanvasImageItem['image']
    const item = imageItem({
      src: original, sourceFile: undefined, sourceWidth: 100, sourceHeight: 100,
      image: thumbnail, width: 100, height: 100, thumbnailSet: undefined,
      crop: { x: 0, y: 0, width: 100, height: 100 }, cropSource: record
    })
    const cropped = 'data:image/png;base64,c3ludGhldGljLWNyb3A='
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as ReturnType<HTMLCanvasElement['getContext']>)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(cropped)
    vi.stubGlobal('Image', class {
      naturalWidth = 200; naturalHeight = 200; onload: (() => void) | null = null; onerror: (() => void) | null = null
      set src(value: string) { queueMicrotask(() => (decodesReadBytes(value) ? this.onload : this.onerror)?.()) }
    })
    try {
      let result: Awaited<ReturnType<typeof materializeCanvasAgentAttachmentItems>> | undefined
      let failure: unknown
      try {
        result = await materializeCanvasAgentAttachmentItems([item])
      } catch (error) { failure = error }
      if (failure !== undefined) {
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toBe('CANVAS_CROP_EXPORT_UNAVAILABLE')
      } else if (result?.length === 0) {
        // The bridge treats a filtered crop as a whole-selection failure.
        expect(buildCanvasAgentAttachments(result)).toEqual([])
      } else {
        expect(result).toHaveLength(1)
        expect(buildCanvasAgentAttachments(result!)[0]?.url).toBe(cropped)
        expect(buildCanvasAgentAttachments(result!)[0]?.url).not.toBe(original)
      }
    } finally { getContext.mockRestore(); toDataURL.mockRestore(); vi.unstubAllGlobals() }
  })
  it('must not return the full source when dimensions are absent and crop export fails', async () => {
    const item = makeItem(crop)
    expect(buildCanvasImageCropSourceMetadata(item)).toBeNull()
    vi.stubGlobal('Image', class {
      naturalWidth = 200; naturalHeight = 200; onload: (() => void) | null = null; onerror: (() => void) | null = null
      set src(value: string) { queueMicrotask(() => (decodesReadBytes(value) ? this.onload : this.onerror)?.()) }
    })
    try {
      const result = await materializeCanvasAgentAttachmentItems([item])
      expect(buildCanvasAgentAttachments(result).some((attachment) => attachment.url === original)).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
})

describe('canvas agent attachments preserve original sources', () => {
  it('uses the original image src, not a thumbnail tile, for agent attachments', () => {
    const item = imageItem()

    expect(buildCanvasImageAttachment(item).url).toBe('local-media:///original/full-frame.png')
    expect(buildCanvasAgentAttachments([item])[0]?.url).toBe(
      'local-media:///original/full-frame.png'
    )
  })

  it('uses the original image src in crop metadata while preserving the source blob', async () => {
    const item = imageItem({ crop: { x: 100, y: 200, width: 1200, height: 900 } })

    expect(buildCanvasImageCropSourceMetadata(item)).toMatchObject({
      url: 'local-media:///original/full-frame.png',
      sourceWidth: 4000,
      sourceHeight: 3000,
      crop: { x: 100, y: 200, width: 1200, height: 900 }
    })

    expect(item.sourceFile).toBeInstanceOf(Blob)
    expect(item.sourceFile).toBeDefined()
  })

  it('uses the original 3D model src rather than a preview texture', () => {
    const item = modelItem()
    const attachment = buildCanvasAgentAttachments([item])[0]

    expect(attachment).toMatchObject({
      type: 'model3d',
      url: 'local-media:///original/model.glb',
      fileName: 'model.glb'
    })
  })
})

describe('canvas proven crop pixels for synchronous sinks', () => {
  const record: CanvasImageCropSource = {
    version: 1, origin: 'confirm', width: 4000, height: 3000, sizeBytes: 12, sha256: '0f'.repeat(32)
  }
  const evidence = { sizeBytes: 12, sha256: record.sha256, width: 4000, height: 3000 }
  const cropped = () => imageItem({ crop: { x: 100, y: 200, width: 300, height: 400 }, cropSource: record })
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const originalToBlob = HTMLCanvasElement.prototype.toBlob
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toBlob = originalToBlob
    vi.restoreAllMocks()
  })
  const stubCanvas = (blob: Blob | null) => {
    const drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    const toBlob = vi.fn((callback: BlobCallback) => callback(blob))
    HTMLCanvasElement.prototype.toBlob = toBlob as unknown as typeof HTMLCanvasElement.prototype.toBlob
    return { drawImage, toBlob }
  }
  const decoded = { width: 4000, height: 3000 } as unknown as HTMLImageElement

  it('draws the recorded crop of verified bytes into a PNG blob at the crop size', async () => {
    const png = new Blob(['png'], { type: 'image/png' })
    const { drawImage, toBlob } = stubCanvas(png)
    await expect(drawVerifiedCanvasImageCropPng(cropped(), { ...evidence, image: decoded })).resolves.toEqual({ blob: png, width: 300, height: 400 })
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(decoded, 100, 200, 300, 400, 0, 0, 300, 400)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
  })

  it.each([
    ['hash', { sha256: 'aa'.repeat(32) }],
    ['byte size', { sizeBytes: 13 }],
    ['decoded size', { width: 2000, height: 1500 }]
  ] as const)('draws nothing when the evidence %s differs from the record', async (_label, change) => {
    const { drawImage, toBlob } = stubCanvas(new Blob(['png'], { type: 'image/png' }))
    const createElement = vi.spyOn(document, 'createElement')
    await expect(drawVerifiedCanvasImageCropPng(cropped(), { ...evidence, ...change, image: decoded })).resolves.toBeNull()
    expect(createElement).not.toHaveBeenCalledWith('canvas')
    expect(drawImage).not.toHaveBeenCalled()
    expect(toBlob).not.toHaveBeenCalled()
  })

  it.each([
    ['no blob', null],
    ['an empty blob', new Blob([], { type: 'image/png' })],
    ['a non-PNG blob', new Blob(['x'], { type: 'image/jpeg' })]
  ] as const)('returns null when the encoder yields %s', async (_label, blob) => {
    stubCanvas(blob)
    await expect(drawVerifiedCanvasImageCropPng(cropped(), { ...evidence, image: decoded })).resolves.toBeNull()
  })

  it('turns only a base64 PNG data URL into a PNG blob', async () => {
    const blob = canvasPngDataUrlToBlob('data:image/png;base64,iVBORw0K')
    expect(blob?.type).toBe('image/png')
    expect(blob?.size).toBe(6)
    expect(canvasPngDataUrlToBlob('data:,')).toBeNull()
    expect(canvasPngDataUrlToBlob('data:image/jpeg;base64,iVBORw0K')).toBeNull()
    expect(canvasPngDataUrlToBlob('local-media:///original/full-frame.png')).toBeNull()
  })

  it('replaces a crop only by a proven PNG that is not the original source', () => {
    const item = cropped()
    const proven = { url: 'blob:proven-crop', fileName: 'full-frame.png', sizeBytes: 3, width: 300, height: 400 }
    const [visible] = materializeCanvasAgentAttachmentItemsSync([item], () => proven) as CanvasImageItem[]
    expect(visible).toEqual(expect.objectContaining({ id: item.id, src: 'blob:proven-crop', sourceWidth: 300, sourceHeight: 400, width: 300, height: 400 }))
    for (const key of ['crop', 'cropSource', 'image', 'thumbnailSet', 'sourceFile', 'sourceIdentity', 'media'] as const) {
      expect(visible).not.toHaveProperty(key)
    }
    expect(materializeCanvasAgentAttachmentItemsSync([item], () => ({ ...proven, url: item.src }))).toEqual([item])
    expect(materializeCanvasAgentAttachmentItemsSync([item], () => null)).toEqual([item])
    expect(materializeCanvasAgentAttachmentItemsSync([item])).toEqual([item])
    expect(item.crop).toEqual({ x: 100, y: 200, width: 300, height: 400 })
  })
})

describe('Agent send of crops: registered PNG and the leak post-check (F2 parts 5 and 6)', () => {
  const PNG_BYTES = 'registered-crop-png'
  const PNG_DATA_URL = `data:image/png;base64,${btoa(PNG_BYTES)}`
  const record: CanvasImageCropSource = {
    version: 1, origin: 'confirm', width: 4000, height: 3000, sizeBytes: 12, sha256: '0f'.repeat(32)
  }
  const cropped = (overrides: Partial<CanvasImageItem> = {}) =>
    imageItem({ crop: { x: 100, y: 200, width: 300, height: 400 }, cropSource: record, ...overrides })
  const registeredPng = () => ({
    blob: new Blob([PNG_BYTES], { type: 'image/png' }),
    fileName: 'full-frame.png',
    width: 300,
    height: 400
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const matchingEvidence = (change: Partial<{ sizeBytes: number; sha256: string; width: number; height: number }> = {}) => ({
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    width: record.width,
    height: record.height,
    ...change,
    image: { width: 4000, height: 3000 } as unknown as HTMLImageElement
  })

  it('sends the registered PNG of a crop whose source still holds the recorded bytes: one read, no canvas', async () => {
    const readEvidence = vi.fn(async () => matchingEvidence())
    const createElement = vi.spyOn(document, 'createElement')
    const item = cropped()
    const prepared = await prepareCanvasAgentCropDelivery([item], () => true, readEvidence, {
      lookupProvenCropPng: () => registeredPng()
    })
    expect(readEvidence).toHaveBeenCalledExactlyOnceWith(item.src, expect.any(Function))
    expect(createElement).not.toHaveBeenCalledWith('canvas')
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    const [attachment] = prepared.attachmentItems as CanvasImageItem[]
    const [overview] = prepared.overviewItems as CanvasImageItem[]
    expect(attachment).toEqual(
      expect.objectContaining({ src: PNG_DATA_URL, sizeBytes: PNG_BYTES.length, sourceWidth: 300, sourceHeight: 400, width: 300, height: 400 })
    )
    expect(overview).toEqual(expect.objectContaining({ src: PNG_DATA_URL, width: 400, height: 300 }))
    for (const key of ['crop', 'cropSource', 'image', 'thumbnailSet', 'sourceFile', 'sourceIdentity']) {
      expect(attachment).not.toHaveProperty(key)
      expect(overview).not.toHaveProperty(key)
    }
  })

  it.each([
    ['hash', { sha256: 'aa'.repeat(32) }],
    ['byte size', { sizeBytes: 13 }],
    ['decoded size', { width: 2000, height: 1500 }]
  ] as const)('refuses a crop with a registered PNG when the source %s no longer equals the record', async (_label, change) => {
    // The file was replaced while the board was open: the registered PNG is not sent in its place.
    const lookupProvenCropPng = vi.fn(() => registeredPng())
    const createElement = vi.spyOn(document, 'createElement')
    const readEvidence = vi.fn(async () => matchingEvidence(change))
    const prepared = await prepareCanvasAgentCropDelivery([cropped()], () => true, readEvidence, { lookupProvenCropPng })
    expect(prepared).toEqual({ status: 'unverified' })
    expect(readEvidence).toHaveBeenCalledOnce()
    expect(lookupProvenCropPng).not.toHaveBeenCalled()
    expect(createElement).not.toHaveBeenCalledWith('canvas')
  })

  it('refuses a crop with a registered PNG when its source cannot be read', async () => {
    const lookupProvenCropPng = vi.fn(() => registeredPng())
    const prepared = await prepareCanvasAgentCropDelivery([cropped()], () => true, vi.fn(async () => null), { lookupProvenCropPng })
    expect(prepared).toEqual({ status: 'unverified' })
    expect(lookupProvenCropPng).not.toHaveBeenCalled()
  })

  it('refuses the whole selection when a registered PNG turns out to be the original source', async () => {
    // The source is itself this PNG as a data: URL: the prepared item would carry the original.
    const item = cropped({ src: PNG_DATA_URL })
    const lookupProvenCropPng = vi.fn(() => registeredPng())
    const prepared = await prepareCanvasAgentCropDelivery([item], () => true, vi.fn(async () => matchingEvidence()), {
      lookupProvenCropPng
    })
    expect(lookupProvenCropPng).toHaveBeenCalledOnce()
    expect(prepared).toEqual({ status: 'unverified' })
  })

  it('refuses the whole selection when the drawn crop is the original source', async () => {
    // A data: source whose drawn crop encodes to the very same string.
    const item = cropped({ src: PNG_DATA_URL })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG_DATA_URL)
    const readEvidence = vi.fn(async () => ({
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      width: record.width,
      height: record.height,
      image: { width: 4000, height: 3000 } as unknown as HTMLImageElement
    }))
    const prepared = await prepareCanvasAgentCropDelivery([item], () => true, readEvidence)
    expect(readEvidence).toHaveBeenCalledOnce()
    expect(prepared).toEqual({ status: 'unverified' })
  })

  it('builds a drag snapshot only from registered PNGs, at the item geometry', () => {
    const item = cropped()
    const plain = imageItem({ id: 'plain' })
    const proven = { url: 'blob:proven-crop', fileName: 'full-frame.png', sizeBytes: 3, width: 300, height: 400 }
    const snapshot = buildCanvasProvenCropSnapshotItemsSync([plain, item], () => proven)!
    expect(snapshot[0]).toBe(plain)
    expect(snapshot[1]).toEqual(expect.objectContaining({ src: 'blob:proven-crop', width: 400, height: 300, sourceWidth: 300, sourceHeight: 400 }))
    expect(snapshot[1]).not.toHaveProperty('crop')
    expect(buildCanvasProvenCropSnapshotItemsSync([plain, item], () => null)).toBeNull()
    expect(buildCanvasProvenCropSnapshotItemsSync([plain, item])).toBeNull()
    expect(buildCanvasProvenCropSnapshotItemsSync([plain, item], () => ({ ...proven, url: item.src }))).toBeNull()
    const plainOnly = [plain]
    expect(buildCanvasProvenCropSnapshotItemsSync(plainOnly)).toBe(plainOnly)
  })
})
