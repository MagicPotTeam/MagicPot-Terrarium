import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CanvasImageCropSource, CanvasImageItem } from './types'

const mocks = vi.hoisted(() => ({
  loadImageFromSrc: vi.fn(),
  resolveAuthorized: vi.fn(),
  sha256Hex: vi.fn()
}))

vi.mock('./canvasAssetIntakeHelpers', () => ({ loadImageFromSrc: mocks.loadImageFromSrc }))
vi.mock('./canvasLocalFileSource', () => ({
  resolveAuthorizedCanvasLocalMediaSourceUrl: mocks.resolveAuthorized
}))
vi.mock('./canvasSha256', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canvasSha256')>()
  mocks.sha256Hex.mockImplementation(actual.sha256Hex)
  return { ...actual, sha256Hex: mocks.sha256Hex }
})

import {
  createCropSourceRecord,
  getCanvasCropOverlaySpace,
  hasVerifiableCrop,
  isConfirmedIdentityCrop,
  isCropSourceRecordValid,
  matchesCropSource,
  readCanvasImageSourceEvidence
} from './canvasCropProvenance'

// Synthetic bytes only: "synthetic" and a short fake PNG header; nothing is a real picture.
const SYNTHETIC_BYTES = new TextEncoder().encode('synthetic')
const SYNTHETIC_DATA_URL = 'data:image/png;base64,c3ludGhldGlj'
const SYNTHETIC_SHA = createHash('sha256').update(SYNTHETIC_BYTES).digest('hex')
const MAX = 1024

function record(overrides: Partial<CanvasImageCropSource> = {}): CanvasImageCropSource {
  return {
    version: 1,
    origin: 'confirm',
    width: 200,
    height: 120,
    sizeBytes: SYNTHETIC_BYTES.byteLength,
    sha256: SYNTHETIC_SHA,
    ...overrides
  }
}

function imageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'synthetic-item',
    type: 'image',
    src: SYNTHETIC_DATA_URL,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(
    await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
  )
}

function fetchResponse(blob: Blob, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    blob: vi.fn(async () => blob)
  }
}

let objectUrlBlobs: Map<string, Blob>
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>
let originalObjectUrlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>

