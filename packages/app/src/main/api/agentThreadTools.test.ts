import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { createAgentThreadToolProvider } from './agentThreadTools'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const context = () => ({ route, runId: 'run', toolCallId: 'call' })
const files = { name: 'files.read', description: 'Read text', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
const create = (messages: ChatMessage[] = []) => {
  const assertInvocation = vi.fn()
  const request = vi.fn(async () => ({ status: 'answered' as const, text: 'Blue' }))
  const provider = createAgentThreadToolProvider({ route, messages, assertInvocation, listVisibleTools: () => [files], interactions: { request, dispose: vi.fn(), assertLive: vi.fn(), signal: new AbortController().signal } })
  return { provider, assertInvocation, request }
}
describe('Agent thread helper tools', () => {
  it('lists only visible tools and cannot inspect an unbound tool', async () => {
    const { provider } = create()
    expect(JSON.parse((await provider.callTool('info', {}, context())).content)).toEqual({ tools: [{ name: 'files.read', description: 'Read text' }], grantsPermission: false })
    expect(JSON.parse((await provider.callTool('info', { name: 'files.read' }, context())).content)).toEqual({ ...files, grantsPermission: false })
    await expect(provider.callTool('info', { name: 'terminal.run' }, context())).rejects.toThrow('not available')
  })
  it.each(['search_memory', 'scratchpad'])('never exposes or executes removed %s', async name => {
    const { provider, request } = create([{ role: 'user', content: 'PRIVATE_ARCHIVE_TEXT' }])
    expect(provider.listTools().map(tool => tool.name)).not.toContain(name)
    await expect(provider.callTool(name, { query: 'PRIVATE_ARCHIVE_TEXT', action: 'list' }, context())).rejects.toThrow('outside')
    expect(request).not.toHaveBeenCalled()
  })
  it('never offers interactive tools without a live desktop response channel', () => {
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [] })
    expect(provider.listTools().map((tool) => tool.name)).toEqual(['info'])
  })
  it('waits for free text and returns it as tool data rather than permission', async () => {
    const { provider, request } = create()
    const controller = new AbortController()
    const result = await provider.callTool('ask_user', { question: 'Colour?', multiline: true }, { ...context(), signal: controller.signal })
    expect(request).toHaveBeenCalledWith({ kind: 'ask_user', question: 'Colour?', multiline: true }, 300, controller.signal)
    expect(JSON.parse(result.content)).toEqual({ status: 'answered', text: 'Blue' })
    expect(result).not.toHaveProperty('approval')
  })
  it('forwards only a plain card and the chosen action', async () => {
    const { provider, request } = create()
    request.mockResolvedValueOnce({ status: 'dismissed' } as never)
    const result = await provider.callTool('show_card', { title: 'Pick', body: '<script>data only</script>', actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], timeout_seconds: 10 }, context())
    expect(JSON.parse(result.content)).toEqual({ status: 'dismissed' })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'show_card', title: 'Pick' }), 10, undefined)
  })
  it('show_app forwards a detached declarative document and labels feedback as non-authorizing', async () => {
    const { provider, request } = create()
    request.mockResolvedValue({ status: 'answered', values: { note: 'user feedback' } } as never)
    const document = { title: 'Report', blocks: [{ kind: 'text', text: 'content' }], fields: [{ kind: 'text', id: 'note', label: 'Note' }] }
    const result = JSON.parse((await provider.callTool('show_app', { document }, context())).content)
    document.blocks[0].text = 'changed'
    expect(request).toHaveBeenCalledWith({ kind: 'show_app', document: expect.objectContaining({ blocks: [{ kind: 'text', text: 'content' }] }) }, 300, undefined)
    expect(result).toEqual({ status: 'answered', values: { note: 'user feedback' }, mode: 'declarative', untrustedData: true, grantsPermission: false })
    for (let i = 0; i < 2; i++) await provider.callTool('show_app', { document }, context())
    await expect(provider.callTool('show_app', { document }, context())).rejects.toThrow('display limit')
    expect(request).toHaveBeenCalledTimes(3)
  })
  it.each([
    ['show_app', { html: '<script>evil()</script>' }],
    ['show_app', { document: { title: 'x', blocks: [{ kind: 'text', text: 'x' }] }, run_in_background: true }],
    ['show_app', { document: { title: 'x', blocks: [{ kind: 'text', text: 'x', url: 'https://evil' }] } }],
    ['search_memory', { query: 'x', sessionId: 'other' }],
    ['search_memory', { query: ' ', limit: 1 }],
    ['search_memory', { query: 'x', limit: 21 }],
    ['ask_user', { question: ' ', confirm: true }],
    ['ask_user', { question: 'Q', timeout_seconds: 0 }],
    ['show_card', { title: 'Pick', actions: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
    ['show_card', { title: 'Pick', actions: [{ id: 'a', label: 'A', url: 'https://example.com' }, { id: 'b', label: 'B' }] }]
  ])('rejects invalid or authority-like inputs to %s', async (name, args) => {
    const { provider, request } = create()
    await expect(provider.callTool(name as string, args as Record<string, unknown>, context())).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects cancellation, wrong thread and expired request admission', async () => {
    const { provider, assertInvocation } = create()
    await expect(provider.callTool('info', {}, { ...context(), route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
    const controller = new AbortController(); controller.abort()
    await expect(provider.callTool('info', {}, { ...context(), signal: controller.signal })).rejects.toThrow()
    assertInvocation.mockImplementation(() => { throw new Error('request ended') })
    await expect(provider.callTool('info', {}, context())).rejects.toThrow('request ended')
  })
})
