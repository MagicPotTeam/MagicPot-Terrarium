import { getEventListeners } from 'node:events'
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatResp, LLMProxySvc } from '@shared/api/svcLLMProxy'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import {
  PROJECT_COMPARISON_CHAT_PATH,
  PROJECT_COMPARISON_PROFILES_PATH
} from '@shared/projectComparisonProtocol'
import { UpstreamHttpError } from '@shared/llm/clients'
import { handleProjectComparisonHttp } from './projectComparisonHttp'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('fs/promises')
vi.unmock('node:fs/promises')

const revision = 'a'.repeat(64)
const safeProfile = {
  id: 'profile-1',
  model_name: 'Fixture model',
  configurationRevision: revision,
  model_use: 'agent' as const,
  deployment: 'cloud' as const,
  context_budget_tokens: 4096,
  context_window_tokens: 8192
}
const validBody = {
  protocol: 1,
  profileId: safeProfile.id,
  expectedProfileRevision: revision,
  messages: [
    { role: 'system', content: 'Compare these texts.' },
    { role: 'user', content: 'Alpha and beta.' }
  ]
}
const fixtures: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((close) => close()))
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type Exchange = {
  req: IncomingMessage
  res: ServerResponse
  listeners: Array<{ emitter: IncomingMessage | ServerResponse; event: string; added: unknown[] }>
  done: Promise<void>
}

async function fixture(timeoutMs?: number) {
  const service = {
    listProfiles: vi
      .fn<LLMProxySvc['listProfiles']>()
      .mockResolvedValue({ profiles: [safeProfile] }),
    chat: vi.fn<LLMProxySvc['chat']>().mockResolvedValue({
      content: 'A comparison.',
      finishReason: 'stop'
    })
  }
  const first = deferred<Exchange>()
  const exchanges: Exchange[] = []
  const server = createServer((req, res) => {
    const watched = [
      ...['data', 'end', 'error', 'aborted'].map((event) => ({ emitter: req, event })),
      { emitter: res, event: 'close' }
    ].map(({ emitter, event }) => ({ emitter, event, before: emitter.listeners(event) }))
    const done = handleProjectComparisonHttp(req, res, service, { timeoutMs })
    // Capture only handler-owned listeners. Node later adds its own upload-drain listeners.
    const listeners = watched.map(({ emitter, event, before }) => ({
      emitter,
      event,
      added: emitter.listeners(event).filter((listener) => !before.includes(listener))
    }))
    const exchange = { req, res, listeners, done }
    exchanges.push(exchange)
    first.resolve(exchange)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const port = address.port
  fixtures.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  )

  function start(
    path = PROJECT_COMPARISON_CHAT_PATH,
    method = 'POST',
    headers: Record<string, string> = {}
  ) {
    let client!: ClientRequest
    const response = new Promise<{
      status: number
      headers: IncomingMessage['headers']
      body: string
    }>((resolve, reject) => {
      client = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString()
          })
        })
      })
      client.on('error', reject)
    })
    return { client, response }
  }

  async function post(body: unknown = validBody) {
    const call = start(PROJECT_COMPARISON_CHAT_PATH, 'POST', { 'Content-Type': 'application/json' })
    call.client.end(JSON.stringify(body))
    return call.response
  }
  return { service, first: first.promise, exchanges, start, post }
}

async function expectCleanup(exchange: Exchange) {
  await exchange.done
  for (const { emitter, event, added } of exchange.listeners) {
    for (const listener of added) expect(emitter.listeners(event)).not.toContain(listener)
  }
}

function expectError(response: { status: number; body: string }, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(JSON.parse(response.body)).toEqual({ code, message: expect.any(String) })
  expect(response.body).not.toContain('SECRET')
}

