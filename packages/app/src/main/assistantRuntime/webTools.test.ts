import https from 'node:https'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webFetch, webSearch } from './webTools'
import * as remoteFetchPolicy from '../api/remoteFetchPolicy'

const mockWebDocument = (body: string, contentType: string) => {
  vi.spyOn(remoteFetchPolicy, 'resolveRemoteFetchAddress').mockResolvedValue({
    address: '1.1.1.1',
    family: 4
  })
  return vi.spyOn(https, 'request').mockImplementation(((...args: unknown[]) => {
    const onResponse = args[1] as (response: unknown) => void
    const request = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true
      },
      end() {
        const response = Object.assign(new EventEmitter(), {
          headers: { 'content-type': contentType },
          statusCode: 200,
          complete: false,
          destroyed: false,
          destroy() {
            this.destroyed = true
          }
        })
        queueMicrotask(() => {
          onResponse(response)
          response.emit('data', Buffer.from(body))
          response.complete = true
          response.emit('end')
        })
      }
    })
    return request
  }) as never)
}

describe('assistant web tools', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('extracts text without double decoding entities or retaining script/style bodies', async () => {
    const request = mockWebDocument(
      '<html><title>Title &amp;#39;</title><SCRIPT type="text/javascript">private-script-body</ScRiPt \t>' +
        '<style>private-style-body</style ><noscript>private-noscript-body</noscript extra="ignored">' +
        '<script>private-malformed-end-body</script extra="ignored"><p>&amp;#39; &#39; &#x41; &#0; &#xD800; &#1114112; &amp;amp;</p></html>',
      'text/html'
    )
    const result = await webFetch('https://1.1.1.1/')
    expect(result.title).toBe('Title &#39;')
    expect(result.text).toBe("Title &#39; &#39; ' A \uFFFD \uFFFD \uFFFD &amp;")
    expect(result.text).not.toContain('private-')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    'duckduckgo.com',
    'html.duckduckgo.com',
    'notduckduckgo.com',
    'duckduckgo.com.example.org'
  ])('only unwraps search redirects on an actual DuckDuckGo host (%s)', async (host) => {
    const target = 'https://example.org/reference'
    const wrapper = `https://${host}/l/?uddg=${encodeURIComponent(target)}`
    const request = mockWebDocument(
      JSON.stringify({
        Heading: 'Fixture result',
        AbstractURL: wrapper,
        AbstractText: 'Fixture text'
      }),
      'application/json'
    )
    const result = await webSearch('fixture query')
    expect(result.results).toHaveLength(1)
    expect(result.results[0].url).toBe(
      host === 'duckduckgo.com' || host === 'html.duckduckgo.com' ? target : wrapper
    )
    expect(request).toHaveBeenCalledTimes(1)
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
