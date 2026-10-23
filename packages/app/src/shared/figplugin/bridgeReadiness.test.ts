import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startFigPluginBridgeProbe,
  figPluginBridgeProbeRequestSchema,
  figPluginBridgeProbeResponseSchema,
  bridgeProbeMessage,
  type ProbeFetch,
  type ProbeResponse
} from './bridgeReadiness'

const origin = 'http://127.0.0.1:49152',
  nonce = 'a'.repeat(32)
const payload = { protocol: 1, kind: 'figplugin-bridge-probe', nonce }
const reply = (value: unknown = payload, extra: Partial<ProbeResponse> = {}): ProbeResponse => ({
  status: 200,
  ok: true,
  url: origin + '/figplugin/v1/probe',
  text: async () => JSON.stringify(value),
  ...extra
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('shared read-only connection probe', () => {
  it('sends one bounded request without credentials or design data', async () => {
    const fetcher = vi.fn<ProbeFetch>().mockResolvedValue(reply())
    const probe = startFigPluginBridgeProbe(origin, nonce, fetcher)
    expect(await probe.result).toBe('reachable')
    expect(Object.isFrozen(probe)).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe(origin + '/figplugin/v1/probe')
    expect(options).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store'
    })
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(options.body))).toEqual({ protocol: 1, nonce })
    expect(bridgeProbeMessage('reachable')).toContain('not authentication')
    probe.cancel()
    expect(await probe.result).toBe('reachable')
  })
  it.each([
    'https://127.0.0.1:49152',
    'http://localhost:49152',
    'http://127.0.0.1:049152',
    'http://127.0.0.1:49152/path',
    'http://127.0.0.1:49152\n',
    'http://127.0.0.1:80'
  ])('does not contact invalid origin %s', async (address) => {
    const fetcher = vi.fn<ProbeFetch>()
    expect(await startFigPluginBridgeProbe(address, nonce, fetcher).result).toBe('invalid-config')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['', 'a'.repeat(31), 'a'.repeat(32) + '\n', 'G'.repeat(32)])(
    'rejects invalid challenge',
    async (challenge) => {
      const fetcher = vi.fn<ProbeFetch>()
      expect(await startFigPluginBridgeProbe(origin, challenge, fetcher).result).toBe(
        'invalid-config'
      )
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  it.each([
    { ...payload, nonce: 'b'.repeat(32) },
    { ...payload, protocol: 2 },
    { ...payload, kind: 'other' },
    { ...payload, token: 'PRIVATE' },
    null,
    []
  ])('rejects a mismatched, extra or malformed reply', async (value) => {
    expect(await startFigPluginBridgeProbe(origin, nonce, async () => reply(value)).result).toBe(
      'invalid-response'
    )
  })
  it.each([
    { redirected: true },
    { url: 'http://127.0.0.1:49153/figplugin/v1/probe' },
    { headers: { get: () => '99999' } },
    { headers: { get: () => '20\n' } },
    { text: async () => 'x'.repeat(2049) },
    { text: async () => '非'.repeat(800) },
    { text: async () => '{broken' },
    { status: 404, ok: false }
  ])('refuses redirects, oversize and incompatible endpoints', async (extra) => {
    expect(
      await startFigPluginBridgeProbe(origin, nonce, async () => reply(payload, extra)).result
    ).toBe('invalid-response')
  })
  it.each([429, 500, 503])('reports unavailable status %s without retry', async (status) => {
    const fetcher = vi.fn<ProbeFetch>().mockResolvedValue(reply(payload, { status, ok: false }))
    expect(await startFigPluginBridgeProbe(origin, nonce, fetcher).result).toBe('unavailable')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('does not read an oversized advertised body', async () => {
    const text = vi.fn().mockResolvedValue(JSON.stringify(payload))
    expect(
      await startFigPluginBridgeProbe(origin, nonce, async () =>
        reply(payload, { text, headers: { get: () => '2049' } })
      ).result
    ).toBe('invalid-response')
    expect(text).not.toHaveBeenCalled()
  })
  it('works without TextEncoder and AbortController', async () => {
    vi.stubGlobal('TextEncoder', undefined)
    vi.stubGlobal('AbortController', undefined)
    expect(await startFigPluginBridgeProbe(origin, nonce, async () => reply()).result).toBe(
      'reachable'
    )
  })
  it('timeout stops delayed response and all timers without requiring native abort', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('AbortController', undefined)
    let release!: (response: ProbeResponse) => void
    const fetcher = vi.fn<ProbeFetch>(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const probe = startFigPluginBridgeProbe(origin, nonce, fetcher)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await probe.result).toBe('timeout')
    release(reply())
    await Promise.resolve()
    expect(await probe.result).toBe('timeout')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancel during body read ignores late content and aborts where supported', async () => {
    vi.useFakeTimers()
    let release!: (text: string) => void
    const fetcher = vi.fn<ProbeFetch>().mockResolvedValue(
      reply(payload, {
        text: () =>
          new Promise((resolve) => {
            release = resolve
          })
      })
    )
    const probe = startFigPluginBridgeProbe(origin, nonce, fetcher)
    await Promise.resolve()
    probe.cancel()
    expect(await probe.result).toBe('cancelled')
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true)
    release(JSON.stringify(payload))
    await Promise.resolve()
    expect(await probe.result).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a response arriving after the deadline before the timer callback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const probe = startFigPluginBridgeProbe(origin, nonce, async () => {
      vi.setSystemTime(6000)
      return reply()
    })
    expect(await probe.result).toBe('timeout')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reports native permission refusal without leaking error details', async () => {
    const probe = startFigPluginBridgeProbe(origin, nonce, async () => {
      throw new Error('Script is not permitted to access the network apis PRIVATE_URL')
    })
    const result = await probe.result
    expect(result).toBe('permission-denied')
    expect(bridgeProbeMessage(result)).toContain('UXP')
    expect(bridgeProbeMessage(result)).not.toContain('PRIVATE_URL')
  })
  it('handles hostile exception getters and malformed JSON without uncaught errors', async () => {
    expect(
      await startFigPluginBridgeProbe(origin, nonce, async () => {
        throw {
          get message() {
            throw new Error('PRIVATE')
          }
        }
      }).result
    ).toBe('unavailable')
  })
  it('has strict request and response contracts', () => {
    expect(
      figPluginBridgeProbeRequestSchema.safeParse({ protocol: 1, nonce, sessionToken: 'x' }).success
    ).toBe(false)
    expect(figPluginBridgeProbeResponseSchema.safeParse({ ...payload, ready: true }).success).toBe(
      false
    )
  })
})
