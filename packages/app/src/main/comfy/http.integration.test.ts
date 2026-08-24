import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { TLS_TEST_CERT, TLS_TEST_KEY } from './http.tlsFixture'
vi.mock('../config/config', () => ({ getConfig: vi.fn(() => ({})) }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: vi.fn(() => ({})) }))
vi.mock('./networkPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./networkPolicy')>()
  return {
    ...actual,
    // These integration tests exercise the real Undici/ws lookup and socket paths against
    // a loopback fixture. Address-policy behavior remains covered by http.test.ts.
    isUnsafeComfyAddress: (address: string) =>
      address === '127.0.0.1' ? false : actual.isUnsafeComfyAddress(address)
  }
})

import { ComfyHttpCli } from './http'

let server: Server
let origin: string

beforeEach(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/object_info')
      return void response.end(JSON.stringify({ LoadImage: {}, SaveImage: {} }))
    if (url.pathname === '/queue')
      return void response.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
    if (url.pathname === '/history') return void response.end(JSON.stringify({}))
    if (url.pathname === '/prompt') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { client_id?: string }
      expect(body.client_id).toBe('batch-client')
      return void response.end(JSON.stringify({ prompt_id: 'prompt-1' }))
    }
    if (url.pathname === '/history/prompt-1') {
      return void response.end(
        JSON.stringify({
          'prompt-1': {
            outputs: {},
            status: { status_str: 'success', completed: true, messages: [] }
          }
        })
      )
    }
    if (url.pathname === '/upload/image') {
      expect(request.headers['content-type']).toContain('multipart/form-data; boundary=')
      return void response.end(
        JSON.stringify({ name: 'uploaded.png', subfolder: 'batch', type: 'input' })
      )
    }
    if (url.pathname === '/view') {
      expect(url.searchParams.get('filename')).toBe('result.png')
      response.setHeader('Content-Type', 'image/png')
      return void response.end(Buffer.from([1, 2, 3]))
    }
    response.statusCode = 404
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake Comfy server did not bind.')
  origin = `http://127.0.0.1:${address.port}/`
})

afterEach(async () => {
  server.close()
  await once(server, 'close')
})

