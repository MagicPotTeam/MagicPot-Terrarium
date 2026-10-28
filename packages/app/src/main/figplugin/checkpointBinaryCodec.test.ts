import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FIGPLUGIN_ASSET_MAX_BYTES } from '@shared/figplugin/hostAssets'
import {
  CHECKPOINT_IMAGE_MAX_CIPHER_BYTES,
  createCheckpointBinaryCodec
} from './checkpointBinaryCodec'

const fixture = () => {
  const key = randomBytes(32)
  const text = {
    available: vi.fn(() => true),
    encrypt: vi.fn((value: string) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), data])
    }),
    decrypt: vi.fn((value: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    })
  }
  return { text, codec: createCheckpointBinaryCodec(text) }
}
const source = Buffer.from('PRIVATE-SYNTHETIC-IMAGE\0\x01\x02\xff', 'latin1')
const aad = '{"purpose":"figplugin-checkpoint-image-v1","blobId":"owned","sourceKey":"exact"}'

describe('OS-wrapped checkpoint image binary codec', () => {
  it('encrypts raw bytes with a fresh wrapped DEK and preserves the borrowed input', () => {
    const { text, codec } = fixture()
    const original = Buffer.from(source)
    const first = codec.encryptBytes(source, aad)
    const second = codec.encryptBytes(source, aad)
    expect(first.equals(second)).toBe(false)
    expect(source).toEqual(original)
    expect(first.includes(source)).toBe(false)
    expect(first.toString('utf8')).not.toContain(source.toString('base64'))
    expect(text.encrypt).toHaveBeenCalledTimes(2)
    for (const [wrapped] of text.encrypt.mock.calls) {
      expect(wrapped).toMatch(/^[a-f0-9]{64}$/)
      expect(first.includes(Buffer.from(wrapped))).toBe(false)
    }
    expect(text.encrypt.mock.calls[0][0]).not.toBe(text.encrypt.mock.calls[1][0])
    const opened = codec.decryptBytes(first, aad, source.length)
    expect(Buffer.isBuffer(opened)).toBe(true)
    expect(opened).toEqual(source)
    opened.fill(0)
    expect(codec.decryptBytes(first, aad, source.length)).toEqual(source)
  })

  it.each([0, 7, 8, 11, 12, 15, 16, 27, 28, 43, 44, 80, -1])(
    'rejects a tampered header, wrapped key, nonce, tag or ciphertext byte at %i',
    (offset) => {
      const { codec } = fixture()
      const encrypted = codec.encryptBytes(source, aad)
      const at = offset < 0 ? encrypted.length + offset : offset
      encrypted[at] ^= 1
      expect(() => codec.decryptBytes(encrypted, aad, source.length)).toThrow(
        'FIGPLUGIN_CHECKPOINT_UNAVAILABLE'
      )
    }
  )

  it('binds ciphertext to the exact versioned metadata and key store', () => {
    const first = fixture()
    const encrypted = first.codec.encryptBytes(source, aad)
    expect(() => first.codec.decryptBytes(encrypted, aad + ' ', source.length)).toThrow()
    expect(() => fixture().codec.decryptBytes(encrypted, aad, source.length)).toThrow()
    first.text.available.mockReturnValue(false)
    expect(() => first.codec.decryptBytes(encrypted, aad, source.length)).toThrow()
    expect(() => first.codec.encryptBytes(source, aad)).toThrow()
  })

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, FIGPLUGIN_ASSET_MAX_BYTES + 1])(
    'rejects invalid explicit plaintext allocation cap %j before key unwrapping',
    (limit) => {
      const { codec, text } = fixture()
      const encrypted = codec.encryptBytes(source, aad)
      expect(() => codec.decryptBytes(encrypted, aad, limit)).toThrow()
      expect(text.decrypt).not.toHaveBeenCalled()
    }
  )

  it('rejects oversized/truncated/trailing binary input before key unwrapping', () => {
    const { codec, text } = fixture()
    const encrypted = codec.encryptBytes(source, aad)
    for (const data of [
      Buffer.alloc(0),
      encrypted.subarray(0, 43),
      encrypted.subarray(0, -1),
      Buffer.concat([encrypted, Buffer.from([0])]),
      Buffer.alloc(CHECKPOINT_IMAGE_MAX_CIPHER_BYTES + 1)
    ])
      expect(() => codec.decryptBytes(data, aad, source.length)).toThrow()
    expect(text.decrypt).not.toHaveBeenCalled()
    expect(() => codec.decryptBytes(encrypted, aad, source.length - 1)).toThrow()
  })

  it.each(['', 'G'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\n'])(
    'rejects malformed unwrapped key %j without exposing it',
    (key) => {
      const { codec, text } = fixture()
      const encrypted = codec.encryptBytes(source, aad)
      text.decrypt.mockReturnValue(key)
      expect(() => codec.decryptBytes(encrypted, aad, source.length)).toThrow(
        'FIGPLUGIN_CHECKPOINT_UNAVAILABLE'
      )
    }
  )

  it('refuses empty/oversized bytes, contexts and wrapped keys without plaintext fallback', () => {
    const { codec, text } = fixture()
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(FIGPLUGIN_ASSET_MAX_BYTES + 1)])
      expect(() => codec.encryptBytes(bytes, aad)).toThrow()
    for (const context of ['', 'x'.repeat(4097)])
      expect(() => codec.encryptBytes(source, context)).toThrow()
    for (const wrapped of [Buffer.alloc(0), Buffer.alloc(65537)]) {
      text.encrypt.mockReturnValue(wrapped)
      expect(() => codec.encryptBytes(source, aad)).toThrow()
    }
    text.encrypt.mockImplementation(() => {
      throw new Error('PRIVATE-KEY-ERROR')
    })
    expect(() => codec.encryptBytes(source, aad)).toThrow('FIGPLUGIN_CHECKPOINT_UNAVAILABLE')
  })
})
