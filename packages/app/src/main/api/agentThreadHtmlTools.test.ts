import { beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./agentThreadHtmlApps', () => ({ agentThreadHtmlApps: { invoke: h.invoke } }))
import { createThreadHtmlProvider } from './agentThreadHtmlTools'
const factory = (enabled = () => true) => createThreadHtmlProvider({ request: { messages: [] }, invocation: { methodName: 'svcLLMProxy.chat' }, signal: new AbortController().signal, assertLive: () => undefined, enabled })
beforeEach(() => { h.invoke.mockReset().mockResolvedValue({ ok: true }) })
describe('HTML request admission, replay and resource bounds', () => {
  it('shares a concurrent same-call result and rejects changed replay without another document', async () => {
    let resolve!: (value: unknown) => void
    h.invoke.mockImplementation(() => new Promise(r => { resolve = r }))
    const p = factory(), input = { title: 'App', html: '<p>ok</p>' }
    const first = p.call(input, undefined, 'call'), replay = p.call(input, undefined, 'call')
    await expect(p.call({ ...input, html: 'changed' }, undefined, 'call')).rejects.toThrow('replay conflict')
    expect(h.invoke).toHaveBeenCalledOnce(); resolve({ app: { id: 'same' } })
    expect(await first).toEqual(await replay)
  })
  it('bounds total calls and re-checks disabled/released ownership before replaying results', async () => {
    let enabled = true; const p = factory(() => enabled)
    await p.call({ title: 'App', html: 'ok' }, undefined, 'first')
    enabled = false; await expect(p.call({ title: 'App', html: 'ok' }, undefined, 'first')).rejects.toThrow('disabled')
    enabled = true
    for (let i = 0; i < 11; i++) await p.call({ title: 'App', html: 'ok' })
    await expect(p.call({ title: 'App', html: 'ok' })).rejects.toThrow('budget')
    p.release(true); await expect(p.call({ title: 'App', html: 'ok' }, undefined, 'first')).rejects.toThrow('ended')
  })
  it.each([{ title: 'App', html: 'ok', executable: 'foreign' }, { read: '../another' }, { update: '123', patch: [] }, { title: 'App', html: 'x'.repeat(400001) }, JSON.parse('{"data":{"__proto__":{"polluted":true}}}')])('rejects malformed, oversized or unsafe input without document admission', async input => {
    await expect(factory().call(input)).rejects.toThrow(); expect(h.invoke).not.toHaveBeenCalled()
  })
  it('runs parent release hooks with success/failure exactly once', async () => {
    const release = vi.fn(); h.invoke.mockImplementation(async (_input, _req, _ctx, _owner, _signal, _check, retain) => { retain(release); return {} })
    const p = factory(); await p.call({ title: 'App', html: 'ok' }); p.release(true); p.release(false)
    expect(release).toHaveBeenCalledExactlyOnceWith(true)
  })
})