describe('ComfyHttpCli fake endpoint integration', () => {
  it('pins a remote hostname through the real Undici Node 22 all-address lookup path', async () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fake Comfy server did not bind.')
    const cli = new ComfyHttpCli({} as never, {} as never, {
      origin: `http://pinned.example.test:${address.port}/`,
      remote: true,
      retryBaseDelayMs: 0,
      resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }]
    })

    await expect(cli.objectInfo()).resolves.toEqual({ LoadImage: {}, SaveImage: {} })
  })

  it('pins a remote hostname through a real ws handshake', async () => {
    const webSocketServer = new WebSocketServer({ server })
    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Fake Comfy server did not bind.')
      const cli = new ComfyHttpCli({} as never, {} as never, {
        origin: `http://pinned-ws.example.test:${address.port}/`,
        remote: true,
        retryBaseDelayMs: 0,
        resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }]
      })
      const serverConnection = once(webSocketServer, 'connection')
      const socket = cli.connect()
      const clientOpen = once(socket, 'open')
      await Promise.all([clientOpen, serverConnection])
      socket.close()
      await once(socket, 'close')
    } finally {
      webSocketServer.close()
      await once(webSocketServer, 'close')
    }
  })

  it('keeps certificate hostname validation and SNI on pinned HTTPS and WSS connections', async () => {
    const observedServerNames: string[] = []
    const tlsServer = createHttpsServer(
      { key: TLS_TEST_KEY, cert: TLS_TEST_CERT },
      (request, response) => {
        if (request.url === '/object_info') {
          response.end(JSON.stringify({ SecureNode: {} }))
          return
        }
        response.statusCode = 404
        response.end()
      }
    )
    tlsServer.on('secureConnection', (socket) => {
      if (typeof socket.servername === 'string') observedServerNames.push(socket.servername)
    })
    const webSocketServer = new WebSocketServer({ server: tlsServer })
    tlsServer.listen(0, '127.0.0.1')
    await once(tlsServer, 'listening')
    const address = tlsServer.address()
    if (!address || typeof address === 'string') throw new Error('TLS fixture did not bind.')

    const options = {
      remote: true,
      retryBaseDelayMs: 0,
      tlsCa: TLS_TEST_CERT,
      resolveHostname: async () => [{ address: '127.0.0.1', family: 4 as const }]
    }
    try {
      const cli = new ComfyHttpCli({} as never, {} as never, {
        ...options,
        origin: `https://pinned-tls.example.test:${address.port}/`
      })
      await expect(cli.objectInfo()).resolves.toEqual({ SecureNode: {} })

      const wsConnection = once(webSocketServer, 'connection')
      const socket = cli.connect()
      await Promise.all([once(socket, 'open'), wsConnection])
      socket.close()
      await once(socket, 'close')

      expect(observedServerNames).toContain('pinned-tls.example.test')

      const wrongHostnameCli = new ComfyHttpCli({} as never, {} as never, {
        ...options,
        networkRetries: 0,
        origin: `https://wrong-host.example.test:${address.port}/`
      })
      await expect(wrongHostnameCli.objectInfo()).rejects.toMatchObject({
        cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
      })
    } finally {
      webSocketServer.close()
      await once(webSocketServer, 'close')
      tlsServer.close()
      await once(tlsServer, 'close')
    }
  })

  it('keeps WSS hostname verification and SNI enabled independently of HTTPS requests', async () => {
    const observedServerNames: string[] = []
    const tlsServer = createHttpsServer({ key: TLS_TEST_KEY, cert: TLS_TEST_CERT })
    tlsServer.on('secureConnection', (socket) => {
      if (typeof socket.servername === 'string') observedServerNames.push(socket.servername)
    })
    const webSocketServer = new WebSocketServer({ server: tlsServer })
    tlsServer.listen(0, '127.0.0.1')
    await once(tlsServer, 'listening')
    const address = tlsServer.address()
    if (!address || typeof address === 'string') throw new Error('WSS fixture did not bind.')

    const options = {
      remote: true,
      networkRetries: 0,
      retryBaseDelayMs: 0,
      tlsCa: TLS_TEST_CERT,
      resolveHostname: async () => [{ address: '127.0.0.1', family: 4 as const }]
    }
    try {
      const validCli = new ComfyHttpCli({} as never, {} as never, {
        ...options,
        origin: `https://pinned-wss.example.test:${address.port}/`
      })
      const serverConnection = once(webSocketServer, 'connection')
      const validSocket = validCli.connect()
      await Promise.all([once(validSocket, 'open'), serverConnection])
      validSocket.close()
      await once(validSocket, 'close')
      expect(observedServerNames).toContain('pinned-wss.example.test')

      const wrongHostnameCli = new ComfyHttpCli({} as never, {} as never, {
        ...options,
        origin: `https://wrong-wss-host.example.test:${address.port}/`
      })
      const invalidSocket = wrongHostnameCli.connect()
      const error = await new Promise<Error & { code?: string }>((resolve, reject) => {
        invalidSocket.once('open', () =>
          reject(new Error('Wrong-hostname WSS unexpectedly opened.'))
        )
        invalidSocket.once('error', (value) => resolve(value as Error & { code?: string }))
      })
      expect(error.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
      expect(observedServerNames).not.toContain('wrong-wss-host.example.test')
    } finally {
      webSocketServer.close()
      await once(webSocketServer, 'close')
      tlsServer.close()
      await once(tlsServer, 'close')
    }
  })

  it('uses one endpoint for capability, upload, prompt, history and view operations', async () => {
    const cli = new ComfyHttpCli({} as never, {} as never, {
      origin,
      remote: false,
      retryBaseDelayMs: 0
    })
    await expect(cli.objectInfo()).resolves.toEqual({ LoadImage: {}, SaveImage: {} })
    await expect(cli.getQueue()).resolves.toEqual({ queue_running: [], queue_pending: [] })
    await expect(
      cli.uploadImage({ filename: 'input.png', type: 'input' }, new Uint8Array([9]))
    ).resolves.toEqual({ filename: 'uploaded.png', subfolder: 'batch', type: 'input' })
    await expect(cli.prompt({ prompt: {}, client_id: 'batch-client' })).resolves.toEqual({
      prompt_id: 'prompt-1'
    })
    await expect(cli.history('prompt-1')).resolves.toHaveProperty('prompt-1.status.completed', true)
    await expect(cli.view({ filename: 'result.png', type: 'output' })).resolves.toEqual(
      new Uint8Array([1, 2, 3])
    )
  })
})
