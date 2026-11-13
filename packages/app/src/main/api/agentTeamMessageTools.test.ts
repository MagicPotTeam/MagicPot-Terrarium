import { describe, expect, it, vi } from 'vitest'
import { createAgentTeamMessageTools } from './agentTeamMessageTools'

const source = { scope: 'scope', thread: 'pane', lead: 'lead', member: 'alice' }
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const context = { route, runId: 'run' }
function setup() {
  const lease = { assertLive: vi.fn() }, assertInvocation = vi.fn(), assertNotEnded = vi.fn(), enqueue = vi.fn(async (_intent: unknown, _signal?: AbortSignal) => ({ requestId: 'req-1' }))
  const tools = createAgentTeamMessageTools({ source, outgoingHop: 1, route, lease, assertInvocation, assertNotEnded, enqueue })
  return { tools, lease, assertInvocation, assertNotEnded, enqueue }
}
describe('request-owned team enqueue tools', () => {
  it('binds sender and passes signal, never treats queued as handled', async () => {
    const f = setup(), controller = new AbortController()
    const result = await f.tools.callTool('send_message', { recipient: 'bob', text: 'hello' }, { ...context, signal: controller.signal })
    expect(f.enqueue).toHaveBeenCalledWith({ source, kind: 'message', hop: 1, recipient: 'bob', text: 'hello' }, controller.signal)
    expect(JSON.parse(result.content)).toEqual({ status: 'queued', requestId: 'req-1' })
    expect(f.assertNotEnded).toHaveBeenCalledWith(source)
  })
  it('rejects spoofed sender, unknown fields, self, malformed and oversize', async () => {
    const f = setup()
    for (const args of [{ recipient: 'bob', text: 'hi', sender: 'bob' }, { recipient: 'bob', text: 'hi', hop: 1 }, { recipient: 'alice', text: 'hi' }, { recipient: 'bob', text: ' ' }, { recipient: 'bob', text: 'x'.repeat(4001) }, { recipient: 'a'.repeat(129), text: 'hi' }, { text: 'hi' }]) await expect(f.tools.callTool('send_message', args, context)).rejects.toThrow()
    await expect(f.tools.callTool('send_channel', { text: 'hi', recipient: 'bob' }, context)).rejects.toThrow()
    expect(f.enqueue).not.toHaveBeenCalled()
  })
  it('returns only a queued request ID for channel, not a recipient count', async () => {
    const f = setup()
    expect(JSON.parse((await f.tools.callTool('send_channel', { text: 'x'.repeat(4000) }, context)).content)).toEqual({ status: 'queued', requestId: 'req-1' })
    expect(f.enqueue).toHaveBeenCalledOnce()
  })
  it('does not enqueue on cancelled, invalid lease, invocation, wrong route or End', async () => {
    const f = setup(), controller = new AbortController(); controller.abort()
    await expect(f.tools.callTool('send_message', { recipient: 'bob', text: 'hi' }, { ...context, signal: controller.signal })).rejects.toThrow()
    f.lease.assertLive.mockImplementationOnce(() => { throw Error('lease') })
    await expect(f.tools.callTool('send_channel', { text: 'hi' }, context)).rejects.toThrow('lease')
    f.assertInvocation.mockImplementationOnce(() => { throw Error('invocation') })
    await expect(f.tools.callTool('send_channel', { text: 'hi' }, context)).rejects.toThrow('invocation')
    await expect(f.tools.callTool('send_channel', { text: 'hi' }, { ...context, route: { ...route, threadId: 'other' } })).rejects.toThrow()
    f.assertNotEnded.mockImplementationOnce(() => { throw Error('ended') })
    await expect(f.tools.callTool('send_channel', { text: 'hi' }, context)).rejects.toThrow('ended')
    expect(f.enqueue).not.toHaveBeenCalled()
  })
  it('bounds concurrency and total calls, including failed enqueue attempts', async () => {
    const f = setup(); let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.enqueue.mockImplementationOnce(async () => { await gate; return { requestId: 'req-1' } })
    const first = f.tools.callTool('send_message', { recipient: 'bob', text: 'hi' }, context)
    await expect(f.tools.callTool('send_channel', { text: 'hi' }, context)).rejects.toThrow('limit')
    release(); await first
    for (let i = 0; i < 7; i++) await f.tools.callTool('send_message', { recipient: 'bob', text: 'hi' }, context)
    await expect(f.tools.callTool('send_message', { recipient: 'bob', text: 'hi' }, context)).rejects.toThrow('limit')
    expect(f.enqueue).toHaveBeenCalledTimes(8)
  })
  it('does not turn a completed enqueue into a false negative on late cancellation or End', async () => {
    const f = setup(), controller = new AbortController(); let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.enqueue.mockImplementationOnce(async () => { await gate; return { requestId: 'req-1' } })
    const pending = f.tools.callTool('send_message', { recipient: 'bob', text: 'hi' }, { ...context, signal: controller.signal })
    controller.abort(); f.assertNotEnded.mockImplementation(() => { throw Error('ended') }); release()
    expect(JSON.parse((await pending).content)).toEqual({ status: 'queued', requestId: 'req-1' })
    expect(f.enqueue).toHaveBeenCalledOnce()
  })
})
