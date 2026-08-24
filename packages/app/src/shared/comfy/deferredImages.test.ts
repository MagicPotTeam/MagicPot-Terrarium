import { describe, expect, it } from 'vitest'
import {
  DEFERRED_COMFY_FILE_VALUE_PREFIX,
  DEFERRED_COMFY_IMAGE_VALUE_PREFIX,
  DEFERRED_COMFY_INLINE_MAX_BYTES,
  DEFERRED_COMFY_MASK_VALUE_PREFIX,
  DEFERRED_COMFY_PERSIST_MAX_BYTES,
  InvalidDeferredComfyInputValueError,
  encodeDeferredComfyFileInputValue,
  encodeDeferredComfyImageInputValue,
  encodeDeferredComfyMaskInputValue,
  getDeferredComfyFileDisplayName,
  isDeferredComfyInputValue,
  parseDeferredComfyFileInputValue,
  parseDeferredComfyImageInputValue,
  parseDeferredComfyMaskInputValue
} from './deferredImages'

const inline = 'data:image/png;base64,AQID'

const deferredValue = (prefix: string, payload: object): string =>
  `${prefix}${encodeURIComponent(JSON.stringify(payload))}`

const expectInvalid = (parse: () => unknown): void => {
  expect(parse).toThrow(InvalidDeferredComfyInputValueError)
}

describe('deferred Comfy input codec', () => {
  it('round-trips strict image, generic file, and mask values', () => {
    const image = encodeDeferredComfyImageInputValue({
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      dataUrl: inline
    })
    const video = encodeDeferredComfyFileInputValue({
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 128,
      filePath: 'C:/cache/clip.mp4'
    })
    const mask = encodeDeferredComfyMaskInputValue({
      fileName: 'mask.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      dataUrl: inline,
      originalValue: image
    })

    expect(parseDeferredComfyImageInputValue(image)).toEqual({
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      dataUrl: inline
    })
    expect(parseDeferredComfyFileInputValue(video)).toEqual({
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 128,
      filePath: 'C:/cache/clip.mp4'
    })
    expect(parseDeferredComfyMaskInputValue(mask)).toMatchObject({
      fileName: 'mask.png',
      originalValue: image
    })
  })

  it('requires canonical base64 and matching declared MIME and byte length', () => {
    for (const payload of [
      {
        fileName: 'bad.png',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        dataUrl: inline
      },
      {
        fileName: 'bad.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        dataUrl: 'data:image/png;base64,AQJ='
      },
      {
        fileName: 'bad.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        dataUrl: 'data:image/png;BASE64,AQID'
      },
      {
        fileName: 'bad.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        dataUrl: 'data:image/png,AQID'
      },
      {
        fileName: 'bad.png',
        mimeType: 'image/png',
        sizeBytes: 2,
        dataUrl: inline
      }
    ]) {
      expectInvalid(() =>
        parseDeferredComfyImageInputValue(deferredValue(DEFERRED_COMFY_IMAGE_VALUE_PREFIX, payload))
      )
    }
  })

  it('enforces filename, MIME, source, and size boundaries consistently', () => {
    for (const payload of [
      { fileName: ' nested.png', mimeType: 'image/png', sizeBytes: 1, filePath: 'C:/x' },
      { fileName: 'nested/name.png', mimeType: 'image/png', sizeBytes: 1, filePath: 'C:/x' },
      { fileName: 'x.png', mimeType: 'Image/PNG', sizeBytes: 1, filePath: 'C:/x' },
      { fileName: 'x.png', mimeType: 'not-a-mime', sizeBytes: 1, filePath: 'C:/x' },
      { fileName: 'x.png', mimeType: 'image/png', sizeBytes: -1, filePath: 'C:/x' },
      { fileName: 'x.png', mimeType: 'image/png', sizeBytes: 1 },
      {
        fileName: 'x.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        filePath: 'C:/x',
        dataUrl: inline
      },
      { fileName: 'x.mp4', mimeType: 'video/mp4', sizeBytes: 1, filePath: 'relative/x' },
      { fileName: 'x.mp4', mimeType: 'video/mp4', sizeBytes: 1, filePath: 'C:/bad\u0000x' },
      {
        fileName: 'x.mp4',
        mimeType: 'video/mp4',
        sizeBytes: DEFERRED_COMFY_PERSIST_MAX_BYTES + 1,
        filePath: '/cache/x.mp4'
      }
    ]) {
      expectInvalid(() =>
        parseDeferredComfyImageInputValue(deferredValue(DEFERRED_COMFY_IMAGE_VALUE_PREFIX, payload))
      )
    }
  })

  it('fails closed for malformed, oversized, and missing mask-original reserved values', () => {
    const malformed = `${DEFERRED_COMFY_FILE_VALUE_PREFIX}%not-json`
    const oversized = `${DEFERRED_COMFY_FILE_VALUE_PREFIX}${'a'.repeat(
      DEFERRED_COMFY_INLINE_MAX_BYTES * 4 + 64 * 1024 + 1
    )}`
    const missingOriginal = deferredValue(DEFERRED_COMFY_MASK_VALUE_PREFIX, {
      fileName: 'mask.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      dataUrl: inline,
      originalValue: '   '
    })

    expect(isDeferredComfyInputValue(malformed)).toBe(true)
    expectInvalid(() => parseDeferredComfyFileInputValue(malformed))
    expectInvalid(() => parseDeferredComfyFileInputValue(oversized))
    expectInvalid(() => parseDeferredComfyMaskInputValue(missingOriginal))
    expect(parseDeferredComfyFileInputValue('ordinary.png')).toBeNull()
    expect(() => getDeferredComfyFileDisplayName(malformed)).not.toThrow()
    expect(getDeferredComfyFileDisplayName(malformed)).toBe('')
  })
})
