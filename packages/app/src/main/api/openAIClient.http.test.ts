import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from '../../shared/llm/clients'

// Exclusively owned ephemeral Node HTTP listener. No TLS, external account, Electron net or SSRF acceptance.
const messages = [{ role: 'user' as const, content: 'Owned request.' }]
const event = (value: unknown) =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const within = async (promise: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned HTTP event did not arrive')), 2_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
const serve = async (
  handle: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void
) => {
  const sockets = new Set<Socket>()
  const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('invalid owned JSON')
        return
      }
      requests.push({ url: req.url, body })
      res.setHeader('Connection', 'close')
      handle(req, res, body)
    })
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
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned listener has no TCP port')
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      for (const socket of sockets) socket.destroy()
      await closed
    }
  }
}
afterEach(() => vi.restoreAllMocks())

describe('standard OpenAI actual owned HTTP transport', () => {
  it.each(['responses', 'chat-completions'] as const)(
    'delivers %s text before the server is allowed to send completion',
    async (mode) => {
      const delta = gate(),
        closed = gate()
      let finish!: () => void
      const server = await serve((_req, res) => {
        res.once('close', closed.resolve)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        finish = () =>
          res.end(
            mode === 'responses'
              ? event({
                  type: 'response.completed',
                  response: {
                    status: 'completed',
                    output: [
                      {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'owned incremental' }]
                      }
                    ],
                    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
                  }
                })
              : event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
                  event({
                    choices: [],
                    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
                  }) +
                  event('[DONE]')
          )
        res.write(
          event(
            mode === 'responses'
              ? { type: 'response.output_text.delta', delta: 'owned incremental' }
              : {
                  choices: [
                    { index: 0, delta: { content: 'owned incremental' }, finish_reason: null }
                  ]
                }
          )
        )
      })
      const caller = new AbortController()
      let outcome: Promise<unknown> | undefined
      try {
        const client = new OpenAIAPICli(
          '',
          mode === 'responses' ? server.base : `${server.base}/chat/completions`,
          'owned',
          {
            apiMode: mode,
            enableHostedTools: false,
            fetchImpl: globalThis.fetch.bind(globalThis)
          }
        )
        let settled = false
        const onDelta = vi.fn(() => delta.resolve())
        outcome = client.chat({ messages, signal: caller.signal, onDelta }).then(
          (value) => {
            settled = true
            return value
          },
          (error) => {
            settled = true
            return error
          }
        )
        await within(delta.promise)
        expect(settled).toBe(false)
        expect(onDelta).toHaveBeenCalledWith({
          type: 'text-delta',
          delta: 'owned incremental',
          metadata: { streaming: { upstreamProtocol: 'sse', upstreamIncremental: true } }
        })
        expect(server.requests).toHaveLength(1)
        expect(server.requests[0].body.stream).toBe(true)
        finish()
        expect(await outcome).toMatchObject({
          content: 'owned incremental',
          finishReason: 'stop',
          usage: { totalTokens: 6 }
        })
        expect(onDelta).toHaveBeenCalledTimes(1)
        await within(closed.promise)
      } finally {
        caller.abort()
        await server.close()
        await outcome
      }
    }
  )

  it.each([502, 504])('retains real upstream %i status and body', async (status) => {
    const server = await serve((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(`owned-${status}`)
    })
    try {
      const client = new OpenAIAPICli('', server.base, 'owned', {
        apiMode: 'responses',
        enableHostedTools: false
      })
      await expect(client.chat({ messages })).rejects.toMatchObject({
        name: 'UpstreamHttpError',
        statusCode: status,
        body: `owned-${status}`
      })
      expect(server.requests).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it.each([502, 504])(
    'keeps received HTTP %i while its unfinished error body times out and closes',
    async (status) => {
      const closed = gate()
      let premature = false
      const server = await serve((_req, res) => {
        res.once('close', () => {
          premature = !res.writableFinished
          closed.resolve()
        })
        res.writeHead(status, { 'content-type': 'text/plain' })
        res.write('owned-error-prefix')
      })
      try {
        const client = new OpenAIAPICli('', server.base, 'owned', {
          apiMode: 'responses',
          enableHostedTools: false,
          requestTimeoutMs: 1_000
        })
        await expect(client.chat({ messages })).rejects.toMatchObject({
          name: 'UpstreamHttpError',
          statusCode: status,
          body: 'owned-error-prefix',
          cause: { name: 'TimeoutError' }
        })
        await within(closed.promise)
        expect(premature).toBe(true)
        expect(server.requests).toHaveLength(1)
      } finally {
        await server.close()
      }
    }
  )

  it('uses its real finite internal deadline to close a stalled JSON response', async () => {
    const closed = gate()
    let premature = false
    const server = await serve((_req, res) => {
      res.once('close', () => {
        premature = !res.writableFinished
        closed.resolve()
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"output":')
    })
    try {
      const client = new OpenAIAPICli('', server.base, 'owned', {
        apiMode: 'responses',
        enableHostedTools: false,
        requestTimeoutMs: 1_000
      })
      const before = performance.now()
      await expect(client.chat({ messages })).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(performance.now() - before).toBeGreaterThanOrEqual(900)
      expect(performance.now() - before).toBeLessThan(3_000)
      await within(closed.promise)
      expect(premature).toBe(true)
      expect(server.requests).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('cancels a live SSE response with exact caller reason and closes the server connection', async () => {
    const delta = gate(),
      closed = gate()
    let premature = false
    const server = await serve((_req, res) => {
      res.once('close', () => {
        premature = !res.writableFinished
        closed.resolve()
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(event({ type: 'response.output_text.delta', delta: 'before cancellation' }))
    })
    const caller = new AbortController()
    const reason = new Error('owned-user-cancel')
    let outcome: Promise<unknown> | undefined
    try {
      const client = new OpenAIAPICli('', server.base, 'owned', {
        apiMode: 'responses',
        enableHostedTools: false
      })
      outcome = client
        .chat({ messages, signal: caller.signal, onDelta: () => delta.resolve() })
        .catch((error) => error)
      await within(delta.promise)
      caller.abort(reason)
      expect(await outcome).toBe(reason)
      await within(closed.promise)
      expect(premature).toBe(true)
    } finally {
      caller.abort()
      await server.close()
      await outcome
    }
  })
})
