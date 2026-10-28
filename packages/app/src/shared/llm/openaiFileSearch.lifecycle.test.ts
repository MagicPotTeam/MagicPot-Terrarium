import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderFileIdCache } from '../providerFileIdCache'
import { createOpenAIFileSearchSession } from './openaiFileSearch'
import type { ChatMessage } from './types'

const messages = (names = ['note.txt']): ChatMessage[] => [
  {
    role: 'user',
    content: 'Analyze owned fixtures.',
    attachments: names.map((fileName) => ({
      type: 'file',
      fileName,
      mimeType: 'text/plain',
      url: 'data:text/plain;base64,b3duZWQ='
    }))
  }
]
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const fixture = (cache = new ProviderFileIdCache()) => {
  const polling = gate()
  const events: Array<{ method: string; url: string; fileId?: string }> = []
  let uploadCount = 0,
    storeCount = 0
  const files = new Map<string, Set<string>>()
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input),
      method = init?.method || 'GET'
    const event: { method: string; url: string; fileId?: string } = { method, url }
    events.push(event)
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (url.endsWith('/v1/files')) return Response.json({ id: `file-${++uploadCount}` })
    if (url.endsWith('/vector_stores')) {
      const id = `vs-${++storeCount}`
      files.set(id, new Set())
      return Response.json({ id })
    }
    const store = /\/vector_stores\/([^/]+)\/files/.exec(url)?.[1]
    if (!store || !files.has(store)) throw new Error('Unexpected owned request')
    if (method === 'POST') {
      const fileId = JSON.parse(String(init?.body)).file_id as string
      event.fileId = fileId
      files.get(store)!.add(fileId)
      return Response.json({ id: fileId, status: 'in_progress' })
    }
    polling.resolve()
    return Response.json({
      data: [...files.get(store)!].map((id) => ({ id, status: 'completed' })),
      has_more: false
    })
  })
  const start = (names?: string[], signal?: AbortSignal) =>
    createOpenAIFileSearchSession({
      apiKey: 'owned-not-a-key',
      baseUrl: 'https://owned.example/v1',
      messages: messages(names),
      fileIdCache: cache,
      fetchImpl,
      signal
    })
  return { start, events, polling, cache, fetchImpl }
}
const completed = async (f: ReturnType<typeof fixture>, names?: string[]) => {
  const outcome = f.start(names).catch((error) => error)
  await f.polling.promise
  await vi.advanceTimersByTimeAsync(30_000)
  const session = await outcome
  expect(session).toHaveProperty('vectorStoreIds')
  return session as NonNullable<Awaited<ReturnType<typeof createOpenAIFileSearchSession>>>
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('file-search provider schema and overlapping upload lifetimes', () => {
  it('recognizes completed vector-store file objects by id, not request-only file_id', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const session = await completed(f)
    await session.cleanup()
    expect(f.events.filter((event) => event.method === 'GET')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('attaches and waits once for renamed references with identical materialized content', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const session = await completed(f, ['first.txt', 'renamed.txt'])
    await session.cleanup()
    expect(
      f.events.filter((event) => event.method === 'POST' && event.url.endsWith('/v1/files'))
    ).toHaveLength(1)
    expect(f.events.filter((event) => event.fileId)).toHaveLength(1)
    expect(
      f.events.filter((event) => event.method === 'DELETE' && /\/v1\/files\//.test(event.url))
    ).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('collects distinct IDs across provider result pages without double-counting records', async () => {
    const f = fixture()
    const baseFetch = f.fetchImpl.getMockImplementation()!
    f.fetchImpl.mockImplementation(async (input, init) => {
      if (init?.method !== 'GET') return baseFetch(input, init)
      return String(input).includes('?after=')
        ? Response.json({ data: [{ id: 'file-2', status: 'completed' }], has_more: false })
        : Response.json({
            data: [
              { id: 'file-1', status: 'completed' },
              { id: 'file-1', status: 'completed' }
            ],
            has_more: true,
            last_id: 'file-1'
          })
    })
    const input = messages(['first.txt', 'second.txt'])
    input[0].attachments![1].url = 'data:text/plain;base64,b3RoZXI='
    const session = await createOpenAIFileSearchSession({
      apiKey: 'owned-not-a-key',
      baseUrl: 'https://owned.example/v1',
      messages: input,
      fileIdCache: f.cache,
      fetchImpl: f.fetchImpl
    })
    try {
      expect(session?.vectorStoreIds).toEqual(['vs-1'])
      expect(f.fetchImpl).toHaveBeenCalledWith(
        'https://owned.example/v1/vector_stores/vs-1/files?after=file-1',
        expect.objectContaining({ method: 'GET' })
      )
    } finally {
      await session?.cleanup()
    }
  })

  it('rejects repeated pagination cursors instead of polling forever', async () => {
    const f = fixture()
    const baseFetch = f.fetchImpl.getMockImplementation()!
    f.fetchImpl.mockImplementation(async (input, init) =>
      init?.method === 'GET'
        ? Response.json({ data: [], has_more: true, last_id: 'repeated' })
        : baseFetch(input, init)
    )
    await expect(f.start()).rejects.toThrow('invalid pagination cursor')
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2)
    expect(f.cache.size).toBe(0)
  })

  it('does not acquire deletion authority over an externally preseeded cached file', async () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const key = {
      provider: 'openai',
      accountIdentity: `https://owned.example/v1:key-sha256:${hash('owned-not-a-key')}`,
      contentIdentity: `source-sha256:${hash('data:text/plain;base64,b3duZWQ=')}`
    }
    const f = fixture()
    f.cache.set(key, { fileId: 'file-external' })
    const first = await f.start()
    const second = await f.start()
    await Promise.all([first?.cleanup(), second?.cleanup()])
    expect(
      f.events.filter((event) => event.method === 'POST' && event.url.endsWith('/v1/files'))
    ).toHaveLength(0)
    expect(
      f.events.filter((event) => event.method === 'DELETE' && /\/v1\/files\//.test(event.url))
    ).toHaveLength(0)
    expect(f.events.filter((event) => event.method === 'DELETE')).toHaveLength(2)
    expect(f.cache.get(key)).toEqual({ fileId: 'file-external' })
  })

  it('keeps active leases after TTL expiry and preserves a newly uploaded replacement', async () => {
    let now = 0
    const f = fixture(new ProviderFileIdCache({ now: () => now }))
    const set = vi.spyOn(f.cache, 'set')
    const owner = await f.start()
    const key = set.mock.calls[0][0]
    f.cache.set(key, { fileId: 'file-1', expiresAt: 100 })
    const borrower = await f.start()
    now = 101
    expect(f.cache.size).toBe(0)
    const replacement = await f.start()
    try {
      await owner?.cleanup()
      expect(
        f.events.filter((event) => event.method === 'DELETE' && event.url.endsWith('/files/file-1'))
      ).toHaveLength(0)
      await borrower?.cleanup()
      expect(
        f.events.filter((event) => event.method === 'DELETE' && event.url.endsWith('/files/file-1'))
      ).toHaveLength(1)
      expect(f.cache.get(key)?.fileId).toBe('file-2')
    } finally {
      await Promise.all([owner?.cleanup(), borrower?.cleanup(), replacement?.cleanup()])
    }
    expect(
      f.events.filter((event) => event.method === 'DELETE' && event.url.endsWith('/files/file-2'))
    ).toHaveLength(1)
    expect(f.cache.size).toBe(0)
  })

  it('keeps a replacement cache entry when an evicted upload is released', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const owner = await completed(f)
    f.cache.clear()
    const replacement = await f.start()
    await owner.cleanup()
    expect(f.cache.size).toBe(1)
    const borrower = await f.start()
    expect(
      f.events.filter((event) => event.method === 'POST' && event.url.endsWith('/v1/files'))
    ).toHaveLength(2)
    await replacement?.cleanup()
    expect(
      f.events.filter((event) => event.method === 'DELETE' && event.url.endsWith('/files/file-2'))
    ).toHaveLength(0)
    await borrower?.cleanup()
    expect(
      f.events.filter((event) => event.method === 'DELETE' && event.url.endsWith('/files/file-1'))
    ).toHaveLength(1)
    expect(
      f.events.filter((event) => event.method === 'DELETE' && event.url.endsWith('/files/file-2'))
    ).toHaveLength(1)
    expect(f.cache.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rolls back a failed borrower without deleting its still-active owner upload', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const owner = await completed(f)
    const failedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'vs-failed' }))
      .mockResolvedValueOnce(new Response('owned attach failure', { status: 500 }))
      .mockResolvedValue(new Response(null, { status: 204 }))
    await expect(
      createOpenAIFileSearchSession({
        apiKey: 'owned-not-a-key',
        baseUrl: 'https://owned.example/v1',
        messages: messages(),
        fileIdCache: f.cache,
        fetchImpl: failedFetch
      })
    ).rejects.toThrow('owned attach failure')
    expect(
      failedFetch.mock.calls.some(
        ([url, init]) => init?.method === 'DELETE' && String(url).includes('/v1/files/')
      )
    ).toBe(false)
    expect(f.cache.size).toBe(1)
    await owner.cleanup()
    expect(
      f.events.filter((event) => event.method === 'DELETE' && event.url.endsWith('/files/file-1'))
    ).toHaveLength(1)
    expect(f.cache.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains an uploaded file until the last overlapping session releases it', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const owner = await completed(f)
    const borrower = await f.start()
    try {
      await owner.cleanup()
      expect(
        f.events.filter((event) => event.method === 'DELETE' && /\/v1\/files\//.test(event.url))
      ).toHaveLength(0)
      expect(f.cache.size).toBe(1)
    } finally {
      await borrower?.cleanup()
    }
    const deletions = f.events.filter(
      (event) => event.method === 'DELETE' && /\/v1\/files\//.test(event.url)
    )
    expect(deletions).toHaveLength(1)
    expect(f.cache.size).toBe(0)
    await Promise.all([owner.cleanup(), borrower?.cleanup()])
    expect(
      f.events.filter((event) => event.method === 'DELETE' && /\/v1\/files\//.test(event.url))
    ).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
