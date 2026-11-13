import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ listTools: vi.fn() }))
vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => { throw Error('Unexpected data path') } }))
vi.mock('./teamEndStore', () => ({ assertTeamRequestActive: vi.fn(), getTeamEndStore: () => { throw Error('Unexpected End store') } }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
const servers: Server[] = []
const originalFetch = globalThis.fetch
function restrictFetch(port: number): void {
  vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(port) || url.username || url.password) throw Error(`Blocked non-fixture fetch: ${url.origin}`)
    return originalFetch(input, { ...init, redirect: 'error' })
  }) as typeof fetch)
}
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllGlobals(); vi.restoreAllMocks() })
beforeEach(() => { h.listTools.mockReturnValue([{ name: 'web_search', description: 'fixture', inputSchema: { type: 'object', properties: {} } }]) })

describe('team relay hop provider retry, real client with loopback only', () => {
  it.each(['chat', 'chatStream'] as const)('%s sends each hop just once on retryable and unsupported responses', async method => {
    for (const status of [503, 400]) {
      let count = 0, body = ''
      const server = createServer((req, res) => { count++; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk }); req.on('end', () => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: status === 400 ? 'tools not supported' : 'server overloaded' } })) }) })
      servers.push(server)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address(); if (!address || typeof address === 'string') throw Error('No loopback port')
      restrictFetch(address.port)
      const config = structuredClone(DEFAULT_CONFIG)
      config.llm_config.api_profiles = [{ id: 'fixture', provider: 'openai', deployment: 'local', call_type: 'api', model_use: 'agent', api_mode: 'chat-completions', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'fixture', model_name: 'fixture' }]
      vi.mocked(getConfig).mockReturnValue(config)
      const req = { messages: [{ role: 'user' as const, content: 'fixture' }], profileId: 'fixture', teamMember: { scope: 'scope', thread: 'pane', lead: 'lead', member: 'member' }, teamMessageHop: 1 as const, skillRuntime: { bindings: [{ appId: 'fixture', toolNames: ['web_search'] }] } }
      const service = new LLMProxySvcImpl(), onData = vi.fn()
      if (method === 'chat') await expect(service.chat(req)).rejects.toThrow()
      else { await service.chatStream(req, { onData }); expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'done', done: true, finishReason: 'error', error: expect.any(String), status })) }
      expect(count).toBe(1)
      expect(JSON.parse(body).tools).toEqual(expect.any(Array))
    }
  }, 20_000)
  it.each(['chat', 'chatStream'] as const)('%s direct member still falls back after unsupported native tools', async method => {
    let count = 0
    const server = createServer((req, res) => {
      count++; req.resume(); req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        if (count === 1) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'tools not supported' } })) }
        else res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture done' }, finish_reason: 'stop' }] }))
      })
    })
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No loopback port')
    restrictFetch(address.port)
    const config = structuredClone(DEFAULT_CONFIG)
    config.llm_config.api_profiles = [{ id: 'fixture', provider: 'openai', deployment: 'local', call_type: 'api', model_use: 'agent', api_mode: 'chat-completions', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'fixture', model_name: 'fixture' }]
    vi.mocked(getConfig).mockReturnValue(config)
    const req = { messages: [{ role: 'user' as const, content: 'fixture' }], profileId: 'fixture', teamMember: { scope: 'scope', thread: 'pane', lead: 'lead', member: 'member' }, skillRuntime: { bindings: [{ appId: 'fixture', toolNames: ['web_search'] }] } }
    const service = new LLMProxySvcImpl(), onData = vi.fn()
    if (method === 'chat') expect((await service.chat(req)).content).toBe('fixture done')
    else { await service.chatStream(req, { onData }); expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'fixture done' })) }
    expect(count).toBe(2)
  }, 20_000)
})
