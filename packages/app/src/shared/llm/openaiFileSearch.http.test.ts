// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { ProviderFileIdCache } from '../providerFileIdCache'
import { createOpenAIFileSearchSession } from './openaiFileSearch'
import type { ChatMessage } from './types'

// Real Node HTTP transport to an exclusively owned ephemeral loopback server.
// This is not TLS, an external Provider, Electron net or public SSRF acceptance.
const messages: ChatMessage[] = [
  {
    role: 'user',
    content: 'Analyze owned content.',
    attachments: [
      {
        type: 'file',
        url: 'data:text/plain;base64,b3duZWQ=',
        fileName: 'owned.txt',
        mimeType: 'text/plain'
      }
    ]
  }
]
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const within = async (promise: Promise<void>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned HTTP event did not arrive')), 3_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
const serve = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const sockets = new Set<Socket>()
  const requests: Array<{ method: string | undefined; url: string | undefined }> = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url })
    // Disable keep-alive only on this owned fixture, not production network configuration.
    res.setHeader('Connection', 'close')
    req.resume()
    handler(req, res)
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
  if (!address || typeof address === 'string') throw new Error('Owned listener has no TCP address')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
const sessionOptions = (baseUrl: string, signal?: AbortSignal) => ({
  apiKey: '',
  baseUrl,
  messages,
  signal,
  fileIdCache: new ProviderFileIdCache(),
  fetchImpl: globalThis.fetch.bind(globalThis)
})

describe('file-search real owned HTTP transport (not Provider acceptance)', () => {
  it('sets up two real HTTP sessions with shared content and deletes only after final release', async () => {
    let uploaded = 0,
      stores = 0
    const attached = new Map<string, Set<string>>()
    const server = await serve((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'DELETE') {
        res.end(JSON.stringify({ deleted: true }))
        return
      }
      if (req.url === '/v1/files') {
        res.end(JSON.stringify({ id: `file-${++uploaded}` }))
        return
      }
      if (req.url === '/v1/vector_stores') {
        const id = `vs-${++stores}`
        attached.set(id, new Set())
        res.end(JSON.stringify({ id }))
        return
      }
      const store = /\/vector_stores\/([^/]+)\/files/.exec(req.url || '')?.[1]
      if (!store || !attached.has(store)) {
        res.writeHead(400)
        res.end('{}')
        return
      }
      if (req.method === 'POST') {
        attached.get(store)!.add('file-1')
        res.end(
          JSON.stringify({ id: 'file-1', object: 'vector_store.file', status: 'in_progress' })
        )
      } else {
        res.end(
          JSON.stringify({
            data: [...attached.get(store)!].map((id) => ({
              id,
              object: 'vector_store.file',
              status: 'completed'
            })),
            has_more: false
          })
        )
      }
    })
    const cache = new ProviderFileIdCache()
    const sessions: NonNullable<Awaited<ReturnType<typeof createOpenAIFileSearchSession>>>[] = []
    try {
      const opts = { ...sessionOptions(server.baseUrl), fileIdCache: cache }
      const repeated: ChatMessage[] = [
        {
          ...messages[0],
          attachments: [
            messages[0].attachments![0],
            { ...messages[0].attachments![0], fileName: 'renamed.txt' }
          ]
        }
      ]
      const owner = await createOpenAIFileSearchSession({ ...opts, messages: repeated })
      expect(owner).not.toBeNull()
      sessions.push(owner!)
      const borrower = await createOpenAIFileSearchSession(opts)
      expect(borrower).not.toBeNull()
      sessions.push(borrower!)
      expect(uploaded).toBe(1)
      expect(stores).toBe(2)
      expect(
        server.requests.filter(
          (r) => r.method === 'POST' && /\/vector_stores\/[^/]+\/files$/.test(r.url || '')
        )
      ).toHaveLength(2)
      await owner!.cleanup()
      expect(
        server.requests.some((r) => r.method === 'DELETE' && r.url === '/v1/files/file-1')
      ).toBe(false)
      await borrower!.cleanup()
      expect(
        server.requests.filter((r) => r.method === 'DELETE' && r.url === '/v1/files/file-1')
      ).toHaveLength(1)
      expect(cache.size).toBe(0)
    } finally {
      await Promise.all(sessions.map((session) => session.cleanup()))
      await server.close()
    }
  })

  it.each([502, 504])('propagates real upstream %i and the owned error body', async (status) => {
    const ended = gate()
    let finished = false
    const server = await serve((_req, res) => {
      res.on('close', () => {
        finished = res.writableFinished
        ended.resolve()
      })
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(`owned-upstream-${status}`)
    })
    try {
      await expect(createOpenAIFileSearchSession(sessionOptions(server.baseUrl))).rejects.toThrow(
        new RegExp(`${status} .*owned-upstream-${status}`)
      )
      await within(ended.promise)
      expect(finished).toBe(true)
      expect(server.requests).toEqual([{ method: 'POST', url: '/v1/files' }])
    } finally {
      await server.close()
    }
  })

  it('caller cancellation closes a real stalled response body and preserves its exact reason', async () => {
    const started = gate(),
      closed = gate()
    let prematurelyClosed = false
    const server = await serve((_req, res) => {
      res.once('close', () => {
        prematurelyClosed = !res.writableFinished
        closed.resolve()
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"id":')
      started.resolve()
    })
    try {
      const controller = new AbortController()
      const reason = new Error('owned-user-cancel')
      const outcome = createOpenAIFileSearchSession(
        sessionOptions(server.baseUrl, controller.signal)
      ).catch((error) => error)
      await within(started.promise)
      controller.abort(reason)
      expect(await outcome).toBe(reason)
      await within(closed.promise)
      expect(prematurelyClosed).toBe(true)
      expect(server.requests).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('the actual 30-second internal deadline closes a real stalled provider body', async () => {
    const closed = gate()
    let prematurelyClosed = false
    const server = await serve((_req, res) => {
      res.once('close', () => {
        prematurelyClosed = !res.writableFinished
        closed.resolve()
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"id":')
    })
    try {
      const start = performance.now()
      await expect(
        createOpenAIFileSearchSession(sessionOptions(server.baseUrl))
      ).rejects.toMatchObject({
        name: 'TimeoutError',
        message: 'OpenAI file search setup timed out.'
      })
      const elapsed = performance.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(29_000)
      expect(elapsed).toBeLessThan(36_000)
      await within(closed.promise)
      expect(prematurelyClosed).toBe(true)
      expect(server.requests).toEqual([{ method: 'POST', url: '/v1/files' }])
    } finally {
      await server.close()
    }
  }, 40_000)
})
