import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  MagicAgentSdkGatewayResponse,
  MagicAgentSdkGatewayStreamResponse
} from './magicAgentSdkGateway'
import { MagicAgentSdkGateway } from './magicAgentSdkGateway'
import type { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

export type MagicAgentSdkDispatcher = {
  preflightAuth?(
    authorization: string | undefined
  ): MagicAgentSdkGatewayResponse | undefined | Promise<MagicAgentSdkGatewayResponse | undefined>
  dispatch(request: {
    method: string
    payload: unknown
    authorization?: string
  }): Promise<MagicAgentSdkGatewayResponse>
  dispatchStream?(request: {
    method: string
    payload: unknown
    authorization?: string
  }): MagicAgentSdkGatewayStreamResponse | Promise<MagicAgentSdkGatewayStreamResponse>
}

export type MagicAgentSdkHttpServerOptions = {
  token: string
  port?: number
  host?: '127.0.0.1' | '::1'
  authenticatedActor?: { kind: string; id: string }
  service?: MagicAgentPlatformSvcImpl
  gateway?: MagicAgentSdkDispatcher
  bodyTimeoutMs?: number
}

const MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_BODY_TIMEOUT_MS = 15_000
const HEADERS_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
const KEEP_ALIVE_TIMEOUT_MS = 5_000

export type MagicAgentSdkHttpServer = {
  baseUrl: string
  close(): Promise<void>
}

class RequestBodyTimeoutError extends Error {}

const readJsonBody = (request: IncomingMessage, timeoutMs: number): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = (): void => {
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAborted)
      request.off('error', onError)
    }
    const fail = (error: Error): void => {
      cleanup()
      request.pause()
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('SDK request body exceeds 1 MiB.'))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      cleanup()
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    }
    const onAborted = (): void => fail(new Error('SDK request body was aborted.'))
    const onError = (error: Error): void => fail(error)
    const timer = setTimeout(
      () => fail(new RequestBodyTimeoutError('SDK request body timed out.')),
      timeoutMs
    )
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAborted)
    request.once('error', onError)
  })

const replyJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

export const startMagicAgentSdkHttpServer = async (
  options: MagicAgentSdkHttpServerOptions
): Promise<MagicAgentSdkHttpServer> => {
  if (!options.gateway && !options.service)
    throw new Error('MagicAgent SDK HTTP server requires an explicit gateway or service.')
  const gateway =
    options.gateway ??
    (new MagicAgentSdkGateway(
      options.service as MagicAgentPlatformSvcImpl,
      options.token,
      options.authenticatedActor
    ) as unknown as MagicAgentSdkDispatcher)
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        replyJson(response, 405, { code: 'method_not_allowed', message: 'POST is required.' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const prefix = '/v2/sdk/'
      if (!url.pathname.startsWith(prefix)) {
        replyJson(response, 404, { code: 'not_found', message: url.pathname })
        return
      }
      const method = decodeURIComponent(url.pathname.slice(prefix.length))
      const authFailure = await gateway.preflightAuth?.(request.headers.authorization)
      if (authFailure) {
        request.resume()
        replyJson(response, authFailure.status, authFailure.body)
        return
      }
      const payload = await readJsonBody(request, options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS)
      const controller = new AbortController()
      if (method === 'graphRun.attach' && gateway.dispatchStream) {
        const result = await gateway.dispatchStream({
          method,
          payload,
          authorization: request.headers.authorization
        })
        if ('body' in result) {
          replyJson(response, result.status, result.body)
          return
        }
        request.once('aborted', () => controller.abort())
        response.once('close', () => controller.abort())
        response.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store'
        })
        response.flushHeaders()
        try {
          await result.stream((event) => {
            if (!response.destroyed)
              response.write(`${JSON.stringify(event)}
`)
          }, controller.signal)
        } finally {
          if (!response.destroyed) response.end()
        }
        return
      }
      const result = await gateway.dispatch({
        method,
        payload,
        authorization: request.headers.authorization
      })
      replyJson(response, result.status, result.body)
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      replyJson(response, error instanceof RequestBodyTimeoutError ? 408 : 400, {
        code: 'invalid_request',
        message: pathname.endsWith('/channel.ack')
          ? 'Runtime Channel acknowledgement failed.'
          : error instanceof Error
            ? error.message
            : String(error)
      })
    }
  })
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('SDK HTTP server did not expose a TCP address.')
  }
  const urlHost = host === '::1' ? '[::1]' : host
  return {
    baseUrl: `http://${urlHost}:${address.port}`,
    close: () => closeServer(server)
  }
}
