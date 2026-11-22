import { describe, expect, it } from 'vitest'
import { inspectThreadImageGif, THREAD_IMAGE_GIF_LIMITS } from './agentThreadImageGif'

const header = () => Buffer.from('47494638396101000100800000000000ffffff', 'hex')
const frame = () => Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex')
const gif = (frames = 2) =>
  Buffer.concat([header(), ...Array.from({ length: frames }, frame), Buffer.from([0x3b])])
const sized = (width: number, height: number, frames = 2) => {
  const bytes = gif(frames)
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

describe('thread GIF output bounded framing only (not pixel decode)', () => {
  it.each(['GIF87a', 'GIF89a'])(
    'compares every raw byte of %s without high-bit masking',
    (signature) => {
      for (const index of [0, 1, 2, 3, 4, 5, 'all'] as const) {
        const bytes = gif()
        bytes.write(signature, 0, 'latin1')
        for (let offset = 0; offset < 6; offset++)
          if (index === 'all' || index === offset) bytes[offset] |= 0x80
        expect(() => inspectThreadImageGif(bytes)).toThrow('GIF output')
      }
    }
  )
  it('accepts framed local palettes without a global palette', () => {
    const local = () =>
      Buffer.concat([Buffer.from('2c000000000100010080000000ffffff0202440100', 'hex')])
    const logical = header().subarray(0, 13)
    logical[10] = 0
    expect(
      inspectThreadImageGif(Buffer.concat([logical, local(), local(), Buffer.from([0x3b])]))
        .frameCount
    ).toBe(2)
  })
  it.each([2, 4, 16])('counts %s valid framed one-pixel images', (frames) => {
    expect(inspectThreadImageGif(gif(frames))).toEqual({
      width: 1,
      height: 1,
      frameCount: frames,
      totalFramePixels: frames
    })
  })
  it('accepts GIF87a and a bounded application/comment extension', () => {
    const bytes = gif()
    bytes.write('GIF87a')
    const withExtensions = Buffer.concat([
      bytes.subarray(0, 19),
      Buffer.from('21ff0b4e45545343415045322e30030100000021fe026f6b00', 'hex'),
      bytes.subarray(19)
    ])
    expect(inspectThreadImageGif(withExtensions).frameCount).toBe(2)
  })
  it('charges full logical canvases for sparse frames and accepts an exact pixel boundary', () => {
    expect(inspectThreadImageGif(sized(4096, 4096, 4)).totalFramePixels).toBe(
      THREAD_IMAGE_GIF_LIMITS.maxTotalFramePixels
    )
    expect(() => inspectThreadImageGif(sized(4096, 4096, 5))).toThrow('bounded')
    expect(() => inspectThreadImageGif(sized(4097, 1))).toThrow('bounded')
  })
  it.each([0, 1, 17])('refuses %s image frames', (frames) => {
    expect(() => inspectThreadImageGif(gif(frames))).toThrow('GIF output')
  })
  it.each([
    [
      'bad header',
      (b: Buffer) => {
        b[0] = 0
      }
    ],
    [
      'zero width',
      (b: Buffer) => {
        b.writeUInt16LE(0, 6)
      }
    ],
    [
      'zero height',
      (b: Buffer) => {
        b.writeUInt16LE(0, 8)
      }
    ],
    [
      'unknown extension',
      (b: Buffer) => {
        b[20] = 1
      }
    ],
    [
      'GCE wrong size',
      (b: Buffer) => {
        b[21] = 5
      }
    ],
    [
      'GCE reserved',
      (b: Buffer) => {
        b[22] = 0xe0
      }
    ],
    [
      'GCE disposal',
      (b: Buffer) => {
        b[22] = 0x1c
      }
    ],
    [
      'GCE terminator',
      (b: Buffer) => {
        b[26] = 1
      }
    ],
    [
      'unknown rendering block',
      (b: Buffer) => {
        b[27] = 0
      }
    ],
    [
      'frame out of canvas',
      (b: Buffer) => {
        b.writeUInt16LE(1, 28)
      }
    ],
    [
      'frame zero width',
      (b: Buffer) => {
        b.writeUInt16LE(0, 32)
      }
    ],
    [
      'frame reserved',
      (b: Buffer) => {
        b[36] = 0x18
      }
    ],
    [
      'missing palette',
      (b: Buffer) => {
        b[10] &= 0x7f
      }
    ],
    [
      'bad LZW min',
      (b: Buffer) => {
        b[37] = 1
      }
    ],
    [
      'bad data length',
      (b: Buffer) => {
        b[38] = 255
      }
    ],
    [
      'missing trailer',
      (b: Buffer) => {
        b[b.length - 1] = 0
      }
    ]
  ] as const)('refuses %s framing', (_, mutate) => {
    const bytes = gif()
    mutate(bytes)
    expect(() => inspectThreadImageGif(bytes)).toThrow('GIF output')
  })
  it('refuses every truncated prefix and bytes after the trailer', () => {
    const bytes = gif()
    for (let index = 0; index < bytes.length; index++)
      expect(() => inspectThreadImageGif(bytes.subarray(0, index))).toThrow('GIF output')
    expect(() => inspectThreadImageGif(Buffer.concat([bytes, Buffer.from([0])]))).toThrow(
      'GIF output'
    )
  })
  it('refuses over-byte/chunk budgets without native decoding', () => {
    const tooBig = Buffer.alloc(THREAD_IMAGE_GIF_LIMITS.maxBytes + 1)
    gif().copy(tooBig)
    expect(() => inspectThreadImageGif(tooBig)).toThrow('GIF output')
    const comments = Buffer.concat(Array.from({ length: 8193 }, () => Buffer.from([0x21, 0xfe, 0])))
    expect(() =>
      inspectThreadImageGif(Buffer.concat([header(), comments, gif().subarray(19)]))
    ).toThrow('GIF output')
  })
  it('explicitly does not claim LZW/pixel decoding of the framed payload', () => {
    const bytes = gif()
    bytes[39] = 0 // Still bounded framing; pixel validity must not be inferred.
    expect(inspectThreadImageGif(bytes).frameCount).toBe(2)
  })
})
