import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { BINARY_CHUNK_PROTOCOL_VERSION, assembleBinaryChunks } from './binaryChunkProtocol'
import type { BinaryChunkRuntime } from './binaryChunkProtocol'

describe('bounded binary assembly copies', () => {
  it('uses a caller-supplied synchronous hasher exactly on the validated assembled bytes', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const hash = createHash('sha256').update(bytes).digest('hex')
    const sha256 = vi.fn((value: Uint8Array) => createHash('sha256').update(value).digest('hex'))
    const reference = { version: BINARY_CHUNK_PROTOCOL_VERSION, kind: 'content-addressed-binary', sha256: hash, sizeBytes: 4, mimeType: 'image/png', chunkSize: 4, chunkCount: 1 }
    const chunks = [{ version: BINARY_CHUNK_PROTOCOL_VERSION, kind: 'content-addressed-binary-chunk', sha256: hash, index: 0, chunkCount: 1, bytesBase64: 'AQIDBA==' }]
    const runtime: BinaryChunkRuntime = { sha256 }
    await expect(assembleBinaryChunks(reference, chunks, runtime)).resolves.toEqual(bytes)
    expect(sha256).toHaveBeenCalledOnce()
    expect(sha256.mock.calls[0][0]).toEqual(bytes)
  })
})
