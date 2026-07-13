import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nextSessionId: 0,
  transports: [] as Array<{
    sessionId: string
    onclose?: () => void
    handlePostMessage: ReturnType<typeof vi.fn>
  }>,
  servers: [] as Array<{
    connect: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => ({
  SSEServerTransport: class {
    sessionId = `session-${++mocks.nextSessionId}`
    onclose?: () => void
    handlePostMessage = vi.fn(async () => undefined)

    constructor() {
      mocks.transports.push(this)
    }
  }
}))

vi.mock('../../assistantRuntime/runtime', () => ({
  getAssistantRuntime: () => ({ listTools: () => [] })
}))
vi.mock('../../config/config', () => ({
  getConfig: () => ({ mcp_config: { server: { path: '/api/mcp' } } })
}))
vi.mock('../serverBridge', () => ({
  createMagicPotMcpServer: () => {
    const server = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    }
    mocks.servers.push(server)
    return server
  }
}))
vi.mock('./runtime', () => ({
  appendMagicPotMcpAudit: vi.fn(),
  refreshMagicPotMcpPlatformRuntime: vi.fn(),
  getMagicPotMcpPlatformRuntime: vi.fn()
}))

import {
  closeMagicPotMcpLegacySseSessions,
  handleMagicPotMcpLegacySseMessageRequest,
  handleMagicPotMcpLegacySseOpenRequest,
  LEGACY_SSE_IDLE_TIMEOUT_MS,
  LEGACY_SSE_MAX_SESSIONS
} from './httpBridge'

const createRequest = (url = '/api/mcp/sse') => {
  const req = new EventEmitter() as EventEmitter & {
    url: string
    method: string
    complete: boolean
  }
  req.url = url
  req.method = 'GET'
  req.complete = false
  return req
}

const createResponse = () => {
  const res = new EventEmitter() as EventEmitter & {
    destroyed: boolean
    setHeader: ReturnType<typeof vi.fn>
    writeHead: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
  res.destroyed = false
  res.setHeader = vi.fn()
  res.writeHead = vi.fn(() => res)
  res.end = vi.fn(() => res)
  return res
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.nextSessionId = 0
  mocks.transports.length = 0
  mocks.servers.length = 0
})

afterEach(async () => {
  await closeMagicPotMcpLegacySseSessions()
  vi.useRealTimers()
})

describe('legacy SSE session lifecycle', () => {
  it('cleans up sessions on response close and request abort', async () => {
    const firstReq = createRequest()
    const firstRes = createResponse()
    await handleMagicPotMcpLegacySseOpenRequest({ req: firstReq as never, res: firstRes as never })
    firstRes.emit('close')
    await Promise.resolve()
    expect(mocks.servers[0].close).toHaveBeenCalledOnce()

    const secondReq = createRequest()
    const secondRes = createResponse()
    await handleMagicPotMcpLegacySseOpenRequest({
      req: secondReq as never,
      res: secondRes as never
    })
    secondReq.emit('aborted')
    await Promise.resolve()
    expect(mocks.servers[1].close).toHaveBeenCalledOnce()
  })

  it('expires an idle session and refreshes activity on messages', async () => {
    const req = createRequest()
    const res = createResponse()
    await handleMagicPotMcpLegacySseOpenRequest({ req: req as never, res: res as never })

    await vi.advanceTimersByTimeAsync(LEGACY_SSE_IDLE_TIMEOUT_MS - 1)
    expect(mocks.servers[0].close).not.toHaveBeenCalled()

    const messageReq = createRequest('/api/mcp/messages?sessionId=session-1')
    const messageRes = createResponse()
    await handleMagicPotMcpLegacySseMessageRequest({
      req: messageReq as never,
      res: messageRes as never,
      parsedBody: { jsonrpc: '2.0', method: 'ping' }
    })

    await vi.advanceTimersByTimeAsync(LEGACY_SSE_IDLE_TIMEOUT_MS - 1)
    expect(mocks.servers[0].close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.servers[0].close).toHaveBeenCalledOnce()
  })

  it('rejects new sessions when the bounded session capacity is reached', async () => {
    for (let index = 0; index < LEGACY_SSE_MAX_SESSIONS; index += 1) {
      await handleMagicPotMcpLegacySseOpenRequest({
        req: createRequest() as never,
        res: createResponse() as never
      })
    }

    const rejectedRes = createResponse()
    await handleMagicPotMcpLegacySseOpenRequest({
      req: createRequest() as never,
      res: rejectedRes as never
    })

    expect(rejectedRes.writeHead).toHaveBeenCalledWith(
      503,
      expect.objectContaining({ 'Retry-After': '1' })
    )
    expect(mocks.servers).toHaveLength(LEGACY_SSE_MAX_SESSIONS)
  })

  it('closes all sessions during module shutdown', async () => {
    await handleMagicPotMcpLegacySseOpenRequest({
      req: createRequest() as never,
      res: createResponse() as never
    })
    await handleMagicPotMcpLegacySseOpenRequest({
      req: createRequest() as never,
      res: createResponse() as never
    })

    await closeMagicPotMcpLegacySseSessions()

    expect(mocks.servers[0].close).toHaveBeenCalledOnce()
    expect(mocks.servers[1].close).toHaveBeenCalledOnce()
  })
})
