import { describe, expect, it } from 'vitest'
import { ModelConnectionError, normalizeModelConnectionError } from './modelConnectionError'
import { modelCapacityReason } from './modelCapacityRetry'

describe('transport-owned connection errors', () => {
  it.each([
    'ERR_CONNECTION_CLOSED',
    'ERR_CONNECTION_RESET',
    'ERR_EMPTY_RESPONSE',
    'ERR_NETWORK_CHANGED'
  ])('recognizes the exact Chromium transport code %s', (code) => {
    const raw = new Error(`net::${code}`)
    const tagged = normalizeModelConnectionError(raw)
    expect(tagged).toBeInstanceOf(ModelConnectionError)
    expect(tagged).toMatchObject({ cause: raw })
    expect(modelCapacityReason(tagged)).toBe('connection-error')
    // An identical message from a callback or tool is not sufficient authority.
    expect(modelCapacityReason(raw)).toBeUndefined()
  })
  it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])(
    'recognizes bounded Node transport causes: %s',
    (code) => {
      const cause = Object.assign(new Error('socket closed'), { code })
      expect(
        normalizeModelConnectionError(new TypeError('fetch failed', { cause }))
      ).toBeInstanceOf(ModelConnectionError)
    }
  )
  it.each([
    new DOMException('net::ERR_CONNECTION_CLOSED', 'AbortError'),
    new DOMException('net::ERR_CONNECTION_CLOSED', 'TimeoutError'),
    Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { statusCode: 401 }),
    Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), {
      providerError: { code: 'invalid_api_key' }
    }),
    Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { body: 'upstream prose' }),
    Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { retryBlocked: true }),
    Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { partialContent: 'already visible' }),
    new Error('Provider says net::ERR_CONNECTION_CLOSED'),
    { message: 'net::ERR_CONNECTION_CLOSED' }
  ])('does not broaden a permanent, local or unowned failure %#', (raw) => {
    expect(normalizeModelConnectionError(raw)).toBe(raw)
    expect(modelCapacityReason(raw)).toBeUndefined()
  })
  it('retains stream replay blockers after tagging a transport failure', () => {
    const tagged = normalizeModelConnectionError(new Error('net::ERR_CONNECTION_CLOSED')) as Error
    Object.assign(tagged, { retryBlocked: true })
    expect(modelCapacityReason(tagged)).toBeUndefined()
  })
  it('terminates cycles and declines causes beyond the bounded inspection depth', () => {
    const cycle = new Error('net::ERR_CONNECTION_CLOSED')
    Object.assign(cycle, { cause: cycle })
    expect(normalizeModelConnectionError(cycle)).toBe(cycle)
    let deep = new Error('net::ERR_CONNECTION_CLOSED')
    for (let n = 0; n < 6; n++) deep = new Error('wrapper', { cause: deep })
    expect(normalizeModelConnectionError(deep)).toBe(deep)
  })
})
