import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/llm'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import { normalizeChatAttachmentsForRequest } from './chatRequestUtils'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const managed: ChatAttachment = {
  type: 'image', url: 'local-media:///fixture/managed.png',
  media: { version: 1, kind: 'managed', relativePath: `originals/aa/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64), sizeBytes: 1, mimeType: 'image/png', originalFileName: 'fixture.png' }
}
const image = (name: string): ChatAttachment => ({ type: 'image', url: `local-media:///fixture/${name}.png`, fileName: `${name}.png` })
const materialized = { transport: 'request-data-url' as const, dataUrl: 'data:image/png;base64,YQ==', mimeType: 'image/png', sizeBytes: 1 }
const response = () => ({ ok: true, blob: async () => new Blob(['a'], { type: 'image/png' }) }) as Response

afterEach(() => vi.unstubAllGlobals())

describe('serial attachment normalization', () => {
  it('awaits managed IPC then ordinary image fetch in input order without mutation', async () => {
    const gate = deferred<typeof materialized>()
    const ipc = vi.fn(() => gate.promise)
    const fetchMock = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetchMock)
    const input = [managed, image('second'), image('third')]
    const original = structuredClone(input)
    const pending = normalizeChatAttachmentsForRequest(input, { managedMediaService: { materializeForRequest: ipc } as unknown as ManagedMediaSvc, allowManagedRequestDataUrl: true, allowRequestDataUrl: true })
    expect(ipc).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    gate.resolve(materialized)
    const result = await pending
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result?.map(item => item.url)).toEqual(['data:image/png;base64,YQ==', 'data:image/png;base64,YQ==', 'data:image/png;base64,YQ=='])
    expect(result?.map(item => item.fileName)).toEqual([undefined, 'second.png', 'third.png'])
    expect(input).toEqual(original)
    expect(result?.[0].media).toBeUndefined()
  })

  it('stops before third attachment when the second rejects', async () => {
    const gate = deferred<Response>()
    const ipc = vi.fn(async () => materialized)
    const fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const input = [managed, image('second'), image('third')]
    const original = structuredClone(input)
    const pending = normalizeChatAttachmentsForRequest(input, { managedMediaService: { materializeForRequest: ipc } as unknown as ManagedMediaSvc, allowManagedRequestDataUrl: true, allowRequestDataUrl: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    gate.reject(new Error('fixture rejection'))
    await expect(pending).rejects.toThrow('fixture rejection')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(input).toEqual(original)
  })

  it('captures the attachment array before awaiting without deep copying objects', async () => {
    const gate = deferred<typeof materialized>()
    const ipc = vi.fn(() => gate.promise)
    const fetchMock = vi.fn(async (_url: string) => response())
    vi.stubGlobal('fetch', fetchMock)
    const input = [managed, image('original')]
    const pending = normalizeChatAttachmentsForRequest(input, { managedMediaService: { materializeForRequest: ipc } as unknown as ManagedMediaSvc, allowManagedRequestDataUrl: true, allowRequestDataUrl: true })
    input[1] = image('replacement')
    input.push(image('added'))
    gate.resolve(materialized)
    const result = await pending
    expect(result?.map(item => item.fileName)).toEqual([undefined, 'original.png'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('original.png')
  })

  it('returns undefined for absent or empty attachments', async () => {
    await expect(normalizeChatAttachmentsForRequest(undefined)).resolves.toBeUndefined()
    await expect(normalizeChatAttachmentsForRequest([])).resolves.toBeUndefined()
  })
})
