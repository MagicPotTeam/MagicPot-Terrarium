import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'

vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn() }))
const mocks = vi.hoisted(() => ({ assemble: vi.fn() }))
vi.mock('@shared/binaryChunkProtocol', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/binaryChunkProtocol')>(),
  assembleBinaryChunks: mocks.assemble
}))
import { materializeChunkedBinaryAttachments } from './svcLLMProxyImpl'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const fixture = () => {
  const binary = (id: string) => ({ transport: 'chunked-binary-v1', reference: { id, sizeBytes: 1, mimeType: 'image/png' }, chunks: [] })
  return { messages: [
    { role: 'user', content: 'one', attachments: [{ type: 'image', url: 'first', binary: binary('a') }, { type: 'file', url: 'keep' }] },
    { role: 'user', content: 'two', attachments: [{ type: 'image', url: 'second', binary: binary('b') }] }
  ] } as unknown as LLMChatReq
}

describe('serial chunked attachment materialization', () => {
  it('awaits each assembly across messages, preserves order and leaves the request unchanged', async () => {
    mocks.assemble.mockReset()
    const first = deferred<Uint8Array>(), second = deferred<Uint8Array>()
    let active = 0, maxActive = 0
    mocks.assemble.mockImplementation((reference: { id: string }) => {
      active++; maxActive = Math.max(maxActive, active)
      return (reference.id === 'a' ? first.promise : second.promise).finally(() => { active-- })
    })
    const request = fixture(), before = structuredClone(request)
    const result = materializeChunkedBinaryAttachments(request)
    expect(mocks.assemble).toHaveBeenCalledTimes(1)
    expect(mocks.assemble.mock.calls[0][0].id).toBe('a')
    first.resolve(Uint8Array.of(1))
    await vi.waitFor(() => expect(mocks.assemble).toHaveBeenCalledTimes(2))
    expect(mocks.assemble.mock.calls[1][0].id).toBe('b')
    second.resolve(Uint8Array.of(2))
    const output = await result
    expect(maxActive).toBe(1)
    expect(output.messages[0].attachments?.map(a => a.url)).toEqual(['data:image/png;base64,AQ==', 'keep'])
    expect(output.messages[1].attachments?.[0].url).toBe('data:image/png;base64,Ag==')
    expect(request).toEqual(before)
  })
  it('uses native synchronous SHA-256 on the exact assembled bytes', async () => {
    mocks.assemble.mockReset().mockImplementation(async (_reference, _chunks, runtime) => {
      expect(typeof runtime?.sha256).toBe('function')
      const bytes = Uint8Array.of(1, 2, 3)
      const result = runtime.sha256(bytes)
      expect(result).toBe(createHash('sha256').update(bytes).digest('hex'))
      return bytes
    })
    const result = await materializeChunkedBinaryAttachments(fixture())
    expect(mocks.assemble).toHaveBeenCalledTimes(2)
    expect(result.messages[0].attachments?.[0].url).toBe('data:image/png;base64,AQID')
  })

  it('rejects the whole request when the second assembly fails without mutating input', async () => {
    mocks.assemble.mockReset()
    const first = deferred<Uint8Array>(), second = deferred<Uint8Array>()
    mocks.assemble.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const request = fixture(), before = structuredClone(request)
    const result = materializeChunkedBinaryAttachments(request)
    const rejected = expect(result).rejects.toThrow('invalid chunked binary payload')
    expect(mocks.assemble).toHaveBeenCalledTimes(1)
    first.resolve(Uint8Array.of(1))
    await vi.waitFor(() => expect(mocks.assemble).toHaveBeenCalledTimes(2))
    second.reject(new Error('synthetic failure'))
    await rejected
    expect(request).toEqual(before)
  })
})
