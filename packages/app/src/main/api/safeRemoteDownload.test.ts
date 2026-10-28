import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lookupMock, requestMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  requestMock: vi.fn()
}))

vi.mock('node:dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock
}))

vi.mock('node:https', () => ({
  default: { request: requestMock },
  request: requestMock
}))

import { safeRemoteDownload } from './safeRemoteDownload'

const mockResponse = (
  statusCode: number,
  headers: Record<string, string>,
  chunks: Buffer[] = []
): void => {
  requestMock.mockImplementationOnce((_options, callback) => {
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: ReturnType<typeof vi.fn>
      destroy: (error: Error) => void
      end: ReturnType<typeof vi.fn>
    }
    request.setTimeout = vi.fn()
    request.destroy = (error) => request.emit('error', error)
    request.end = vi.fn(() => {
      const response = new PassThrough() as PassThrough & {
        statusCode: number
        statusMessage: string
        headers: Record<string, string>
      }
      response.statusCode = statusCode
      response.statusMessage = statusCode === 200 ? 'OK' : 'Found'
      response.headers = headers
      callback(response)
      for (const chunk of chunks) response.write(chunk)
      response.end()
    })
    return request
  })
}

describe('safeRemoteDownload', () => {
  beforeEach(() => {
    lookupMock.mockReset()
    requestMock.mockReset()
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })

  it.each(['https://localhost/image.png', 'https://10.0.0.8/image.png'])(
    'rejects local or private target %s before requesting it',
    async (url) => {
      await expect(safeRemoteDownload(url, { allowedContentTypes: ['image/'] })).rejects.toThrow(
        'public host'
      )
      expect(requestMock).not.toHaveBeenCalled()
    }
  )

  it('validates every redirect target and rejects redirects to private hosts', async () => {
    mockResponse(302, { location: 'https://127.0.0.1/secret' })

    await expect(
      safeRemoteDownload('https://public.example/image.png', {
        allowedContentTypes: ['image/']
      })
    ).rejects.toThrow('public host')
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a response that exceeds the streaming size limit', async () => {
    mockResponse(200, { 'content-type': 'image/png' }, [Buffer.alloc(3), Buffer.alloc(3)])

    await expect(
      safeRemoteDownload('https://public.example/image.png', {
        allowedContentTypes: ['image/'],
        maxBytes: 5
      })
    ).rejects.toThrow('response is too large')
  })

  it('aborts an in-flight request when the caller signal is cancelled', async () => {
    const abortController = new AbortController()
    let requestDestroyed = false
    requestMock.mockImplementationOnce((_options, _callback) => {
      const request = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>
        destroy: (error: Error) => void
        end: ReturnType<typeof vi.fn>
      }
      request.setTimeout = vi.fn()
      request.destroy = (error) => {
        requestDestroyed = true
        request.emit('error', error)
      }
      request.end = vi.fn()
      return request
    })

    const pending = safeRemoteDownload('https://public.example/image.png', {
      allowedContentTypes: ['image/'],
      signal: abortController.signal
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    abortController.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(requestDestroyed).toBe(true)
  })

  it.each(['NaN', 'Infinity', '-1', '1.5', '1e2', ' 1'])(
    'rejects an invalid Content-Length value: %s',
    async (contentLength) => {
      mockResponse(200, {
        'content-type': 'image/png',
        'content-length': contentLength
      })

      await expect(
        safeRemoteDownload('https://public.example/image.png', {
          allowedContentTypes: ['image/']
        })
      ).rejects.toThrow('invalid content length')
    }
  )

  it('rejects a response whose Content-Length does not match the bytes received at EOF', async () => {
    mockResponse(200, { 'content-type': 'image/png', 'content-length': '4' }, [
      Buffer.from([1, 2, 3])
    ])

    await expect(
      safeRemoteDownload('https://public.example/image.png', {
        allowedContentTypes: ['image/']
      })
    ).rejects.toThrow('content length mismatch')
  })

  it('downloads a valid public HTTPS resource', async () => {
    mockResponse(200, { 'content-type': 'image/png' }, [Buffer.from([1, 2]), Buffer.from([3])])

    await expect(
      safeRemoteDownload('https://public.example/image.png', {
        allowedContentTypes: ['image/'],
        maxBytes: 5
      })
    ).resolves.toMatchObject({ buffer: Buffer.from([1, 2, 3]), contentType: 'image/png' })

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'public.example', method: 'GET' }),
      expect.any(Function)
    )
  })
})
