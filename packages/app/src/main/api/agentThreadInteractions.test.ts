import { EventEmitter } from 'node:events'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'

const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('./agentThreadArchive', () => ({ agentThreadArchive: { search: async () => undefined } }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = (method = 'chat') => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, isMainFrame: true, senderUrl: url, frameUrl: url })
const question = { kind: 'ask_user', question: 'Which colour?' } as const
let manager: AgentThreadInteractions
let channel: AgentThreadInteractionChannel
let sender: EventEmitter & { id: number; isDestroyed: () => boolean; getURL: () => string }
beforeEach(() => {
  vi.useFakeTimers()
  manager = new AgentThreadInteractions()
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  electron.fromId.mockReturnValue(sender)
  electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
  channel = manager.create({ ...scope, messages: [] }, invocation())!
})
afterEach(() => { channel.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.useRealTimers(); vi.clearAllMocks() })
const pending = () => manager.list(scope, invocation('listAgentInteractions'))
const respond = (interactionId: string, answer: Parameters<AgentThreadInteractions['resolve']>[0]['answer']) => manager.resolve({ ...scope, interactionId, answer }, invocation('resolveAgentInteraction'))

describe('local Agent thread interactions', () => {
  it('rejects original nonprimitive/oversize icons before JSON hooks, pending input or timers and validates the entire icon-only prompt', async () => {
    const base = { kind: 'show_card' as const, title: 'Direct icon', actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, toJSON = vi.fn(() => '✓'), toString = vi.fn(() => '✓')
    for (const icon of [null, false, 1, [], {}, ['✓'], Object('✓'), { toJSON, toString }, Object.assign(Object('✓'), { toJSON, toString }), 'x'.repeat(65), '😀'.repeat(33)]) {
      const result = channel.request({ ...base, icon } as never, 17).then(() => 'resolved', () => 'rejected')
      await Promise.resolve(); expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0); expect(await result).toBe('rejected')
    }
    expect(toJSON).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled()
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { subtitle: '😀'.repeat(101) }, { footer: '😀'.repeat(101) }, { fields: null }, { accent: 'error' }, { actions: [] }, { actions: [{ ...base.actions[0], label: '😀'.repeat(101) }, base.actions[1]] }, { actions: [base.actions[0], base.actions[0]] }, { actions: [{ ...base.actions[0], url: 'https://external.invalid' }] }, { actions: [{ ...base.actions[0], style: 'link' }] }, { actions: [{ ...base.actions[0], icon: '✓' }] }, { approved: true }, { ['__proto__']: { approved: true } }]) {
      await expect(channel.request({ ...base, icon: '', ...patch } as never, 17)).rejects.toThrow('Invalid bounded')
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('keeps original raw icon context detached and ownundefined/inherited legacy omission separate from supplied-icon strict validation', async () => {
    for (const count of [1, 2, 4]) {
      const base = { kind: 'show_card' as const, title: count === 1 ? 'Single already strict' : '😀'.repeat(101), actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'A' })) }
      for (const source of [{ ...base }, { ...base, icon: undefined }, Object.assign(Object.create({ icon: { toJSON: () => '✓' } }), base)]) {
        const result = channel.request(source, 17), [item] = pending()
        expect(item.prompt).toEqual(count > 1 && Object.hasOwn(source, 'icon') ? { ...base, icon: undefined } : base)
        expect(Object.hasOwn(item.prompt, 'icon')).toBe(count > 1 && Object.hasOwn(source, 'icon'))
        respond(item.id, { status: 'dismissed' }); expect(await result).toEqual({ status: 'dismissed' }); expect(vi.getTimerCount()).toBe(0)
      }
      if (count > 1) { await expect(channel.request({ ...base, icon: '' }, 17)).rejects.toThrow('Invalid bounded'); expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0) }
    }
    const source = { kind: 'show_card' as const, title: 'Raw context not rewritten', icon: '\u0001👩🏽‍💻\u202e', subtitle: '', footer: '  ', accent: 'success' as const, fields: [{ label: 'Status', value: 'Not approval' }], actions: [{ id: 'approve', label: 'Explicit feedback', style: 'primary' as const }, { id: 'no', label: 'Other', style: 'secondary' as const }] }
    const expected = structuredClone(source), result = channel.request(source, 17), [item] = pending(); expect(item.prompt).toEqual(expected)
    source.icon = 'source changed'; source.fields[0].value = 'source changed'
    if (item.prompt.kind === 'show_card') { item.prompt.icon = 'view changed'; item.prompt.actions[0].id = 'view changed' }
    expect(pending()[0].prompt).toEqual(expected)
    for (const answer of [{ status: 'answered', actionId: 'approve', icon: '✓' }, { status: 'dismissed', icon: '' }, { status: 'answered', actionId: 'approve', approved: true }, { status: 'answered', actionId: 'approve', style: 'primary' }, { status: 'answered', actionId: 'approve', values: {} }]) expect(() => respond(item.id, answer as never)).toThrow('Invalid')
    respond(item.id, { status: 'answered', actionId: 'approve' }); expect(await result).toEqual({ status: 'answered', actionId: 'approve' }); expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it('counts decorative icon, all contexts and styles in exact MAIN unit AND byte caps before pending/timer allocation', async () => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const prompt = { kind: 'show_card' as const, title: 'Caps', icon: '\u0001'.repeat(64), subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), accent: 'success' as const, body: '\u0001'.repeat(3700), fields, actions: [{ id: 'a', label: 'A', style: 'primary' as const }, { id: 'b', label: 'B', style: 'danger' as const }] }, remaining = 32768 - Buffer.byteLength(JSON.stringify(prompt), 'utf8')
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000); fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(prompt).length).toBe(32768); const result = channel.request(prompt, 17), [item] = pending(); expect(item.prompt).toEqual(prompt)
    respond(item.id, { status: 'dismissed' }); expect(await result).toEqual({ status: 'dismissed' }); fields[2].value += 'x'
    await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded'); fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(prompt).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32770); await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded')
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['', '✓', '👩🏽‍💻'])('retains an owned detached icon-only choice and accepts only explicit offeredID, not icon authority %#', async icon => {
    const source = { kind: 'show_card' as const, title: 'Decorative icon only', icon, actions: [{ id: 'approve', label: 'Feedback not approval' }] }
    let settled = false
    const result = channel.request(source, 17).then(value => { settled = true; return value }, () => 'rejected')
    await Promise.resolve(); expect(settled).toBe(false)
    const [item] = pending(); expect(item?.prompt).toEqual(source)
    source.icon = 'changed-source'; expect(pending()[0].prompt).toMatchObject({ icon })
    expect(() => respond(item.id, { status: 'answered', actionId: 'approve', icon } as never)).toThrow('Invalid')
    expect(pending()).toHaveLength(1)
    respond(item.id, { status: 'answered', actionId: 'approve' }); expect(await result).toEqual({ status: 'answered', actionId: 'approve' })
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects raw style coercion before JSON hooks, pending retention and timers while validating style-only whole prompts', async () => {
    const base = { kind: 'show_card' as const, title: 'Literal only', actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    const toJSON = vi.fn(() => 'primary'), toString = vi.fn(() => 'primary')
    for (const style of [null, 1, false, [], {}, ['primary'], Object('primary'), { toJSON, toString }, '', 'link', 'error', 'Primary', 'primary ', '#f00', 'url(https://external.invalid)', '__proto__', 'constructor']) {
      const outcome = channel.request({ ...base, actions: [{ ...base.actions[0], style }, base.actions[1]] } as never, 17).then(value => value, () => 'rejected')
      await Promise.resolve(); expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0); expect(await outcome).toBe('rejected')
    }
    expect(toJSON).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled()
    const actions = [{ ...base.actions[0], style: 'secondary' }, base.actions[1]]
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { actions: [{ ...actions[0], label: '😀'.repeat(101) }, actions[1]] }, { actions: [actions[0], actions[0]] }, { actions: [{ ...actions[0], url: 'https://external.invalid' }] }, { actions: [{ ...actions[0], variant: 'contained' }] }, { style: 'primary' }, { approved: true }, { fields: null }, { subtitle: null }, { footer: null }, { accent: 'error' }]) {
      await expect(channel.request({ ...base, actions, ...patch } as never, 17)).rejects.toThrow('Invalid bounded')
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('ignores nested inherited style and omits raw ownundefined without tightening old bare2–4 admission', async () => {
    for (const count of [1, 2, 4]) for (const own of [false, true]) {
      const actions = Array.from({ length: count }, (_, i) => Object.assign(Object.create(own ? null : { style: 'link' }), { id: `a${i}`, label: 'A' }, own ? { style: undefined } : {}))
      const source = { kind: 'show_card' as const, title: count > 1 ? '😀'.repeat(101) : 'Single strict', actions }
      const waiting = channel.request(source, 17), [item] = pending()
      expect(item.prompt).toEqual({ ...source, actions: actions.map(({ id, label }) => ({ id, label })) })
      respond(item.id, { status: 'dismissed' }); expect(await waiting).toEqual({ status: 'dismissed' }); expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('includes nested styles plus all optional context in exact direct-MAIN unit AND UTF8 caps before a timer', async () => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const prompt = { kind: 'show_card' as const, title: 'Caps', subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), accent: 'success' as const, body: '\u0001'.repeat(3800), fields, actions: [{ id: 'a', label: 'A', style: 'primary' as const }, { id: 'b', label: 'B', style: 'danger' as const }] }
    const remaining = 32768 - Buffer.byteLength(JSON.stringify(prompt), 'utf8')
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(prompt).length).toBe(32768)
    const waiting = channel.request(prompt, 17), [item] = pending(); expect(item.prompt).toEqual(prompt)
    respond(item.id, { status: 'dismissed' }); expect(await waiting).toEqual({ status: 'dismissed' })
    fields[2].value += 'x'; await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded')
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(prompt).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32770)
    await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded'); expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['primary', 'secondary', 'danger'])('validates and retains a detached styled action without approval or autoanswer style=%s', async style => {
    const prompt = { kind: 'show_card' as const, title: 'Explicit feedback only', actions: [{ id: 'approve', label: 'Feedback', style }] }
    let settled = false
    const waiting = channel.request(prompt as never, 17).then(value => { settled = true; return value }, () => 'rejected')
    await Promise.resolve(); expect(settled).toBe(false)
    const [item] = pending(); expect(item?.prompt).toEqual(prompt)
    prompt.actions[0].style = 'changed-source'
    expect(pending()[0].prompt).toMatchObject({ actions: [{ id: 'approve', label: 'Feedback', style }] })
    expect(() => respond(item.id, { status: 'answered', actionId: 'approve', style } as never)).toThrow('Invalid')
    expect(pending()).toHaveLength(1)
    respond(item.id, { status: 'answered', actionId: 'approve' }); expect(await waiting).toEqual({ status: 'answered', actionId: 'approve' })
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects raw accent JSON coercion without invoking user hooks or retaining timers', async () => {
    const toJSON = vi.fn(() => 'primary'), toString = vi.fn(() => 'primary')
    const accent = { toJSON, toString }, prompt = { kind: 'show_card', title: 'No coercion', accent, actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    await expect(channel.request(prompt as never, 17)).rejects.toThrow('Invalid bounded')
    expect(toJSON).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled()
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it('validates direct-MAIN accent-only context before retaining a prompt/timer, preserving deliberate legacy no-context handling', async () => {
    const base = { kind: 'show_card' as const, title: 'Visual only', actions: [{ id: 'approve', label: 'Feedback' }, { id: 'no', label: 'Other' }] }
    for (const accent of [null, false, 1, [], {}, ['primary'], Object('primary'), { toJSON: () => 'primary' }, { toString: () => 'primary' }, '', 'error', 'Primary', '#f00', 'url(https://external.invalid)', '__proto__', 'constructor', 'toString']) {
      const outcome = channel.request({ ...base, accent } as never, 17).then(value => value, () => 'rejected')
      await Promise.resolve()
      expect(pending(), `Invalid raw accent type=${typeof accent}`).toEqual([]); expect(vi.getTimerCount()).toBe(0)
      expect(await outcome).toBe('rejected')
    }
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { subtitle: null }, { footer: null }, { fields: null }, { actions: [] }, { actions: [{ id: 'approve', label: '😀'.repeat(101) }, base.actions[1]] }, { actions: [base.actions[0], base.actions[0]] }, { actions: [{ ...base.actions[0], style: { color: 'red' } }, base.actions[1]] }, { approved: true }, { style: { color: 'red' } }, { className: 'accent-primary' }, { ['__proto__']: { approved: true } }]) {
      await expect(channel.request({ ...base, accent: 'neutral', ...patch } as never, 17)).rejects.toThrow('Invalid bounded')
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
    for (const source of [{ ...base, accent: undefined }, Object.assign(Object.create({ accent: 'error' }), base), { ...base, title: '😀'.repeat(101), accent: undefined }]) {
      const waiting = channel.request(source, 17), [item] = pending()
      expect(Object.hasOwn(item.prompt, 'accent')).toBe(Object.hasOwn(source, 'accent'))
      respond(item.id, { status: 'dismissed' }); expect(await waiting).toEqual({ status: 'dismissed' })
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('includes all context plus accent in exact direct-MAIN JSON unit/byte caps without creating timers on overflow', async () => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const prompt = { kind: 'show_card' as const, title: 'Caps', accent: 'warning' as const, subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), body: '\u0001'.repeat(3800), fields, actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    const remaining = 32768 - Buffer.byteLength(JSON.stringify(prompt), 'utf8')
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(prompt).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32768)
    const waiting = channel.request(prompt, 17), [item] = pending(); expect(item.prompt).toEqual(prompt)
    respond(item.id, { status: 'dismissed' }); expect(await waiting).toEqual({ status: 'dismissed' })
    fields[2].value += 'x'; await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded')
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(prompt).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32770)
    await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded')
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([false, true])('keeps accent as detached untrusted provider context until owned explicit feedback, not approval othercontext=%s', async withContext => {
    const { createAgentThreadToolProvider } = await import('./agentThreadTools')
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [], interactions: channel })
    const actions = [{ id: 'approve', label: 'Feedback only' }, { id: 'no', label: 'Other' }]
    const args = { title: 'Visual only', accent: 'success', actions, ...(withContext ? { subtitle: '', footer: 'No approval', fields: [{ label: 'State', value: 'No grant' }] } : {}) }
    let settled = false
    const result = provider.callTool('show_card', args, { route, runId: 'accent-wait' }).then(value => { settled = true; return value })
    await Promise.resolve(); expect(settled).toBe(false)
    const [item] = pending(); expect(item.prompt).toEqual({ kind: 'show_card', ...args })
    args.accent = 'changed-source'; actions[0].id = 'changed-source'
    Reflect.set(item.prompt, 'accent', 'changed-view'); if (item.prompt.kind === 'show_card') item.prompt.actions[0].id = 'changed-view'
    expect(pending()[0].prompt).toMatchObject({ accent: 'success', actions: [{ id: 'approve' }, { id: 'no' }] })
    for (const answer of [{ status: 'answered', actionId: 'approve', accent: 'success' }, { status: 'answered', actionId: 'approve', approved: true }, { status: 'answered', actionId: 'approve', values: {} }, { status: 'dismissed', accent: 'neutral' }, { status: 'answered', actionId: 'changed-source' }]) expect(() => respond(item.id, answer as never)).toThrow('Invalid')
    expect(pending()).toHaveLength(1); expect(settled).toBe(false)
    respond(item.id, { status: 'answered', actionId: 'approve' }); expect(JSON.parse((await result).content)).toEqual({ status: 'answered', actionId: 'approve' })
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    expect(() => respond(item.id, { status: 'answered', actionId: 'approve' })).toThrow('not active')
  })
  it.each([1, 2])('treats a supplied accent as strict direct-MAIN prompt context before pending/timer, never an answer actions=%s', async count => {
    const actions = [{ id: 'approve', label: 'Feedback only' }, { id: 'no', label: 'Other feedback' }].slice(0, count)
    const source = { kind: 'show_card' as const, title: 'Visual context', accent: 'success', actions }
    const waiting = channel.request(source as never, 17).then(value => value, () => 'rejected'), [item] = pending()
    expect(item.prompt).toEqual(source); source.accent = 'changed-source'
    if (item.prompt.kind === 'show_card') Reflect.set(item.prompt, 'accent', 'changed-view')
    expect(pending()[0].prompt).toMatchObject({ accent: 'success' })
    expect(() => respond(item.id, { status: 'answered', actionId: 'approve', ...{ accent: 'success' } })).toThrow('Invalid')
    respond(item.id, { status: 'dismissed' }); expect(await waiting).toEqual({ status: 'dismissed' })
    const invalid = channel.request({ kind: 'show_card', title: 'Visual context', ...{ accent: 'error' }, actions } as never, 17).then(() => 'resolved', () => 'rejected')
    await Promise.resolve()
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    expect(await invalid).toBe('rejected')
  })
  it.each([false, true])('retains a detached owned footer with optional context and rejects footer/values/approval answers fields=%s', async withContext => {
    const { createAgentThreadToolProvider } = await import('./agentThreadTools')
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [], interactions: channel })
    const actions = [{ id: 'approve', label: 'Feedback only' }, { id: 'no', label: 'Other feedback' }]
    const args = { title: 'Owned footer', footer: 'Closing context, not authorization', actions, ...(withContext ? { subtitle: 'Smaller context', fields: [{ label: 'Status', value: 'Read only' }] } : {}) }
    const result = provider.callTool('show_card', args, { route, runId: 'footer-wait' })
    const [item] = pending(); expect(item.prompt).toEqual({ kind: 'show_card', ...args })
    args.footer = 'MUTATED SOURCE'; actions[0].id = 'changed-source'
    if (item.prompt.kind === 'show_card') { item.prompt.footer = 'MUTATED VIEW'; item.prompt.actions[0].id = 'changed-view' }
    expect(pending()[0].prompt).toMatchObject({ footer: 'Closing context, not authorization', actions: [{ id: 'approve' }, { id: 'no' }] })
    for (const answer of [{ status: 'answered', actionId: 'approve', footer: 'Extra context' }, { status: 'answered', actionId: 'approve', approved: true }, { status: 'answered', actionId: 'approve', values: {} }, { status: 'answered', actionId: 'changed-source' }, { status: 'dismissed', footer: '' }]) expect(() => respond(item.id, answer as never)).toThrow('Invalid')
    expect(pending()).toHaveLength(1)
    respond(item.id, { status: 'answered', actionId: 'approve' })
    expect(JSON.parse((await result).content)).toEqual({ status: 'answered', actionId: 'approve' })
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it('validates direct MAIN footer-only context before retention/timer, keeping absent/undefined/inherited compatibility', async () => {
    const base = { kind: 'show_card' as const, title: 'Direct footer', actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    for (const patch of [{ footer: null }, { footer: false }, { footer: 1 }, { footer: {} }, { footer: [] }, { footer: ['text'] }, { footer: 'x'.repeat(201) }, { footer: '😀'.repeat(101) }, { footer: '', title: '😀'.repeat(101) }, { footer: '', body: '😀'.repeat(2001) }, { footer: '', actions: [] }, { footer: '', actions: [{ id: 'a', label: '😀'.repeat(101) }, base.actions[1]] }, { footer: '', approved: true }, { footer: '', fields: null }, { footer: '', actions: [{ ...base.actions[0], style: 'link', url: 'https://external.invalid' }, base.actions[1]] }, { footer: '', ['__proto__']: { approved: true } }]) {
      await expect(channel.request({ ...base, ...patch } as never, 17)).rejects.toThrow('Invalid bounded')
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
    for (const prompt of [{ ...base, footer: '' }, { ...base, footer: '  ' }, { ...base, footer: '😀'.repeat(100) }, { ...base, footer: undefined }, Object.assign(Object.create({ footer: 'INHERITED_IGNORE' }), base)]) {
      const result = channel.request(prompt, 17), [item] = pending()
      if (Object.hasOwn(prompt, 'footer') && prompt.footer !== undefined) expect(item.prompt).toMatchObject({ footer: prompt.footer })
      else expect(Object.hasOwn(item.prompt, 'footer')).toBe(Object.hasOwn(prompt, 'footer'))
      respond(item.id, { status: 'dismissed' }); expect(await result).toEqual({ status: 'dismissed' })
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('includes footer plus subtitle in exact direct-MAIN serialized units/bytes before creating a timer', async () => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const prompt = { kind: 'show_card' as const, title: 'Footer', subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), body: '\u0001'.repeat(3800), fields, actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    const remaining = 32768 - Buffer.byteLength(JSON.stringify(prompt), 'utf8')
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32768)
    const result = channel.request(prompt, 17), [item] = pending(); expect(item.prompt).toEqual(prompt)
    respond(item.id, { status: 'dismissed' }); expect(await result).toEqual({ status: 'dismissed' })
    fields[2].value += 'x'; await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded')
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(prompt).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32770)
    await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded')
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['bare', 'fields', 'subtitle', 'both'] as const)('keeps a lone choice pending until its owned exact ID and detaches all context=%s', async variant => {
    const { createAgentThreadToolProvider } = await import('./agentThreadTools')
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [], interactions: channel })
    const actions = [{ id: 'approve', label: 'Conversation only' }]
    const args = { title: 'Explicit lone button', actions,
      ...(['fields', 'both'].includes(variant) ? { fields: [{ label: 'Status', value: 'Read only' }] } : {}),
      ...(['subtitle', 'both'].includes(variant) ? { subtitle: 'Not execution permission' } : {}) }
    let settled = false
    const outcome = provider.callTool('show_card', args, { route, runId: 'single-wait' }).then(value => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false); expect(vi.getTimerCount()).toBe(1)
    const [item] = pending(); expect(item.prompt).toEqual({ kind: 'show_card', ...args })
    actions[0].id = 'changed-source'
    if (item.prompt.kind === 'show_card') { item.prompt.actions[0].id = 'changed-view'; if (item.prompt.fields) item.prompt.fields[0].value = 'changed-field' }
    expect(pending()[0].prompt).toMatchObject({ actions: [{ id: 'approve', label: 'Conversation only' }] })
    for (const answer of [{ status: 'answered', actionId: 'changed-source' }, { status: 'answered', actionId: 'approve', approved: true }, { status: 'answered', actionId: 'approve', values: {} }, { status: 'answered', actionId: 'approve', subtitle: 'Not an answer' }, { status: 'answered', text: 'approve' }]) expect(() => respond(item.id, answer as never)).toThrow('Invalid')
    expect(pending()).toHaveLength(1); expect(settled).toBe(false)
    respond(item.id, { status: 'answered', actionId: 'approve' })
    expect(JSON.parse((await outcome).content)).toEqual({ status: 'answered', actionId: 'approve' })
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    expect(() => respond(item.id, { status: 'answered', actionId: 'approve' })).toThrow('not active')
  })
  it('rejects malformed single-action direct MAIN prompts even without context before retention or a timer', async () => {
    const base = { kind: 'show_card' as const, title: 'Direct one', actions: [{ id: 'a', label: 'A' }] }
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { approved: true }, { actions: [{ id: '', label: 'A' }] }, { actions: [{ id: 'a'.repeat(65), label: 'A' }] }, { actions: [{ id: 'bad id', label: 'A' }] }, { actions: [{ id: 'a', label: '😀'.repeat(101) }] }, { actions: [{ id: 'a', label: ' ' }] }, { actions: [null] }, { actions: [{}] }, { actions: [{ id: 'a', label: 'A', style: 'link' }] }, { actions: [{ id: 'a', label: 'A', url: 'https://external.invalid' }] }, { fields: null }, { subtitle: null }, { answer: { actionId: 'a' } }, { ['__proto__']: { approved: true } }]) {
      await expect(channel.request({ ...base, ...patch } as never, 1)).rejects.toThrow('Invalid bounded')
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
    for (const prompt of [{ ...base, fields: undefined, subtitle: undefined }, Object.assign(Object.create({ fields: [null], subtitle: 'INHERITED_IGNORE' }), base)]) {
      const outcome = channel.request(prompt, 1), [item] = pending()
      expect(item.prompt).toEqual(base)
      respond(item.id, { status: 'dismissed' }); expect(await outcome).toEqual({ status: 'dismissed' })
      expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('enforces exact serialized single-action MAIN caps before pending/timer creation', async () => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const prompt = { kind: 'show_card' as const, title: 'One', subtitle: '\u0001'.repeat(200), body: '\u0001'.repeat(4000), fields, actions: [{ id: 'a', label: 'A' }] }
    const remaining = 32768 - Buffer.byteLength(JSON.stringify(prompt), 'utf8')
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32768)
    const outcome = channel.request(prompt, 1), [item] = pending()
    expect(item.prompt).toEqual(prompt)
    respond(item.id, { status: 'dismissed' }); expect(await outcome).toEqual({ status: 'dismissed' })
    fields[2].value += 'x'; await expect(channel.request(prompt, 1)).rejects.toThrow('Invalid bounded')
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(prompt).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32770)
    await expect(channel.request(prompt, 1)).rejects.toThrow('Invalid bounded')
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([false, true])('retains a detached subtitle in owned choice state and accepts only the offered action ID fields=%s', async withFields => {
    const { createAgentThreadToolProvider } = await import('./agentThreadTools')
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [], interactions: channel })
    const actions = [{ id: 'approve', label: 'Feedback only' }, { id: 'no', label: 'Other feedback' }]
    const args = { title: 'Owned subtitle', subtitle: 'Context is not execution approval', actions, ...(withFields ? { fields: [{ label: 'Status', value: 'Read only' }] } : {}) }
    const result = provider.callTool('show_card', args, { route, runId: 'subtitle-wait' })
    const [item] = pending()
    expect(item.prompt).toEqual({ kind: 'show_card', ...args })
    args.subtitle = 'MUTATED SOURCE'; actions[0].id = 'source-mutated'
    if (item.prompt.kind === 'show_card') { item.prompt.subtitle = 'MUTATED VIEW'; item.prompt.actions[0].id = 'view-mutated' }
    expect(pending()[0].prompt).toMatchObject({ subtitle: 'Context is not execution approval', actions: [{ id: 'approve' }, { id: 'no' }] })
    for (const answer of [{ status: 'answered', actionId: 'approve', subtitle: 'Return extra' }, { status: 'answered', actionId: 'approve', approved: true }, { status: 'answered', actionId: 'approve', values: {} }, { status: 'answered', actionId: 'source-mutated' }]) expect(() => respond(item.id, answer as never)).toThrow('Invalid')
    expect(pending()).toHaveLength(1)
    respond(item.id, { status: 'answered', actionId: 'approve' })
    expect(JSON.parse((await result).content)).toEqual({ status: 'answered', actionId: 'approve' })
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it('validates direct MAIN subtitle-only prompts before retention/timers, preserving omitted/own-undefined/inherited optional behavior', async () => {
    const base = { kind: 'show_card' as const, title: 'Direct subtitle', actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    for (const patch of [{ subtitle: null }, { subtitle: false }, { subtitle: 1 }, { subtitle: {} }, { subtitle: [] }, { subtitle: 'x'.repeat(201) }, { subtitle: '😀'.repeat(101) }, { subtitle: '', title: '😀'.repeat(101) }, { subtitle: '', body: '😀'.repeat(2001) }, { subtitle: '', actions: [] }, { subtitle: '', actions: [{ id: 'a', label: '😀'.repeat(101) }, base.actions[1]] }, { subtitle: '', approved: true }, { subtitle: '', fields: null }, { subtitle: '', actions: [{ ...base.actions[0], url: 'https://external.invalid' }, base.actions[1]] }]) {
      await expect(channel.request({ ...base, ...patch } as never, 17)).rejects.toThrow('Invalid bounded')
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
    for (const prompt of [{ ...base, subtitle: '' }, { ...base, subtitle: '😀'.repeat(100) }, { ...base, subtitle: undefined }, Object.assign(Object.create({ subtitle: 'INHERITED_IGNORE' }), base)]) {
      const result = channel.request(prompt, 17)
      const [item] = pending()
      if (Object.hasOwn(prompt, 'subtitle') && prompt.subtitle !== undefined) expect(item.prompt).toMatchObject({ subtitle: prompt.subtitle })
      else expect(Object.hasOwn(item.prompt, 'subtitle')).toBe(Object.hasOwn(prompt, 'subtitle'))
      respond(item.id, { status: 'dismissed' }); expect(await result).toEqual({ status: 'dismissed' })
      expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
    }
  })
  it('includes subtitle in the direct MAIN exact JSON cap before starting a timer', async () => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const prompt = { kind: 'show_card' as const, title: 'B', subtitle: '\u0001'.repeat(200), body: '\u0001'.repeat(4000), fields, actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    const remaining = 32768 - Buffer.byteLength(JSON.stringify(prompt), 'utf8')
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(Buffer.byteLength(JSON.stringify(prompt), 'utf8')).toBe(32768)
    const result = channel.request(prompt, 17), [item] = pending()
    expect(item.prompt).toEqual(prompt)
    respond(item.id, { status: 'dismissed' }); expect(await result).toEqual({ status: 'dismissed' })
    fields[2].value += 'x'
    await expect(channel.request(prompt, 17)).rejects.toThrow('Invalid bounded')
    expect(pending()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it('carries bounded read-only fields through the real choice wait, detaches views and accepts only the offered ID', async () => {
    const { createAgentThreadToolProvider } = await import('./agentThreadTools')
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [], interactions: channel })
    const fields = [{ label: 'Status', value: '<img src="https://external.invalid">', inline: true }, { label: 'Next', value: 'Choice is not edit authorization', inline: false }]
    const actions = [{ id: 'approve', label: 'Feedback only' }, { id: 'no', label: 'Other feedback' }]
    const result = provider.callTool('show_card', { title: 'Choice fields', fields, actions, timeout_s: 17 }, { route, runId: 'choice-fields', toolCallId: 'choice-fields-call' })
    const outcome = result.then(value => ({ value }), error => ({ error }))
    const [item] = pending()
    expect(item?.prompt).toEqual({ kind: 'show_card', title: 'Choice fields', fields, actions })
    expect(item.expiresAt).toBe(Date.now() + 17000)
    fields[0].value = 'Changed source'; actions[0].id = 'changed'
    expect(item.prompt.kind).toBe('show_card')
    if (item.prompt.kind === 'show_card') {
      item.prompt.actions[0].id = 'changed view'
      item.prompt.fields![0].value = 'Changed view'
    }
    expect(pending()[0].prompt).toMatchObject({ fields: [{ value: '<img src="https://external.invalid">' }, { value: 'Choice is not edit authorization' }], actions: [{ id: 'approve' }, { id: 'no' }] })
    expect(() => respond(item.id, { status: 'answered', actionId: 'changed' })).toThrow('Invalid')
    respond(item.id, { status: 'answered', actionId: 'approve' })
    const settled = await outcome
    expect(settled).toMatchObject({ value: { content: JSON.stringify({ status: 'answered', actionId: 'approve' }) } })
    expect(pending()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('validates explicit choice fields before retaining input or starting a timer, including direct MAIN channel calls', async () => {
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const base = { kind: 'show_card' as const, title: 'Choice', actions }
    for (const patch of [
      { fields: null }, { fields: [null] }, { fields: [{ label: 'x', value: 1 }] },
      { fields: [{ label: 'x', value: 'x', approved: true }] }, { fields: [{ label: '😀'.repeat(101), value: '' }] },
      { fields: [{ label: '', value: '😀'.repeat(501) }] }, { fields: [{ ['__proto__']: { label: 'Inherited' }, value: '' }] },
      { fields: Array.from({ length: 9 }, () => ({ label: '', value: '' })) },
      { fields: Array.from({ length: 4 }, () => ({ label: 'x'.repeat(200), value: 'x'.repeat(1000) })) },
      { fields: [], actions: [] },
      { fields: [], actions: [{ id: 'a', label: 'A', url: 'https://external.invalid' }, actions[1]] },
      { fields: [], grantsPermission: true }, { fields: [], title: '😀'.repeat(101) },
      { fields: [], body: '😀'.repeat(2001) },
      { fields: Array.from({ length: 4 }, () => ({ label: '', value: '\u0001'.repeat(1000) })), body: '\u0001'.repeat(4000) }
    ]) {
      await expect(channel.request({ ...base, ...patch } as never, 17)).rejects.toThrow('Invalid bounded')
      expect(pending()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    }
    const result = channel.request({ ...base, fields: [] }, 17)
    const [item] = pending()
    expect(item.prompt).toMatchObject({ kind: 'show_card', fields: [] })
    respond(item.id, { status: 'dismissed' }); expect(await result).toEqual({ status: 'dismissed' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each((['answer', 'dismiss', 'expiry', 'stale-expiry', 'abort', 'navigation', 'crash', 'destroyed'] as const).flatMap(kind => [1, 2].flatMap(count => [false, true].flatMap(withFooter => [false, true].flatMap(withAccent => [false, true].flatMap(withStyle => [false, true].flatMap(withIcon => [false, true].map(withBody => [kind, count, withFooter, withAccent, withStyle, withIcon, withBody] as const))))))))('keeps subtitle/fielded choice ownership, one-shot answers and timer cleanup on %s actions=%s footer=%s accent=%s actionStyle=%s icon=%s body=%s', async (kind, count, withFooter, withAccent, withStyle, withIcon, withBody) => {
    const { createAgentThreadToolProvider } = await import('./agentThreadTools')
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [], interactions: channel })
    const controller = new AbortController()
    const body = '**Context only**\n\nBearer a**RAW_SUFFIX**\n\n[No authority](https://external.invalid/no-open)\n\n- [x] Not consent'
    const result = provider.callTool('show_card', { title: 'Field context only', ...(withBody ? { body } : {}), ...(withIcon ? { icon: '✓👩🏽‍💻' } : {}), ...(withAccent ? { accent: 'danger' } : {}), subtitle: 'Read-only subtitle, not permission', ...(withFooter ? { footer: 'Read-only closing context, never permission' } : {}), fields: [{ label: 'Status', value: 'Not execution permission' }], actions: [{ id: 'approve', label: 'Feedback only', ...(withStyle ? { style: 'primary' } : {}) }, { id: 'no', label: 'Other feedback', ...(withStyle ? { style: 'danger' } : {}) }].slice(0, count), timeout_s: 1 }, { route, runId: 'choice-lifetime', signal: controller.signal }).then(value => JSON.parse(value.content), () => 'cancelled')
    const [item] = pending()
    if (withBody) {
      expect(item.prompt).toMatchObject({ body })
      if (item.prompt.kind === 'show_card') item.prompt.body = 'Changed display copy'
      expect(pending()[0].prompt).toMatchObject({ body })
      expect(() => respond(item.id, { status: 'answered', actionId: 'approve', body } as never)).toThrow('Invalid')
    }
    if (withIcon) expect(item.prompt).toMatchObject({ icon: '✓👩🏽‍💻' })
    if (withStyle) expect(item.prompt).toMatchObject({ actions: count === 1 ? [{ id: 'approve', style: 'primary' }] : [{ id: 'approve', style: 'primary' }, { id: 'no', style: 'danger' }] })
    if (withAccent) expect(item.prompt).toMatchObject({ accent: 'danger' })
    if (withFooter) expect(item.prompt).toMatchObject({ footer: 'Read-only closing context, never permission' })
    expect(vi.getTimerCount()).toBe(1)
    for (const other of [{ ...scope, conversationId: 'other' }, { ...scope, route: { ...route, threadId: 'other' } }]) {
      expect(manager.list(other, invocation('listAgentInteractions'))).toEqual([])
      expect(() => manager.resolve({ ...other, interactionId: item.id, answer: { status: 'answered', actionId: 'approve' } }, invocation('resolveAgentInteraction'))).toThrow('not active')
    }
    expect(() => manager.list(scope, { ...invocation('listAgentInteractions'), senderId: 72 })).toThrow()
    for (const answer of [
      { status: 'answered', actionId: 'not-offered' }, { status: 'answered', values: { Status: 'changed' } },
      { status: 'answered', actionId: 'approve', values: {} }, { status: 'answered', actionId: 'approve', approved: true },
      { status: 'answered', text: 'approve' }, { status: 'dismissed', approved: true }, { status: 'answered', actionId: 'approve', footer: '' }, { status: 'answered', actionId: 'approve', accent: 'success' }, { status: 'answered', actionId: 'approve', style: 'primary' }, { status: 'answered', actionId: 'approve', icon: '✓' }
    ]) expect(() => respond(item.id, answer as never)).toThrow('Invalid')
    expect(pending()).toHaveLength(1)
    if (kind === 'answer') respond(item.id, { status: 'answered', actionId: 'approve' })
    else if (kind === 'dismiss') respond(item.id, { status: 'dismissed' })
    else if (kind === 'expiry') {
      await vi.advanceTimersByTimeAsync(999); expect(pending()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
    } else if (kind === 'stale-expiry') {
      vi.setSystemTime(Date.now() + 1000)
      expect(() => respond(item.id, { status: 'answered', actionId: 'approve' })).toThrow('expired')
    } else if (kind === 'abort') controller.abort()
    else sender.emit(kind === 'navigation' ? 'did-start-navigation' : kind === 'crash' ? 'render-process-gone' : 'destroyed')
    expect(await result).toEqual(kind === 'answer' ? { status: 'answered', actionId: 'approve' } : kind === 'dismiss' ? { status: 'dismissed' } : ['expiry', 'stale-expiry'].includes(kind) ? { status: 'timeout' } : 'cancelled')
    expect(pending()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(() => respond(item.id, { status: 'answered', actionId: 'approve' })).toThrow('not active')
  })
  it('exposes team message tools only to matching local member turns and requires their live admission', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const source = { scope: 'team-scope', thread: route.threadId, lead: 'leader', member: scope.conversationId }
    const req: LLMChatReq = { ...scope, messages: [], teamMember: source }
    const enqueue = vi.fn(async () => ({ requestId: 'request-1' }))
    const assertNotEnded = vi.fn()
    const settings = { local: true, terminalEnabled: false, teamMessages: { enqueue, assertNotEnded } }
    const first = prepareCanvasAgentTools(req, invocation(), settings)
    const other = prepareCanvasAgentTools(req, invocation(), settings)
    try {
      expect(first.toolProvider!.listTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['send_message', 'send_channel']))
      expect(first.request.skillRuntime?.bindings?.[0]?.toolNames).toContain('send_message')
      const args = { recipient: 'other', text: 'hello' }, context = { route, runId: 'test' }
      const invoke = (prepared: typeof first, name: string, input: Record<string, unknown>) => prepared.toolProvider!.callTool(name, input, context)
      await expect(invoke(first, 'send_message', args)).rejects.toThrow('live Agent thread invocation')
      await expect(other.admission!.run('send_message', undefined, () => invoke(first, 'send_message', args))).rejects.toThrow('live Agent thread invocation')
      const result = await first.admission!.run('send_message', undefined, () => invoke(first, 'send_message', args))
      expect(JSON.parse(result.content)).toEqual({ status: 'queued', requestId: 'request-1' })
      expect(enqueue).toHaveBeenCalledWith({ source, kind: 'message', hop: 1, recipient: 'other', text: 'hello' }, expect.objectContaining({ assertLive: expect.any(Function) }), undefined)
      expect(assertNotEnded).toHaveBeenCalledWith(source)
      assertNotEnded.mockImplementationOnce(() => { throw Error('ended') })
      await expect(first.admission!.run('send_channel', undefined, () => first.toolProvider!.callTool('send_channel', { text: 'hi' }, context))).rejects.toThrow('ended')
      expect(enqueue).toHaveBeenCalledTimes(1)
      const wrongMember = prepareCanvasAgentTools({ ...req, teamMember: { ...source, member: 'another' } }, invocation(), settings)
      const noMember = prepareCanvasAgentTools({ ...scope, messages: [] }, invocation(), settings)
      const relayed = prepareCanvasAgentTools({ ...req, teamMessageHop: 1 }, invocation(), settings)
      const lastHop = prepareCanvasAgentTools({ ...req, teamMessageHop: 2 }, invocation(), settings)
      const invalidHop = prepareCanvasAgentTools({ ...req, teamMessageHop: 3 as 1 }, invocation(), settings)
      try {
        expect(wrongMember.toolProvider!.listTools().map(tool => tool.name)).not.toContain('send_message')
        expect(noMember.toolProvider!.listTools().map(tool => tool.name)).not.toContain('send_message')
        expect(relayed.toolProvider!.listTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['send_message', 'send_channel']))
        await relayed.admission!.run('send_message', undefined, () => invoke(relayed, 'send_message', args))
        expect(enqueue).toHaveBeenLastCalledWith({ source, kind: 'message', hop: 2, recipient: 'other', text: 'hello' }, expect.objectContaining({ assertLive: expect.any(Function) }), undefined)
        expect(lastHop.toolProvider!.listTools().map(tool => tool.name)).not.toContain('send_message')
        expect(lastHop.toolProvider!.listTools().map(tool => tool.name)).not.toContain('send_channel')
        expect(invalidHop.toolProvider!.listTools().map(tool => tool.name)).not.toContain('send_message')
      } finally { wrongMember.dispose!(); noMember.dispose!(); relayed.dispose!(); lastHop.dispose!(); invalidHop.dispose!() }
      expect(prepareCanvasAgentTools(req, invocation(), { ...settings, local: false }).toolProvider).toBeUndefined()
      expect(prepareCanvasAgentTools({ ...req, skillRuntime: { skillId: 'restricted' } }, invocation(), settings).toolProvider).toBeUndefined()
    } finally { first.dispose!(); other.dispose!() }
  })

  it('adds image_gen only to an eligible document and rejects inherited, cross-thread or model-supplied authority', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const generator = { approval: { backend: 'codex-json-oauth' as const, endpoint: 'https://chatgpt.com/backend-api/codex', profileId: 'selected' }, assertCurrent: vi.fn(), generate: vi.fn() }
    const createImageGenerator = vi.fn(() => generator)
    const settings = { local: true, terminalEnabled: false, createImageGenerator }
    const req = { ...scope, messages: [] }
    expect(prepareCanvasAgentTools(req, invocation(), { ...settings, local: false }).toolProvider).toBeUndefined()
    expect(prepareCanvasAgentTools({ ...req, skillRuntime: { skillId: 'explicit' } }, invocation(), settings).toolProvider).toBeUndefined()
    expect(createImageGenerator).not.toHaveBeenCalled()
    const first = prepareCanvasAgentTools(req, invocation(), settings)
    const second = prepareCanvasAgentTools(req, invocation(), settings)
    const args = { prompt: 'fixture' }, context = { route, runId: 'image-authority' }
    try {
      expect(first.toolProvider!.listTools().map(tool => tool.name)).toContain('image_gen')
      await expect(first.toolProvider!.callTool('image_gen', args, context)).rejects.toThrow('live Agent thread invocation')
      await expect(first.admission!.run('image_gen', undefined, () => first.toolProvider!.callTool('image_gen', args, { ...context, route: { ...route, threadId: 'foreign' } }))).rejects.toThrow('outside')
      await expect(first.admission!.run('image_gen', undefined, () => second.toolProvider!.callTool('image_gen', args, context))).rejects.toThrow('live Agent thread invocation')
      await expect(first.admission!.run('image_gen', undefined, () => first.toolProvider!.callTool('image_gen', { ...args, confirmed: true }, context))).rejects.toThrow('Invalid')
      let release!: () => void
      let late!: Promise<unknown>
      await expect(first.admission!.run('image_gen', undefined, async () => {
        late = new Promise<void>(resolve => { release = resolve }).then(() => first.toolProvider!.callTool('image_gen', args, context))
      })).rejects.toMatchObject({ code: 'IMAGE_RESULT_RESTORE_FAILED' })
      release()
      await expect(late).rejects.toThrow('live Agent thread invocation')
      expect(generator.generate).not.toHaveBeenCalled()
      sender.emit('did-start-navigation')
      await expect(first.admission!.run('image_gen', undefined, async () => ({ content: 'never' }))).rejects.toThrow('no longer active')
    } finally { first.dispose!(); second.dispose!() }
  })

  it.each([false, true])('GIF capability=%s is reflected in this request schema and guidance under existing owner guards', async gifEnabled => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const generator = { gifEnabled, approval: { backend: 'codex-json-oauth' as const, endpoint: 'https://chatgpt.com/backend-api/codex', profileId: 'selected' }, assertCurrent: vi.fn(), generate: vi.fn() }
    const request: LLMChatReq = { ...scope, messages: [] }
    const options = { local: true, terminalEnabled: false, createImageGenerator: () => generator }
    const first = prepareCanvasAgentTools(request, invocation(), options)
    const other = prepareCanvasAgentTools(request, invocation(), options)
    const input = { prompt: 'animated', gif: {} }, context = { route, runId: 'gif-owner' }
    try {
      const tool = first.toolProvider!.listTools().find(tool => tool.name === 'image_gen')!
      if (gifEnabled) {
        expect(tool.inputSchema).toHaveProperty('properties.gif')
        expect(first.request.systemPrompt).toContain('explicitly enabled GIF OUTPUT')
      } else {
        expect(tool.inputSchema).not.toHaveProperty('properties.gif')
        expect(first.request.systemPrompt).toContain('GIF output is disabled')
      }
      expect(first.request.systemPrompt).toContain('GIF/animation inputs')
      await expect(first.toolProvider!.callTool('image_gen', input, context)).rejects.toThrow('live Agent thread invocation')
      await expect(first.admission!.run('image_gen', undefined, () => other.toolProvider!.callTool('image_gen', input, context))).rejects.toThrow('live Agent thread invocation')
      await expect(first.admission!.run('image_gen', undefined, () => first.toolProvider!.callTool('image_gen', input, { ...context, route: { ...route, threadId: 'foreign' } }))).rejects.toThrow('outside')
      sender.emit('did-start-navigation')
      await expect(first.admission!.run('image_gen', undefined, () => first.toolProvider!.callTool('image_gen', input, context))).rejects.toThrow('no longer active')
      expect(generator.generate).not.toHaveBeenCalled()
    } finally { first.dispose!(); other.dispose!() }
  })

  it('keeps recent-image edits under the same request owner, foreign route and navigation guards', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const generator = { approval: { backend: 'codex-json-oauth' as const, endpoint: 'https://chatgpt.com/backend-api/codex', profileId: 'selected' }, assertCurrent: vi.fn(), generate: vi.fn(), edit: vi.fn() }
    const settings = { local: true, terminalEnabled: false, createImageGenerator: () => generator }
    const request: LLMChatReq = { ...scope, messages: [] }
    const first = prepareCanvasAgentTools(request, invocation(), settings)
    const other = prepareCanvasAgentTools(request, invocation(), settings)
    const input = { prompt: 'edit only owned image', num_last_images_to_include: 1 }, context = { route, runId: 'edit-owner' }
    try {
      expect(first.request.systemPrompt).toContain('num_last_images_to_include')
      expect(first.request.systemPrompt).toContain('PNG/JPEG')
      expect(first.request.systemPrompt).not.toContain('Local/recent reference edits and GIF are not admitted')
      await expect(first.toolProvider!.callTool('image_gen', input, context)).rejects.toThrow('live Agent thread invocation')
      await expect(first.admission!.run('image_gen', undefined, () => other.toolProvider!.callTool('image_gen', input, context))).rejects.toThrow('live Agent thread invocation')
      await expect(first.admission!.run('image_gen', undefined, () => first.toolProvider!.callTool('image_gen', input, { ...context, route: { ...route, threadId: 'other' } }))).rejects.toThrow('outside')
      sender.emit('did-start-navigation')
      await expect(first.admission!.run('image_gen', undefined, () => first.toolProvider!.callTool('image_gen', input, context))).rejects.toThrow('no longer active')
      expect(generator.edit).not.toHaveBeenCalled()
      expect(generator.generate).not.toHaveBeenCalled()
    } finally { first.dispose!(); other.dispose!() }
  })

  it('adds HTML only under its independent local-thread opt-in and rechecks live request authority', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const req = { ...scope, messages: [] }, args = { title: 'App', html: '<p>ok</p>' }
    let enabledFlag = true
    const disabled = prepareCanvasAgentTools(req, invocation(), { local: true, terminalEnabled: true, scriptToolsEnabled: () => true, shellToolsEnabled: () => true })
    const enabled = prepareCanvasAgentTools(req, invocation(), { local: true, terminalEnabled: false, htmlAppsEnabled: () => enabledFlag })
    try {
      expect(JSON.stringify(disabled.toolProvider!.listTools().find(tool => tool.name === 'show_app')!.inputSchema)).not.toContain('wait_for')
      expect(JSON.stringify(enabled.toolProvider!.listTools().find(tool => tool.name === 'show_app')!.inputSchema)).toContain('wait_for')
      expect(prepareCanvasAgentTools(req, invocation(), { local: false, terminalEnabled: false, htmlAppsEnabled: () => true }).toolProvider).toBeUndefined()
      expect(prepareCanvasAgentTools({ ...req, skillRuntime: { skillId: 'external' } }, invocation(), { local: true, terminalEnabled: false, htmlAppsEnabled: () => true }).toolProvider).toBeUndefined()
      await expect(disabled.admission!.run('show_app', undefined, () => disabled.toolProvider!.callTool('show_app', args, { route, runId: 'disabled' }))).rejects.toThrow('Invalid arguments')
      await expect(enabled.toolProvider!.callTool('show_app', args, { route, runId: 'outside' })).rejects.toThrow('live Agent thread invocation')
      enabledFlag = false
      await expect(enabled.admission!.run('show_app', undefined, () => enabled.toolProvider!.callTool('show_app', args, { route, runId: 'revoked' }))).rejects.toThrow('disabled')
      sender.emit('did-start-navigation')
      await expect(enabled.admission!.run('show_app', undefined, async () => ({ content: 'never' }))).rejects.toThrow('no longer active')
    } finally { disabled.dispose!(); enabled.dispose!() }
  })
  it('exposes general shell only under its independent flag and live document, not Python or terminal grants', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const req = { ...scope, messages: [] }
    const readOnly = prepareCanvasAgentTools(req, invocation(), { local: true, terminalEnabled: true, scriptToolsEnabled: () => true })
    const enabled = prepareCanvasAgentTools(req, invocation(), { local: true, terminalEnabled: false, shellToolsEnabled: () => true })
    try {
      expect(readOnly.toolProvider!.listTools().map((tool) => tool.name)).not.toContain('shell.execute')
      expect(enabled.toolProvider!.listTools().map((tool) => tool.name)).toContain('shell.execute')
      expect(prepareCanvasAgentTools(req, invocation(), { local: false, terminalEnabled: false, shellToolsEnabled: () => true }).toolProvider).toBeUndefined()
      expect(prepareCanvasAgentTools({ ...req, skillRuntime: { skillId: 'external' } }, invocation(), { local: true, terminalEnabled: false, shellToolsEnabled: () => true }).toolProvider).toBeUndefined()
      await expect(enabled.toolProvider!.callTool('shell.execute', { code: 'echo x' }, { route, runId: 'foreign', workspaceRootDir: 'C:/untrusted' })).rejects.toThrow('live Agent thread invocation')
      sender.emit('did-start-navigation')
      await expect(enabled.admission!.run('shell.execute', undefined, async () => ({ content: 'never' }))).rejects.toThrow('no longer active')
    } finally { enabled.dispose!(); readOnly.dispose!() }
  })
  it('keeps the first skill-context guard when a caller tries to prepare again under changed opt-ins', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const loadSkills = vi.fn(async () => ({ skills: [], truncated: false }))
    let enabled = true
    const prepared = prepareCanvasAgentTools({ ...scope, messages: [] }, invocation(), { local: true, terminalEnabled: false, loadSkills, skillContextConfig: () => ({ index: enabled, paths: false, revision: 'same-registry' }) })
    try {
      const first = await prepared.prepareSkillContext!()
      expect(JSON.parse(first).indexEnabled).toBe(true); expect(loadSkills).toHaveBeenCalledOnce()
      enabled = false
      await expect(prepared.prepareSkillContext!()).rejects.toThrow('settings changed')
      expect(() => prepared.assertSkillContext!()).toThrow('settings changed')
      expect(loadSkills).toHaveBeenCalledOnce()
    } finally { prepared.dispose!() }
  })
  it('cancels pending procedural discovery on navigation without reusing it from another request', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    let resolve!: (value: { skills: []; truncated: boolean }) => void
    const loadSkills = vi.fn(() => new Promise<{ skills: []; truncated: boolean }>((r) => { resolve = r }))
    const prepared = prepareCanvasAgentTools({ ...scope, messages: [] }, invocation(), { local: true, terminalEnabled: false, loadSkills })
    try {
      expect(prepared.toolProvider!.listTools().map((tool) => tool.name)).toContain('skill')
      const pending = prepared.admission!.run('info', undefined, () => prepared.toolProvider!.callTool('info', { kind: 'skill' }, { route, runId: 'skills' })).catch((error) => error)
      expect(loadSkills).toHaveBeenCalledOnce()
      sender.emit('did-start-navigation')
      expect(await pending).toBeInstanceOf(Error)
      await expect(prepared.toolProvider!.callTool('skill', { name: 'x' }, { route, runId: 'new' })).rejects.toThrow()
      resolve({ skills: [], truncated: false }); await Promise.resolve()
    } finally { resolve?.({ skills: [], truncated: false }); prepared.dispose!() }
  })

  it('binds per-service MCP tools to an eligible document, never to remote/explicit skills or an inherited late invocation', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const { DEFAULT_CONFIG } = await import('@shared/config/config')
    const config = { ...DEFAULT_CONFIG, mcp_config: { ...DEFAULT_CONFIG.mcp_config, client: { servers: [{ id: 'allowed', enabled: true, transport: 'stdio' as const, command: 'configured-only', agentThreadAccess: 'call' as const, agentThreadManage: true }] } } }
    const opts = { local: true, terminalEnabled: false, mcpConfig: () => config }
    const first = prepareCanvasAgentTools<import('@shared/api/svcLLMProxy').LLMChatReq>({ ...scope, messages: [] }, invocation(), opts)
    try {
      expect(first.request.skillRuntime?.bindings?.[0]?.toolNames).toEqual(expect.arrayContaining(['mcp_list', 'mcp_call', 'mcp_connect', 'mcp_disconnect']))
      expect(prepareCanvasAgentTools({ ...scope, messages: [] }, invocation(), { ...opts, local: false }).toolProvider).toBeUndefined()
      expect(prepareCanvasAgentTools({ ...scope, messages: [], skillRuntime: { skillId: 'external' } }, invocation(), opts).toolProvider).toBeUndefined()
      await expect(first.toolProvider!.callTool('mcp_list', {}, { route, runId: 'outside' })).rejects.toThrow('live Agent thread invocation')
      await expect(first.toolProvider!.callTool('mcp_connect', { server: 'allowed' }, { route, runId: 'outside' })).rejects.toThrow('live Agent thread invocation')
      sender.emit('did-start-navigation')
      await expect(first.admission!.run('mcp_connect', undefined, async () => ({ content: 'not reached' }))).rejects.toThrow('no longer active')
      await expect(first.admission!.run('mcp_list', undefined, async () => ({ content: 'not reached' }))).rejects.toThrow('no longer active')
    } finally { first.dispose!() }
  })

  it('validates app feedback against the stored document, rejects authority extras and isolates scope', async () => {
    const document = { title: 'Report', blocks: [{ kind: 'text' as const, text: 'data' }], fields: [{ kind: 'select' as const, id: 'choice', label: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }
    const result = channel.request({ kind: 'show_app', document }, 30)
    document.fields[0].options[0].id = 'changed'
    const [item] = pending()
    expect(item.prompt).toMatchObject({ kind: 'show_app', document: { fields: [{ options: [{ id: 'a' }, { id: 'b' }] }] } })
    expect(() => respond(item.id, { status: 'answered', values: { choice: 'changed' } })).toThrow('Invalid')
    expect(() => respond(item.id, { status: 'answered', values: { choice: 'a', approved: true } })).toThrow('Invalid')
    expect(() => respond(item.id, { status: 'answered', text: 'a' })).toThrow('Invalid')
    expect(() => manager.resolve({ ...scope, conversationId: 'other', interactionId: item.id, answer: { status: 'answered', values: { choice: 'a' } } }, invocation('resolveAgentInteraction'))).toThrow('not active')
    respond(item.id, { status: 'answered', values: { choice: 'a' } })
    expect(await result).toEqual({ status: 'answered', values: { choice: 'a' } })
    expect(() => respond(item.id, { status: 'answered', values: { choice: 'a' } })).toThrow('not active')
  })
  it.each(['abort', 'navigation', 'expiry'])('removes declarative displays on %s and rejects late values', async (kind) => {
    const controller = new AbortController()
    const result = channel.request({ kind: 'show_app', document: { title: 'Report', blocks: [{ kind: 'text', text: 'data' }] } }, 1, controller.signal).catch(() => 'cancelled')
    const [item] = pending()
    if (kind === 'abort') controller.abort()
    else if (kind === 'navigation') sender.emit('did-start-navigation')
    else await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toEqual(kind === 'expiry' ? { status: 'timeout' } : 'cancelled')
    expect(pending()).toEqual([])
    expect(() => respond(item.id, { status: 'answered', values: {} })).toThrow('not active')
  })
  it('bounds global app documents and rejects invalid app payloads before retention', async () => {
    const channels: AgentThreadInteractionChannel[] = [], promises: Promise<unknown>[] = []
    const document = { title: 'Report', blocks: [{ kind: 'text' as const, text: 'data' }] }
    sender.setMaxListeners(0)
    try {
      await expect(channel.request({ kind: 'show_app', document: { ...document, html: '<iframe>' } } as never, 30)).rejects.toThrow('Invalid')
      for (let i = 0; i < 8; i++) {
        const item = manager.create({ route, conversationId: `app-${i}`, messages: [] }, invocation())!
        channels.push(item); promises.push(item.request({ kind: 'show_app', document }, 30).catch(() => undefined))
      }
      await expect(channel.request({ kind: 'show_app', document }, 30)).rejects.toThrow('display capacity')
    } finally { channels.forEach((item) => item.dispose()); await Promise.all(promises) }
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['ask_user', 'show_card'] as const)('maps timeout_s through the tool into the real scoped %s timer and clears expiry/Stop/document waits', async name => {
    const { createAgentThreadToolProvider } = await import('./agentThreadTools')
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: () => undefined, listVisibleTools: () => provider.listTools(), interactions: channel })
    const args = name === 'ask_user' ? { question: 'Reply before expiry', timeout_s: 1 } : { title: 'Reply before expiry', timeout_s: 1, actions: [{ id: 'approve', label: 'Feedback' }, { id: 'deny', label: 'Other feedback' }] }
    const now = Date.now()
    const result = provider.callTool(name, args, { route, runId: 'alias-run', toolCallId: 'alias-expiry' })
    const [item] = pending()
    expect(item.prompt.kind).toBe(name)
    expect(item.expiresAt).toBe(now + 1000)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(pending()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.parse((await result).content)).toEqual({ status: 'timeout' })
    expect(pending()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(() => respond(item.id, { status: 'dismissed' })).toThrow('not active')
    const controller = new AbortController()
    const stopped = provider.callTool(name, args, { route, runId: 'alias-run', toolCallId: 'alias-stop', signal: controller.signal }).then(() => 'unexpected', () => 'cancelled')
    const [stoppedItem] = pending()
    controller.abort()
    expect(await stopped).toBe('cancelled')
    expect(pending()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(() => respond(stoppedItem.id, { status: 'dismissed' })).toThrow('not active')
    const replaced = provider.callTool(name, args, { route, runId: 'alias-run', toolCallId: 'alias-document' }).then(() => 'unexpected', () => 'cancelled')
    sender.emit('did-start-navigation')
    expect(await replaced).toBe('cancelled')
    expect(pending()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for one answer and removes the prompt; duplicate replies cannot settle another call', async () => {
    const result = channel.request(question, 60)
    const [item] = pending()
    expect(item.prompt).toEqual(question)
    respond(item.id, { status: 'answered', text: 'Blue' })
    expect(await result).toEqual({ status: 'answered', text: 'Blue' })
    expect(pending()).toEqual([])
    expect(() => respond(item.id, { status: 'answered', text: 'Red' })).toThrow('not active')
  })
  it('isolates conversations, panes, projects and renderer identities', async () => {
    const result = channel.request(question, 60)
    const [item] = pending()
    for (const other of [
      { ...scope, conversationId: 'other' },
      { ...scope, route: { ...route, threadId: 'other' } }
    ]) {
      expect(manager.list(other, invocation('listAgentInteractions'))).toEqual([])
      expect(() => manager.resolve({ ...other, interactionId: item.id, answer: { status: 'dismissed' } }, invocation('resolveAgentInteraction'))).toThrow('not active')
    }
    expect(() => manager.list({ ...scope, route: { ...route, scopeId: 'other' } }, invocation('listAgentInteractions'))).toThrow('denied')
    expect(() => manager.list(scope, { ...invocation('listAgentInteractions'), senderId: 72 })).toThrow()
    respond(item.id, { status: 'dismissed' })
    expect(await result).toEqual({ status: 'dismissed' })
  })
  it('rejects missing/remote/iframe and wrong-method callers', () => {
    expect(() => manager.list(scope)).toThrow('denied')
    expect(() => manager.list(scope, invocation('chat'))).toThrow('denied')
    expect(() => manager.list(scope, { ...invocation('listAgentInteractions'), isMainFrame: false })).toThrow()
    expect(manager.create({ ...scope, messages: [], skillRuntime: { skillId: 'external' } }, invocation())).toBeUndefined()
    expect(manager.create({ ...scope, messages: [] })).toBeUndefined()
  })
  it('accepts only the displayed action IDs and rejects fake approval fields', async () => {
    const result = channel.request({ kind: 'show_card', title: 'Pick', actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, 60)
    const [item] = pending()
    expect(() => respond(item.id, { status: 'answered', actionId: 'execute-other' })).toThrow('Invalid')
    expect(() => respond(item.id, { status: 'answered', text: 'yes' })).toThrow('Invalid')
    expect(() => respond(item.id, { status: 'answered', actionId: 'a', approved: true } as never)).toThrow('Invalid')
    respond(item.id, { status: 'answered', actionId: 'a' })
    expect(await result).toEqual({ status: 'answered', actionId: 'a' })
  })
  it('rejects blank and oversized answers and detached snapshots cannot change the question', async () => {
    const result = channel.request(question, 60)
    const [item] = pending()
    item.prompt = { kind: 'ask_user', question: 'forged' }
    expect(() => respond(item.id, { status: 'answered', text: ' ' })).toThrow('Invalid')
    expect(() => respond(item.id, { status: 'answered', text: 'a'.repeat(4001) })).toThrow('Invalid')
    expect(pending()[0].prompt).toEqual(question)
    respond(item.id, { status: 'dismissed' })
    await result
  })
  it('times out without interpreting silence as consent', async () => {
    const result = channel.request(question, 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual({ status: 'timeout' })
    expect(pending()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects stale answers even if the timer callback has not run yet', async () => {
    const result = channel.request(question, 1)
    const [item] = pending()
    vi.setSystemTime(Date.now() + 2000)
    expect(() => respond(item.id, { status: 'answered', text: 'late' })).toThrow('expired')
    expect(await result).toEqual({ status: 'timeout' })
  })
  it.each(['abort', 'dispose', 'navigation', 'crash', 'destroyed'])('cleans up on %s and rejects late replies', async (kind) => {
    const controller = new AbortController()
    const result = channel.request(question, 60, controller.signal).then(() => 'unexpected', () => 'cancelled')
    const [item] = pending()
    if (kind === 'abort') controller.abort()
    else if (kind === 'dispose') channel.dispose()
    else sender.emit(kind === 'navigation' ? 'did-start-navigation' : kind === 'crash' ? 'render-process-gone' : 'destroyed')
    expect(await result).toBe('cancelled')
    expect(pending()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(() => respond(item.id, { status: 'answered', text: 'late' })).toThrow('not active')
  })
  it('rechecks the live URL before delivering an answer', async () => {
    const result = channel.request(question, 60).catch(() => undefined)
    const [item] = pending()
    sender.getURL = () => url.replace('project', 'other')
    expect(() => respond(item.id, { status: 'answered', text: 'late' })).toThrow('denied')
    channel.dispose()
    await result
  })
  it('ignores subframe navigation but revokes main-frame reloads', async () => {
    sender.emit('did-start-navigation', { isMainFrame: false })
    sender.emit('did-start-navigation', {}, 'https://frame.invalid', false, false)
    expect(() => channel.assertLive()).not.toThrow()
    const result = channel.request(question, 60).catch(() => 'cancelled')
    sender.emit('did-start-navigation', { isMainFrame: true })
    expect(await result).toBe('cancelled')
    expect(pending()).toEqual([])
  })
  it('invalidates before the first tool on same-URL reload and removes listeners', async () => {
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    sender.emit('did-start-navigation')
    await expect(channel.request(question, 60)).rejects.toThrow('no longer active')
    expect(() => channel.assertLive()).toThrow('no longer active')
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('revokes info along with interaction tools after navigation', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const prepared = prepareCanvasAgentTools({ ...scope, messages: [{ role: 'user', content: 'remember blue' }] }, invocation(), { local: true, terminalEnabled: false })
    try {
      const names = prepared.toolProvider!.listTools().map(tool => tool.name)
      expect(names).toEqual(expect.arrayContaining(['ask_user', 'show_card', 'info']))
      expect(names).toContain('search_memory'); expect(names).toContain('scratchpad')
      const read = await prepared.admission!.run('info', undefined, () => prepared.toolProvider!.callTool('info', {}, { route, runId: 'r' }))
      expect(read.content).toContain('ask_user')
      sender.emit('did-start-navigation')
      for (const name of ['info', 'ask_user', 'search_memory', 'scratchpad']) {
        await expect(prepared.admission!.run(name, undefined, () => prepared.toolProvider!.callTool(name, {}, { route, runId: 'r' }))).rejects.toThrow('no longer active')
      }
    } finally { prepared.dispose!() }
  })
  it('keeps info to the effective allowlist, describes admitted search and scratchpad without reading stored contents and rejects invalid get', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const tools = [
      { name: 'files.read', description: 'workspace text', inputSchema: { type: 'object' } },
      { name: 'terminal.run', description: 'must not be exposed', inputSchema: { type: 'object' } }
    ]
    const first = prepareCanvasAgentTools({ ...scope, messages: [{ role: 'user', content: 'first-only-token' }] }, invocation(), { local: true, terminalEnabled: false, listTools: () => tools })
    const second = prepareCanvasAgentTools({ route, conversationId: 'second', messages: [{ role: 'user', content: 'second-only-token' }] }, invocation(), { local: true, terminalEnabled: false, listTools: () => tools })
    try {
      const call = (prepared: typeof first, name: string, args: Record<string, unknown>) => prepared.admission!.run(name, undefined, () => prepared.toolProvider!.callTool(name, args, { route, runId: 'r' }))
      const info = await call(first, 'info', {})
      expect(info.content).toContain('files.read')
      expect(info.content).toContain('ask_user')
      expect(info.content).not.toContain('terminal.run')
      await expect(call(first, 'info', { name: 'terminal.run' })).rejects.toThrow('not available')
      for (const prepared of [first, second]) {
        expect(prepared.toolProvider!.listTools().map(tool => tool.name)).toContain('search_memory')
        const description = JSON.parse((await call(prepared, 'info', { name: 'search_memory' })).content)
        expect(description).toMatchObject({ name: 'search_memory', grantsPermission: false })
        expect(description).not.toHaveProperty('matches')
        expect(prepared.toolProvider!.listTools().map(tool => tool.name)).toContain('scratchpad')
        const noteInfo = JSON.parse((await call(prepared, 'info', { name: 'scratchpad' })).content)
        expect(noteInfo).toMatchObject({ name: 'scratchpad', grantsPermission: false })
        expect(noteInfo).not.toHaveProperty('value'); expect(noteInfo).not.toHaveProperty('notes')
        expect(noteInfo.description).toContain('formal approval')
        await expect(call(prepared, 'scratchpad', {})).rejects.toThrow('Invalid scratchpad action fields.')
      }
      first.dispose!()
      await expect(call(first, 'info', {})).rejects.toThrow('request has ended')
    } finally { first.dispose!(); second.dispose!() }
  })
  it('exposes only notebook reads by default, enables exact opt-in names and revokes all of them on navigation', async () => {
    const { prepareCanvasAgentTools } = await import('./canvasAgentTools')
    const first = prepareCanvasAgentTools({ ...scope, messages: [] }, invocation(), { local: true, terminalEnabled: false })
    const enabled = prepareCanvasAgentTools<import('@shared/api/svcLLMProxy').LLMChatReq>({ ...scope, messages: [] }, invocation(), { local: true, terminalEnabled: false, scriptToolsEnabled: () => true })
    try {
      const defaults = first.toolProvider!.listTools().map((tool) => tool.name)
      expect(defaults).toContain('notebook.inspect'); expect(defaults).not.toContain('python.execute')
      const names = enabled.request.skillRuntime!.bindings![0].toolNames!
      expect(names).toEqual(expect.arrayContaining(['python.execute', 'notebook.run', 'notebook.cell.insert']))
      for (const forbidden of ['python.run', 'commands.background', 'notebook.execute-all', 'notebook.interrupt']) expect(names).not.toContain(forbidden)
      await expect(enabled.toolProvider!.callTool('python.execute', { code: 'pass' }, { route, runId: 'outside', workspaceRootDir: 'D:/untrusted' })).rejects.toThrow('live Agent thread invocation')
      sender.emit('did-start-navigation')
      await expect(enabled.admission!.run('python.execute', undefined, async () => ({ content: 'never' }))).rejects.toThrow('no longer active')
    } finally { first.dispose!(); enabled.dispose!() }
  })
  it('bounds pending prompts and releases all timers/listeners on disposal', async () => {
    sender.setMaxListeners(0)
    const channels: AgentThreadInteractionChannel[] = []
    const results: Promise<unknown>[] = []
    try {
      for (let index = 0; index < 65; index++) {
        const item = manager.create({ route, conversationId: `limit-${index}`, messages: [] }, invocation())!
        channels.push(item)
        if (index < 64) results.push(item.request(question, 60).catch(() => 'cancelled'))
        else await expect(item.request(question, 60)).rejects.toThrow('limit')
      }
      expect(vi.getTimerCount()).toBe(64)
      for (const item of channels) item.dispose()
      await Promise.all(results)
      expect(vi.getTimerCount()).toBe(0)
      expect(sender.listenerCount('did-start-navigation')).toBe(1)
    } finally { for (const item of channels) item.dispose() }
  })
  it('does not overwrite an already pending prompt', async () => {
    const result = channel.request(question, 60)
    await expect(channel.request(question, 60)).rejects.toThrow('already pending')
    respond(pending()[0].id, { status: 'dismissed' })
    await result
  })
})
