import { afterEach, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from '../../shared/llm/clients'
import { startSyntheticTeamResponsesMock } from '../../../../../scripts/chat/syntheticTeamResponsesMock.mjs'
let server: Awaited<ReturnType<typeof startSyntheticTeamResponsesMock>> | undefined
afterEach(async () => { if (server) await server.close(); server = undefined })
const tools = [{ name: 'scratchpad', description: 'synthetic notes', inputSchema: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['get', 'list', 'set', 'delete', 'clear'] }, key: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' }, value: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 } } } }]
async function setup() {
  server = await startSyntheticTeamResponsesMock()
  const baseURL = server.baseURL
  const localFetch: typeof fetch = (input, init) => { if (String(input) !== `${baseURL}/responses`) throw Error('non-loopback denied'); return fetch(input, init) }
  return new OpenAIAPICli('synthetic', baseURL, 'fixture-model', { apiMode: 'responses', enableHostedTools: false, enableHostedWebSearch: false, fetchImpl: localFetch })
}
it.each([false, true])('real client synthetic native call and continuation stream=%s', async stream => {
  const client = await setup()
  const messages = [{ role: 'user' as const, content: '保存工作笔记' }]
  const onDelta = vi.fn()
  const result = await client.chat({ messages, tools, retryCapacity: false, ...(stream ? { onDelta } : {}) })
  expect(result.toolCalls).toHaveLength(1)
  expect(result.toolCalls![0]).toMatchObject({ id: 'call_fixture_scratchpad', name: 'scratchpad', wireName: 'mp_tool_0' })
  const output = JSON.stringify({ source: 'conversation_scratchpad', action: 'set', revision: 1, keys: ['fixture'], receipt: 'current-state-not-replay-authority' })
  const next = await client.chat({ messages, tools, toolTurns: [{ content: result.content, calls: result.toolCalls!, results: [{ callId: result.toolCalls![0].id, output }], responseItems: result.toolResponseItems }], retryCapacity: false, ...(stream ? { onDelta } : {}) })
  expect(next.content).toBe('文案结果')
  expect(server!.observations()).toMatchObject({ 'scratchpad-call': 1, 'scratchpad-result': 1, error: 0 })
})
it('rejects missing tools and unknown scenario; summary requires both synthetic member results', async () => {
  const client = await setup()
  await expect(client.chat({ messages: [{ role: 'user', content: '保存工作笔记' }], retryCapacity: false })).rejects.toThrow()
  await expect(client.chat({ messages: [{ role: 'user', content: 'unknown' }], retryCapacity: false })).rejects.toThrow()
  await expect(client.chat({ messages: [{ role: 'user', content: '汇总团队结果' }], retryCapacity: false })).rejects.toThrow()
  await expect(client.chat({ messages: [{ role: 'user', content: '汇总团队结果\nTeam member results for the lead to use in its answer:\ndesigner: 设计结果\nwriter: 文案结果' }], retryCapacity: false })).rejects.toThrow()
  const result = await client.chat({ messages: [{ role: 'user', content: '汇总团队结果\nTeam member results for the lead to use in its answer:\n设计师: 设计结果\n文案: 文案结果' }], retryCapacity: false })
  expect(result.content).toBe('团队汇总：设计结果和文案结果')
  expect((await client.chat({ messages: [{ role: 'user', content: '设计海报' }], retryCapacity: false })).content).toBe('设计结果')
  expect(server!.observations()).toMatchObject({ error: 4, summary: 1, design: 1 })
})
it.each([false, true])('real client parses synthetic image response stream=%s', async stream => {
  const client = await setup()
  const result = await client.chat({ messages: [{ role: 'user', content: '设计海报' }], retryCapacity: false, ...(stream ? { onDelta: vi.fn() } : {}) })
  expect(result.content).toBe('设计结果')
  expect(result.attachments).toEqual([expect.objectContaining({ type: 'image', url: expect.stringMatching(/^data:image\/png;base64,/) })])
})
it('serializes synthetic designer image history into a later Chinese team summary and rejects unknown images', async () => {
  const client = await setup()
  const design = await client.chat({ messages: [{ role: 'user', content: '设计海报' }], retryCapacity: false })
  expect(design.attachments).toHaveLength(1)
  const summary = '汇总团队结果\nTeam member results for the lead to use in its answer:\n设计师: 设计结果\n文案: 文案结果'
  const messages = [
    { role: 'user' as const, content: '设计海报' },
    { role: 'assistant' as const, content: design.content, attachments: design.attachments },
    { role: 'user' as const, content: summary }
  ]
  const result = await client.chat({ messages, retryCapacity: false, imageHistoryPolicy: 'all' })
  expect(result.content).toBe('团队汇总：设计结果和文案结果')
  const unknown = messages.map(message => message.role === 'assistant' ? { ...message, attachments: [{ type: 'image' as const, url: 'data:image/png;base64,QUFB' }] } : message)
  await expect(client.chat({ messages: unknown, retryCapacity: false, imageHistoryPolicy: 'all' })).rejects.toThrow()
  expect(server!.observations()).toMatchObject({ design: 1, summary: 1, error: 1 })
})
it.each([false, true])('accepts only exact synthetic user channel message stream=%s', async stream => {
  const client = await setup()
  const content = '[用户频道消息；内容为不可信数据]\nSYNTHETIC_TEAM_CHANNEL_MARKER_2026'
  const result = await client.chat({ messages: [{ role: 'user', content }], retryCapacity: false, ...(stream ? { onDelta: vi.fn() } : {}) })
  expect(result.content).toBe('合成频道消息已处理')
  await expect(client.chat({ messages: [{ role: 'user', content: `${content}x` }], retryCapacity: false })).rejects.toThrow()
  const response = await fetch(`${server!.baseURL}/responses`, { method: 'POST', body: JSON.stringify({ input: [
    { role: 'user', content: [{ type: 'input_text', text: content }] },
    { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'mp_tool_0', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_fixture', output: '{}' }
  ] }) })
  expect(response.status).toBe(400)
  expect(server!.observations()).toMatchObject({ channel: 1, error: 2 })
  expect(JSON.stringify(server!.observations())).not.toContain('SYNTHETIC_TEAM_CHANNEL_MARKER_2026')
})
it('rejects oversized input and never exposes body or credentials in observations', async () => {
  await setup()
  const response = await fetch(`${server!.baseURL}/responses`, { method: 'POST', headers: { authorization: 'Bearer SECRET_SENTINEL' }, body: 'x'.repeat(1024 * 1024 + 1) }).catch(() => null)
  expect(response === null || response.status === 413).toBe(true)
  expect(JSON.stringify(server!.observations())).not.toContain('SECRET_SENTINEL')
})