describe('project comparison HTTP boundary', () => {
  it('exposes only allowlisted profile metadata and asks for local revision-pinned profiles', async () => {
    const f = await fixture()
    f.service.listProfiles.mockResolvedValue({
      profiles: [
        {
          ...safeProfile,
          base_profile_id: 'SECRET',
          tagger_endpoint: 'https://SECRET.invalid',
          tagger_runtime_key: 'SECRET',
          ...{
            api_key: 'SECRET',
            base_url: 'https://SECRET.invalid',
            metadata: { token: 'SECRET' }
          }
        }
      ]
    })
    const call = f.start(`${PROJECT_COMPARISON_PROFILES_PATH}?ignored=1`, 'GET')
    call.client.end()
    const response = await call.response
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      protocol: 1,
      profiles: [{ ...safeProfile, deployment: 'api' }]
    })
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-magicpot-project-comparison']).toBe('1')
    expect(f.service.listProfiles).toHaveBeenCalledWith({
      includeConfigurationRevision: true,
      comparisonRouting: 'local'
    })
    expect(f.service.chat).not.toHaveBeenCalled()
    await expectCleanup(await f.first)
  })

  it.each([
    { profiles: [{ id: 'old', model_name: 'No revisions' }] },
    { profiles: [{ ...safeProfile, configurationRevision: 'old' }] },
    { profiles: Array.from({ length: 257 }, () => safeProfile) }
  ])('fails closed on unsupported or unbounded profile metadata', async (profiles) => {
    const f = await fixture()
    f.service.listProfiles.mockResolvedValue(profiles)
    const call = f.start(PROJECT_COMPARISON_PROFILES_PATH, 'GET')
    call.client.end()
    expectError(await call.response, 501, 'PROTOCOL_UNSUPPORTED')
  })

  it('accepts exactly 256 profiles', async () => {
    const f = await fixture()
    f.service.listProfiles.mockResolvedValue({
      profiles: Array.from({ length: 256 }, () => safeProfile)
    })
    const call = f.start(PROJECT_COMPARISON_PROFILES_PATH, 'GET')
    call.client.end()
    expect((await call.response).status).toBe(200)
  })

  it('sends schema-only chat fields, fresh main IDs and signals, and filters output without rewriting', async () => {
    const f = await fixture()
    const content = 'A comparison: magicpot-asset://unchanged'
    f.service.chat.mockResolvedValue({
      content,
      finishReason: 'length',
      sessionUrl: 'https://SECRET.invalid',
      metadata: { token: 'SECRET' },
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, ...{ token: 'SECRET' } }
    })
    for (let index = 0; index < 2; index++) {
      const response = await f.post()
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({
        protocol: 1,
        result: {
          content,
          finishReason: 'length',
          usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }
        }
      })
      const [req, options] = f.service.chat.mock.calls[index]
      expect(req).toEqual({
        profileId: safeProfile.id,
        expectedProfileRevision: revision,
        messages: validBody.messages,
        temperature: 0.2,
        maxOutputTokens: 1200,
        profileScope: 'agent',
        comparisonRouting: 'local',
        conversationId: expect.stringMatching(/^remote-comparison-[0-9a-f-]{36}$/)
      })
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      expect(options?.signal?.aborted).toBe(false)
      expect(getEventListeners(options!.signal!, 'abort')).toHaveLength(0)
    }
    expect(f.service.chat.mock.calls[0][0].conversationId).not.toBe(
      f.service.chat.mock.calls[1][0].conversationId
    )
    await Promise.all(f.exchanges.map(expectCleanup))
  })

  it.each([
    { ...validBody, protocol: undefined },
    { ...validBody, protocol: 2 },
    { ...validBody, route: 'SECRET' },
    { ...validBody, tools: ['SECRET'] },
    { ...validBody, attachments: ['SECRET'] },
    { ...validBody, conversationId: 'SECRET' },
    { ...validBody, comparisonRouting: 'SECRET' },
    { ...validBody, profileScope: 'qapp' },
    {
      ...validBody,
      messages: [
        { role: 'system', content: 'x' },
        { role: 'user', content: 'x', attachments: [] }
      ]
    },
    {
      ...validBody,
      messages: [
        { role: 'assistant', content: 'x' },
        { role: 'user', content: 'x' }
      ]
    }
  ])(
    'rejects unsupported request fields or versions without reaching the service',
    async (body) => {
      const f = await fixture()
      const response = await f.post(body)
      expectError(response, 400, 'VALIDATION_ERROR')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(f.service.chat).not.toHaveBeenCalled()
      await expectCleanup(await f.first)
    }
  )

  it.each(['', '{"SECRET":', 'null'])('rejects malformed or non-object JSON', async (body) => {
    const f = await fixture()
    const call = f.start()
    call.client.end(body)
    expectError(await call.response, 400, 'VALIDATION_ERROR')
    expect(f.service.chat).not.toHaveBeenCalled()
  })

  it('checks Content-Length before waiting for body bytes', async () => {
    const f = await fixture()
    const call = f.start(PROJECT_COMPARISON_CHAT_PATH, 'POST', {
      'Content-Length': String(48 * 1024 + 1)
    })
    call.client.flushHeaders()
    expectError(await call.response, 413, 'PAYLOAD_TOO_LARGE')
    call.client.destroy()
    expect(f.service.chat).not.toHaveBeenCalled()
    await expectCleanup(await f.first)
  })

  it('bounds chunked raw bytes, including whitespace, before parsing', async () => {
    const f = await fixture()
    const call = f.start(PROJECT_COMPARISON_CHAT_PATH, 'POST', { 'Transfer-Encoding': 'chunked' })
    call.client.write(Buffer.alloc(24 * 1024, ' '))
    call.client.write(Buffer.alloc(24 * 1024 + 1, ' '))
    expectError(await call.response, 413, 'PAYLOAD_TOO_LARGE')
    call.client.destroy()
    expect(f.service.chat).not.toHaveBeenCalled()
    await expectCleanup(await f.first)
  })

  it('uses fatal UTF-8 decoding instead of accepting replacement characters in JSON', async () => {
    const f = await fixture()
    const call = f.start(PROJECT_COMPARISON_CHAT_PATH, 'POST', { 'Transfer-Encoding': 'chunked' })
    const body = JSON.stringify(validBody)
    const marker = body.indexOf('Alpha')
    call.client.write(Buffer.from(body.slice(0, marker)))
    call.client.write(Buffer.from([0xc3, 0x28]))
    call.client.end(Buffer.from(body.slice(marker)))
    expectError(await call.response, 400, 'VALIDATION_ERROR')
    expect(f.service.chat).not.toHaveBeenCalled()
  })

  it('accepts a valid multibyte character split across chunks and the exact raw body limit', async () => {
    const f = await fixture()
    const body = Buffer.from(
      JSON.stringify({
        ...validBody,
        messages: [{ role: 'system', content: 'é' }, validBody.messages[1]]
      })
    )
    const split = body.indexOf(Buffer.from('é')) + 1
    const call = f.start(PROJECT_COMPARISON_CHAT_PATH, 'POST', { 'Transfer-Encoding': 'chunked' })
    call.client.write(body.subarray(0, split))
    call.client.write(body.subarray(split))
    call.client.end(Buffer.alloc(48 * 1024 - body.byteLength, ' '))
    expect((await call.response).status).toBe(200)
  })

  it.each([
    ['GET', PROJECT_COMPARISON_CHAT_PATH],
    ['POST', PROJECT_COMPARISON_PROFILES_PATH],
    ['POST', `${PROJECT_COMPARISON_CHAT_PATH}/extra`],
    ['POST', `http://SECRET.invalid${PROJECT_COMPARISON_CHAT_PATH}`],
    ['POST', `//SECRET.invalid${PROJECT_COMPARISON_CHAT_PATH}`],
    ['POST', `/\\SECRET.invalid${PROJECT_COMPARISON_CHAT_PATH}`]
  ])('rejects method/path mismatches and external URL targets: %s %s', async (method, path) => {
    const f = await fixture()
    const call = f.start(path, method)
    call.client.end()
    expectError(await call.response, 400, 'VALIDATION_ERROR')
    expect(f.service.chat).not.toHaveBeenCalled()
    expect(f.service.listProfiles).not.toHaveBeenCalled()
  })

  it('applies the deadline to delayed request bodies and removes body-phase listeners', async () => {
    const f = await fixture(30)
    const call = f.start(PROJECT_COMPARISON_CHAT_PATH, 'POST', { 'Transfer-Encoding': 'chunked' })
    call.client.write('{')
    expectError(await call.response, 504, 'TIMEOUT')
    call.client.destroy()
    expect(f.service.chat).not.toHaveBeenCalled()
    await expectCleanup(await f.first)
  })

  it('uses one deadline for body reading plus a chat provider that ignores abort', async () => {
    const f = await fixture(300)
    const timer = vi.spyOn(globalThis, 'setTimeout')
    f.service.chat.mockImplementation(() => new Promise(() => {}))
    const call = f.start(PROJECT_COMPARISON_CHAT_PATH, 'POST', { 'Transfer-Encoding': 'chunked' })
    const body = JSON.stringify(validBody)
    call.client.write(body.slice(0, -1))
    const exchange = await f.first
    await new Promise((resolve) => setTimeout(resolve, 60))
    call.client.end('}')
    expectError(await call.response, 504, 'TIMEOUT')
    expect(f.service.chat).toHaveBeenCalledOnce()
    expect(f.service.chat.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(timer.mock.calls.filter(([, delay]) => delay === 300)).toHaveLength(1)
    await expectCleanup(exchange)
  })

  it('settles on timeout even when chat ignores its signal', async () => {
    const f = await fixture(30)
    f.service.chat.mockImplementation(() => new Promise(() => {}))
    expectError(await f.post(), 504, 'TIMEOUT')
    expect(f.service.chat.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await expectCleanup(await f.first)
  })

  it('also bounds a profile service that never settles', async () => {
    const f = await fixture(30)
    f.service.listProfiles.mockImplementation(() => new Promise(() => {}))
    const call = f.start(PROJECT_COMPARISON_PROFILES_PATH, 'GET')
    call.client.end()
    expectError(await call.response, 504, 'TIMEOUT')
    await expectCleanup(await f.first)
  })

  it('aborts main chat and settles without writing after a client disconnect', async () => {
    const f = await fixture()
    const started = deferred<AbortSignal>()
    f.service.chat.mockImplementation((_req, options) => {
      started.resolve(options!.signal!)
      return new Promise(() => {})
    })
    const call = f.start()
    const disconnected = call.response.catch(() => undefined)
    call.client.end(JSON.stringify(validBody))
    const signal = await started.promise
    const exchange = await f.first
    const end = vi.spyOn(exchange.res, 'end')
    call.client.destroy()
    await disconnected
    await expectCleanup(exchange)
    expect(signal.aborted).toBe(true)
    expect(end).not.toHaveBeenCalled()
  })

  it('cleans up an aborted upload before chat starts', async () => {
    const f = await fixture()
    const call = f.start(PROJECT_COMPARISON_CHAT_PATH, 'POST', { 'Transfer-Encoding': 'chunked' })
    const disconnected = call.response.catch(() => undefined)
    call.client.write('{')
    const exchange = await f.first
    const end = vi.spyOn(exchange.res, 'end')
    call.client.destroy()
    await disconnected
    await expectCleanup(exchange)
    expect(f.service.chat).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it.each([
    [
      new ServiceError('SECRET', { code: 'PROFILE_CONFIGURATION_CHANGED' }),
      409,
      'PROFILE_CONFIGURATION_CHANGED'
    ],
    [new ServiceError('SECRET', { code: 'PROTOCOL_UNSUPPORTED' }), 501, 'PROTOCOL_UNSUPPORTED'],
    [
      new UpstreamHttpError('SECRET', { status: 502, statusText: 'SECRET' }, 'SECRET'),
      502,
      'REMOTE_UPSTREAM_FAILED'
    ],
    [
      new UpstreamHttpError('SECRET', { status: 504, statusText: 'SECRET' }, 'SECRET'),
      504,
      'TIMEOUT'
    ],
    [{ status: 502, message: 'SECRET' }, 502, 'REMOTE_UPSTREAM_FAILED'],
    [{ status: 504, message: 'SECRET' }, 504, 'TIMEOUT'],
    [new Error('SECRET 504 URL key token'), 502, 'REMOTE_UPSTREAM_FAILED']
  ])(
    'preserves typed failure semantics but never provider messages',
    async (error, status, code) => {
      const f = await fixture()
      const logging = vi.spyOn(console, 'error').mockImplementation(() => {})
      f.service.chat.mockRejectedValue(error)
      expectError(await f.post(), status as number, code as string)
      expect(logging).not.toHaveBeenCalled()
    }
  )

  it.each([
    { content: '' },
    { content: '  \n' },
    { content: 'text', finishReason: 'error' },
    { content: 'text', finishReason: 'cancelled' },
    { content: 'text', finishReason: 'tool_call' },
    { content: 'text', toolCalls: [{ secret: 'SECRET' }] },
    { content: 'text', tool_calls: [{ secret: 'SECRET' }] },
    { content: 'text', error: 'SECRET' },
    { content: 'text', imageUrl: 'https://SECRET.invalid' },
    { content: 'text', attachments: [{ type: 'file', url: 'SECRET' }] },
    { content: 'text', usage: { promptTokens: -1 } },
    { content: 'é'.repeat(8193) },
    { content: 'x'.repeat(16 * 1024 + 1) }
  ])('rejects unsupported or oversized output instead of faking success', async (result) => {
    const f = await fixture()
    f.service.chat.mockResolvedValue(result as LLMChatResp)
    expectError(await f.post(), 502, 'REMOTE_UPSTREAM_FAILED')
  })

  it('accepts exactly 16 KiB UTF-8 output', async () => {
    const f = await fixture()
    f.service.chat.mockResolvedValue({ content: 'é'.repeat(8192) })
    expect((await f.post()).status).toBe(200)
  })

  it.each([Infinity, NaN, 240_000])(
    'cannot extend or disable the 120-second deadline: %s',
    async (timeoutMs) => {
      const f = await fixture(timeoutMs)
      const timer = vi.spyOn(globalThis, 'setTimeout')
      const clear = vi.spyOn(globalThis, 'clearTimeout')
      expect((await f.post()).status).toBe(200)
      const index = timer.mock.calls.findIndex(([, delay]) => delay === 120_000)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(clear).toHaveBeenCalledWith(timer.mock.results[index].value)
    }
  )
})
