import https from 'node:https'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webFetch, webSearch } from './webTools'

describe('assistant web tools', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('rejects empty search queries before network access', async () => {
    await expect(webSearch('   ')).rejects.toThrow('non-empty query')
  })

  it('rejects non-HTTPS and embedded-credential URLs', async () => {
    await expect(webFetch('http://example.com')).rejects.toThrow('https')
    await expect(webFetch('https://user:pass@example.com')).rejects.toThrow('credentials')
  })

  it('rejects explicit private hosts before opening a socket', async () => {
    await expect(webFetch('https://127.0.0.1/secret')).rejects.toThrow('public host')
    await expect(webFetch('https://localhost/secret')).rejects.toThrow('public host')
  })

  it('cleans up the request timeout when the transport rejects synchronously', async () => {
    vi.useFakeTimers()
    vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('transport setup failed')
    })

    await expect(webFetch('https://1.1.1.1/')).rejects.toThrow('transport setup failed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('observes body errors when content-length rejects a synchronous response callback', async () => {
    vi.useFakeTimers()
    vi.spyOn(https, 'request').mockImplementation(((...args: unknown[]) => {
      const callback = args[1] as ((response: unknown) => void) | undefined
      const request = new EventEmitter() as EventEmitter & {
        destroyed: boolean
        end: () => void
        destroy: () => void
      }
      request.destroyed = false
      request.end = vi.fn()
      request.destroy = () => {
        request.destroyed = true
        queueMicrotask(() => request.emit('error', new Error('request destroyed')))
      }
      const response = new EventEmitter() as EventEmitter & {
        headers: { 'content-length': string }
        statusCode: number
        complete: boolean
        destroyed: boolean
        destroy: () => void
      }
      response.headers = { 'content-length': '999999999' }
      response.statusCode = 200
      response.complete = false
      response.destroyed = false
      response.destroy = () => {
        response.destroyed = true
        queueMicrotask(() => response.emit('error', new Error('response destroyed')))
      }
      callback?.(response)
      return request
    }) as never)

    await expect(webFetch('https://1.1.1.1/')).rejects.toThrow('too large')
    await Promise.resolve()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('destroys a response that arrives after cancellation settled the request', async () => {
    let onResponse: ((response: unknown) => void) | undefined
    const request = new EventEmitter() as EventEmitter & {
      destroyed: boolean
      end: () => void
      destroy: () => void
    }
    request.destroyed = false
    request.end = vi.fn()
    request.destroy = () => {
      request.destroyed = true
      queueMicrotask(() => request.emit('error', new Error('request destroyed')))
    }
    vi.spyOn(https, 'request').mockImplementation(((...args: unknown[]) => {
      onResponse = args[1] as (response: unknown) => void
      return request
    }) as never)
    const response = new EventEmitter() as EventEmitter & {
      headers: Record<string, string>
      statusCode: number
      complete: boolean
      destroyed: boolean
      destroy: () => void
    }
    response.headers = {}
    response.statusCode = 200
    response.complete = false
    response.destroyed = false
    response.destroy = () => {
      response.destroyed = true
      queueMicrotask(() => response.emit('error', new Error('response destroyed')))
    }
    const controller = new AbortController()
    const pending = webFetch('https://1.1.1.1/', { signal: controller.signal })
    await vi.waitFor(() => expect(onResponse).toBeDefined())
    controller.abort('cancel before headers')
    onResponse?.(response)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(response.destroyed).toBe(true)
  })

  it('preserves AbortError semantics when cancellation interrupts a retry delay', async () => {
    let onResponse: ((response: unknown) => void) | undefined
    let responseFinished = false
    const request = new EventEmitter() as EventEmitter & {
      destroyed: boolean
      end: () => void
      destroy: () => void
    }
    request.destroyed = false
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & {
        headers: Record<string, string>
        statusCode: number
        complete: boolean
        destroyed: boolean
        destroy: () => void
      }
      response.headers = { 'retry-after': '2' }
      response.statusCode = 503
      response.complete = true
      response.destroyed = false
      response.destroy = () => {
        response.destroyed = true
      }
      queueMicrotask(() => {
        onResponse?.(response)
        response.emit('end')
        responseFinished = true
      })
    }
    request.destroy = () => {
      request.destroyed = true
    }
    const requestMock = vi.spyOn(https, 'request').mockImplementation(((...args: unknown[]) => {
      onResponse = args[1] as (response: unknown) => void
      return request
    }) as never)
    const controller = new AbortController()
    const pending = webFetch('https://1.1.1.1/', { signal: controller.signal })

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(responseFinished).toBe(true))
    controller.abort('cancel during retry')

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'cancel during retry'
    })
  })
})
