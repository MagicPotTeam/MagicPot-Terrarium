import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startMagicAgentSdkHttpServer,
  type MagicAgentSdkHttpServer
} from './magicAgentSdkHttpServer'

let server: MagicAgentSdkHttpServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('MagicAgent SDK loopback HTTP server', () => {
  it('dispatches authenticated semantic memory ingest/search/inspect/admin and rejects actor injection', async () => {
    const service = {
      ingestSessionMemory: vi.fn(async () => ({ discovered: 1, upserted: 1 })),
      searchMemory: vi.fn(async () => ({
        hits: [{ memory: { id: 'm1' } }],
        requestedMode: 'lexical',
        effectiveMode: 'lexical',
        degraded: false
      })),
      inspectMemory: vi.fn(async () => ({ memory: { id: 'm1' } })),
      setMemoryDisabled: vi.fn(async () => ({ affected: 1 }))
    }
    server = await startMagicAgentSdkHttpServer({
      token: 'secret',
      service: service as never,
      authenticatedActor: { kind: 'user', id: 'owner' }
    })
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'owner' }
    const calls = [
      ['memory.ingestSession', { sourceRoute: route }],
      ['memory.search', { query: 'alpha', scopes: [{ kind: 'session', route }], mode: 'lexical' }],
      ['memory.inspect', { id: 'm1', sourceRoute: route }],
      ['memory.setDisabled', { id: 'm1', sourceRoute: route, disabled: true }]
    ] as const
    for (const [method, payload] of calls) {
      const response = await fetch(`${server.baseUrl}/v2/sdk/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      })
      expect(response.status).toBe(200)
    }
    for (const fn of Object.values(service))
      expect(fn).toHaveBeenCalledWith(
        expect.not.objectContaining({ actor: expect.anything() }),
        expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
      )
    const injected = await fetch(`${server.baseUrl}/v2/sdk/memory.search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...calls[1][1], actor: { kind: 'user', id: 'attacker' } })
    })
    expect(injected.status).toBe(400)
  })

  it('dispatches authenticated export/diff without accepting payload actors', async () => {
    const exportSession = vi.fn(async () => ({
      format: 'markdown',
      mimeType: 'text/markdown; charset=utf-8',
      filename: 'session.md',
      body: '# safe\n[REDACTED]',
      availability: {}
    }))
    const diffSessions = vi.fn(async () => ({
      schemaVersion: 1,
      leftSessionKey: 'generic:dm:left',
      rightSessionKey: 'generic:dm:right',
      relationship: { relationship: 'unrelated' },
      dimensions: {},
      timeline: [],
      sideBySide: []
    }))
    server = await startMagicAgentSdkHttpServer({
      token: 'secret',
      service: { exportSession, diffSessions } as never,
      authenticatedActor: { kind: 'user', id: 'owner' }
    })
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const sourceRoute = { channel: 'generic', scopeType: 'dm', scopeId: 'left' }
    for (const format of ['markdown', 'html', 'jsonl']) {
      const response = await fetch(`${server.baseUrl}/v2/sdk/session.export`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sourceRoute, format })
      })
      expect(response.status).toBe(200)
      expect(JSON.stringify(await response.json())).not.toContain('supersecret')
    }
    const diff = await fetch(`${server.baseUrl}/v2/sdk/session.diff`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        leftRoute: sourceRoute,
        rightRoute: { ...sourceRoute, scopeId: 'right' }
      })
    })
    expect(diff.status).toBe(200)
    expect(exportSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ actor: expect.anything() }),
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
    expect(diffSessions).toHaveBeenCalledWith(
      expect.not.objectContaining({ actor: expect.anything() }),
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
    const injected = await fetch(`${server.baseUrl}/v2/sdk/session.export`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sourceRoute,
        format: 'markdown',
        actor: { kind: 'user', id: 'attacker' }
      })
    })
    expect(injected.status).toBe(400)
  })

  it('dispatches authenticated session.fork and derives the user actor from the server', async () => {
    const forkSessionAtEvent = vi.fn(async () => ({
      targetSessionKey: 'generic:dm:target',
      lineage: {
        sourceSessionKey: 'generic:dm:source',
        sourceEventId: 'event-2',
        sourceRunId: 'run-1',
        forkedAt: 123
      },
      warning: 'External side effects are not rolled back.',
      counts: { messages: 2, runs: 1, events: 3, artifacts: 1 }
    }))
    server = await startMagicAgentSdkHttpServer({
      token: 'secret',
      service: { forkSessionAtEvent } as never,
      authenticatedActor: { kind: 'user', id: 'owner' }
    })
    const payload = {
      sourceRoute: { channel: 'generic', scopeType: 'dm', scopeId: 'source' },
      sourceEventId: 'event-2',
      targetRoute: { channel: 'generic', scopeType: 'dm', scopeId: 'target' },
      idempotencyKey: 'fork-http'
    }
    const response = await fetch(`${server.baseUrl}/v2/sdk/session.fork`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      targetSessionKey: 'generic:dm:target',
      counts: { events: 3 }
    })
    expect(forkSessionAtEvent).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
  })

  it('streams authenticated graph-run attach events as NDJSON with cursor payload', async () => {
    const attachGraphRun = vi.fn(async (_request, stream) => {
      stream.onData({
        eventId: 'e1',
        runId: 'run',
        sequence: 1,
        kind: 'run.started',
        timestamp: 1,
        payload: {}
      })
      stream.onData({
        eventId: 'e2',
        runId: 'run',
        sequence: 2,
        kind: 'run.completed',
        timestamp: 2,
        payload: {}
      })
      stream.abortReceiver.abortHandler(() => undefined)
    })
    server = await startMagicAgentSdkHttpServer({
      token: 'secret',
      service: { runAgent: vi.fn(), attachGraphRun } as never,
      authenticatedActor: { kind: 'user', id: 'owner' }
    })
    const response = await fetch(`${server.baseUrl}/v2/sdk/graphRun.attach`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run',
        route: { channel: 'sdk', scopeType: 'run', scopeId: 'run' },
        afterEventId: 'e0'
      })
    })
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    expect(
      (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .map((item) => item.eventId)
    ).toEqual(['e1', 'e2'])
    expect(attachGraphRun).toHaveBeenCalledWith(
      {
        runId: 'run',
        route: { channel: 'sdk', scopeType: 'run', scopeId: 'run' },
        afterEventId: 'e0'
      },
      expect.objectContaining({ onData: expect.any(Function) }),
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
  })

  it('binds to loopback and dispatches authenticated agent.run requests', async () => {
    const runAgent = vi.fn(async () => ({ run: { runId: 'run-http', status: 'completed' } }))
    server = await startMagicAgentSdkHttpServer({
      token: 'secret',
      gateway: {
        dispatch: async (request) => {
          if (request.authorization !== 'Bearer secret')
            return { status: 401, body: { code: 'unauthorized' } }
          await runAgent()
          return { status: 200, body: { run: { runId: 'run-http', status: 'completed' } } }
        }
      }
    })
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
    const response = await fetch(`${server.baseUrl}/v2/sdk/agent.run`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-1', input: { prompt: 'hello' } })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ run: { runId: 'run-http' } })
    expect(runAgent).toHaveBeenCalledOnce()
  })

  it('redacts acknowledgement token from HTTP error bodies', async () => {
    const token = 'claim-token-must-not-leak'
    const gateway = {
      dispatch: vi.fn(async () => ({
        status: 400,
        body: { code: 'invalid_request', message: 'Runtime Channel acknowledgement failed.' }
      }))
    }
    server = await startMagicAgentSdkHttpServer({ token: 'secret', gateway: gateway as never })
    const response = await fetch(`${server.baseUrl}/v2/sdk/channel.ack`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'message', token })
    })
    const body = await response.text()
    expect(response.status).toBe(400)
    expect(body).not.toContain(token)
  })

  it('rejects unauthenticated requests and non-POST methods', async () => {
    const runAgent = vi.fn()
    server = await startMagicAgentSdkHttpServer({
      token: 'secret',
      gateway: {
        dispatch: async (request) => {
          if (request.authorization !== 'Bearer secret')
            return { status: 401, body: { code: 'unauthorized' } }
          await runAgent()
          return { status: 200, body: {} }
        }
      }
    })
    const unauthorized = await fetch(`${server.baseUrl}/v2/sdk/agent.run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(unauthorized.status).toBe(401)
    const wrongMethod = await fetch(`${server.baseUrl}/v2/sdk/agent.run`)
    expect(wrongMethod.status).toBe(405)
    expect(runAgent).not.toHaveBeenCalled()
  })
})
