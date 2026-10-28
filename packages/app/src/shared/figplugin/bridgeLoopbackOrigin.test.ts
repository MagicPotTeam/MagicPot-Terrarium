import { describe, expect, it, vi } from 'vitest'
import { FigPluginDesktopBridgeOriginSchema, canonicalFigPluginJson } from './manifest'
import { startFigPluginBridgeProbe, type ProbeFetch } from './bridgeReadiness'

describe('explicit localhost bridge identity', () => {
  it('accepts either explicitly selected loopback spelling without rewriting its identity', () => {
    for (const host of ['127.0.0.1', 'localhost'])
      for (const port of [1024, 49153, 65535]) {
        const origin = `http://${host}:${port}`
        expect(FigPluginDesktopBridgeOriginSchema.parse(origin)).toBe(origin)
      }
    expect(canonicalFigPluginJson({ origin: 'http://localhost:49153' })).not.toBe(
      canonicalFigPluginJson({ origin: 'http://127.0.0.1:49153' })
    )
  })
  it('rejects lookalikes, alternate spellings and unbounded permissions', () => {
    for (const origin of [
      'http://localhost.invalid:49153',
      'http://LOCALHOST:49153',
      'http://localhost.:49153',
      'http://localhost:49153/',
      'http://localhost:49153/path',
      'http://localhost:49153?x',
      'http://localhost:49153#x',
      'http://localhost:049153',
      'http://localhost:1023',
      'http://localhost:65536',
      'http://localhost',
      'http://localhost:*',
      'http://user@localhost:49153',
      'http://localhost:49153@remote.invalid',
      'http://local%68ost:49153',
      'http://localhost:49153\n',
      ' http://localhost:49153',
      '*',
      'all'
    ])
      expect(FigPluginDesktopBridgeOriginSchema.safeParse(origin).success).toBe(false)
  })
  it('uses exactly the selected localhost origin, never falls back to the numeric address', async () => {
    const origin = 'http://localhost:49153',
      nonce = 'a'.repeat(32)
    const fetcher = vi.fn<ProbeFetch>().mockResolvedValue({
      status: 200,
      ok: true,
      url: origin + '/figplugin/v1/probe',
      text: async () => JSON.stringify({ protocol: 1, kind: 'figplugin-bridge-probe', nonce })
    })
    expect(await startFigPluginBridgeProbe(origin, nonce, fetcher).result).toBe('reachable')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe(origin + '/figplugin/v1/probe')
    fetcher.mockClear().mockRejectedValue(new Error('unreachable'))
    expect(await startFigPluginBridgeProbe(origin, nonce, fetcher).result).toBe('unavailable')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('classifies native manifest network refusal without displaying its URL', async () => {
    const fetcher = vi
      .fn<ProbeFetch>()
      .mockRejectedValue(
        new Error(
          'Permission denied to the url http://127.0.0.1:49153/private?token=SECRET. Manifest entry not found.'
        )
      )
    expect(
      await startFigPluginBridgeProbe('http://127.0.0.1:49153', 'a'.repeat(32), fetcher).result
    ).toBe('permission-denied')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
