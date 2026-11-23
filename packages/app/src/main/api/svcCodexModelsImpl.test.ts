import { describe, expect, it, vi } from 'vitest'
import {
  CodexModelsSvcImpl,
  discoverCLIProxyModels,
  InMemoryCodexModelsCacheStore
} from './svcCodexModelsImpl'

// Contract tests, not a model catalog. IDs are opaque provider-owned strings;
// model releases must never require changes to these fixtures or expectations.
// Fixed seeds make generated cases reproducible and keep tests offline/non-flaky.
const generateModelIds = (seed: number, count: number): string[] => {
  let state = seed >>> 0
  const token = (): string => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state.toString(36)
  }
  const shapes = [
    () => token(),
    () => `${token()}/${token()}`,
    () => `${token().toUpperCase()}:${token()}+${token()}`,
    () => `Alias ${token()}_percent%${token()}`,
    () => `模型-${token()}.${token()}`
  ]
  return Array.from({ length: count }, (_, index) => `${shapes[index % shapes.length]()}-${index}`)
}

const contractCases = [1, 0x5eed, 0xc0ffee].flatMap((seed) =>
  [1, 17, 257].map((count) => ({ seed, count }))
)

const createProxyService = (payload: unknown, caseId: string) => {
  const fetchImpl = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  )
  const svc = new CodexModelsSvcImpl({
    fetchImpl,
    resolveCLIProxyProfile: (id) => ({
      id,
      model_name: '',
      base_url: `https://${caseId}.example.test/v1/`,
      api_key: 'test-key',
      call_type: 'cliproxyapi'
    }),
    now: () => new Date('2026-01-01T00:00:00.000Z')
  })
  return { svc, fetchImpl }
}

const modelValues = (result: Awaited<ReturnType<CodexModelsSvcImpl['list']>>) =>
  result.models.map((model) => model.value)

