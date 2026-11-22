import { describe, expect, it, vi } from 'vitest'
import { createAgentThreadToolProvider } from './agentThreadTools'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'card-project', threadId: 'pane' } as const
const context = () => ({ route, runId: 'display-run', toolCallId: 'display-call' })
const create = () => {
  const request = vi.fn(), assertLive = vi.fn(), assertInvocation = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [], listVisibleTools: () => [], assertInvocation,
    interactions: { request, assertLive, dispose: vi.fn(), signal: new AbortController().signal } })
  return { provider, request, assertLive, assertInvocation }
}

describe('display-only show_card in the existing thread', () => {
  it.each([null, false, 1, [], {}, ['✓'], Object('✓'), { toJSON: () => '✓' }, { toString: () => '✓' }, { src: 'https://external.invalid/i' }, 'x'.repeat(65), '😀'.repeat(33)])('rejects raw invalid decorative icons on provided and explicitchoices before input or hooks %#', async icon => {
    const { provider, request, assertLive } = create()
    for (const count of [0, 1, 2, 4]) await expect(provider.callTool('show_card', { title: 'Only text', icon, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Explicit feedback' })) }, context())).rejects.toThrow()
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('keeps icon hooks inert, ownundefined/inherited omission and old bare2–4 legacy admission distinct from suppliedicon strictness', async () => {
    const { provider, request } = create(), toJSON = vi.fn(() => '✓'), toString = vi.fn(() => '✓'); request.mockResolvedValue({ status: 'dismissed' })
    for (const count of [0, 1, 2, 4]) {
      const actions = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'A' })), base = { title: 'Own context', actions }
      for (const icon of [{ toJSON, toString }, Object.assign(Object('✓'), { toJSON, toString })]) await expect(provider.callTool('show_card', { ...base, icon }, context())).rejects.toThrow('Invalid')
      for (const args of [{ ...base }, { ...base, icon: undefined }, Object.assign(Object.create({ icon: { toJSON, toString } }), base)]) {
        const output = JSON.parse((await provider.callTool('show_card', args, context())).content)
        if (count) expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', ...base }, 300, undefined)
        else expect(output.card).toEqual({ title: base.title })
      }
    }
    expect(toJSON).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled(); request.mockClear()
    const base = { title: '😀'.repeat(101), actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    await provider.callTool('show_card', { ...base, icon: undefined }, context()); request.mockClear()
    for (const icon of ['', '✓']) await expect(provider.callTool('show_card', { ...base, icon }, context())).rejects.toThrow('serialized prompt')
    expect(request).not.toHaveBeenCalled()
    await expect(provider.callTool('ask_user', { question: 'No card icon alias', icon: '✓' }, context())).rejects.toThrow('Invalid')
    await expect(provider.callTool('show_app', { document: { title: 'No card icon alias', blocks: [] }, icon: '✓' }, context())).rejects.toThrow('Invalid')
  })
  it('validates complete icon-only context and detaches styled choices without answer or formalapproval authority', async () => {
    const { provider, request, assertLive } = create(); request.mockResolvedValue({ status: 'dismissed' })
    const actions = [{ id: 'approve', label: 'Explicit feedback' }, { id: 'no', label: 'Other' }], base = { title: 'Icon-only', icon: '', actions }
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { subtitle: '😀'.repeat(101) }, { footer: '😀'.repeat(101) }, { fields: null }, { accent: 'error' }, { actions: [{ ...actions[0], label: '😀'.repeat(101) }, actions[1]] }, { actions: [actions[0], actions[0]] }, { actions: [{ ...actions[0], url: 'https://external.invalid' }] }, { actions: [{ ...actions[0], style: 'link' }] }, { actions: [{ ...actions[0], icon: '✓' }] }, { approved: true }, { ['__proto__']: { approved: true } }]) await expect(provider.callTool('show_card', { ...base, ...patch }, context())).rejects.toThrow()
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
    const args = { ...base, icon: '👩🏽‍💻', subtitle: '', footer: 'Closing context', accent: 'success', fields: [{ label: 'Status', value: 'Not approval' }], actions: [{ ...actions[0], style: 'primary' }, { ...actions[1], style: 'secondary' }, { id: 'danger', label: 'Not an operation', style: 'danger' }] }
    await provider.callTool('show_card', args, context()); const expected = structuredClone(args)
    args.icon = 'source changed'; args.fields[0].value = 'source changed'; args.actions[0].style = 'source changed'
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'show_card', ...expected }, 300, undefined)
  })
  it.each(['provided', 'choice'] as const)('counts icon with every context and styles in exact units AND byte caps before retaining input mode=%s', async mode => {
    const { provider, request, assertLive } = create(); request.mockResolvedValue({ status: 'dismissed' })
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const card = { title: 'Caps', icon: '\u0001'.repeat(64), subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), accent: 'success', body: '\u0001'.repeat(3700), fields }, actions = [{ id: 'a', label: 'A', style: 'primary' }, { id: 'b', label: 'B', style: 'danger' }]
    const expected = mode === 'provided' ? { contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false } : { kind: 'show_card', ...card, actions }, remaining = 32768 - Buffer.byteLength(JSON.stringify(expected), 'utf8')
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000); fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    const args = { ...card, ...(mode === 'choice' ? { actions } : {}) }
    expect(JSON.stringify(expected).length).toBe(32768); const output = JSON.parse((await provider.callTool('show_card', args, context())).content)
    if (mode === 'provided') expect(output).toEqual(expected)
    else expect(request).toHaveBeenCalledExactlyOnceWith(expected, 300, undefined)
    request.mockClear(); assertLive.mockClear(); fields[2].value += 'x'; await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized')
    fields[2].value = fields[2].value.slice(2) + '漢'; expect(JSON.stringify(expected).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32770)
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized'); expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it.each([0, 1, 2, 4])('advertises and preserves bounded decorative icon text on provided or explicitly waiting paths count=%s', async count => {
    const { provider, request, assertLive } = create()
    expect(provider.listTools().find(tool => tool.name === 'show_card')!.inputSchema).toMatchObject({ properties: { icon: { type: 'string', maxLength: 64 } } })
    for (const icon of ['', '  ', '✓', '👩🏽‍💻', '😀'.repeat(32)]) {
      request.mockResolvedValue({ status: 'answered', actionId: 'approve' })
      const actions = Array.from({ length: count }, (_, i) => ({ id: i ? `a${i}` : 'approve', label: 'Feedback only' }))
      const output = JSON.parse((await provider.callTool('show_card', { title: 'Decoration not approval', icon, actions }, context())).content)
      if (count) { expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', title: 'Decoration not approval', icon, actions }, 300, undefined); expect(output).toEqual({ status: 'answered', actionId: 'approve' }) }
      else expect(output).toEqual({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Decoration not approval', icon }, untrustedData: true, grantsPermission: false })
    }
    if (count) expect(assertLive).not.toHaveBeenCalled()
    else expect(request).not.toHaveBeenCalled()
  })
  it.each([null, 1, false, [], {}, ['primary'], Object('primary'), { toJSON: () => 'primary' }, { toString: () => 'primary' }, '', 'link', 'error', 'Primary', 'primary ', '#f00', 'url(https://external.invalid)', '__proto__', 'constructor'])('rejects raw invalid action styles without retaining input, approval or conversion %#', async style => {
    const { provider, request, assertLive } = create()
    for (const count of [1, 2, 4]) await expect(provider.callTool('show_card', { title: 'Literal only', actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'A', ...(i === 0 ? { style } : {}) })) }, context())).rejects.toThrow('Invalid')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('ignores inherited and omits ownundefined action styles without changing legacy bare2–4 admission or inserting defaults', async () => {
    const { provider, request } = create(); request.mockResolvedValue({ status: 'dismissed' })
    for (const count of [1, 2, 4]) for (const own of [false, true]) {
      const actions = Array.from({ length: count }, (_, i) => Object.assign(Object.create(own ? null : { style: 'link' }), { id: `a${i}`, label: 'A' }, own ? { style: undefined } : {}))
      await provider.callTool('show_card', { title: 'Own only', actions }, context())
      expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', title: 'Own only', actions: actions.map(({ id, label }) => ({ id, label })) }, 300, undefined)
    }
    const actions = [{ id: 'a', label: 'A', style: undefined }, { id: 'b', label: 'B' }]
    await provider.callTool('show_card', { title: '😀'.repeat(101), actions }, context()); request.mockClear()
    await expect(provider.callTool('show_card', { title: '😀'.repeat(101), actions: [{ ...actions[0], style: 'secondary' }, actions[1]] }, context())).rejects.toThrow('serialized prompt')
    expect(request).not.toHaveBeenCalled()
  })
  it('enforces the whole styled prompt before request and never accepts action props, links or style on unrelated tools or provided cards', async () => {
    const { provider, request, assertLive } = create(); const actions = [{ id: 'a', label: 'A', style: 'primary' }, { id: 'b', label: 'B' }]
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { actions: [{ ...actions[0], label: '😀'.repeat(101) }, actions[1]] }, { actions: [actions[0], actions[0]] }, { actions: [{ ...actions[0], url: 'https://external.invalid' }] }, { actions: [{ ...actions[0], variant: 'contained' }] }, { style: 'primary' }, { approved: true }, { fields: null }, { subtitle: null }, { footer: null }, { accent: 'error' }]) await expect(provider.callTool('show_card', { title: 'Visual only', actions, ...patch }, context())).rejects.toThrow()
    for (const actions of [undefined, []]) await expect(provider.callTool('show_card', { title: 'No style on receipt', actions, style: 'danger' }, context())).rejects.toThrow('Invalid')
    await expect(provider.callTool('ask_user', { question: 'No style alias', style: 'primary' }, context())).rejects.toThrow('Invalid')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('includes nested styles in exact whole-prompt serialized units AND byte caps before request', async () => {
    const { provider, request } = create(); request.mockResolvedValue({ status: 'dismissed' })
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const args = { title: 'Caps', subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), accent: 'success', body: '\u0001'.repeat(3800), fields, actions: [{ id: 'a', label: 'A', style: 'primary' }, { id: 'b', label: 'B', style: 'danger' }] }
    const expected = { kind: 'show_card', ...args }, remaining = 32768 - Buffer.byteLength(JSON.stringify(expected), 'utf8')
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(expected).length).toBe(32768)
    await provider.callTool('show_card', args, context()); expect(request).toHaveBeenCalledExactlyOnceWith(expected, 300, undefined); request.mockClear()
    fields[2].value += 'x'; await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized prompt')
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(expected).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32770)
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized prompt'); expect(request).not.toHaveBeenCalled()
  })
  it.each(['primary', 'secondary', 'danger'])('advertises and carries only non-link literal action styles, still awaiting explicit feedback style=%s', async style => {
    const { provider, request, assertLive } = create(), spec = provider.listTools().find(tool => tool.name === 'show_card')!
    expect(spec.inputSchema).toMatchObject({ properties: { actions: { items: { properties: { style: { type: 'string', enum: ['primary', 'secondary', 'danger'] } } } } } })
    const args = { title: 'Button hint only', actions: [{ id: 'approve', label: 'Feedback only', style }] }
    let release!: (value: unknown) => void, settled = false
    request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const waiting = provider.callTool('show_card', args, context()).then(value => { settled = true; return value })
    await Promise.resolve(); expect(settled).toBe(false)
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'show_card', ...args }, 300, undefined)
    args.actions[0].style = 'changed-source'
    expect(request.mock.calls[0][0].actions[0].style).toBe(style)
    release({ status: 'answered', actionId: 'approve' })
    expect(JSON.parse((await waiting).content)).toEqual({ status: 'answered', actionId: 'approve' })
    expect(assertLive).not.toHaveBeenCalled()
  })
  it.each([null, false, 1, [], {}, ['primary'], Object('primary'), { toJSON: () => 'primary' }, { toString: () => 'primary' }, '', 'error', 'Primary', 'primary ', '#f00', 'url(https://external.invalid)', 'var(--color-error)', '__proto__', 'constructor', 'toString', '<style>body{display:none}</style>'])('rejects invalid accent before either provided admission or waiting channel calls %#', async accent => {
    const { provider, request, assertLive } = create()
    for (const count of [0, 1, 2, 4]) await expect(provider.callTool('show_card', { title: 'No raw styles', accent, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback' })) }, context())).rejects.toThrow('Invalid')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('does not insert a default accent and ignores inherited/ownundefined without tightening the deliberate bare2–4 legacy path', async () => {
    const { provider, request } = create(); request.mockResolvedValue({ status: 'dismissed' })
    for (const count of [0, 1, 2, 4]) for (const own of [false, true]) {
      const card = { title: 'Own context only' }, actions = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback' }))
      const args = Object.assign(Object.create(own ? null : { accent: 'error' }), card, { actions }, own ? { accent: undefined } : {})
      const output = JSON.parse((await provider.callTool('show_card', args, context())).content)
      if (count) { expect(output).toEqual({ status: 'dismissed' }); expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', ...card, actions }, 300, undefined) }
      else expect(output.card).toEqual(card)
    }
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    await provider.callTool('show_card', { title: '😀'.repeat(101), actions, accent: undefined }, context())
    request.mockClear()
    await expect(provider.callTool('show_card', { title: '😀'.repeat(101), actions, accent: 'neutral' }, context())).rejects.toThrow('serialized prompt')
    expect(request).not.toHaveBeenCalled()
  })
  it('validates the full accent-only multi-choice prompt and rejects accent aliases on unrelated tools, styles and authority', async () => {
    const { provider, request, assertLive } = create(), actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { subtitle: '😀'.repeat(101) }, { footer: '😀'.repeat(101) }, { fields: null }, { actions: [{ id: 'a', label: '😀'.repeat(101) }, actions[1]] }, { actions: [actions[0], actions[0]] }, { actions: [{ ...actions[0], style: { color: 'red' } }, actions[1]] }, { actions: [{ ...actions[0], style: 'link', url: 'https://external.invalid' }, actions[1]] }, { approved: true }, { style: { color: 'red' } }, { className: 'accent-primary' }, { color: 'red' }, { html: '<script>not active</script>' }, { wait_for_reply: false }, { icon: { src: 'https://external.invalid/icon' } }, { surface: 'modal' }, { ['__proto__']: { approved: true } }, { timeout_s: 1, timeout_seconds: 1 }]) await expect(provider.callTool('show_card', { title: 'Visual hint only', accent: 'success', actions, ...patch }, context())).rejects.toThrow()
    await expect(provider.callTool('ask_user', { question: 'No accent alias', accent: 'primary' }, context())).rejects.toThrow('Invalid')
    await expect(provider.callTool('show_app', { document: { title: 'No accent alias', blocks: [] }, accent: 'primary' }, context())).rejects.toThrow('Invalid')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it.each(['provided', 'choice'] as const)('counts accent with all text context in exact serialized units AND bytes before queue mode=%s', async mode => {
    const { provider, request, assertLive } = create(); request.mockResolvedValue({ status: 'dismissed' })
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const card = { title: 'Caps', accent: 'warning', subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), body: '\u0001'.repeat(3800), fields }, actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const expected = mode === 'provided' ? { contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false } : { kind: 'show_card', ...card, actions }
    const args = { ...card, ...(mode === 'choice' ? { actions } : {}) }
    const remaining = 32768 - Buffer.byteLength(JSON.stringify(expected), 'utf8')
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(expected).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32768)
    const output = JSON.parse((await provider.callTool('show_card', args, context())).content)
    if (mode === 'provided') { expect(output).toEqual(expected); expect(assertLive).toHaveBeenCalledOnce() }
    else expect(request).toHaveBeenCalledExactlyOnceWith(expected, 300, undefined)
    request.mockClear(); assertLive.mockClear(); fields[2].value += 'x'
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized')
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(expected).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32770)
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('keeps accent receipt cancellation, ownership, live-document, revoked-admission and no-channel guards', async () => {
    const args = { title: 'Visual context', accent: 'success' }, abort = new AbortController(); abort.abort()
    const { provider, request, assertLive, assertInvocation } = create()
    await expect(provider.callTool('show_card', args, { ...context(), signal: abort.signal })).rejects.toThrow()
    await expect(provider.callTool('show_card', args, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(assertInvocation).not.toHaveBeenCalled()
    assertLive.mockImplementationOnce(() => { throw new Error('document ended') })
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('document ended')
    assertLive.mockImplementationOnce(() => { assertInvocation.mockImplementation(() => { throw new Error('revoked') }) })
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('revoked')
    const noChannel = createAgentThreadToolProvider({ route, messages: [], listVisibleTools: () => [], assertInvocation: vi.fn() })
    expect(noChannel.listTools().some(tool => tool.name === 'show_card')).toBe(false)
    await expect(noChannel.callTool('show_card', args, context())).rejects.toThrow('outside')
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['primary', 'info', 'success', 'warning', 'danger', 'neutral'])('offers only six literal visual accents and never autoanswers or approves accent=%s', async accent => {
    const { provider, request, assertLive } = create(), spec = provider.listTools().find(tool => tool.name === 'show_card')!
    expect(spec.inputSchema).toMatchObject({ properties: { accent: { type: 'string', enum: ['primary', 'info', 'success', 'warning', 'danger', 'neutral'] } } })
    const card = { title: 'Visual hint only', accent }
    const display = await provider.callTool('show_card', card, context())
    expect(JSON.parse(display.content)).toEqual({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    expect(assertLive).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled()
    for (const count of [1, 4]) {
      const actions = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback only' }))
      let release!: (value: unknown) => void, settled = false
      request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const pending = provider.callTool('show_card', { ...card, actions }, context()).then(value => { settled = true; return value })
      await Promise.resolve(); expect(settled).toBe(false)
      expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', ...card, actions }, 300, undefined)
      release({ status: 'answered', actionId: 'a0' })
      expect(JSON.parse((await pending).content)).toEqual({ status: 'answered', actionId: 'a0' })
    }
  })
  it.each(['', '  ', 'x'.repeat(200), '😀'.repeat(100), '\u0001'.repeat(200), '**plain** <a href="https://external.invalid">not active</a>'])('keeps valid footer data across provided/1–4choices and optional-context combinations %#', async footer => {
    const { provider, request, assertLive } = create()
    request.mockResolvedValue({ status: 'dismissed' })
    for (const count of [0, 1, 2, 3, 4]) for (const withContext of [false, true]) {
      const card = { title: 'Footer', footer, ...(withContext ? { subtitle: 'Smaller context', fields: [{ label: 'Status', value: 'Read only' }] } : {}) }
      const actions = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback' }))
      const output = await provider.callTool('show_card', { ...card, actions }, context())
      if (!count) expect(JSON.parse(output.content)).toEqual({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
      else { expect(JSON.parse(output.content)).toEqual({ status: 'dismissed' }); expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', ...card, actions }, 300, undefined) }
    }
    expect(assertLive).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(8)
  })
  it.each([null, false, 1, {}, [], ['text'], { text: 'Not string' }, 'x'.repeat(201), '😀'.repeat(101)])('rejects invalid footer scalars/UTF16 before a provided receipt or input retention %#', async footer => {
    const { provider, request, assertLive } = create()
    for (const actions of [undefined, [], [{ id: 'a', label: 'A' }], [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]]) {
      await expect(provider.callTool('show_card', { title: 'Footer', footer, ...(actions ? { actions } : {}) }, context())).rejects.toThrow()
    }
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('omits ownundefined/inherited footer across provided and waiting paths without tightening legacy bare2–4', async () => {
    const { provider, request } = create(); request.mockResolvedValue({ status: 'dismissed' })
    for (const count of [0, 1, 2, 4]) for (const own of [false, true]) {
      const card = { title: 'Own footer only' }, actions = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback' }))
      const args = Object.assign(Object.create(own ? null : { footer: 'INHERITED_IGNORE' }), card, { actions }, own ? { footer: undefined } : {})
      const output = JSON.parse((await provider.callTool('show_card', args, context())).content)
      if (count) { expect(output).toEqual({ status: 'dismissed' }); expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', ...card, actions }, 300, undefined) }
      else expect(output.card).toEqual(card)
    }
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    await provider.callTool('show_card', { title: '😀'.repeat(101), actions, footer: undefined }, context())
    request.mockClear()
    await expect(provider.callTool('show_card', { title: '😀'.repeat(101), actions, footer: '' }, context())).rejects.toThrow('serialized prompt')
    expect(request).not.toHaveBeenCalled()
  })
  it('validates the complete footer-only choice prompt and keeps other tools, styles and authority unsupported', async () => {
    const { provider, request, assertLive } = create(), actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { actions: [{ id: 'a', label: '😀'.repeat(101) }, actions[1]] }, { actions: [actions[0], actions[0]] }, { actions: [{ ...actions[0], style: 'link', url: 'https://external.invalid' }] }, { approved: true }, { html: '<script>not active</script>' }, { wait_for_reply: false }, { icon: { src: 'https://external.invalid/icon' } }, { accent: 'error' }, { surface: 'modal' }, { fields: null }, { ['__proto__']: { approved: true } }, { timeout_s: 1, timeout_seconds: 1 }]) {
      await expect(provider.callTool('show_card', { title: 'Footer only', footer: '', actions, ...patch }, context())).rejects.toThrow()
    }
    await expect(provider.callTool('ask_user', { question: 'No footer alias', footer: '' }, context())).rejects.toThrow('Invalid')
    await expect(provider.callTool('show_app', { document: { title: 'No footer alias', blocks: [] }, footer: '' }, context())).rejects.toThrow('Invalid')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it.each(['provided', 'choice'] as const)('includes footer in exact32768 serialized units/bytes with subtitle without truncation mode=%s', async mode => {
    const { provider, request, assertLive } = create(); request.mockResolvedValue({ status: 'dismissed' })
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const card = { title: 'Footer', subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), body: '\u0001'.repeat(3800), fields }
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const expected = mode === 'provided' ? { contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false } : { kind: 'show_card', ...card, actions }
    const args = { ...card, ...(mode === 'choice' ? { actions } : {}) }
    const remaining = 32768 - Buffer.byteLength(JSON.stringify(expected), 'utf8')
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32768)
    const output = JSON.parse((await provider.callTool('show_card', args, context())).content)
    if (mode === 'provided') { expect(output).toEqual(expected); expect(assertLive).toHaveBeenCalledOnce() }
    else expect(request).toHaveBeenCalledExactlyOnceWith(expected, 300, undefined)
    request.mockClear(); assertLive.mockClear(); fields[2].value += 'x'
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized')
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(expected).length).toBe(32768); expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32770)
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('keeps footer receipt cancellation/route/current-document/admission guards and no-channel hiding', async () => {
    const args = { title: 'Owned footer', footer: '' }, abort = new AbortController(); abort.abort()
    const { provider, request, assertLive, assertInvocation } = create()
    await expect(provider.callTool('show_card', args, { ...context(), signal: abort.signal })).rejects.toThrow()
    await expect(provider.callTool('show_card', args, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(assertInvocation).not.toHaveBeenCalled()
    assertLive.mockImplementationOnce(() => { throw new Error('document ended') })
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('document ended')
    assertLive.mockImplementationOnce(() => { assertInvocation.mockImplementation(() => { throw new Error('revoked') }) })
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('revoked')
    const noChannel = createAgentThreadToolProvider({ route, messages: [], listVisibleTools: () => [], assertInvocation: vi.fn() })
    expect(noChannel.listTools().some(tool => tool.name === 'show_card')).toBe(false)
    await expect(noChannel.callTool('show_card', args, context())).rejects.toThrow('outside')
    expect(request).not.toHaveBeenCalled()
  })
  it('advertises and provides a bounded optional plain-text footer in the original nonauthorizing receipt', async () => {
    const { provider, request, assertLive } = create()
    const card = provider.listTools().find(tool => tool.name === 'show_card')!
    expect(card.inputSchema).toMatchObject({ properties: { footer: { type: 'string', maxLength: 200 } } })
    expect(card.description).toContain('footer')
    const footer = '<b>Closing context only</b>'
    const output = await provider.callTool('show_card', { title: 'Footer display', footer }, context())
    expect(JSON.parse(output.content)).toEqual({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Footer display', footer }, untrustedData: true, grantsPermission: false })
    expect(assertLive).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled()
  })
  it.each([1, 2])('passes footer without fields/subtitle through the original explicit pending channel actions=%s', async count => {
    const { provider, request, assertLive } = create(), actions = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Explicit feedback' }))
    request.mockResolvedValue({ status: 'answered', actionId: 'a0' })
    const footer = 'Not approval even if a0 is selected'
    const output = await provider.callTool('show_card', { title: 'Footer choice', footer, actions }, context())
    expect(JSON.parse(output.content)).toEqual({ status: 'answered', actionId: 'a0' })
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'show_card', title: 'Footer choice', footer, actions }, 300, undefined)
    expect(assertLive).not.toHaveBeenCalled()
  })
  it('keeps zero as provided-only and every count from one through four as an explicit wait, rejecting five', async () => {
    const { provider, request, assertLive } = create()
    request.mockResolvedValue({ status: 'dismissed' })
    for (const count of [0, 1, 2, 3, 4]) {
      const actions = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: `Choice ${i}` }))
      const result = JSON.parse((await provider.callTool('show_card', { title: 'Counts', actions }, context())).content)
      if (count === 0) expect(result).toMatchObject({ status: 'provided', grantsPermission: false })
      else { expect(result).toEqual({ status: 'dismissed' }); expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', title: 'Counts', actions }, 300, undefined) }
    }
    expect(request).toHaveBeenCalledTimes(4); expect(assertLive).toHaveBeenCalledOnce()
    request.mockClear(); assertLive.mockClear()
    await expect(provider.callTool('show_card', { title: 'Too many', actions: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: 'No fifth action' })) }, context())).rejects.toThrow('Invalid')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('validates every single-action prompt even without fields/subtitle and ignores inherited/own-undefined optional context', async () => {
    const { provider, request } = create(), actions = [{ id: 'a'.repeat(64), label: '😀'.repeat(100) }]
    request.mockResolvedValue({ status: 'dismissed' })
    for (const extra of [{}, { fields: undefined, subtitle: undefined }, Object.create({ fields: [null], subtitle: 'INHERITED_IGNORE' })]) {
      const args = Object.assign(Object.create(Object.getPrototypeOf(extra)), extra, { title: '😀'.repeat(100), body: '😀'.repeat(2000), actions })
      await provider.callTool('show_card', args, context())
      expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', title: args.title, body: args.body, actions }, 300, undefined)
    }
    request.mockClear()
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { actions: [{ id: 'a', label: '😀'.repeat(101) }] }]) {
      await expect(provider.callTool('show_card', { title: 'Bare single', actions, ...patch }, context())).rejects.toThrow('serialized prompt')
    }
    for (const action of [null, [], {}, { id: '', label: 'A' }, { id: 'a'.repeat(65), label: 'A' }, { id: 'bad id', label: 'A' }, { id: 'a', label: ' ' }, { id: 'a', label: 'A', style: 'link' }, { id: 'a', label: 'A', url: 'https://external.invalid' }, { id: 'a', label: 'A', approved: true }]) {
      await expect(provider.callTool('show_card', { title: 'Single malformed', actions: [action] }, context())).rejects.toThrow()
    }
    expect(request).not.toHaveBeenCalled()
    // Previously admitted bare 2–4 choices deliberately keep their legacy schema-scalar path.
    await provider.callTool('show_card', { title: '😀'.repeat(101), actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, context())
    expect(request).toHaveBeenCalledOnce()
  })
  it('counts the exact single-action serialized prompt before requesting input and rejects unit/UTF8 overflow', async () => {
    const { provider, request } = create()
    request.mockResolvedValue({ status: 'dismissed' })
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const args = { title: 'One', subtitle: '\u0001'.repeat(200), body: '\u0001'.repeat(4000), actions: [{ id: 'a', label: 'A' }], fields }
    const expected = { kind: 'show_card', ...args }, remaining = 32768 - Buffer.byteLength(JSON.stringify(expected), 'utf8')
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32768)
    await provider.callTool('show_card', args, context())
    expect(request).toHaveBeenCalledExactlyOnceWith(expected, 300, undefined)
    request.mockClear(); fields[2].value += 'x'
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized prompt')
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(expected).length).toBe(32768)
    expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32770)
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized prompt')
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['bare', 'fields', 'subtitle', 'both'] as const)('sends one action into the original wait until explicit feedback, never implicitly confirms context=%s', async variant => {
    const { provider, request, assertLive } = create()
    let release!: (answer: { status: 'answered'; actionId: string }) => void
    request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const actions = [{ id: 'approve', label: 'Feedback only' }]
    const args = { title: 'Single choice', actions,
      ...(['fields', 'both'].includes(variant) ? { fields: [{ label: 'Status', value: 'Read only' }] } : {}),
      ...(['subtitle', 'both'].includes(variant) ? { subtitle: 'Not execution approval' } : {}) }
    let settled = false
    const result = provider.callTool('show_card', args, context()).then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
    await Promise.resolve()
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'show_card', ...args }, 300, undefined)
    expect(settled).toBe(false); expect(assertLive).not.toHaveBeenCalled()
    actions[0].id = 'changed-source'
    expect(request.mock.calls[0][0].actions).toEqual([{ id: 'approve', label: 'Feedback only' }])
    release({ status: 'answered', actionId: 'approve' })
    expect(await result).toEqual({ value: { content: JSON.stringify({ status: 'answered', actionId: 'approve' }), metadata: { source: 'agent-thread-tool', toolName: 'show_card' } } })
  })
  it.each([false, true])('preserves empty/Unicode/escaped subtitle boundaries and omits own-undefined or inherited subtitle choices=%s', async choices => {
    const { provider, request } = create(), actions = choices ? { actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } : {}
    request.mockResolvedValue({ status: 'dismissed' })
    for (const subtitle of ['', '  ', 'x'.repeat(200), '😀'.repeat(100), '\u0001'.repeat(200)]) {
      const output = await provider.callTool('show_card', { title: 'Own text', subtitle, ...actions }, context())
      if (choices) expect(request.mock.calls.at(-1)?.[0]).toEqual({ kind: 'show_card', title: 'Own text', subtitle, ...actions })
      else expect(JSON.parse(output.content).card).toEqual({ title: 'Own text', subtitle })
    }
    for (const args of [{ title: 'Own text', subtitle: undefined, ...actions }, Object.assign(Object.create({ subtitle: 'INHERITED_MUST_NOT_CARRY' }), { title: 'Own text', ...actions })]) {
      const output = await provider.callTool('show_card', args, context())
      if (choices) expect(request.mock.calls.at(-1)?.[0]).toEqual({ kind: 'show_card', title: 'Own text', ...actions })
      else expect(JSON.parse(output.content).card).toEqual({ title: 'Own text' })
    }
    expect(request).toHaveBeenCalledTimes(choices ? 7 : 0)
  })
  it.each([null, false, 1, {}, [], ['text'], new String('boxed'), 'x'.repeat(201), '😀'.repeat(101)])('rejects invalid subtitle input before creating any provided receipt or wait %#', async subtitle => {
    const { provider, request, assertLive } = create()
    for (const withFields of [false, true]) for (const choices of [false, true]) {
      await expect(provider.callTool('show_card', { title: 'Invalid subtitle', subtitle, ...(withFields ? { fields: [] } : {}), ...(choices ? { actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } : {}) }, context())).rejects.toThrow()
    }
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('validates subtitle-only choice text/IDs/extras before queueing and does not generalize other tools', async () => {
    const { provider, request, assertLive } = create(), actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    for (const patch of [{ title: '😀'.repeat(101) }, { body: '😀'.repeat(2001) }, { actions: [{ id: 'a', label: '😀'.repeat(101) }, actions[1]] }, { actions: [{ id: 'a', label: ' ' }] }, { actions: [actions[0], actions[0]] }, { actions: [{ ...actions[0], style: 'link', url: 'https://external.invalid' }, actions[1]] }, { approved: true }, { html: '<script>bad()</script>' }, { wait_for_reply: false }, { surface: 'modal' }, { footer: 1 }, { icon: { src: 'https://external.invalid/icon' } }, { timeout_s: 1, timeout_seconds: 1 }]) {
      await expect(provider.callTool('show_card', { title: 'Bounds', subtitle: '', actions, ...patch }, context())).rejects.toThrow()
    }
    await expect(provider.callTool('ask_user', { question: 'No subtitle alias', subtitle: 'Not supported' }, context())).rejects.toThrow('Invalid')
    await expect(provider.callTool('show_app', { subtitle: 'Not a card', document: { title: 'Unchanged', blocks: [{ kind: 'text', text: 'x' }] } }, context())).rejects.toThrow('Invalid')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it.each([false, true])('counts subtitle in exact serialized receipt/prompt caps before side effects choices=%s', async choices => {
    const { provider, request, assertLive } = create()
    request.mockResolvedValue({ status: 'dismissed' })
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const card = { title: 'B', subtitle: '\u0001'.repeat(200), body: '\u0001'.repeat(4000), fields }
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const expected = choices ? { kind: 'show_card', ...card, actions } : { contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false }
    const remaining = 32768 - Buffer.byteLength(JSON.stringify(expected), 'utf8')
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBe(32768)
    const args = { ...card, ...(choices ? { actions } : {}) }
    const exact = await provider.callTool('show_card', args, context())
    if (choices) expect(request).toHaveBeenCalledExactlyOnceWith(expected, 300, undefined)
    else expect(JSON.parse(exact.content)).toEqual(expected)
    request.mockClear(); assertLive.mockClear()
    fields[2].value += 'x'
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow(choices ? 'serialized prompt' : 'serialized receipt')
    expect(request).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
  })
  it('preserves subtitle admission, current-document, foreign-route, cancellation and late revocation checks without granting authority', async () => {
    const { provider, request, assertLive, assertInvocation } = create(), args = { title: 'Live only', subtitle: 'Read-only context' }
    const controller = new AbortController(); controller.abort()
    await expect(provider.callTool('show_card', args, { ...context(), signal: controller.signal })).rejects.toThrow()
    await expect(provider.callTool('show_card', args, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(assertInvocation).not.toHaveBeenCalled(); expect(assertLive).not.toHaveBeenCalled()
    assertLive.mockImplementationOnce(() => { throw Error('document gone') })
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('document gone')
    const late = new AbortController()
    assertLive.mockImplementationOnce(() => { late.abort() })
    await expect(provider.callTool('show_card', args, { ...context(), signal: late.signal })).rejects.toThrow()
    assertLive.mockImplementationOnce(() => { assertInvocation.mockImplementation(() => { throw Error('revoked') }) })
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('revoked')
    const noChannel = createAgentThreadToolProvider({ route, messages: [], listVisibleTools: () => [], assertInvocation: vi.fn() })
    await expect(noChannel.callTool('show_card', args, context())).rejects.toThrow('outside')
    expect(request).not.toHaveBeenCalled()
  })
  it.each([false, true])('carries plain subtitle on provided and original choices without changing feedback semantics fields=%s', async withFields => {
    const { provider, request, assertLive } = create(), subtitle = 'Smaller line: not approval'
    const fields = withFields ? { fields: [{ label: 'Status', value: 'Read only' }] } : {}
    const definition = provider.listTools().find(tool => tool.name === 'show_card')!
    expect(definition.inputSchema).toMatchObject({ properties: { subtitle: { type: 'string', maxLength: 200 } } })
    const output = await provider.callTool('show_card', { title: 'Subtitle heading', subtitle, ...fields }, context())
    expect(JSON.parse(output.content)).toMatchObject({ status: 'provided', grantsPermission: false, card: { title: 'Subtitle heading', subtitle, ...fields } })
    expect(request).not.toHaveBeenCalled(); expect(assertLive).toHaveBeenCalledOnce()
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    request.mockResolvedValueOnce({ status: 'answered', actionId: 'a' })
    const answer = await provider.callTool('show_card', { title: 'Subtitle heading', subtitle, actions, ...fields }, context())
    expect(JSON.parse(answer.content)).toEqual({ status: 'answered', actionId: 'a' })
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'show_card', title: 'Subtitle heading', subtitle, actions, ...fields }, 300, undefined)
  })
  it.each([{ actions: undefined }, { actions: [] }])('provides detached bounded key/value/inline fields without creating input for %j', async ({ actions }) => {
    const { provider, request, assertLive } = create()
    const fields = [{ label: 'Status', value: 'Read only', inline: true }, { label: '', value: '<script>text only</script>', inline: false }]
    const { parseAgentThreadCardDisplay } = await import('@shared/api/agentThreadCardDisplay')
    const output = await provider.callTool('show_card', { title: 'Fields', fields, ...(actions === undefined ? {} : { actions }) }, context())
    const parsed = JSON.parse(output.content)
    expect(parsed).toMatchObject({ status: 'provided', grantsPermission: false, card: { title: 'Fields', fields } })
    expect(parseAgentThreadCardDisplay(output.content)).toEqual(parsed)
    fields[0].value = 'MUTATED AFTER CALL'
    expect(JSON.parse(output.content).card.fields[0].value).toBe('Read only')
    expect(request).not.toHaveBeenCalled()
    expect(assertLive).toHaveBeenCalledOnce()
  })
  it.each([
    { title: 'Read-only status' },
    { title: 'Read-only status', body: 'Still untrusted model content.' },
    { title: 'Read-only status', actions: [] },
    { title: 'Read-only status', body: 'Still untrusted model content.', actions: [] }
  ])('returns a provided receipt immediately without pending user input for %j', async args => {
    const { provider, request, assertLive, assertInvocation } = create()
    const value = await provider.callTool('show_card', args, context())
    expect(JSON.parse(value.content)).toEqual({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only',
      card: { title: args.title, ...('body' in args ? { body: args.body } : {}) }, untrustedData: true, grantsPermission: false })
    expect(value.metadata).toEqual({ source: 'agent-thread-tool', toolName: 'show_card' })
    expect(request).not.toHaveBeenCalled()
    expect(assertLive).toHaveBeenCalled()
    expect(assertInvocation).toHaveBeenCalledWith('show_card')
  })
  it.each([
    { title: '' }, { title: ' ' }, { title: 'x'.repeat(201) }, { title: '😀'.repeat(101) }, { title: 'x', body: 'x'.repeat(4001) }, { title: 'x', body: '😀'.repeat(2001) },
    { title: 'x', actions: [{ id: 'a', label: '' }] }, { title: 'x', actions: null }, { title: 'x', actions: 'no' },
    { title: 'x', actions: [], wait_for_reply: false }, { title: 'x', actions: [], fields: [null] }, { title: 'x', surface: 'modal' },
    { title: 'x', actions: [], html: '<script>bad()</script>' }, { title: 'x', actions: [], confirm: true },
    { title: 'x', actions: [], approved: true }, { title: 'x', actions: [], timeout_seconds: 0 },
    { title: 'x', actions: [{ id: 'a', label: 'A', style: 'link', url: 'https://example.invalid' }, { id: 'b', label: 'B' }] }
  ])('does not queue or provide invalid/authority-like input %j', async args => {
    const { provider, request } = create()
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('uses matching bounded UTF-16 receipt limits for valid Unicode and escaped control content', async () => {
    const { provider, request } = create()
    const { parseAgentThreadCardDisplay } = await import('@shared/api/agentThreadCardDisplay')
    for (const [title, body] of [['😀'.repeat(100), '😀'.repeat(2000)], ['\u0001'.repeat(200), '\u0001'.repeat(4000)]]) {
      const value = await provider.callTool('show_card', { title, body, actions: [] }, context())
      expect(parseAgentThreadCardDisplay(value.content)).toMatchObject({ card: { title, body }, status: 'provided' })
    }
    expect(request).not.toHaveBeenCalled()
  })
  it('accepts empty, eight-row and exact aggregate/UTF-16 field boundaries without coercion or truncation', async () => {
    const { provider, request } = create()
    const variants = [[], Array.from({ length: 8 }, () => ({ label: '', value: '' })),
      [{ label: '😀'.repeat(100), value: '😀'.repeat(500) }],
      [...Array.from({ length: 3 }, () => ({ label: 'x'.repeat(200), value: 'x'.repeat(1000) })), { label: '', value: 'x'.repeat(496) }]]
    for (const fields of variants) {
      const content = (await provider.callTool('show_card', { title: 'Bounded fields', fields, timeout_s: 1 }, context())).content
      expect(JSON.parse(content).card.fields).toEqual(fields)
    }
    const inherited = Object.assign(Object.create({ fields: [{ label: 'Ignored', value: 'Not input data' }] }), { title: 'Own data only' })
    expect(JSON.parse((await provider.callTool('show_card', inherited, context())).content).card).toEqual({ title: 'Own data only' })
    expect(request).not.toHaveBeenCalled()
  })
  it.each([
    null, {}, '', true, [null], [[]], [1], [{}], [{ label: 'Only label' }], [{ value: 'Only value' }],
    [{ label: null, value: 'x' }], [{ label: 'x', value: 1 }], [{ label: true, value: 'x' }],
    [{ label: 'x', value: 'x', inline: 'true' }], [{ label: 'x', value: 'x', inline: null }],
    [{ label: 'x'.repeat(201), value: '' }], [{ label: '😀'.repeat(101), value: '' }],
    [{ label: '', value: 'x'.repeat(1001) }], [{ label: '', value: '😀'.repeat(501) }],
    Array.from({ length: 9 }, () => ({ label: '', value: '' })),
    Array.from({ length: 4 }, () => ({ label: 'x'.repeat(200), value: 'x'.repeat(1000) })),
    [{ label: 'x', value: 'x', html: '<script>unsafe extension</script>' }],
    [{ label: 'x', value: 'x', approved: true }], [{ label: 'x', value: 'x', url: 'https://external.invalid' }],
    [{ label: 'x', value: 'x', ['__proto__']: { grantsPermission: true } }],
    [Object.assign(Object.create({ label: 'Inherited label' }), { value: 'Own value' })]
  ].map(fields => ({ fields })))('rejects invalid, extended, inherited or oversized field input %# before any pending or provided result', async ({ fields }) => {
    const { provider, request, assertLive } = create()
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    for (const choice of [false, true]) await expect(provider.callTool('show_card', { title: 'Not provided', fields, ...(choice ? { actions } : {}) }, context())).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    expect(assertLive).not.toHaveBeenCalled()
  })
  it('supports empty/omitted optional fields with choices but does not generalize ask_user or show_app', async () => {
    const { provider, request, assertLive } = create()
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    request.mockResolvedValue({ status: 'answered', actionId: 'a' })
    for (const fields of [[], undefined, [{ label: 'Status', value: 'Read only' }]]) {
      const output = await provider.callTool('show_card', { title: 'Choose separately', actions, fields }, context())
      expect(JSON.parse(output.content)).toEqual({ status: 'answered', actionId: 'a' })
      expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', title: 'Choose separately', actions, ...(fields === undefined ? {} : { fields }) }, 300, undefined)
    }
    expect(request).toHaveBeenCalledTimes(3)
    await expect(provider.callTool('ask_user', { question: 'Unchanged', fields: [] }, context())).rejects.toThrow('Invalid arguments')
    await expect(provider.callTool('show_app', { document: { title: 'Unchanged', blocks: [{ kind: 'text', text: 'x' }] }, fields: [] }, context())).rejects.toThrow('Invalid arguments')
    expect(request).toHaveBeenCalledTimes(3)
    expect(assertLive).not.toHaveBeenCalled()
  })
  it('bounds explicit-fields choice prompts before requesting input and ignores inherited optional fields', async () => {
    const { provider, request } = create()
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    request.mockResolvedValue({ status: 'dismissed' })
    const invalid = [
      { title: '😀'.repeat(101) }, { title: 'Bounds', body: '😀'.repeat(2001) },
      { title: 'Bounds', actions: [{ id: 'a', label: '😀'.repeat(101) }, actions[1]] },
      { title: 'Bounds', body: '\u0001'.repeat(4000), fields: Array.from({ length: 4 }, () => ({ label: '', value: '\u0001'.repeat(1000) })) }
    ]
    for (const patch of invalid) await expect(provider.callTool('show_card', { actions, fields: [], ...patch }, context())).rejects.toThrow('serialized prompt')
    expect(request).not.toHaveBeenCalled()
    const inherited = Object.assign(Object.create({ fields: [{ label: 'Ignored', value: 'Not own data' }] }), { title: 'Own only', actions })
    await provider.callTool('show_card', inherited, context())
    expect(request).toHaveBeenLastCalledWith({ kind: 'show_card', title: 'Own only', actions }, 300, undefined)
    for (const fields of [[], [{ label: '😀'.repeat(100), value: '😀'.repeat(500) }]]) {
      await provider.callTool('show_card', { title: '😀'.repeat(100), body: '😀'.repeat(2000), fields, actions: [{ id: 'a', label: '😀'.repeat(100) }, actions[1]], timeout_seconds: 2 }, context())
      expect(request.mock.calls.at(-1)?.[1]).toBe(2)
    }
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('rejects a schema-valid escaped combination that exceeds the exact serialized receipt cap', async () => {
    const { provider, request, assertLive } = create()
    const fields = Array.from({ length: 4 }, () => ({ label: '', value: '\u0001'.repeat(1000) }))
    const args = { title: 'Bounds', body: '\u0001'.repeat(4000), fields }
    expect(JSON.stringify(args).length).toBeGreaterThan(32768)
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('serialized receipt')
    expect(request).not.toHaveBeenCalled()
    expect(assertLive).not.toHaveBeenCalled()
  })
  it('keeps cancellation/document/scope/admission gates for fielded cards, including revocation after construction', async () => {
    const { provider, request, assertLive, assertInvocation } = create()
    const args = { title: 'Live document only', fields: [{ label: 'Status', value: 'Untrusted feedback' }] }
    const controller = new AbortController(); controller.abort()
    await expect(provider.callTool('show_card', args, { ...context(), signal: controller.signal })).rejects.toThrow()
    await expect(provider.callTool('show_card', args, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(assertInvocation).not.toHaveBeenCalled()
    assertLive.mockImplementationOnce(() => { throw new Error('document ended') })
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('document ended')
    assertLive.mockImplementationOnce(() => { assertInvocation.mockImplementation(() => { throw new Error('revoked') }) })
    await expect(provider.callTool('show_card', args, context())).rejects.toThrow('revoked')
    const detached = createAgentThreadToolProvider({ route, messages: [], listVisibleTools: () => [], assertInvocation: vi.fn() })
    await expect(detached.callTool('show_card', args, context())).rejects.toThrow('outside')
    expect(request).not.toHaveBeenCalled()
  })
  it('still sends ordinary 2-4 unique choices through the original pending channel', async () => {
    const { provider, request, assertLive } = create()
    const actions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    request.mockResolvedValue({ status: 'answered', actionId: 'a' })
    const output = await provider.callTool('show_card', { title: 'Choose', actions }, context())
    expect(JSON.parse(output.content)).toEqual({ status: 'answered', actionId: 'a' })
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'show_card', title: 'Choose', actions }, 300, undefined)
    expect(assertLive).not.toHaveBeenCalled()
  })
  it('retains no-channel/profile, cancellation, scope, invocation and current-document gates without input wait', async () => {
    const noChannel = createAgentThreadToolProvider({ route, messages: [], listVisibleTools: () => [], assertInvocation: vi.fn() })
    expect(noChannel.listTools().some(tool => tool.name === 'show_card')).toBe(false)
    await expect(noChannel.callTool('show_card', { title: 'x' }, context())).rejects.toThrow('outside')
    const { provider, request, assertInvocation, assertLive } = create()
    const abort = new AbortController(); abort.abort()
    await expect(provider.callTool('show_card', { title: 'x' }, { ...context(), signal: abort.signal })).rejects.toThrow()
    await expect(provider.callTool('show_card', { title: 'x' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(assertLive).not.toHaveBeenCalled()
    assertLive.mockImplementationOnce(() => { throw new Error('document ended') })
    await expect(provider.callTool('show_card', { title: 'x' }, context())).rejects.toThrow('document ended')
    assertInvocation.mockImplementation(() => { throw new Error('request ended') })
    await expect(provider.callTool('show_card', { title: 'x' }, context())).rejects.toThrow('request ended')
    expect(request).not.toHaveBeenCalled()
  })
  it('rechecks cancellation and invocation immediately after the document assertion', async () => {
    const { provider, request, assertInvocation, assertLive } = create()
    const abort = new AbortController()
    assertLive.mockImplementationOnce(() => { abort.abort() })
    await expect(provider.callTool('show_card', { title: 'x' }, { ...context(), signal: abort.signal })).rejects.toThrow()
    assertLive.mockImplementationOnce(() => { assertInvocation.mockImplementation(() => { throw new Error('revoked') }) })
    await expect(provider.callTool('show_card', { title: 'x' }, context())).rejects.toThrow('revoked')
    expect(request).not.toHaveBeenCalled()
  })
})