beforeEach(() => {
  objectUrlBlobs = new Map()
  let nextId = 0
  createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:synthetic-evidence-${++nextId}`
    objectUrlBlobs.set(url, blob)
    return url
  })
  revokeObjectURL = vi.fn()
  originalObjectUrlApi = {
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL
  }
  Object.assign(URL, { createObjectURL, revokeObjectURL })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  mocks.loadImageFromSrc.mockReset()
  mocks.loadImageFromSrc.mockImplementation(async () => ({
    img: document.createElement('img'),
    width: 200,
    height: 120
  }))
  mocks.resolveAuthorized.mockReset()
  mocks.sha256Hex.mockClear()
})

afterEach(() => {
  Object.assign(URL, originalObjectUrlApi)
  vi.unstubAllGlobals()
})

describe('readCanvasImageSourceEvidence', () => {
  it('hashes and decodes the same bytes of a data: URL, without any fetch', async () => {
    const evidence = await readCanvasImageSourceEvidence(SYNTHETIC_DATA_URL, () => true, {
      maxBytes: MAX
    })

    expect(evidence).toEqual(
      expect.objectContaining({
        sizeBytes: SYNTHETIC_BYTES.byteLength,
        sha256: SYNTHETIC_SHA,
        width: 200,
        height: 120
      })
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.loadImageFromSrc).toHaveBeenCalledTimes(1)
    const decodeInput = mocks.loadImageFromSrc.mock.calls[0][0] as string
    expect(decodeInput).not.toBe(SYNTHETIC_DATA_URL)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(createObjectURL.mock.results[0].value).toBe(decodeInput)
    expect(Array.from(await readBlobBytes(objectUrlBlobs.get(decodeInput)!))).toEqual(
      Array.from(SYNTHETIC_BYTES)
    )
    expect(mocks.sha256Hex).toHaveBeenCalledTimes(1)
    expect(Array.from(new Uint8Array(mocks.sha256Hex.mock.calls[0][0]))).toEqual(
      Array.from(SYNTHETIC_BYTES)
    )
    expect(revokeObjectURL).toHaveBeenCalledWith(decodeInput)
  })

  it('reads a blob: source exactly once and decodes the object URL of the hashed blob', async () => {
    const blob = new Blob([SYNTHETIC_BYTES], { type: 'image/png' })
    const response = fetchResponse(blob)
    fetchMock.mockResolvedValue(response)

    const evidence = await readCanvasImageSourceEvidence('blob:synthetic-source', () => true, {
      maxBytes: MAX
    })

    expect(evidence).toEqual(expect.objectContaining({ sha256: SYNTHETIC_SHA, sizeBytes: 9 }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(response.blob).toHaveBeenCalledTimes(1)
    const decodeInput = mocks.loadImageFromSrc.mock.calls[0][0] as string
    expect(decodeInput).not.toBe('blob:synthetic-source')
    expect(objectUrlBlobs.get(decodeInput)).toBe(blob)
    expect(Array.from(new Uint8Array(mocks.sha256Hex.mock.calls[0][0]))).toEqual(
      Array.from(SYNTHETIC_BYTES)
    )
    expect(revokeObjectURL).toHaveBeenCalledWith(decodeInput)
  })

  it('reads a local source once through the authorized local-media path', async () => {
    mocks.resolveAuthorized.mockResolvedValue('local-media:///authorized/synthetic.png')
    fetchMock.mockResolvedValue(fetchResponse(new Blob([SYNTHETIC_BYTES], { type: 'image/png' })))

    const evidence = await readCanvasImageSourceEvidence(
      'file:///synthetic/synthetic.png',
      () => true,
      { maxBytes: MAX }
    )

    expect(evidence?.sha256).toBe(SYNTHETIC_SHA)
    expect(mocks.resolveAuthorized).toHaveBeenCalledWith('file:///synthetic/synthetic.png')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('local-media:///authorized/synthetic.png')
  })

  it('refuses an unauthorized local source without reading it', async () => {
    mocks.resolveAuthorized.mockResolvedValue(null)

    await expect(
      readCanvasImageSourceEvidence('local-media:///synthetic/denied.png', () => true, {
        maxBytes: MAX
      })
    ).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
  })

  it('starts the decode before the hash settles', async () => {
    let releaseHash!: (value: string) => void
    mocks.sha256Hex.mockImplementationOnce(
      () => new Promise<string>((resolve) => (releaseHash = resolve))
    )

    const pending = readCanvasImageSourceEvidence(SYNTHETIC_DATA_URL, () => true, {
      maxBytes: MAX
    })
    await vi.waitFor(() => expect(mocks.sha256Hex).toHaveBeenCalledTimes(1))
    expect(mocks.loadImageFromSrc).toHaveBeenCalledTimes(1)
    releaseHash(SYNTHETIC_SHA)
    await expect(pending).resolves.toEqual(expect.objectContaining({ sha256: SYNTHETIC_SHA }))
  })

  it.each([
    ['https://example.invalid/synthetic.png'],
    ['javascript:alert(1)'],
    ['synthetic.png'],
    ['data:image/svg+xml,%3Csvg%3E%3C/svg%3E']
  ])('refuses the unsupported source %s without reading or decoding', async (src) => {
    await expect(
      readCanvasImageSourceEvidence(src, () => true, { maxBytes: MAX })
    ).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
  })

  it('refuses an oversized data: source before decoding it', async () => {
    await expect(
      readCanvasImageSourceEvidence(SYNTHETIC_DATA_URL, () => true, { maxBytes: 8 })
    ).resolves.toBeNull()
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
    expect(mocks.sha256Hex).not.toHaveBeenCalled()
  })

  it('refuses an oversized fetched source by its declared length, before reading the body', async () => {
    const response = fetchResponse(new Blob([SYNTHETIC_BYTES]), { 'content-length': '4096' })
    fetchMock.mockResolvedValue(response)

    await expect(
      readCanvasImageSourceEvidence('blob:synthetic-large', () => true, { maxBytes: MAX })
    ).resolves.toBeNull()
    expect(response.blob).not.toHaveBeenCalled()
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
  })

  it('refuses an oversized fetched source by its real size', async () => {
    fetchMock.mockResolvedValue(fetchResponse(new Blob([SYNTHETIC_BYTES])))

    await expect(
      readCanvasImageSourceEvidence('blob:synthetic-large', () => true, { maxBytes: 8 })
    ).resolves.toBeNull()
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
  })

  it('stops after the read when the fence closes (unmount) and never decodes', async () => {
    let current = true
    let releaseFetch!: (value: unknown) => void
    fetchMock.mockImplementation(() => new Promise((resolve) => (releaseFetch = resolve)))

    const pending = readCanvasImageSourceEvidence('blob:synthetic-source', () => current, {
      maxBytes: MAX
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    current = false
    releaseFetch(fetchResponse(new Blob([SYNTHETIC_BYTES])))

    await expect(pending).resolves.toBeNull()
    expect(mocks.loadImageFromSrc).not.toHaveBeenCalled()
    expect(mocks.sha256Hex).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('drops a finished decode and revokes its URL when the fence closes meanwhile', async () => {
    let current = true
    mocks.loadImageFromSrc.mockImplementationOnce(async () => {
      current = false
      return { img: document.createElement('img'), width: 200, height: 120 }
    })

    await expect(
      readCanvasImageSourceEvidence(SYNTHETIC_DATA_URL, () => current, { maxBytes: MAX })
    ).resolves.toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith(createObjectURL.mock.results[0].value)
  })

  it('resolves null and revokes when the decode fails', async () => {
    mocks.loadImageFromSrc.mockRejectedValueOnce(new Error('synthetic decode failure'))

    await expect(
      readCanvasImageSourceEvidence(SYNTHETIC_DATA_URL, () => true, { maxBytes: MAX })
    ).resolves.toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })
})

describe('crop source records', () => {
  const evidence = { sizeBytes: 9, sha256: SYNTHETIC_SHA, width: 200, height: 120 }

  it('accepts only the exact record shape', () => {
    expect(isCropSourceRecordValid(record())).toBe(true)
    expect(isCropSourceRecordValid(record({ origin: 'reopen' }))).toBe(true)
    for (const malformed of [
      null,
      'record',
      [],
      { ...record(), extra: true },
      { ...record(), version: 2 },
      { ...record(), origin: 'import' },
      { ...record(), width: 0 },
      { ...record(), height: 1.5 },
      { ...record(), sizeBytes: -9 },
      { ...record(), sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...record(), sha256: SYNTHETIC_SHA.toUpperCase() },
      { ...record(), sha256: SYNTHETIC_SHA.slice(1) },
      (({ sha256: _sha256, ...rest }) => rest)(record())
    ]) {
      expect(isCropSourceRecordValid(malformed)).toBe(false)
    }
  })

  it('ignores a malformed record: the crop stays unverified', () => {
    const item = imageItem({
      crop: { x: 0, y: 0, width: 200, height: 120 },
      sourceWidth: 200,
      sourceHeight: 120,
      cropSource: { ...record(), sha256: 'not-a-hash' }
    })
    expect(hasVerifiableCrop(item)).toBe(false)
    expect(matchesCropSource(item, evidence)).toBe(false)
    expect(isConfirmedIdentityCrop(item)).toBe(false)
  })

  it('verifies only when hash, byte size and pixel size all match', () => {
    const item = imageItem({ crop: { x: 10, y: 10, width: 50, height: 50 }, cropSource: record() })
    expect(matchesCropSource(item, evidence)).toBe(true)
    expect(matchesCropSource(item, { ...evidence, sha256: 'f'.repeat(64) })).toBe(false)
    expect(matchesCropSource(item, { ...evidence, sizeBytes: 10 })).toBe(false)
    expect(matchesCropSource(item, { ...evidence, width: 100 })).toBe(false)
    expect(matchesCropSource(item, { ...evidence, height: 60 })).toBe(false)
    expect(matchesCropSource(imageItem({ crop: item.crop }), evidence)).toBe(false)
  })

  it('treats a crop as verifiable only inside the record with equal or absent size hints', () => {
    const crop = { x: 100, y: 20, width: 100, height: 100 }
    expect(hasVerifiableCrop(imageItem({ crop, cropSource: record() }))).toBe(true)
    expect(
      hasVerifiableCrop(
        imageItem({ crop, cropSource: record(), sourceWidth: 200, sourceHeight: 120 })
      )
    ).toBe(true)
    expect(
      hasVerifiableCrop(
        imageItem({ crop, cropSource: record(), sourceWidth: 100, sourceHeight: 60 })
      )
    ).toBe(false)
    expect(hasVerifiableCrop(imageItem({ crop: { ...crop, x: 101 }, cropSource: record() }))).toBe(
      false
    )
    expect(hasVerifiableCrop(imageItem({ crop: { ...crop, y: -1 }, cropSource: record() }))).toBe(
      false
    )
    expect(hasVerifiableCrop(imageItem({ cropSource: record() }))).toBe(false)
    expect(hasVerifiableCrop(imageItem({ crop }))).toBe(false)
  })

  it('proves an identity crop only from a confirm record with present, equal source size', () => {
    const full = { x: 0, y: 0, width: 200, height: 120 }
    const confirmed = imageItem({
      crop: full,
      cropSource: record(),
      sourceWidth: 200,
      sourceHeight: 120
    })
    expect(isConfirmedIdentityCrop(confirmed)).toBe(true)
    expect(
      isConfirmedIdentityCrop({ ...confirmed, cropSource: record({ origin: 'reopen' }) })
    ).toBe(false)
    expect(
      isConfirmedIdentityCrop({ ...confirmed, sourceWidth: undefined, sourceHeight: undefined })
    ).toBe(false)
    expect(isConfirmedIdentityCrop({ ...confirmed, sourceWidth: 100, sourceHeight: 60 })).toBe(
      false
    )
    expect(isConfirmedIdentityCrop({ ...confirmed, crop: { ...full, width: 199 } })).toBe(false)
    expect(isConfirmedIdentityCrop({ ...confirmed, cropSource: undefined })).toBe(false)
  })

  it('builds a record from evidence and reads the overlay crop space', () => {
    expect(createCropSourceRecord(evidence, 'confirm')).toEqual(record())
    expect(createCropSourceRecord({ ...evidence, width: 0 }, 'confirm')).toBeNull()
    const image = document.createElement('img')
    Object.defineProperty(image, 'naturalWidth', { value: 64 })
    Object.defineProperty(image, 'naturalHeight', { value: 32 })
    expect(getCanvasCropOverlaySpace(imageItem({ image }))).toEqual({ width: 64, height: 32 })
    expect(
      getCanvasCropOverlaySpace(imageItem({ image, sourceWidth: 200, sourceHeight: 120 }))
    ).toEqual({ width: 200, height: 120 })
    expect(getCanvasCropOverlaySpace(imageItem())).toBeNull()
  })
})
