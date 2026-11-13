import { describe, expect, it, vi } from 'vitest'
import { runAgentSideTurn } from './agentThreadSideRunner'
import { sideDocument } from './agentThreadSideTestUtils'
const tools = [{ name: 'files.read', description: 'read', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } }]
describe('bounded private side runner', () => {
  it.each([false, true])('retains completed read pairs and answers for follow-up without recapturing parent (native=%s)', async (native) => {
    const doc = sideDocument(), checkpoint = vi.fn(), read = vi.fn().mockResolvedValue({ content: 'FILE_EVIDENCE' })
    const chat = vi.fn().mockResolvedValueOnce(native ? { content: '', toolCalls: [{ id: 'r1', name: 'files.read', wireName: 'mp_tool_0', arguments: '{"path":"evidence.txt"}' }] } : '{"toolName":"files.read","args":{"path":"evidence.txt"}}').mockResolvedValueOnce('FIRST_ANSWER')
    const dependencies = { signal: new AbortController().signal, assertLive: () => undefined, checkpoint, createClient: async () => ({ chat, supportsNativeTools: native, supportsIsolatedReadOnlyTurns: true }), listTools: () => tools, read }
    await runAgentSideTurn(doc, dependencies)
    expect(doc).toMatchObject({ status: 'completed', modelSteps: 2, toolCalls: 1 })
    expect(doc.messages.map((m) => m.kind)).toEqual(['question', 'tool-call', 'tool-result', 'answer'])
    expect(chat.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 2048, disableProviderTools: true, retryCapacity: false })
    doc.generation++; doc.turns++; doc.status = 'running'; doc.messages.push({ role: 'user', kind: 'question', content: 'FOLLOW_UP' })
    chat.mockResolvedValueOnce('SECOND_ANSWER'); await runAgentSideTurn(doc, dependencies)
    const input = JSON.stringify(chat.mock.calls[2][0].messages)
    for (const expected of ['PRIVATE_SNAPSHOT', 'PRIVATE_QUESTION', 'FILE_EVIDENCE', 'FIRST_ANSWER', 'FOLLOW_UP']) expect(input).toContain(expected)
    expect(doc.messages.at(-1)?.content).toBe('SECOND_ANSWER')
    expect(doc.modelSteps).toBe(3)
  })
  it('charges before provider invocation and preserves no partial tool pair after cancellation', async () => {
    const doc = sideDocument(), abort = new AbortController(), checkpoint = vi.fn()
    const chat = vi.fn().mockImplementation(async () => { expect(doc.modelSteps).toBe(1); expect(checkpoint).toHaveBeenCalled(); return '{"toolName":"files.read","args":{"path":"a"}}' })
    let finish!: (value: { content: string }) => void
    const read = vi.fn(() => new Promise<{ content: string }>((resolve) => { finish = resolve }))
    let settled = false
    const pending = runAgentSideTurn(doc, { signal: abort.signal, assertLive: () => undefined, checkpoint, createClient: async () => ({ chat, supportsIsolatedReadOnlyTurns: true }), listTools: () => tools, read }).catch((e) => e).finally(() => { settled = true })
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce()); abort.abort()
    await Promise.resolve(); expect(settled).toBe(false)
    finish({ content: 'LATE_SECRET' }); expect(await pending).toBeInstanceOf(Error)
    expect(doc.toolCalls).toBe(1); expect(JSON.stringify(doc)).not.toContain('LATE_SECRET'); expect(doc.messages).toHaveLength(1)
  })
  it.each(['shell.execute', 'mcp_call', 'fork'])('never executes unauthorized %s or allows parent inventories to widen the tool list', async (name) => {
    const doc = sideDocument(), read = vi.fn()
    await expect(runAgentSideTurn(doc, { signal: new AbortController().signal, assertLive: () => undefined, checkpoint: () => undefined, createClient: async () => ({ chat: async () => ({ content: JSON.stringify({ toolName: name, args: {} }) }), supportsIsolatedReadOnlyTurns: true }), listTools: () => [...tools, { name, description: 'forbidden', inputSchema: { type: 'object' } }], read })).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
  it('returns bounded partial text on length and refuses clients without isolated output limits', async () => {
    const doc = sideDocument()
    const dependencies = { signal: new AbortController().signal, assertLive: () => undefined, checkpoint: () => undefined, listTools: () => tools, read: vi.fn() }
    await runAgentSideTurn(doc, { ...dependencies, createClient: async () => ({ supportsIsolatedReadOnlyTurns: true, chat: async () => ({ content: 'partial', finishReason: 'length' }) }) })
    expect(doc.status).toBe('incomplete'); expect(doc.messages.at(-1)?.content).toBe('partial')
    await expect(runAgentSideTurn(sideDocument(), { ...dependencies, createClient: async () => ({ chat: vi.fn() }) })).rejects.toThrow('isolate')
  })
  it('does not regain lifetime budget after a continued turn and bounds per-turn repeated reads', async () => {
    const doc = sideDocument(); doc.modelSteps = 64
    const chat = vi.fn().mockResolvedValue('{"toolName":"files.read","args":{"path":"a"}}'), read = vi.fn().mockResolvedValue({ content: 'small' })
    const dependencies = { signal: new AbortController().signal, assertLive: () => undefined, checkpoint: () => undefined, listTools: () => tools, read, createClient: async () => ({ chat, supportsIsolatedReadOnlyTurns: true }) }
    await runAgentSideTurn(doc, dependencies); expect(doc.status).toBe('budget_exhausted'); expect(chat).not.toHaveBeenCalled()
    const second = sideDocument(); await runAgentSideTurn(second, dependencies)
    expect(second.status).toBe('budget_exhausted'); expect(chat).toHaveBeenCalledTimes(8); expect(read).toHaveBeenCalledTimes(8)
    expect(chat.mock.calls.at(-1)![0].systemPrompt).toContain('1 model calls')
  })
})
