import { describe, expect, it, vi } from 'vitest'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { createBoundedReportManifestReader } from './boundedReportManifestReader'

const encode = (value: string) => new Uint8Array(new NodeTextEncoder().encode(value))

function makeResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let index = 0
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index === chunks.length) controller.close()
        else controller.enqueue(chunks[index++])
      },
      cancel
    },
    { highWaterMark: 0 }
  )
  return { response: new Response(stream, { headers }), cancel }
}

const budget = { perManifestBytes: 6, totalBytes: 12, maxManifests: 2, maxChunksPerManifest: 4 }
const options = (response: Response) => ({ ...budget, fetchResponse: vi.fn(async () => response) })

describe('unwired bounded report manifest reader', () => {
  it('rejects invalid budget configuration before fetching', () => {
    const fetchResponse = vi.fn()
    for (const key of [
      'perManifestBytes',
      'totalBytes',
      'maxManifests',
      'maxChunksPerManifest'
    ] as const) {
      for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() =>
          createBoundedReportManifestReader({ ...budget, [key]: value, fetchResponse })
        ).toThrow('manifest')
      }
    }
    expect(fetchResponse).not.toHaveBeenCalled()
  })

  it('decodes multibyte UTF-8 split over chunks, counts bytes rather than characters, and accepts the boundary', async () => {
    const bytes = encode('汉字')
    const { response, cancel } = makeResponse([
      bytes.slice(0, 2),
      bytes.slice(2, 4),
      bytes.slice(4)
    ])
    const read = createBoundedReportManifestReader(options(response))
    await expect(read('fixture-a')).resolves.toBe('汉字')
    expect(cancel).not.toHaveBeenCalled()
  })

  it.each(['1', '9999'])(
    'uses actual bytes rather than the advertised Content-Length %s',
    async (length) => {
      const { response, cancel } = makeResponse([encode('1234567')], { 'content-length': length })
      const read = createBoundedReportManifestReader(options(response))
      await expect(read('fixture-private-location')).rejects.toThrow('manifest')
      expect(cancel).toHaveBeenCalledOnce()
    }
  )

  it('does not reject an honest actual body solely due to an overreported Content-Length', async () => {
    const { response } = makeResponse([encode('hello')], { 'content-length': '9999' })
    await expect(createBoundedReportManifestReader(options(response))('fixture')).resolves.toBe(
      'hello'
    )
  })

  it('requires a readable response body without invoking unbounded text or arrayBuffer helpers', async () => {
    const text = vi.fn()
    const arrayBuffer = vi.fn()
    const response = { ok: true, body: null, text, arrayBuffer } as unknown as Response
    await expect(createBoundedReportManifestReader(options(response))('fixture')).rejects.toThrow(
      'manifest'
    )
    expect(text).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects malformed UTF-8 without returning a partial string and cancels on failure', async () => {
    const { response, cancel } = makeResponse([encode('a'), new Uint8Array([0xff]), encode('z')])
    await expect(createBoundedReportManifestReader(options(response))('fixture')).rejects.toThrow(
      'manifest'
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects an incomplete multibyte sequence at end of stream without returning a prefix', async () => {
    const { response } = makeResponse([encode('a'), new Uint8Array([0xe6, 0xb1])])
    await expect(
      createBoundedReportManifestReader(options(response))('fixture')
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID_UTF8' })
  })

  it('decodes a producer-owned chunk before it can be reused by the next read', async () => {
    const first = encode('ab')
    let step = 0
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (step++ === 0) controller.enqueue(first)
            else if (step === 2) {
              first.fill(0x7a)
              controller.enqueue(encode('c'))
            } else controller.close()
          }
        },
        { highWaterMark: 0 }
      )
    )
    await expect(createBoundedReportManifestReader(options(response))('fixture')).resolves.toBe(
      'abc'
    )
  })

  it('rejects excessive fragmented or empty chunks even under the byte cap', async () => {
    const { response, cancel } = makeResponse(Array.from({ length: 5 }, () => new Uint8Array()))
    await expect(createBoundedReportManifestReader(options(response))('fixture')).rejects.toThrow(
      'manifest'
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('shares actual byte and manifest count budgets across sequential reads, without fetching after exhaustion', async () => {
    const first = makeResponse([encode('123456')])
    const second = makeResponse([encode('123456')])
    const fetchResponse = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
    const read = createBoundedReportManifestReader({ ...budget, fetchResponse })
    await expect(read('first')).resolves.toBe('123456')
    await expect(read('second')).resolves.toBe('123456')
    await expect(read('third')).rejects.toThrow('manifest')
    expect(fetchResponse).toHaveBeenCalledTimes(2)
  })

  it('aborts the next read as soon as the total actual-byte budget would be exceeded', async () => {
    const first = makeResponse([encode('12345')])
    const second = makeResponse([encode('123456')])
    const fetchResponse = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
    const read = createBoundedReportManifestReader({ ...budget, totalBytes: 10, fetchResponse })
    await expect(read('first')).resolves.toBe('12345')
    await expect(read('second')).rejects.toThrow('manifest')
    expect(second.cancel).toHaveBeenCalledOnce()
  })

  it('does not fetch on pre-cancel and preserves an AbortError name and string reason', async () => {
    const controller = new AbortController()
    controller.abort('stop manifest')
    const fetchResponse = vi.fn()
    const read = createBoundedReportManifestReader({
      ...budget,
      fetchResponse,
      signal: controller.signal
    })
    await expect(read('fixture')).rejects.toMatchObject({
      name: 'AbortError',
      message: 'stop manifest'
    })
    expect(fetchResponse).not.toHaveBeenCalled()
  })

  it('aborts a stalled reader even when cancel is ignored and ignores a late chunk', async () => {
    const controller = new AbortController()
    let finish!: (value: ReadableStreamReadResult<Uint8Array>) => void
    const readChunk = vi.fn(
      () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          finish = resolve
        })
    )
    const cancel = vi.fn(() => Promise.resolve())
    const releaseLock = vi.fn()
    const response = {
      ok: true,
      body: { getReader: () => ({ read: readChunk, cancel, releaseLock }) }
    } as unknown as Response
    const read = createBoundedReportManifestReader({
      ...budget,
      fetchResponse: vi.fn(async () => response),
      signal: controller.signal
    })
    const pending = read('fixture')
    await vi.waitFor(() => expect(readChunk).toHaveBeenCalledOnce())
    controller.abort('stop manifest')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'stop manifest' })
    expect(cancel).toHaveBeenCalledOnce()
    finish({ done: false, value: encode('late') })
    await Promise.resolve()
    expect(readChunk).toHaveBeenCalledOnce()
  })

  it('poisons the accepted operation after a failed read and never fetches another manifest', async () => {
    const { response, cancel } = makeResponse([encode('1234567')])
    const fetchResponse = vi.fn(async () => response)
    const read = createBoundedReportManifestReader({ ...budget, fetchResponse })
    await expect(read('first')).rejects.toThrow('manifest')
    await expect(read('second')).rejects.toMatchObject({ code: 'MANIFEST_FAILED' })
    expect(fetchResponse).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('aborts a stalled fetch, then cancels a late response without reading it', async () => {
    const controller = new AbortController()
    let finish!: (response: Response) => void
    const fetchResponse = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    const read = createBoundedReportManifestReader({
      ...budget,
      fetchResponse,
      signal: controller.signal
    })
    const pending = read('fixture')
    await vi.waitFor(() => expect(fetchResponse).toHaveBeenCalledOnce())
    controller.abort('stop manifest')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'stop manifest' })
    const late = makeResponse([encode('secret')])
    const getReader = vi.spyOn(late.response.body!, 'getReader')
    finish(late.response)
    await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledOnce())
    expect(getReader).not.toHaveBeenCalled()
  })

  it('does not cancel a successfully consumed stream when abort comes later', async () => {
    const controller = new AbortController()
    const { response, cancel } = makeResponse([encode('done')])
    const read = createBoundedReportManifestReader({
      ...options(response),
      signal: controller.signal
    })
    await expect(read('fixture')).resolves.toBe('done')
    controller.abort('late')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('distinguishes observed byte and chunk limits without exposing the private location', async () => {
    for (const [chunks, expectedCode] of [
      [[encode('1234567')], 'MANIFEST_BYTE_LIMIT'],
      [
        [new Uint8Array(), new Uint8Array(), new Uint8Array(), new Uint8Array(), new Uint8Array()],
        'MANIFEST_CHUNK_LIMIT'
      ]
    ] as const) {
      const { response } = makeResponse([...chunks])
      const result = createBoundedReportManifestReader(options(response))(
        'fixture-private-location'
      )
      await expect(result).rejects.toMatchObject({ code: expectedCode })
      await expect(result).rejects.toThrow('manifest')
      await result.catch((error) => expect(error.message).not.toContain('fixture-private-location'))
    }
  })

  it('distinguishes malformed UTF-8, invalid responses and upstream I/O failures', async () => {
    const invalidUtf8 = makeResponse([new Uint8Array([0xff])])
    await expect(
      createBoundedReportManifestReader(options(invalidUtf8.response))('fixture')
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID_UTF8' })
    const noBody = { ok: true, body: null } as unknown as Response
    await expect(
      createBoundedReportManifestReader(options(noBody))('fixture')
    ).rejects.toMatchObject({ code: 'MANIFEST_INVALID_RESPONSE' })
    const read = createBoundedReportManifestReader({
      ...budget,
      fetchResponse: vi.fn(async () => {
        throw new Error('private upstream detail')
      })
    })
    const error = read('private-location')
    await expect(error).rejects.toMatchObject({ code: 'MANIFEST_IO_ERROR' })
    await error.catch((value) => expect(value.message).not.toContain('private'))
  })

  it('distinguishes cumulative byte, manifest count and concurrent-use limits', async () => {
    const first = makeResponse([encode('12345')])
    const second = makeResponse([encode('123456')])
    const fetchResponse = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
    const read = createBoundedReportManifestReader({ ...budget, totalBytes: 10, fetchResponse })
    await expect(read('first')).resolves.toBe('12345')
    await expect(read('second')).rejects.toMatchObject({ code: 'MANIFEST_TOTAL_BYTE_LIMIT' })

    const one = makeResponse([encode('a')])
    const count = createBoundedReportManifestReader({ ...options(one.response), maxManifests: 1 })
    await expect(count('first')).resolves.toBe('a')
    await expect(count('second')).rejects.toMatchObject({ code: 'MANIFEST_COUNT_LIMIT' })
  })

  it('prevents overlapping calls from bypassing cumulative reservation', async () => {
    let finish!: (value: ReadableStreamReadResult<Uint8Array>) => void
    const readChunk = vi.fn(
      () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          finish = resolve
        })
    )
    const response = {
      ok: true,
      body: {
        getReader: () => ({
          read: readChunk,
          cancel: () => Promise.resolve(),
          releaseLock: () => undefined
        })
      }
    } as unknown as Response
    const fetchResponse = vi.fn(async () => response)
    const read = createBoundedReportManifestReader({ ...budget, fetchResponse })
    const pending = read('first')
    await vi.waitFor(() => expect(readChunk).toHaveBeenCalledOnce())
    await expect(read('overlap')).rejects.toMatchObject({ code: 'MANIFEST_BUSY' })
    expect(fetchResponse).toHaveBeenCalledOnce()
    finish({ done: true, value: undefined })
    await expect(pending).resolves.toBe('')
  })
})