describe('CodexModelsSvcImpl', () => {
  it.each([
    'http://proxy.example.test/v1',
    'https://user:password@proxy.example.test/v1',
    'https://proxy.example.test/v1?token=secret',
    'https://proxy.example.test/v1#fragment'
  ])('rejects an unsafe CLIProxy endpoint before issuing discovery: %s', async (baseUrl) => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      discoverCLIProxyModels(
        { base_url: baseUrl, api_key: 'test-key' },
        { fetchImpl: fetchImpl as typeof fetch, forceRefresh: true }
      )
    ).rejects.toThrow(/CLIProxyAPI\/Codex base URL is not allowed/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps HTTP discovery available for loopback and LAN gateways', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'lan-model' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    await expect(
      discoverCLIProxyModels(
        { base_url: 'http://192.168.1.30:3721/v1', api_key: 'test-key' },
        { fetchImpl: fetchImpl as typeof fetch, forceRefresh: true }
      )
    ).resolves.toMatchObject({ models: ['lan-model'] })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://192.168.1.30:3721/v1/models',
      expect.objectContaining({ redirect: 'error' })
    )
  })

  it('isolates caller cancellation from a shared CLIProxy model discovery request', async () => {
    let resolveFetch!: (response: Response) => void
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
    const profile = {
      base_url: 'https://inflight-abort-isolation.example.test/v1',
      api_key: 'test-key'
    }
    const firstController = new AbortController()
    const first = discoverCLIProxyModels(profile, {
      fetchImpl,
      forceRefresh: true,
      signal: firstController.signal
    })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())

    const second = discoverCLIProxyModels(profile, {
      fetchImpl,
      signal: new AbortController().signal
    })
    firstController.abort(new DOMException('first caller stopped', 'AbortError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(false)

    resolveFetch(
      new Response(JSON.stringify({ data: [{ id: 'shared-model' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    await expect(second).resolves.toMatchObject({ models: ['shared-model'] })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each(contractCases)(
    'preserves generated channel IDs in scan order (seed=$seed, count=$count)',
    async ({ seed, count }) => {
      // Expected IDs exist BEFORE payload construction; do not compute the oracle
      // by applying the production parser/filter to the response.
      const expected = generateModelIds(seed, count)
      const payload = {
        data: [
          ...expected.flatMap((id) => [{ id: ` \t${id}\n` }, { id }]),
          ...expected.toReversed().map((id) => ({ id })),
          { id: '' },
          { id: ' \t\n' },
          { id: 123 },
          { id: null },
          { id: true },
          { id: {} },
          { id: [] },
          {},
          null,
          'not-a-model-record'
        ]
      }
      const caseId = `generated-${seed}-${count}`
      const { svc, fetchImpl } = createProxyService(payload, caseId)
      const result = await svc.list({
        cliProxyProfileId: caseId,
        forceRefresh: true
      })

      expect(modelValues(result)).toEqual(expected)
      expect(result.models.every((model) => model.source === 'remote')).toBe(true)
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        `https://${caseId}.example.test/v1/models`,
        {
          headers: { Authorization: 'Bearer test-key' },
          redirect: 'error',
          signal: expect.any(AbortSignal)
        }
      )
    }
  )

  it.each(contractCases)(
    'preserves generated OAuth discovery IDs without bundled fallbacks (seed=$seed, count=$count)',
    async ({ seed, count }) => {
      const expected = generateModelIds(seed, count)
      const discoveryProvider = vi.fn().mockResolvedValue({
        models: [
          ...expected.map((value) => ({ value: ` ${value} `, label: value })),
          ...expected.toReversed()
        ]
      })
      const svc = new CodexModelsSvcImpl({ discoveryProvider })

      expect(modelValues(await svc.list({}))).toEqual(expected)
      expect(discoveryProvider).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves case-sensitive IDs and contract length boundaries while dropping invalid IDs', async () => {
    const expected = ['x', 'a'.repeat(200), 'Namespace/Model', 'namespace/model']
    const { svc } = createProxyService(
      {
        data: [
          ...expected.map((id) => ({ id })),
          { id: 'a'.repeat(201) },
          { id: '' },
          { id: false }
        ]
      },
      'boundaries'
    )

    expect(
      modelValues(await svc.list({ cliProxyProfileId: 'boundaries', forceRefresh: true }))
    ).toEqual(expected)
  })

  it.each([
    { label: 'missing data', payload: {} },
    { label: 'null body', payload: null },
    { label: 'non-array data', payload: { data: {} } },
    {
      label: 'invalid entries',
      payload: { data: [null, {}, { id: 1 }, { id: ' ' }] }
    }
  ])('rejects $label instead of inventing a default model', async ({ payload, label }) => {
    const { svc } = createProxyService(payload, `invalid-${label.replaceAll(' ', '-')}`)
    await expect(svc.list({ cliProxyProfileId: 'invalid', forceRefresh: true })).rejects.toThrow(
      'did not return any models'
    )
  })

  it('does not silently truncate channel catalogs at 200 models and picks up refreshed IDs', async () => {
    const names = generateModelIds(0x1234, 257)
    const refreshedNames = [...names.slice(10).toReversed(), ...generateModelIds(0x9876, 31)]
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: names.map((id) => ({ id })) })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: refreshedNames.map((id) => ({ id })) }))
      )
    const svc = new CodexModelsSvcImpl({
      fetchImpl,
      resolveCLIProxyProfile: (id) => ({
        id,
        model_name: '',
        call_type: 'cliproxyapi',
        base_url: 'https://large-catalog.example.test/v1',
        api_key: 'test-key'
      })
    })

    const initial = await svc.list({ cliProxyProfileId: 'large-catalog' })
    expect(initial.models.map((model) => model.value)).toEqual(names)
    const refreshed = await svc.list({
      cliProxyProfileId: 'large-catalog',
      forceRefresh: true
    })
    expect(modelValues(refreshed)).toEqual(refreshedNames)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reports an empty channel catalog instead of selecting a hardcoded model', async () => {
    const svc = new CodexModelsSvcImpl({
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }))),
      resolveCLIProxyProfile: (id) => ({
        id,
        model_name: '',
        call_type: 'cliproxyapi',
        base_url: 'https://empty-catalog.example.test/v1',
        api_key: 'test-key'
      })
    })
    await expect(svc.list({ cliProxyProfileId: 'empty-catalog' })).rejects.toThrow(
      'did not return any models'
    )
  })

  it('marks cached channel models stale when refreshing fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'Team/Model' }, { id: 'team/model' }]
          })
        )
      )
      .mockRejectedValueOnce(new Error('offline'))
    const svc = new CodexModelsSvcImpl({
      fetchImpl,
      resolveCLIProxyProfile: (id) => ({
        id,
        model_name: '',
        call_type: 'cliproxyapi',
        base_url: 'https://stale-aliases.example.test/v1',
        api_key: 'test-key'
      })
    })
    const first = await svc.list({ cliProxyProfileId: 'aliases' })
    expect(first.models.map((model) => model.value)).toEqual(['Team/Model', 'team/model'])
    expect(first.stale).toBe(false)
    const stale = await svc.list({
      cliProxyProfileId: 'aliases',
      forceRefresh: true
    })
    expect(stale.models).toEqual(first.models)
    expect(stale.stale).toBe(true)
  })

  it('returns remote models, preserves unknown current values, and updates the cache', async () => {
    const cacheStore = new InMemoryCodexModelsCacheStore()
    const discoveryProvider = vi.fn().mockResolvedValue({
      models: [' remote-model-a ', { label: 'Display label B', value: 'remote-model-b' }],
      fetchedAt: '2026-04-22T00:00:00.000Z'
    })

    const svc = new CodexModelsSvcImpl({
      cacheStore,
      discoveryProvider,
      now: () => new Date('2026-04-22T00:30:00.000Z'),
      ttlMs: 60 * 60 * 1000
    })

    const result = await svc.list({
      currentModelName: ' custom-codex-preview ',
      observedModelNames: ['custom-codex-observed', 'observed-model']
    })

    expect(discoveryProvider).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      source: 'remote',
      stale: false,
      fetchedAt: '2026-04-22T00:00:00.000Z',
      expiresAt: '2026-04-22T01:00:00.000Z'
    })
    expect(result.models.map((model) => model.value)).toEqual([
      'custom-codex-preview',
      'remote-model-a',
      'remote-model-b'
    ])
    expect(result.models.find((model) => model.value === 'custom-codex-preview')).toMatchObject({
      source: 'current'
    })
    expect(result.models.find((model) => model.value === 'remote-model-a')).toMatchObject({
      source: 'remote'
    })
    expect(result.models.find((model) => model.value === 'remote-model-b')).toMatchObject({
      label: 'Display label B'
    })

    await expect(cacheStore.read()).resolves.toEqual({
      models: [
        { label: 'remote-model-a', value: 'remote-model-a' },
        { label: 'Display label B', value: 'remote-model-b' }
      ],
      fetchedAt: '2026-04-22T00:00:00.000Z',
      expiresAt: '2026-04-22T01:00:00.000Z'
    })
  })

  it('uses a fresh cache without calling remote discovery', async () => {
    const cacheStore = new InMemoryCodexModelsCacheStore()
    await cacheStore.write({
      models: ['cached-codex-preview'],
      fetchedAt: '2026-04-22T00:00:00.000Z',
      expiresAt: '2026-04-22T06:00:00.000Z'
    })
    const discoveryProvider = vi.fn()

    const svc = new CodexModelsSvcImpl({
      cacheStore,
      discoveryProvider,
      now: () => new Date('2026-04-22T01:00:00.000Z')
    })

    const result = await svc.list({})

    expect(discoveryProvider).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      source: 'cache',
      stale: false,
      fetchedAt: '2026-04-22T00:00:00.000Z',
      expiresAt: '2026-04-22T06:00:00.000Z'
    })
    expect(result.models.find((model) => model.value === 'cached-codex-preview')).toMatchObject({
      source: 'remote'
    })
  })

  it('falls back to cached models when a forced refresh fails', async () => {
    const cacheStore = new InMemoryCodexModelsCacheStore()
    await cacheStore.write({
      models: ['cached-codex-preview'],
      fetchedAt: '2026-04-22T00:00:00.000Z',
      expiresAt: '2026-04-22T01:00:00.000Z'
    })
    const discoveryProvider = vi.fn().mockRejectedValue(new Error('offline'))

    const svc = new CodexModelsSvcImpl({
      cacheStore,
      discoveryProvider,
      now: () => new Date('2026-04-22T02:00:00.000Z')
    })

    const result = await svc.list({
      currentModelName: 'custom-codex-preview',
      forceRefresh: true
    })

    expect(discoveryProvider).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      source: 'cache',
      stale: true,
      fetchedAt: '2026-04-22T00:00:00.000Z',
      expiresAt: '2026-04-22T01:00:00.000Z'
    })
    expect(result.models.map((model) => model.value)).toEqual([
      'custom-codex-preview',
      'cached-codex-preview'
    ])
  })

  it('does not invent fallback model IDs when discovery fails without any cache', async () => {
    const discoveryProvider = vi.fn().mockRejectedValue(new Error('offline'))
    const svc = new CodexModelsSvcImpl({
      discoveryProvider,
      now: () => new Date('2026-04-22T03:00:00.000Z')
    })

    await expect(svc.list({})).rejects.toThrow('offline')
    expect(discoveryProvider).toHaveBeenCalledTimes(1)
  })
})
