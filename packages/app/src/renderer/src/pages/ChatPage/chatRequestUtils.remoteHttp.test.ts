import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { isInvalidSessionContinuationError, requestChatCompletion } from './chatRequestUtils'

// Actual HTTP on a fresh loopback-only server, not a real upstream/provider or Electron.
// The only permitted fetch destinations are the four request routes on this server.
const nativeFetch = globalThis.fetch.bind(globalThis)
const fixtures: Array<{ close: () => Promise<void> }> = []
beforeEach(() => {
  window.api = { svcManagedMedia: {} } as unknown as Window['api']
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

const createFixture = async (
  handler: (request: IncomingMessage, response: ServerResponse, index: number) => void
) => {
  const paths: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    expect(request.method).toBe('POST')
    expect(request.headers.authorization).toBeUndefined()
    paths.push(request.url || '')
    request.resume()
    handler(request, response, paths.length)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const allowed = new Set(
    ['/api/chat', '/api/bot/chat', '/api/bot/message', '/api/message'].map((p) => origin + p)
  )
  let onBodyRead: () => void = () => undefined
  const bodyReadStarted = new Promise<void>((resolve) => (onBodyRead = resolve))
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
    if (typeof input !== 'string' || !allowed.has(input)) {
      throw new Error('Unexpected loopback fixture destination')
    }
    const response = await nativeFetch(input, { ...options, redirect: 'error' })
    const read = response.text.bind(response)
    vi.spyOn(response, 'text').mockImplementation(() => {
      onBodyRead()
      return read()
    })
    return response
  })
  vi.stubGlobal('fetch', fetch)
  const config: Config = {
    ...DEFAULT_CONFIG,
    use_remote_llm: true,
    llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] },
    remote_llm_server_config: { server_origin: origin, access_token: '' }
  }
  const run = (signal?: AbortSignal) =>
    requestChatCompletion({
      config,
      profileId: 'fixture-loopback',
      messages: [{ role: 'user', content: 'Fixture fixture request, no user data.' }],
      sessionUrl: 'fixture-continuation',
      signal
    })
  const close = async () => {
    const finished = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    for (const socket of sockets) socket.destroy()
    await bounded(finished)
    expect(server.listening).toBe(false)
  }
  fixtures.push({ close })
  return { paths, fetch, run, bodyReadStarted }
}

const bounded = <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Fixture loopback test deadline')), 4000)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

describe('remote request real loopback HTTP status and body lifetime', () => {
  it('falls back after a real 404 Not Found with a session endpoint-unavailable body', async () => {
    const fixture = await createFixture((_request, response, index) => {
      response.writeHead(index === 1 ? 404 : 200, { 'content-type': 'application/json' })
      response.end(
        index === 1
          ? '{"error":"Session endpoint is unavailable; use the legacy API"}'
          : '{"content":"Fixture legacy"}'
      )
    })
    await expect(bounded(fixture.run())).resolves.toMatchObject({ content: 'Fixture legacy' })
    expect(fixture.paths).toEqual(['/api/chat', '/api/bot/chat'])
    expect(fixture.fetch).toHaveBeenCalledTimes(2)
  })

  it('retains an explicit previous_response not found detail on real HTTP 404', async () => {
    const fixture = await createFixture((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(
        '{"error":{"code":"previous_response_not_found","message":"previous_response not found"}}'
      )
    })
    const error = await bounded(fixture.run()).catch((reason: unknown) => reason)
    expect(String(error)).toContain('previous_response not found')
    expect(isInvalidSessionContinuationError(error, true)).toBe(true)
    expect(fixture.paths).toEqual(['/api/chat'])
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([502, 504])(
    'propagates a real HTTP %s without legacy fallback or retry',
    async (status) => {
      const fixture = await createFixture((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end('{"error":"Fixture upstream failure"}')
      })
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      await expect(bounded(fixture.run(controller.signal))).rejects.toThrow(
        `Remote chat request failed (${status}`
      )
      expect(fixture.paths).toEqual(['/api/chat'])
      expect(fixture.fetch).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    }
  )

  it.each([404, 410])(
    'retains actual HTTP %s continuation rejection before trying legacy URLs',
    async (status) => {
      const fixture = await createFixture((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(
          '{"error":{"code":"session_expired","message":"expired session continuation"}}'
        )
      })
      const error = await bounded(fixture.run()).catch((reason: unknown) => reason)
      expect(String(error)).toContain('expired session continuation')
      expect(isInvalidSessionContinuationError(error, true)).toBe(true)
      expect(fixture.paths).toEqual(['/api/chat'])
    }
  )

  it('keeps genuine route fallback usable with four real HTTP response bodies', async () => {
    const fixture = await createFixture((_request, response, index) => {
      response.writeHead([404, 405, 410, 200][index - 1], {
        'content-type': 'application/json'
      })
      response.end(index < 4 ? '{"error":"route unavailable"}' : '{"content":"Fixture legacy"}')
    })
    await expect(bounded(fixture.run())).resolves.toMatchObject({ content: 'Fixture legacy' })
    expect(fixture.paths).toEqual([
      '/api/chat',
      '/api/bot/chat',
      '/api/bot/message',
      '/api/message'
    ])
  })

  it('cancels a real unfinished fallback body without trying another endpoint', async () => {
    let onBody: () => void = () => undefined
    let onClosed: () => void = () => undefined
    const bodyStarted = new Promise<void>((resolve) => (onBody = resolve))
    const bodyClosed = new Promise<void>((resolve) => (onClosed = resolve))
    const fixture = await createFixture((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.write('{"error":"unfinished')
      response.once('close', onClosed)
      onBody()
    })
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = fixture.run(controller.signal).catch((error: unknown) => error)
    await bounded(bodyStarted)
    await bounded(fixture.bodyReadStarted)
    controller.abort(new DOMException('Fixture cancellation', 'AbortError'))
    expect(await bounded(pending)).toMatchObject({ name: 'AbortError' })
    // This resolves from the real server-side response closing, before fixture cleanup.
    await bounded(bodyClosed)
    expect(fixture.paths).toEqual(['/api/chat'])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
