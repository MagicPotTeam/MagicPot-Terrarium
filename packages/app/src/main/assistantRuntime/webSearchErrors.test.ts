import https from 'node:https'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webSearch } from './webTools'
import * as remoteFetchPolicy from '../api/remoteFetchPolicy'

type Reply = { status?: number; body: string; contentType?: string } | Error
const emptyAnswer = { body: JSON.stringify({ Heading: '', RelatedTopics: [], Results: [] }) }
const htmlResult = {
  contentType: 'text/html',
  body: '<a class="result__a" href="https://example.org/docs">Official docs</a><div class="result__snippet">Reference</div>'
}

// Real search/parsing/retry code, with only the network boundary replaced.
const transport = (...replies: Reply[]) => {
  vi.spyOn(remoteFetchPolicy, 'resolveRemoteFetchAddress').mockResolvedValue({
    address: '1.1.1.1',
    family: 4
  })
  let index = 0
  return vi.spyOn(https, 'request').mockImplementation(((...args: unknown[]) => {
    const callback = args[1] as (response: unknown) => void
    const reply = replies[Math.min(index++, replies.length - 1)]
    const request = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true
      },
      end() {
        queueMicrotask(() => {
          if (reply instanceof Error) {
            request.emit('error', reply)
            return
          }
          const response = Object.assign(new EventEmitter(), {
            headers: {
              'content-type': reply.contentType ?? 'application/json',
              'retry-after': '0'
            },
            statusCode: reply.status ?? 200,
            complete: false,
            destroyed: false,
            destroy() {
              this.destroyed = true
            }
          })
          callback(response)
          response.emit('data', Buffer.from(reply.body))
          response.complete = true
          response.emit('end')
        })
      }
    })
    return request
  }) as never)
}

afterEach(() => vi.restoreAllMocks())

describe('search failure classification', () => {
  it.each([
    { status: 401, code: 'access_denied', attempts: 1 },
    { status: 403, code: 'access_denied', attempts: 1 },
    { status: 429, code: 'rate_limited', attempts: 2 },
    { status: 503, code: 'unavailable', attempts: 2 },
    { status: 504, code: 'timeout', attempts: 2 },
    { status: 404, code: 'http_error', attempts: 1 }
  ])(
    'does not turn HTTP $status into zero search results or try a different endpoint',
    async ({ status, code, attempts }) => {
      const request = transport({ status, body: 'private upstream diagnostic body' })
      const error = await webSearch('private query').catch((error: unknown) => error)
      expect(error).toMatchObject({ name: 'WebSearchError', code, status })
      expect(String(error)).not.toContain('private upstream diagnostic body')
      expect(String(error)).not.toContain('private query')
      expect(request).toHaveBeenCalledTimes(attempts)
      for (const [options] of request.mock.calls)
        expect(options).toMatchObject({ hostname: 'api.duckduckgo.com' })
    }
  )

  it.each([
    '<form id="challenge-form" action="/anomaly.js"></form>',
    '<div class="anomaly-modal__mask"><div>Verify you are human</div></div>'
  ])('reports a challenge page even with a successful HTTP status', async (body) => {
    transport({ status: 200, body, contentType: 'text/html' })
    await expect(webSearch('query')).rejects.toMatchObject({ code: 'challenge' })
  })

  it('reports challenges in the HTML fallback without attempting to solve them', async () => {
    const request = transport(emptyAnswer, {
      status: 202,
      body: '<form id="challenge-form"></form>',
      contentType: 'text/html'
    })
    await expect(webSearch('query')).rejects.toMatchObject({ code: 'challenge' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    'not json',
    '{}',
    'null',
    '[]',
    '{"error":"service failed"}',
    '{"RelatedTopics":"invalid"}'
  ])('rejects malformed or unknown JSON instead of declaring no results: %s', async (body) => {
    const request = transport({ body })
    await expect(webSearch('query')).rejects.toMatchObject({ code: 'invalid_response' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('retains the HTML fallback for a valid empty instant answer', async () => {
    const request = transport(emptyAnswer, htmlResult)
    await expect(webSearch('query')).resolves.toMatchObject({
      source: 'duckduckgo',
      results: [{ title: 'Official docs', url: 'https://example.org/docs' }]
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('accepts an explicit no-results page, but not a layout change or an error page', async () => {
    transport(emptyAnswer, {
      contentType: 'text/html',
      body: '<div class="no-results">No results found.</div>'
    })
    await expect(webSearch('query')).resolves.toMatchObject({ results: [] })
  })

  it.each([
    '<html><body>Service temporarily unavailable</body></html>',
    '<html><div>Unknown layout</div></html>',
    ''
  ])('does not mistake unrecognized HTML for no results', async (body) => {
    transport(emptyAnswer, { contentType: 'text/html', body })
    await expect(webSearch('query')).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('does not mistake a result about CAPTCHA for a challenge', async () => {
    transport({
      body: JSON.stringify({
        Heading: 'CAPTCHA and anomaly-modal',
        AbstractURL: 'https://example.org/captcha',
        AbstractText: 'Research about CAPTCHA'
      })
    })
    await expect(webSearch('captcha')).resolves.toMatchObject({
      results: [{ title: 'CAPTCHA and anomaly-modal' }]
    })
  })

  it.each([
    {
      error: Object.assign(new Error('connection failed'), { code: 'ECONNRESET' }),
      code: 'network'
    },
    { error: Object.assign(new Error('timeout'), { name: 'TimeoutError' }), code: 'timeout' }
  ])(
    'classifies exhausted $code failures without silently retrying another service',
    async ({ error, code }) => {
      const request = transport(error)
      await expect(webSearch('query')).rejects.toMatchObject({ name: 'WebSearchError', code })
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it('preserves cancellation and makes no request after cancellation', async () => {
    const request = transport(emptyAnswer)
    const controller = new AbortController()
    controller.abort('stopped by user')
    await expect(webSearch('query', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('preserves a security rejection rather than relabelling it as a network problem', async () => {
    const request = transport(emptyAnswer)
    const rejection = new Error('Remote URL must use a public host')
    vi.mocked(remoteFetchPolicy.resolveRemoteFetchAddress).mockRejectedValue(rejection)
    await expect(webSearch('query')).rejects.toBe(rejection)
    expect(request).not.toHaveBeenCalled()
  })
})
