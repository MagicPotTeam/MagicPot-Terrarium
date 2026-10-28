import { describe, expect, it } from 'vitest'
import {
  BINARY_CHUNK_PROTOCOL_VERSION,
  assembleBinaryChunks,
  createBinaryChunkTransport,
  validateBinaryChunkFrame,
  validateBinaryChunkReference
} from './binaryChunkProtocol'

const bytes = Uint8Array.from({ length: 32 }, (_, index) => index)

describe('content-addressed binary chunk protocol', () => {
  it('creates and reassembles canonical chunks independent of frame order', async () => {
    const transport = await createBinaryChunkTransport(bytes, {
      mimeType: 'IMAGE/PNG',
      chunkSize: 7
    })
    expect(transport.reference).toMatchObject({
      version: BINARY_CHUNK_PROTOCOL_VERSION,
      kind: 'content-addressed-binary',
      sizeBytes: 32,
      chunkSize: 7,
      chunkCount: 5,
      mimeType: 'image/png'
    })
    expect(transport.chunks.every((chunk) => chunk.bytesBase64.length % 4 === 0)).toBe(true)
    await expect(
      assembleBinaryChunks(transport.reference, [...transport.chunks].reverse())
    ).resolves.toEqual(bytes)
  })

  it('rejects duplicate, missing, forged and incorrectly sized frames', async () => {
    const transport = await createBinaryChunkTransport(bytes, {
      mimeType: 'image/png',
      chunkSize: 8
    })
    await expect(
      assembleBinaryChunks(transport.reference, [
        transport.chunks[0],
        transport.chunks[0],
        ...transport.chunks.slice(2)
      ])
    ).rejects.toThrow('does not match')
    await expect(
      assembleBinaryChunks(transport.reference, transport.chunks.slice(0, -1))
    ).rejects.toThrow('incomplete')
    await expect(
      assembleBinaryChunks(
        transport.reference,
        transport.chunks.map((chunk, index) =>
          index === 0 ? { ...chunk, sha256: '0'.repeat(64) } : chunk
        )
      )
    ).rejects.toThrow('does not match')
    await expect(
      assembleBinaryChunks(
        transport.reference,
        transport.chunks.map((chunk, index) =>
          index === 0 ? { ...chunk, bytesBase64: 'AQ==' } : chunk
        )
      )
    ).rejects.toThrow('invalid length')
  })

  it('rejects malformed references and non-canonical base64 at the boundary', () => {
    expect(() => validateBinaryChunkReference({})).toThrow('reference')
    expect(() =>
      validateBinaryChunkReference({
        version: 1,
        kind: 'content-addressed-binary',
        sha256: '0'.repeat(64),
        sizeBytes: 10,
        mimeType: 'image/png',
        chunkSize: 4,
        chunkCount: 2
      })
    ).toThrow('chunk count')
    expect(() =>
      validateBinaryChunkFrame({
        version: 1,
        kind: 'content-addressed-binary-chunk',
        sha256: '0'.repeat(64),
        index: 0,
        chunkCount: 1,
        bytesBase64: 'AB=='
      })
    ).toThrow('canonical')
  })

  it('does not mutate caller bytes and rejects unsupported object sizes', async () => {
    const source = Uint8Array.from([1, 2, 3, 4])
    const transport = await createBinaryChunkTransport(source, {
      mimeType: 'application/octet-stream'
    })
    source[0] = 99
    await expect(assembleBinaryChunks(transport.reference, transport.chunks)).resolves.toEqual(
      Uint8Array.from([1, 2, 3, 4])
    )
    await expect(
      createBinaryChunkTransport(new Uint8Array(0), { mimeType: 'application/octet-stream' })
    ).rejects.toThrow('outside protocol limits')
  })
})
