import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  MagicAgentSdkGatewayResponse,
  MagicAgentSdkGatewayStreamResponse
} from './magicAgentSdkGateway'
import { MagicAgentSdkGateway } from './magicAgentSdkGateway'
import type { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

export type MagicAgentSdkDispatcher = {
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
}

export type MagicAgentSdkHttpServer = {
  baseUrl: string
  close(): Promise<void>
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) throw new Error('SDK request body exceeds 1 MiB.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

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
      const payload = await readJsonBody(request)
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
      replyJson(response, 400, {
        code: 'invalid_request',
        message: pathname.endsWith('/channel.ack')
          ? 'Runtime Channel acknowledgement failed.'
          : error instanceof Error
            ? error.message
            : String(error)
      })
    }
  })
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
