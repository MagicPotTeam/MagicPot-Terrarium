import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { FIGPLUGIN_ASSET_MAX_BYTES } from '@shared/figplugin/hostAssets'

export const CHECKPOINT_IMAGE_MAX_WRAPPED_KEY_BYTES = 64 * 1024
const MAGIC = Buffer.from('MPICB001', 'ascii')
const HEADER_BYTES = 44
export const CHECKPOINT_IMAGE_MAX_CIPHER_BYTES =
  FIGPLUGIN_ASSET_MAX_BYTES + CHECKPOINT_IMAGE_MAX_WRAPPED_KEY_BYTES + HEADER_BYTES

type KeyCodec = {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}
export type CheckpointBinaryCodec = {
  encryptBytes(bytes: Uint8Array, associatedData: string): Buffer
  decryptBytes(data: Uint8Array, associatedData: string, maxBytes: number): Buffer
}

const unavailable = (): Error => new Error('FIGPLUGIN_CHECKPOINT_UNAVAILABLE')
const checkedContext = (text: string): Buffer => {
  if (typeof text !== 'string' || text.length < 1 || Buffer.byteLength(text, 'utf8') > 4096)
    throw unavailable()
  return Buffer.from(text, 'utf8')
}

/** The OS text codec wraps a fresh DEK only. Image bytes never become a plaintext disk file. */
export function createCheckpointBinaryCodec(keys: KeyCodec): CheckpointBinaryCodec {
  return {
    encryptBytes(bytes, associatedData) {
      let key: Buffer | undefined
      let owned: Buffer | undefined
      try {
        const context = checkedContext(associatedData)
        if (
          !keys.available() ||
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength < 1 ||
          bytes.byteLength > FIGPLUGIN_ASSET_MAX_BYTES
        )
          throw unavailable()
        owned = Buffer.from(bytes)
        key = randomBytes(32)
        const wrapped = keys.encrypt(key.toString('hex'))
        if (
          !Buffer.isBuffer(wrapped) ||
          wrapped.length < 1 ||
          wrapped.length > CHECKPOINT_IMAGE_MAX_WRAPPED_KEY_BYTES
        )
          throw unavailable()
        const header = Buffer.alloc(HEADER_BYTES)
        MAGIC.copy(header)
        header.writeUInt32BE(wrapped.length, 8)
        header.writeUInt32BE(owned.length, 12)
        randomBytes(12).copy(header, 16)
        const cipher = createCipheriv('aes-256-gcm', key, header.subarray(16, 28))
        cipher.setAAD(Buffer.concat([header.subarray(0, 28), wrapped, context]))
        const ciphertext = Buffer.concat([cipher.update(owned), cipher.final()])
        cipher.getAuthTag().copy(header, 28)
        return Buffer.concat([header, wrapped, ciphertext])
      } catch {
        throw unavailable()
      } finally {
        key?.fill(0)
        owned?.fill(0)
      }
    },
    decryptBytes(data, associatedData, maxBytes) {
      let key: Buffer | undefined
      let partial: Buffer | undefined
      let plain: Buffer | undefined
      let returned = false
      try {
        const context = checkedContext(associatedData)
        if (
          !keys.available() ||
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > FIGPLUGIN_ASSET_MAX_BYTES ||
          !(data instanceof Uint8Array) ||
          data.byteLength <= HEADER_BYTES ||
          data.byteLength > CHECKPOINT_IMAGE_MAX_CIPHER_BYTES
        )
          throw unavailable()
        const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        if (!input.subarray(0, 8).equals(MAGIC)) throw unavailable()
        const wrappedLength = input.readUInt32BE(8)
        const plainLength = input.readUInt32BE(12)
        if (
          wrappedLength < 1 ||
          wrappedLength > CHECKPOINT_IMAGE_MAX_WRAPPED_KEY_BYTES ||
          plainLength < 1 ||
          plainLength > maxBytes ||
          input.length !== HEADER_BYTES + wrappedLength + plainLength
        )
          throw unavailable()
        const wrapped = input.subarray(HEADER_BYTES, HEADER_BYTES + wrappedLength)
        const decodedKey = keys.decrypt(wrapped)
        if (typeof decodedKey !== 'string' || !/^[a-f0-9]{64}$(?![\s\S])/.test(decodedKey))
          throw unavailable()
        key = Buffer.from(decodedKey, 'hex')
        const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(16, 28))
        decipher.setAAD(Buffer.concat([input.subarray(0, 28), wrapped, context]))
        decipher.setAuthTag(input.subarray(28, HEADER_BYTES))
        partial = decipher.update(input.subarray(HEADER_BYTES + wrappedLength))
        const tail = decipher.final()
        try {
          plain = Buffer.concat([partial, tail])
        } finally {
          tail.fill(0)
        }
        if (plain.length !== plainLength) throw unavailable()
        returned = true
        return plain
      } catch {
        throw unavailable()
      } finally {
        key?.fill(0)
        partial?.fill(0)
        if (!returned) plain?.fill(0)
      }
    }
  }
}
