import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMCli } from '@shared/llm/types'
import { createAgentThreadMemoryFiles } from './agentThreadMemoryFiles'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-files-project', threadId: 'pane' } as const
const context = { route, runId: 'outer-memory-run', toolCallId: 'outer-memory-call' }
const schema = (name: string) => ({ name, description: 'Dedicated memory namespace only.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } })
let parent: AbortController
beforeEach(() => { parent = new AbortController() })
afterEach(() => { parent.abort(); vi.restoreAllMocks() })
function fixture(cli: LLMCli, writable = true) {
  const call = vi.fn(async () => ({ content: '{"path":"./memory/facts.md","content":"MEMORY_FILE_FACT_原始🌱","sha256":"abc","exists":true}' }))
  const close = vi.fn(), open = vi.fn(async () => ({ listTools: () => [schema('memory.files.tree'), schema('memory.files.read'), schema('memory.files.grep'), ...(writable ? [schema('memory.files.write')] : [])], callTool: call, close }))
  const createClient = vi.fn(async () => cli), assertInvocation = vi.fn()
  const provider = createAgentThreadMemoryFiles({ route, signal: parent.signal, assertInvocation, createClient, openSession: open })
  return { provider, open, call, close, createClient, assertInvocation }
}
describe('separately authorized stateless memory-file helper transport and narrow MAIN dispatcher', () => {
  it('lists exactly separate names without a client/session/file or parent snapshot', () => {
    const f = fixture({ chat: vi.fn() })
    expect(f.provider.listTools().map(tool => tool.name)).toEqual(['memory_read', 'memory_write'])
    for (const tool of f.provider.listTools()) expect(tool.inputSchema).toMatchObject({ additionalProperties: false, required: ['task'] })
    expect(f.createClient).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
    f.provider.dispose()
  })
  it('fails closed when a formerly read-only capable client has not independently opted into MAIN-tool-only transport', async () => {
    const chat = vi.fn(), f = fixture({ chat, supportsIsolatedReadOnlyTurns: true })
    await expect(f.provider.callTool('memory_write', { task: 'Remember a preference.' }, context)).rejects.toThrow('isolated MAIN-tool')
    expect(chat).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled(); f.provider.dispose()
  })
  it.each([false, true])('returns a completed file-backed report through native=%s with only read/tree/grep, no media or inherited context', async native => {
    let turns = 0
    const chat = vi.fn<LLMCli['chat']>(async input => {
      turns++
      expect(input).toMatchObject({ disableProviderTools: true, retryCapacity: false, imageGenerationOptions: { enabled: false }, maxOutputTokens: 2048 })
      expect(input.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: expect.stringContaining('Read facts for this task only.') })]))
      expect(JSON.stringify(input)).not.toContain('PARENT_SECRET_OR_NOTE')
      if (turns === 1) {
        if (!native) { expect(input.systemPrompt).toContain('memory.files.read'); expect(input.systemPrompt).not.toContain('memory.files.write'); return { content: JSON.stringify({ toolName: 'memory.files.read', args: { path: './memory/facts.md' } }) } }
        expect(input.tools?.map(tool => tool.name)).toEqual(['memory.files.tree', 'memory.files.read', 'memory.files.grep'])
        return { content: '', toolCalls: [{ id: 'observed-memory', name: 'memory.files.read', wireName: 'mp_tool_1', arguments: '{"path":"./memory/facts.md"}' }] }
      }
      expect(JSON.stringify(native ? input.toolTurns : input.messages)).toContain('MEMORY_FILE_FACT_原始🌱')
      return { content: 'Observed ./memory/facts.md, not chat notes.' }
    })
    const f = fixture({ chat, supportsNativeTools: native, supportsIsolatedMainToolTurns: true })
    const result = await f.provider.callTool('memory_read', { task: 'Read facts for this task only.' }, context)
    expect(JSON.parse(result.content)).toMatchObject({ kind: 'memory_read', status: 'completed', modelSteps: 2, toolCalls: 1, content: 'Observed ./memory/facts.md, not chat notes.' })
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ writable: false, parentRunId: context.runId, parentToolCallId: context.toolCallId }))
    expect(f.call).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce(); f.provider.dispose()
  })
  it('writer receives tree/read/write but not grep or general files/shell/delegation', async () => {
    const chat = vi.fn<LLMCli['chat']>(async input => {
      expect(input.tools?.map(tool => tool.name)).toEqual(['memory.files.tree', 'memory.files.read', 'memory.files.write'])
      expect(input.systemPrompt).toContain('read before'); return { content: 'No changes needed.' }
    })
    const f = fixture({ chat, supportsNativeTools: true, supportsIsolatedMainToolTurns: true })
    await f.provider.callTool('memory_write', { task: 'Update only after reading.' }, context)
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ writable: true }))
    expect(f.call).not.toHaveBeenCalled(); f.provider.dispose()
  })
  it.each(['files.write', 'shell.execute', 'memory.files.write', 'fork'])('read helper rejects unavailable requested %s before any dispatch', async toolName => {
    const f = fixture({ chat: vi.fn<LLMCli['chat']>(async () => ({ content: JSON.stringify({ toolName, args: { path: './memory/facts.md', content: 'injected' } }) })), supportsIsolatedMainToolTurns: true })
    await expect(f.provider.callTool('memory_read', { task: 'Read only.' }, context)).rejects.toThrow(/unavailable|invalid|not allowed/)
    expect(f.call).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce(); f.provider.dispose()
  })
  it('captures task before the first await and rejects caller-selected root/owner/background flags', async () => {
    const chat = vi.fn<LLMCli['chat']>(async input => { expect(JSON.stringify(input.messages)).toContain('ORIGINAL_TASK'); expect(JSON.stringify(input.messages)).not.toContain('CHANGED_TASK'); return { content: 'done' } })
    const f = fixture({ chat, supportsIsolatedMainToolTurns: true }), args = { task: 'ORIGINAL_TASK' }, pending = f.provider.callTool('memory_read', args, context)
    args.task = 'CHANGED_TASK'; await pending
    for (const extra of [{ root: 'D:/private' }, { conversationId: 'other' }, { run_in_background: true }]) await expect(f.provider.callTool('memory_write', { task: 'read', ...extra }, context)).rejects.toThrow('Invalid memory helper')
    f.provider.dispose()
  })
  it('rejects different structural route tuples with the same flattened key before opening any client or session', async () => {
    const chat = vi.fn<LLMCli['chat']>(async () => ({ content: 'must not run' }))
    const f = fixture({ chat, supportsIsolatedMainToolTurns: true })
    const collision = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-files-project:thread:pane' } as const
    await expect(f.provider.callTool('memory_read', { task: 'Read.' }, { ...context, route: collision })).rejects.toThrow(/outside.*thread/)
    expect(f.createClient).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled(); f.provider.dispose()
  })
  it('sender metadata does not change the route conversation identity', async () => {
    const chat = vi.fn<LLMCli['chat']>(async () => ({ content: 'No read required.' }))
    const f = fixture({ chat, supportsIsolatedMainToolTurns: true })
    await f.provider.callTool('memory_read', { task: 'Report no read needed.' }, { ...context, route: { ...route, senderId: 'participant-metadata', senderName: 'Different participant' } })
    expect(chat).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledOnce(); f.provider.dispose()
  })
  it('parent Stop while model is pending rejects late output and closes its session', async () => {
    let finish!: (text: Awaited<ReturnType<LLMCli['chat']>>) => void
    const f = fixture({ chat: vi.fn<LLMCli['chat']>(() => new Promise(resolve => { finish = resolve })), supportsIsolatedMainToolTurns: true })
    const pending = f.provider.callTool('memory_read', { task: 'Read.' }, context)
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce()); parent.abort(new Error('Parent stopped'))
    await expect(pending).rejects.toThrow('Parent stopped'); finish({ content: 'late completion' })
    expect(f.call).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce(); f.provider.dispose()
  })
})
