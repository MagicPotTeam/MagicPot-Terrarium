import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import { cliFromProfile } from '@shared/llm'
import { RemoteProjectComparisonClient } from './remoteProjectComparison'

vi.mock('@shared/llm', () => ({ cliFromProfile: vi.fn() }))
const remoteRevision = 'a'.repeat(64)
const profile = {
  id: 'base::selected-model',
  model_name: 'Synthetic model',
  configurationRevision: remoteRevision,
  deployment: 'api',
  model_use: 'agent',
  context_budget_tokens: 4000,
  context_window_tokens: 8000
}
const messages: LLMChatReq['messages'] = [
  { role: 'system', content: 'Compare synthetic summaries only.' },
  { role: 'user', content: 'Synthetic comparison input.' }
]
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
const metadata = (profiles: unknown[] = [profile]): Response => json({ protocol: 1, profiles })
const result = (content = 'Synthetic advice'): Response =>
  json({ protocol: 1, result: { content, finishReason: 'stop', usage: { totalTokens: 12 } } })
const streamed = (chunks: Uint8Array[], headers: Record<string, string> = {}, close = false) => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (close) controller.close()
    },
    cancel
  })
  return {
    cancel,
    response: new Response(body, {
      headers: { 'Content-Type': 'application/json', ...headers }
    })
  }
}
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const fixture = (options: ConstructorParameters<typeof RemoteProjectComparisonClient>[1] = {}) => {
  const config: Config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = true
  config.remote_llm_server_config = {
    server_origin: 'https://comparison.invalid/',
    access_token: 'main-only-test-secret'
  }
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => metadata())
  return { config, fetch, client: new RemoteProjectComparisonClient(fetch, options) }
}
const issue = async ({ client, config }: ReturnType<typeof fixture>): Promise<LLMChatReq> => {
  const { profiles } = await client.list(config)
  return {
    profileId: profiles[0].id,
    expectedProfileRevision: profiles[0].configurationRevision,
    messages: structuredClone(messages),
    profileScope: 'agent'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected global network call')))
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(cliFromProfile).not.toHaveBeenCalled()
  expect(console.error).not.toHaveBeenCalled()
  expect(console.warn).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('main-configured comparison destination', () => {
  it('GETs only the fixed endpoint and projects safe fields plus destination and random receipt', async () => {
    const f = fixture()
    const listed = await f.client.list(f.config)
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.fetch).toHaveBeenCalledWith(
      'https://comparison.invalid/api/project-comparison/profiles',
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer main-only-test-secret' },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: expect.any(AbortSignal)
      }
    )
    expect(listed).toEqual({
      profiles: [
        {
          ...profile,
          deployment: 'cloud',
          configurationRevision: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      ],
      comparisonDestination: { kind: 'remote', origin: 'https://comparison.invalid' }
    })
    expect(listed.profiles[0].configurationRevision).not.toBe(remoteRevision)
    expect(JSON.stringify(listed)).not.toContain(f.config.remote_llm_server_config.access_token)
    const next = await f.client.list(f.config)
    expect(next.profiles[0].configurationRevision).not.toBe(
      listed.profiles[0].configurationRevision
    )
  })

  it.each([
    'http://localhost:8787/',
    'http://127.0.0.1',
    'http://127.9.8.7',
    'http://[::1]:8787',
    'http://10.0.0.1',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.0.1',
    'https://public.example',
    'https://a.localhost',
    'https://8.8.8.8'
  ])('accepts the explicitly configured allowed origin %s', async (origin) => {
    const f = fixture()
    f.config.remote_llm_server_config.server_origin = origin
    await expect(f.client.list(f.config)).resolves.toHaveProperty('profiles')
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.fetch.mock.calls[0][0]).toBe(
      `${new URL(origin).origin}/api/project-comparison/profiles`
    )
  })

  it.each([
    'http://public.example',
    'http://a.localhost',
    'http://localhost.',
    'http://8.8.8.8',
    'http://169.254.169.254',
    'http://172.15.1.1',
    'http://172.32.1.1',
    'http://192.169.1.1',
    'http://224.0.0.1',
    'http://0.0.0.0',
    'http://[fc00::1]',
    'http://[::ffff:127.0.0.1]',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://0177.0.0.1',
    'https://user:secret@comparison.invalid',
    'https://@comparison.invalid',
    'https://comparison.invalid/path',
    'https://comparison.invalid/..',
    'https://comparison.invalid/%2e',
    'https://comparison.invalid//',
    'https://comparison.invalid?',
    'https://comparison.invalid#',
    ' https://comparison.invalid',
    'https://comparison.invalid\n',
    'https://comparison.invalid\0',
    'https://comparison.invalid\\',
    'https://%63omparison.invalid',
    'file:///tmp/test',
    'https://',
    `https://${'a'.repeat(2048)}`
  ])('rejects unsafe/non-root origin before fetch: %j', async (origin) => {
    const f = fixture()
    f.config.remote_llm_server_config.server_origin = origin
    await expect(f.client.list(f.config)).rejects.toMatchObject({
      code: 'INVALID_REMOTE_CONFIGURATION'
    })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('requires remote mode and an explicit token setting even on loopback', async () => {
    const f = fixture()
    f.config.use_remote_llm = false
    await expect(f.client.list(f.config)).rejects.toMatchObject({
      code: 'INVALID_REMOTE_CONFIGURATION'
    })
    f.config.use_remote_llm = true
    f.config.remote_llm_server_config = {
      server_origin: 'http://localhost',
      access_token: undefined as never
    }
    await expect(f.client.list(f.config)).rejects.toMatchObject({
      code: 'INVALID_REMOTE_CONFIGURATION'
    })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it.each(['http://localhost', 'http://127.0.0.1', 'http://[::1]', 'https://localhost'])(
    'allows explicit anonymous loopback %s without Authorization',
    async (origin) => {
      const f = fixture()
      f.config.remote_llm_server_config = { server_origin: origin, access_token: '' }
      await f.client.list(f.config)
      expect(f.fetch.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json' })
    }
  )

  it.each([
    '',
    '   ',
    'bad\r\nAuthorization: injected',
    'bad\0token',
    '\u007f',
    '\u0085',
    'x'.repeat(4097)
  ])('rejects invalid nonloopback token without echoing it', async (token) => {
    const f = fixture()
    f.config.remote_llm_server_config.access_token = token
    const error = await f.client.list(f.config).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ServiceError)
    expect(error).toMatchObject({
      message: 'Invalid remote project comparison configuration.',
      cause: undefined,
      payload: undefined
    })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('does not treat a private LAN destination as anonymous loopback', async () => {
    const f = fixture()
    f.config.remote_llm_server_config = { server_origin: 'http://192.168.1.2', access_token: '' }
    await expect(f.client.list(f.config)).rejects.toMatchObject({
      code: 'INVALID_REMOTE_CONFIGURATION'
    })
    expect(f.fetch).not.toHaveBeenCalled()
  })
})

describe('strict remote responses and transport failures', () => {
  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [404, 'PROTOCOL_UNSUPPORTED'],
    [501, 'PROTOCOL_UNSUPPORTED'],
    [409, 'PROFILE_CONFIGURATION_CHANGED'],
    [502, 'REMOTE_UPSTREAM_FAILED'],
    [504, 'TIMEOUT'],
    [302, 'REMOTE_HTTP_ERROR'],
    [201, 'REMOTE_HTTP_ERROR']
  ])(
    'normalizes status %i without reading/echoing the server error and never retries',
    async (status, code) => {
      const f = fixture()
      const cancel = vi.fn()
      const response = new Response(new ReadableStream({ cancel }), {
        status: Number(status),
        headers: { 'Content-Type': 'text/html', Location: 'https://other.invalid/secret' }
      })
      f.fetch.mockResolvedValue(response)
      const error = await f.client.list(f.config).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(ServiceError)
      expect(error).toMatchObject({ code, cause: undefined })
      if (status === 502)
        expect(error).toMatchObject({
          payload: { status },
          message: 'Remote project comparison upstream failed.'
        })
      if (status === 504)
        expect(error).toMatchObject({
          payload: { status },
          message: 'Remote project comparison request timed out.'
        })
      if (status === 409)
        expect(error).toMatchObject({
          message: 'Model configuration changed; review and confirm again.',
          payload: undefined
        })
      expect(JSON.stringify(error)).not.toContain('other.invalid')
      expect(cancel).toHaveBeenCalledOnce()
      expect(f.fetch).toHaveBeenCalledOnce()
    }
  )

  it.each([
    [502, 'REMOTE_UPSTREAM_FAILED', 'Project comparison upstream failed.'],
    [504, 'TIMEOUT', 'Project comparison request timed out.'],
    [
      409,
      'PROFILE_CONFIGURATION_CHANGED',
      'Model configuration changed; review and confirm again.'
    ],
    [499, 'CANCELLED', 'Project comparison request cancelled.']
  ] as const)('retains a valid fixed error envelope on HTTP %i', async (status, code, message) => {
    const f = fixture()
    f.fetch.mockResolvedValue(json({ code, message }, status))
    const error = await f.client.list(f.config).catch((error: unknown) => error)
    expect(error).toMatchObject({ code, cause: undefined })
    expect(JSON.stringify(error)).not.toContain('Bearer')
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('falls back to the HTTP classification for malformed or untrusted error envelopes', async () => {
    const f = fixture()
    f.fetch.mockResolvedValue(
      json({ code: 'TIMEOUT', message: 'Bearer main-only-test-secret https://secret.invalid' }, 502)
    )
    const error = await f.client.list(f.config).catch((error: unknown) => error)
    expect(error).toMatchObject({
      code: 'REMOTE_UPSTREAM_FAILED',
      message: 'Remote project comparison upstream failed.',
      payload: { status: 502 },
      cause: undefined
    })
    expect(JSON.stringify(error)).not.toContain('secret.invalid')
  })

  it('rejects transport-followed redirects even if the transport disregards redirect:error', async () => {
    const f = fixture()
    const response = metadata()
    Object.defineProperty(response, 'redirected', { value: true })
    f.fetch.mockResolvedValue(response)
    await expect(f.client.list(f.config)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it.each([{}, { protocol: 2, profiles: [] }, { protocol: '1', profiles: [] }])(
    'requires protocol 1: %j',
    async (body) => {
      const f = fixture()
      f.fetch.mockResolvedValue(json(body))
      await expect(f.client.list(f.config)).rejects.toMatchObject({ code: 'PROTOCOL_UNSUPPORTED' })
      expect(f.fetch).toHaveBeenCalledOnce()
    }
  )

  it.each(['text/html', 'application/problem+json', 'application/jsonp', ''])(
    'requires JSON content type, not %j',
    async (type) => {
      const f = fixture()
      const stream = streamed([], { 'Content-Type': type })
      f.fetch.mockResolvedValue(stream.response)
      await expect(f.client.list(f.config)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
      expect(stream.cancel).toHaveBeenCalledOnce()
    }
  )

  it.each(['1048577', '999999999999999999999', '-1', '1.5', 'bad'])(
    'rejects excessive/malformed Content-Length %s and cancels unread body',
    async (length) => {
      const f = fixture()
      const stream = streamed([], { 'Content-Length': length })
      f.fetch.mockResolvedValue(stream.response)
      await expect(f.client.list(f.config)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
      expect(stream.cancel).toHaveBeenCalledOnce()
    }
  )

  it('enforces the metadata byte cap across chunks even with a lying Content-Length', async () => {
    const f = fixture()
    const stream = streamed([encode(' '.repeat(1024 * 1024)), encode('x')], {
      'Content-Length': '1'
    })
    f.fetch.mockResolvedValue(stream.response)
    await expect(f.client.list(f.config)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(stream.cancel).toHaveBeenCalledOnce()
  })

  it.each([new Uint8Array([0xc3, 0x28]), new Uint8Array([0xf0, 0x9f]), encode('{broken-json')])(
    'rejects malformed/truncated UTF-8 and JSON',
    async (bytes) => {
      const f = fixture()
      f.fetch.mockResolvedValue(streamed([bytes], {}, true).response)
      await expect(f.client.list(f.config)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    }
  )

  it('decodes valid multibyte UTF-8 split across response chunks', async () => {
    const f = fixture()
    const bytes = encode(
      JSON.stringify({ protocol: 1, profiles: [{ ...profile, model_name: '多🙂' }] })
    )
    f.fetch.mockResolvedValue(
      streamed(
        Array.from(bytes, (byte) => new Uint8Array([byte])),
        {},
        true
      ).response
    )
    await expect(f.client.list(f.config)).resolves.toMatchObject({
      profiles: [{ model_name: '多🙂' }]
    })
  })

  it.each([
    { name: 'identical duplicate IDs', profiles: [profile, profile] },
    {
      name: 'conflicting duplicate IDs',
      profiles: [profile, { ...profile, configurationRevision: 'b'.repeat(64) }]
    },
    {
      name: '257 profiles',
      profiles: Array.from({ length: 257 }, (_, index) => ({ ...profile, id: `p${index}` }))
    },
    { name: 'unknown keys', profiles: [{ ...profile, access_token: 'server-secret' }] },
    {
      name: 'invalid revision',
      profiles: [{ ...profile, configurationRevision: 'not-a-revision' }]
    },
    { name: 'invalid ID', profiles: [{ ...profile, id: ' space ' }] }
  ])('rejects $name', async ({ profiles }) => {
    const f = fixture()
    f.fetch.mockResolvedValue(metadata(profiles))
    const error = await f.client.list(f.config).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'PROTOCOL_ERROR', cause: undefined, payload: undefined })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('maps only supported model-use values without inventing aliases or returning extra config', async () => {
    const f = fixture()
    f.fetch.mockResolvedValue(
      metadata(
        ['default', 'coding', 'reasoning'].map((model_use) => ({
          ...profile,
          id: model_use,
          model_use,
          deployment: 'local'
        }))
      )
    )
    const listed = await f.client.list(f.config)
    for (const listedProfile of listed.profiles) {
      expect(listedProfile).toMatchObject({ deployment: 'local' })
      expect(listedProfile).not.toHaveProperty('model_use')
      expect(listedProfile).not.toHaveProperty('base_profile_id')
    }
  })

  it('normalizes even injected ServiceError failures without authorization, URL, payload or cause echo', async () => {
    const f = fixture()
    f.fetch.mockRejectedValue(
      new ServiceError('Bearer main-only-test-secret https://comparison.invalid', {
        code: 'UNTRUSTED',
        payload: { secret: 'server-secret' },
        cause: new Error('private cause')
      })
    )
    const error = await f.client.list(f.config).catch((error: unknown) => error)
    expect(error).toMatchObject({
      code: 'REMOTE_REQUEST_FAILED',
      message: 'Remote project comparison request failed.',
      cause: undefined,
      payload: undefined
    })
    expect(f.fetch).toHaveBeenCalledOnce()
  })
})

describe('main-memory consent receipts and one-shot chat', () => {
  it('uses only the remote revision in the strict fixed-endpoint wire request and projects text/usage', async () => {
    const f = fixture()
    const req = await issue(f)
    f.fetch.mockResolvedValue(result())
    const response = await f.client.chat(f.config, {
      ...req,
      comparisonRouting: 'local'
    } as LLMChatReq)
    expect(response).toEqual({
      content: 'Synthetic advice',
      finishReason: 'stop',
      usage: { totalTokens: 12 }
    })
    expect(f.fetch).toHaveBeenCalledTimes(2)
    const [url, init] = f.fetch.mock.calls[1]
    expect(url).toBe('https://comparison.invalid/api/project-comparison/chat')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer main-only-test-secret'
      }
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      protocol: 1,
      profileId: profile.id,
      expectedProfileRevision: remoteRevision,
      messages,
      temperature: 0.2,
      maxOutputTokens: 1200
    })
    expect(String(init?.body)).not.toContain(req.expectedProfileRevision)
    expect(String(init?.body)).not.toContain('main-only-test-secret')
  })

  it('preserves a trusted correlation id across the remote comparison envelope', async () => {
    const f = fixture()
    const req = await issue(f)
    const correlationId = '0123456789abcdef0123456789abcdef'
    f.fetch.mockResolvedValue(result())

    await f.client.chat(f.config, { ...req, correlationId })

    expect(JSON.parse(String(f.fetch.mock.calls[1][1]?.body))).toMatchObject({
      protocol: 1,
      correlationId
    })
  })

  it.each(['origin', 'credential', 'remoteMode', 'originSpelling'] as const)(
    'rejects changed main %s before chat fetch',
    async (field) => {
      const f = fixture()
      const req = await issue(f)
      if (field === 'origin')
        f.config.remote_llm_server_config.server_origin = 'https://changed.invalid'
      if (field === 'credential') f.config.remote_llm_server_config.access_token = 'changed-key'
      if (field === 'remoteMode') f.config.use_remote_llm = false
      if (field === 'originSpelling')
        f.config.remote_llm_server_config.server_origin = 'https://comparison.invalid'
      await expect(f.client.chat(f.config, req)).rejects.toMatchObject({
        code: 'PROFILE_CONFIGURATION_CHANGED'
      })
      expect(f.fetch).toHaveBeenCalledOnce()
    }
  )

  it('pins an in-flight metadata fetch to its captured main configuration, not later mutations', async () => {
    const f = fixture()
    f.fetch.mockImplementation(async () => {
      f.config.remote_llm_server_config.access_token = 'mutated-key'
      return metadata()
    })
    const req = await issue(f)
    await expect(f.client.chat(f.config, req)).rejects.toMatchObject({
      code: 'PROFILE_CONFIGURATION_CHANGED'
    })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('keeps each receipt pinned to its original remote revision after metadata refresh', async () => {
    const f = fixture()
    const old = await issue(f)
    f.fetch.mockResolvedValueOnce(metadata([{ ...profile, configurationRevision: 'b'.repeat(64) }]))
    const fresh = await issue(f)
    f.fetch.mockImplementation(async () => result())
    await f.client.chat(f.config, old)
    await f.client.chat(f.config, fresh)
    expect(JSON.parse(String(f.fetch.mock.calls[2][1]?.body)).expectedProfileRevision).toBe(
      remoteRevision
    )
    expect(JSON.parse(String(f.fetch.mock.calls[3][1]?.body)).expectedProfileRevision).toBe(
      'b'.repeat(64)
    )
    expect(f.fetch).toHaveBeenCalledTimes(4)
  })

  it('does not normalize composite profile IDs or accept renderer profile objects', async () => {
    const f = fixture()
    const req = await issue(f)
    for (const profileId of ['base', 'base::other', 'BASE::selected-model'])
      await expect(f.client.chat(f.config, { ...req, profileId })).rejects.toMatchObject({
        code: 'PROFILE_CONFIGURATION_CHANGED'
      })
    await expect(
      f.client.chat(f.config, {
        ...req,
        profile: { ...profile, api_key: 'renderer-key' }
      } as LLMChatReq)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('rejects missing, malformed, forged and other-client receipts before fetch', async () => {
    const f = fixture()
    const req = await issue(f)
    for (const expectedProfileRevision of [
      undefined,
      '',
      'a'.repeat(32),
      'G'.repeat(64),
      remoteRevision
    ])
      await expect(
        f.client.chat(f.config, { ...req, expectedProfileRevision })
      ).rejects.toMatchObject({ code: 'PROFILE_CONFIGURATION_CHANGED' })
    const another = new RemoteProjectComparisonClient(f.fetch)
    await expect(another.chat(f.config, req)).rejects.toMatchObject({
      code: 'PROFILE_CONFIGURATION_CHANGED'
    })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('expires receipts exactly at ten minutes without sliding expiry or clock-rollback resurrection', async () => {
    let now = 1000
    const f = fixture({ now: () => now })
    const req = await issue(f)
    f.fetch.mockResolvedValue(result())
    now += 600_000 - 1
    await f.client.chat(f.config, req)
    now += 1
    await expect(f.client.chat(f.config, req)).rejects.toMatchObject({
      code: 'PROFILE_CONFIGURATION_CHANGED'
    })
    now = 1000
    await expect(f.client.chat(f.config, req)).rejects.toMatchObject({
      code: 'PROFILE_CONFIGURATION_CHANGED'
    })
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('bounds the receipt cache at 512 and evicts the least recently used receipt', async () => {
    const f = fixture()
    const batch = (prefix: string) =>
      Array.from({ length: 256 }, (_, index) => ({ ...profile, id: `${prefix}-${index}` }))
    f.fetch
      .mockResolvedValueOnce(metadata(batch('first')))
      .mockResolvedValueOnce(metadata(batch('second')))
    const first = await f.client.list(f.config)
    await f.client.list(f.config)
    const req = (index: number): LLMChatReq => ({
      messages,
      profileId: first.profiles[index].id,
      expectedProfileRevision: first.profiles[index].configurationRevision
    })
    f.fetch.mockResolvedValueOnce(result())
    await f.client.chat(f.config, req(0))
    f.fetch.mockResolvedValueOnce(metadata())
    await f.client.list(f.config)
    await expect(f.client.chat(f.config, req(1))).rejects.toMatchObject({
      code: 'PROFILE_CONFIGURATION_CHANGED'
    })
    expect(f.fetch).toHaveBeenCalledTimes(4)
    f.fetch.mockResolvedValueOnce(result())
    await expect(f.client.chat(f.config, req(0))).resolves.toHaveProperty('content')
    expect(f.fetch).toHaveBeenCalledTimes(5)
  })

  it.each([
    { skillRuntime: {} },
    { route: {} },
    { sessionUrl: 'https://renderer.invalid/secret' },
    { apiMode: 'responses' },
    { profileScope: 'qapp' },
    { systemPrompt: 'extra' },
    { url: 'https://renderer.invalid' },
    { headers: { Authorization: 'renderer-secret' } },
    { maxOutputTokens: 1201 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
    { temperature: -0.1 },
    { temperature: 1.1 },
    { temperature: NaN },
    { messages: [messages[0]] },
    { messages: [...messages, ...messages, messages[0]] },
    { messages: [{ role: 'assistant', content: 'extra' }, messages[1]] },
    { messages: [{ ...messages[0], attachments: [] }, messages[1]] },
    { messages: [{ ...messages[0], hiddenContext: 'secret' }, messages[1]] },
    { messages: [{ ...messages[0], content: '🙂'.repeat(13000) }, messages[1]] },
    { messages: messages.map((message) => ({ ...message, content: 'x'.repeat(25 * 1024) })) }
  ])(
    'rejects disallowed request controls or text/token budgets before fetch: %j',
    async (overrides) => {
      const f = fixture()
      const req = await issue(f)
      await expect(
        f.client.chat(f.config, { ...req, ...overrides } as LLMChatReq)
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(f.fetch).toHaveBeenCalledOnce()
    }
  )

  it('counts default options against the encoded 48 KiB request boundary', async () => {
    const f = fixture()
    const req = await issue(f)
    const emptyMessages = [
      { role: 'system' as const, content: '' },
      { role: 'user' as const, content: '' }
    ]
    const wire = {
      protocol: 1,
      profileId: req.profileId,
      expectedProfileRevision: remoteRevision,
      messages: emptyMessages,
      temperature: 0.2,
      maxOutputTokens: 1200
    }
    const available = 48 * 1024 - encode(JSON.stringify(wire)).byteLength
    req.messages = [{ ...emptyMessages[0], content: 'x'.repeat(available + 1) }, emptyMessages[1]]
    await expect(f.client.chat(f.config, req)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(f.fetch).toHaveBeenCalledOnce()
    req.messages[0].content = 'x'.repeat(available)
    f.fetch.mockResolvedValueOnce(result())
    await expect(f.client.chat(f.config, req)).resolves.toHaveProperty('content')
    expect(encode(String(f.fetch.mock.calls[1][1]?.body)).byteLength).toBe(48 * 1024)
  })

  it.each([
    { protocol: 2, result: { content: 'advice' } },
    { protocol: 1, result: { content: 'advice', sessionUrl: 'https://secret.invalid' } },
    { protocol: 1, result: { content: 'advice', attachments: [] } },
    { protocol: 1, result: { content: 'advice', usage: { totalTokens: -1 } } },
    { protocol: 1, result: { content: '🙂'.repeat(4097) } }
  ])('validates chat protocol, projection and actual 16 KiB content budget', async (body) => {
    const f = fixture()
    const req = await issue(f)
    f.fetch.mockResolvedValue(json(body))
    await expect(f.client.chat(f.config, req)).rejects.toMatchObject({
      code: body.protocol === 2 ? 'PROTOCOL_UNSUPPORTED' : 'PROTOCOL_ERROR'
    })
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('accepts content exactly at the UTF-8 budget and enforces the encoded JSON cap separately', async () => {
    const f = fixture()
    const req = await issue(f)
    f.fetch.mockResolvedValueOnce(result('🙂'.repeat(4096)))
    await expect(f.client.chat(f.config, req)).resolves.toMatchObject({
      content: '🙂'.repeat(4096)
    })
    const stream = streamed([encode(' '.repeat(128 * 1024)), encode('{}')])
    f.fetch.mockResolvedValueOnce(stream.response)
    await expect(f.client.chat(f.config, req)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(stream.cancel).toHaveBeenCalledOnce()
    const excessive = streamed([], { 'Content-Length': String(128 * 1024 + 1) })
    f.fetch.mockResolvedValueOnce(excessive.response)
    await expect(f.client.chat(f.config, req)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(excessive.cancel).toHaveBeenCalledOnce()
    expect(f.fetch).toHaveBeenCalledTimes(4)
  })

  it('does not retry, refresh metadata or fall back locally after remote revision conflict', async () => {
    const f = fixture()
    const req = await issue(f)
    f.fetch.mockResolvedValue(json({ secret: 'main-only-test-secret' }, 409))
    await expect(f.client.chat(f.config, req)).rejects.toMatchObject({
      code: 'PROFILE_CONFIGURATION_CHANGED'
    })
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('total deadlines and cancellation', () => {
  it('times out even if fetch ignores AbortSignal and cancels a response arriving later', async () => {
    vi.useFakeTimers()
    const f = fixture({ metadataTimeoutMs: 10 })
    let finish!: (response: Response) => void
    f.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const outcome = expect(f.client.list(f.config)).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10)
    await outcome
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    const stream = streamed([])
    finish(stream.response)
    await vi.advanceTimersByTimeAsync(0)
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('uses one chat deadline across fetch and body reads, and does not await stalled cancellation', async () => {
    vi.useFakeTimers()
    const f = fixture({ requestTimeoutMs: 100 })
    const req = await issue(f)
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Type': 'application/json' }
    })
    f.fetch.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(response), 60))
    )
    const outcome = expect(f.client.chat(f.config, req)).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(99)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(cancel).toHaveBeenCalledOnce()
    expect(f.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true)
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('checks elapsed time while immediately resolved empty chunks would starve the timer', async () => {
    const f = fixture({ metadataTimeoutMs: 10 })
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const cancel = vi.fn()
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      elapsed += 2
      controller.enqueue(new Uint8Array())
    })
    f.fetch.mockResolvedValue(
      new Response(new ReadableStream({ pull, cancel }), {
        headers: { 'Content-Type': 'application/json' }
      })
    )
    await expect(f.client.list(f.config)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(pull.mock.calls.length).toBeLessThan(10)
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it.each(['list', 'chat'] as const)(
    'clamps longer %s timeout overrides to the production maximum',
    async (method) => {
      vi.useFakeTimers()
      const f = fixture({ metadataTimeoutMs: 999_999, requestTimeoutMs: 999_999 })
      const req = await issue(f)
      f.fetch.mockImplementation(() => new Promise(() => {}))
      const timeout = method === 'list' ? 30_000 : 120_000
      const operation = method === 'list' ? f.client.list(f.config) : f.client.chat(f.config, req)
      const outcome = expect(operation).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(timeout)
      await outcome
      expect(f.fetch).toHaveBeenCalledTimes(2)
    }
  )

  it('honors caller abort even when fetch ignores it without leaking the abort reason', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.fetch.mockImplementation(() => new Promise(() => {}))
    const outcome = expect(f.client.list(f.config, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
      message: 'Remote project comparison request cancelled.',
      cause: undefined
    })
    controller.abort(new Error('main-only-test-secret https://comparison.invalid'))
    await outcome
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('cancels an active response reader on caller abort', async () => {
    const f = fixture()
    const controller = new AbortController()
    const stream = streamed([])
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
      reading = resolve
    })
    const body = stream.response.body!
    const getReader = body.getReader.bind(body)
    vi.spyOn(body, 'getReader').mockImplementation((() => {
      reading()
      return getReader()
    }) as typeof body.getReader)
    f.fetch.mockResolvedValue(stream.response)
    const outcome = expect(f.client.list(f.config, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED'
    })
    await started
    controller.abort()
    await outcome
    expect(stream.cancel).toHaveBeenCalledOnce()
  })

  it('does not fetch when the caller signal is already aborted', async () => {
    const f = fixture()
    const req = await issue(f)
    const controller = new AbortController()
    controller.abort('private abort reason')
    await expect(f.client.list(f.config, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED'
    })
    await expect(f.client.chat(f.config, req, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED'
    })
    expect(f.fetch).toHaveBeenCalledOnce()
  })
})
