import vm from 'node:vm'
import { TextEncoder } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { buildIsolatedHtmlShell, HTML_BRIDGE_PROTOCOL } from './agentThreadHtmlDocument'
const bridge = '11111111-1111-4111-8111-111111111111'
function fixture() {
  const source = buildIsolatedHtmlShell({ title: 'App', html: '<p>hello</p>', data: { count: 3 }, revision: 7 }, bridge)
  const script = source.match(/<script>([\s\S]*)<\/script>/)![1]
  const messages: any[] = [], handlers = new Map<string, (event: any) => void>(), frameWindow = { postMessage: vi.fn((message) => messages.push(message)) }
  let now = 100, resize!: () => void
  const frame = { contentWindow: frameWindow, clientWidth: 800, clientHeight: 550, srcdoc: '' }, title = { textContent: '' }, document = { activeElement: frame, getElementById: (id: string) => id === 'app' ? frame : title }
  const window: any = {}
  vm.runInNewContext(script, { window, document, TextEncoder, performance: { now: () => now }, addEventListener: (name: string, fn: (event: any) => void) => handlers.set(name, fn), ResizeObserver: class { constructor(fn: () => void) { resize = fn } observe() { return undefined } }, requestAnimationFrame: (fn: () => void) => fn() })
  const host = window[bridge]
  const send = (id: number, method: string, fields: object = {}, otherSource = false) => handlers.get('message')!({ source: otherSource ? {} : frameWindow, data: JSON.stringify({ protocol: HTML_BRIDGE_PROTOCOL, id, method, ...fields }) })
  return { host, send, messages, frame, document, tick: (ms: number) => { now += ms }, resize: () => resize() }
}
function childFixture() {
  const shell = fixture(), sent: any[] = [], handlers = new Map<string, (event: any) => void>(), timers = new Map<number, () => void>(); let nextTimer = 0
  const parent = { postMessage: vi.fn((raw: string) => sent.push(JSON.parse(raw))) }, window: any = {}, style = { setProperty: vi.fn(), colorScheme: '' }
  vm.runInNewContext(shell.frame.srcdoc.match(/<script>([\s\S]*)<\/script>/)![1], { window, parent, document: { documentElement: { style } }, innerWidth: 600, innerHeight: 300, TextEncoder, performance: { now: () => 100 }, addEventListener: (name: string, fn: (event: any) => void) => handlers.set(name, fn), setTimeout: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer }, clearTimeout: (id: number) => timers.delete(id) })
  const reply = (id: number, value: object) => handlers.get('message')!({ source: parent, data: { protocol: HTML_BRIDGE_PROTOCOL, type: 'reply', id, ...value } })
  const notify = (type: string, value: object) => handlers.get('message')!({ source: parent, data: { protocol: HTML_BRIDGE_PROTOCOL, type, value } })
  return { kt: window.kt, sent, timers, reply, notify, handlers, parent, style }
}
describe('opaque child public bridge API', () => {
  it('provides ready/on and updates immutable viewport/theme values without parent DOM/API access', async () => {
    const t = childFixture(), viewport = vi.fn(), theme = vi.fn()
    t.kt.on('viewport', viewport); t.kt.on('theme', theme)
    expect(t.sent[0]).toMatchObject({ method: 'initialize', id: 1 })
    t.reply(1, { result: { viewport: { width: 500, height: 250, mode: 'window' }, theme: { scheme: 'dark', vars: { '--kt-bg': '#111111' } } } })
    expect(await t.kt.ready).toMatchObject({ viewport: { width: 500 } }); expect(t.kt.data).toMatchObject({ count: 3 }); expect(viewport).toHaveBeenCalledOnce()
    const off = t.kt.on('viewport', viewport); off()
    t.notify('viewport', { width: 300, height: 200 }); expect(t.kt.viewport.width).toBe(300); expect(viewport).toHaveBeenCalledOnce()
    t.notify('theme', { scheme: 'light', vars: { '--kt-bg': '#ffffff' } }); expect(t.kt.theme.scheme).toBe('light'); expect(theme).toHaveBeenCalledTimes(2)
  })
  it('exposes cloned JSON state, shallow-merge updates and state notifications without granting an event permission', async () => {
    const t = childFixture(), changed = vi.fn()
    t.kt.on('state', changed); t.reply(1, { result: { viewport: {}, theme: { vars: {} }, state: { n: 1 } } }); await t.kt.ready
    const local = t.kt.state.get(); local.n = 99; expect(t.kt.state.get()).toEqual({ n: 1 })
    const pending = t.kt.state.set({ n: 2 }); expect(t.sent.at(-1)).toMatchObject({ method: 'state', patch: { n: 2 } })
    t.reply(t.sent.at(-1).id, { result: { state: { n: 2 }, grantsPermission: false } }); expect(await pending).toEqual({ n: 2 }); expect(changed).toHaveBeenLastCalledWith({ n: 2 })
  })
  it('caps outstanding Promises and listeners instead of accumulating unbounded callbacks', async () => {
    const t = childFixture(), pending: Promise<unknown>[] = []
    // initialize already occupies one of32 slots.
    for (let i = 0; i < 31; i++) pending.push(t.kt.send('pending', { i }))
    await expect(t.kt.send('extra', {})).rejects.toThrow('outstanding-call limit')
    expect(t.sent).toHaveLength(32)
    for (const request of t.sent) if (request.method !== 'initialize') t.reply(request.id, { result: { accepted: true } })
    await Promise.all(pending)
    for (let i = 0; i < 64; i++) t.kt.on('viewport', () => i)
    expect(() => t.kt.on('viewport', () => undefined)).toThrow('listener limit')
    await expect(t.kt.send('oversized', '界'.repeat(8192))).rejects.toThrow('byte limit')
  })
  it('returns correlated send promises, propagates refusal and bounds pending requests/timeouts', async () => {
    const t = childFixture()
    const output = t.kt.send('done', { answer: 42 }); const id = t.sent.at(-1).id
    let finished = false; void output.then(() => { finished = true }); await Promise.resolve(); expect(finished).toBe(false)
    t.reply(id, { result: { accepted: true, stage: 'auxiliary-host' } }); expect(await output).toMatchObject({ accepted: true })
    const denied = t.kt.send('done', {}); t.reply(t.sent.at(-1).id, { error: 'needs recent input' }); await expect(denied).rejects.toThrow('recent input')
    await expect(t.kt.send('__error__', {})).rejects.toThrow('reserved')
    const waiting = t.kt.send('timeout', {}); t.timers.get(Math.max(...t.timers.keys()))!(); await expect(waiting).rejects.toThrow('timed out')
  })
})
describe('trusted-shell bridge ordering and bounded acknowledgements', () => {
  it('initializes data-free host metadata and reports dynamic viewport without executing child content', () => {
    const t = fixture(); t.send(1, 'initialize'); expect(t.messages.at(-1).result).toMatchObject({ title: 'App', revision: 7, viewport: { width: 800, height: 550, mode: 'window' }, theme: { scheme: 'light' } })
    expect(t.frame.srcdoc).toContain('get viewport()'); expect(t.frame.srcdoc).toContain('ready')
    t.frame.clientWidth = 450; t.resize(); expect(t.messages.at(-1)).toMatchObject({ type: 'viewport', value: { width: 450 } })
  })
  it('bounds/coalesces state independently of events and freezes the final capture', () => {
    const t = fixture(); t.send(1, 'state', { patch: { n: 1, retained: true } }); t.send(2, 'state', { patch: { n: 2 } })
    const first = JSON.parse(t.host.drain()); expect(first).toMatchObject({ requests: [], state: { revision: 7, stateRevision: 2, value: { n: 2, retained: true } } }); expect(JSON.parse(t.host.drain())).not.toHaveProperty('state')
    t.send(3, 'state', { patch: JSON.parse('{"__proto__":{"polluted":true}}') }); expect(t.messages.at(-1).error).toContain('Invalid')
    t.send(4, 'state', { patch: { oversized: '界'.repeat(23000) } }); expect(t.messages.at(-1).error).toBeTruthy()
    t.send(5, 'state', { patch: { nested: { child: true } } }); expect(t.messages.at(-1).result.grantsPermission).toBe(false)
    const frozen = JSON.parse(t.host.freezeState()); expect(frozen).toMatchObject({ stateRevision: 3, value: { nested: { child: true } } })
    t.send(6, 'state', { patch: { n: 3 } }); expect(t.messages.at(-1).error).toContain('frozen'); expect(JSON.parse(t.host.freezeState())).toEqual(frozen)
  })
  it('rejects automatic/foreign/reserved sends and never accepts a payload-supplied input token', () => {
    const t = fixture(); t.send(1, 'send', { name: 'done', inputToken: 'forged', data: 1 }); expect(t.messages.at(-1).error).toContain('recent input')
    t.send(2, 'send', { name: 'done' }, true); expect(t.messages).toHaveLength(1)
    t.host.markInput('native-owned', false); t.send(2, 'send', { name: '__error__' }); expect(t.messages.at(-1).error).toContain('reserved')
    expect(JSON.parse(t.host.drain()).requests).toEqual([])
  })
  it('settles only after main acknowledges; later input does not replace an already tagged request', () => {
    const t = fixture(); t.host.markInput('down', false); t.send(1, 'send', { name: 'done', data: 42 }); t.host.markInput('up', false)
    expect(t.messages).toEqual([])
    const drained = JSON.parse(t.host.drain()); expect(drained.requests[0]).toMatchObject({ id: 1, inputToken: 'down', event: { revision: 7, name: 'done', data: 42, grantsPermission: false } })
    expect(t.messages).toEqual([]); t.host.settle([{ id: 1 }]); expect(t.messages.at(-1)).toMatchObject({ id: 1, result: { accepted: true, stage: 'auxiliary-host', grantsPermission: false } })
    t.send(1, 'send', { name: 'replay' }); expect(JSON.parse(t.host.drain()).requests).toEqual([])
  })
  it('revokes pending and inflight promises and requires a focused iframe for keyboard grants', () => {
    const t = fixture(); t.document.activeElement = {} as typeof t.frame
    expect(t.host.markInput('key', true)).toBe(false)
    t.document.activeElement = t.frame
    t.host.markInput('mouse', false); t.send(1, 'send', { name: 'first' }); t.host.drain(); t.send(2, 'send', { name: 'second' }); t.host.revokeInput()
    expect(t.messages.map(message => message.id).sort()).toEqual([1, 2]); expect(t.messages.every(message => message.error.includes('revoked'))).toBe(true)
    t.host.settle([{ id: 1 }]); expect(t.messages).toHaveLength(2)
  })
  it('expires the interval and keeps only16 requests, with explicit overflow replies', () => {
    const t = fixture(); t.host.markInput('owned', false)
    for (let id = 1; id <= 17; id++) t.send(id, 'send', { name: 'progress' })
    expect(t.messages.at(-1)).toMatchObject({ id: 17, error: 'App bridge queue limit' }); expect(JSON.parse(t.host.drain()).dropped).toBe(1)
    t.tick(5001); t.send(18, 'send', { name: 'expired' }); expect(t.messages.at(-1).error).toContain('recent input')
  })
  it('reports generic errors without a gesture, not app-supplied exception text or permission', () => {
    const t = fixture(); t.send(1, 'error', { data: 'SECRET_STACK' })
    const request = JSON.parse(t.host.drain()).requests[0]; expect(request).toMatchObject({ event: { name: '__error__', data: { message: 'App script error' }, grantsPermission: false } }); expect(JSON.stringify(request)).not.toContain('SECRET_STACK')
  })
})
