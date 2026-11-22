import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createDeterministicPng } from '../../../../../scripts/chat/chatImageMemoryBenchmark.mjs'
import { ChatImagePreparer, type ChatImageEncoder } from './chatImagePreparer'

// Only exercises batch admission/byte preservation with a fake encoder. It does
// not test real image resizing, transparency, provider transport or memory peaks.
it('admits eight 4096 synthetic source PNGs to the bounded batch candidate', async () => {
  const sources = Array.from({ length: 8 }, (_, index) => createDeterministicPng(index, 4096, 4096))
  const hashes = sources.map(bytes => createHash('sha256').update(bytes).digest('hex'))
  const size = sources.reduce((sum, bytes) => sum + bytes.byteLength, 0)
  expect(size).toBe(30_390_951)
  const output = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'))
  const encode = vi.fn<ChatImageEncoder['encode']>(async bytes => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hashes[encode.mock.calls.length - 1])
    return Uint8Array.from(output)
  })
  const p = new ChatImagePreparer({ encode }, { entries: 0, bytes: 0 })
  const results = await p.prepareBatch(sources, 8 * 512_000)
  expect(encode).toHaveBeenCalledTimes(8)
  expect(results).toHaveLength(8)
  expect(results.every(result => result.width === 1 && result.height === 1)).toBe(true)
  expect(sources.map(bytes => createHash('sha256').update(bytes).digest('hex'))).toEqual(hashes)
}, 30_000)
