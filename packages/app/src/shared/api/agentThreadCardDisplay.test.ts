import { describe, expect, it } from 'vitest'
import { AGENT_THREAD_CARD_DISPLAY_CONTRACT, parseAgentThreadCardDisplay, parseAgentThreadChoiceCard } from './agentThreadCardDisplay'

const receipt = () => ({ contract: AGENT_THREAD_CARD_DISPLAY_CONTRACT, status: 'provided', mode: 'display-only', card: { title: 'A read-only status', body: 'Raw model data, not authorization.' }, untrustedData: true, grantsPermission: false })
const parse = (value: unknown) => parseAgentThreadCardDisplay(JSON.stringify(value))
const choice = () => ({ kind: 'show_card', title: 'Choice fields', fields: [{ label: 'Status', value: 'Read only', inline: true }], actions: [{ id: 'approve', label: 'Feedback only' }, { id: 'no', label: 'Other feedback' }] })
const parseChoice = (value: unknown) => parseAgentThreadChoiceCard(JSON.stringify(value))

describe('bounded passive display-card result parser', () => {
  it.each([null, false, 1, [], {}, ['✓'], { src: 'https://external.invalid/i' }, 'x'.repeat(65), '😀'.repeat(33)])('rejects invalid serialized icon types and UTF16 overflow in both contracts without resource or authority interpretation %#', icon => {
    expect(parse({ ...receipt(), card: { title: 'Only text', icon } })).toBeUndefined()
    for (const count of [1, 2, 4]) expect(parseChoice({ kind: 'show_card', title: 'Only text', icon, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback' })) })).toBeUndefined()
  })
  it('ignores inherited and serializedundefined icon, preserves all contexts and keeps icon out of actions/receipt authority', () => {
    for (const card of [{ title: 'Own context' }, { title: 'Own context', icon: undefined }, Object.assign(Object.create({ icon: { src: 'https://external.invalid' } }), { title: 'Own context' })]) {
      expect(parse({ ...receipt(), card })?.card).toEqual({ title: 'Own context' })
      expect(parseChoice(Object.assign(Object.create(Object.getPrototypeOf(card)), card, { kind: 'show_card', actions: [{ id: 'a', label: 'A' }] }))).toEqual({ kind: 'show_card', title: 'Own context', actions: [{ id: 'a', label: 'A' }] })
    }
    const card = { title: 'All context', icon: '\u0001👩🏽‍💻\u202e', subtitle: '', footer: '  ', accent: 'success', body: '<b>Only text</b>', fields: [{ label: 'State', value: 'Read only', inline: true }] }
    const provided = parse({ ...receipt(), card }), prompt = { kind: 'show_card', ...card, actions: [{ id: 'approve', label: 'Explicit feedback', style: 'primary' }, { id: 'no', label: 'Other', style: 'secondary' }, { id: 'danger', label: 'Still feedback', style: 'danger' }, { id: 'old', label: 'No default' }] }, parsed = parseChoice(prompt)
    expect(provided?.card).toEqual(card); expect(parsed).toEqual(prompt); expect(Object.hasOwn(parsed!.actions[3], 'style')).toBe(false)
    provided!.card.fields![0].value = 'copy'; parsed!.fields![0].value = 'copy'; expect(card.fields[0].value).toBe('Read only'); expect(card.icon).toBe('\u0001👩🏽‍💻\u202e')
    for (const patch of [{ approved: true }, { iconUrl: 'https://external.invalid' }, { className: 'i-carbon-checkmark' }, { ['__proto__']: { icon: '✓' } }]) {
      expect(parse({ ...receipt(), card: { ...card, ...patch } })).toBeUndefined(); expect(parseChoice({ ...prompt, ...patch })).toBeUndefined()
    }
    expect(parse({ ...receipt(), icon: '✓' })).toBeUndefined()
    expect(parse({ ...receipt(), card: { ...card, actions: prompt.actions } })).toBeUndefined()
    expect(parseChoice({ ...prompt, actions: [{ ...prompt.actions[0], icon: '✓' }] })).toBeUndefined()
  })
  it.each(['provided', 'choice'] as const)('includes escaped decorative icon and every context in exact serialized unit AND UTF8 caps mode=%s', mode => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const card = { title: 'Caps', icon: '\u0001'.repeat(64), subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), accent: 'success', body: '\u0001'.repeat(3700), fields }
    const source = mode === 'provided' ? { ...receipt(), card } : { kind: 'show_card', ...card, actions: [{ id: 'a', label: 'A', style: 'primary' }, { id: 'b', label: 'B', style: 'danger' }] }, parser = mode === 'provided' ? parse : parseChoice
    const remaining = 32768 - new TextEncoder().encode(JSON.stringify(source)).length
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(source).length).toBe(32768); expect(parser(source)).toEqual(source)
    fields[2].value += 'x'; expect(parser(source)).toBeUndefined(); fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(source).length).toBe(32768); expect(new TextEncoder().encode(JSON.stringify(source)).length).toBe(32770); expect(parser(source)).toBeUndefined()
  })
  it.each(['', '  ', '✓', '👩🏽‍💻', 'x'.repeat(64), '😀'.repeat(32), '<img src="https://external.invalid/i">'])('preserves detached bounded icon text on provided and1–4choice contracts without changing authority %#', icon => {
    const card = { title: 'Decorative text only', icon }, source = { ...receipt(), card }, parsed = parse(source)
    expect(parsed).toEqual(source)
    if (!parsed) throw new Error('Expected an inert icon receipt')
    Reflect.set(parsed.card, 'icon', 'changed-copy'); expect(card.icon).toBe(icon); expect(parsed.grantsPermission).toBe(false)
    for (const count of [1, 2, 4]) {
      const prompt = { kind: 'show_card', ...card, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Explicit feedback' })) }, choice = parseChoice(prompt)
      expect(choice).toEqual(prompt); if (!choice) throw new Error('Expected icon choice')
      Reflect.set(choice, 'icon', 'changed-copy'); expect(prompt.icon).toBe(icon)
    }
  })
  it.each(['bare', 'fields', 'subtitle', 'footer', 'accent', 'all'])('keeps mixed styles and omitted style detached without manufacturing default or authority context=%s', variant => {
    const actions = [{ id: 'a', label: 'Primary', style: 'primary' }, { id: 'b', label: 'Secondary', style: 'secondary' }, { id: 'c', label: 'Danger', style: 'danger' }, { id: 'd', label: 'Omitted' }]
    const source = { kind: 'show_card', title: 'Only feedback', actions, ...(['fields', 'all'].includes(variant) ? { fields: [{ label: 'State', value: 'No grant' }] } : {}), ...(['subtitle', 'all'].includes(variant) ? { subtitle: '' } : {}), ...(['footer', 'all'].includes(variant) ? { footer: '' } : {}), ...(['accent', 'all'].includes(variant) ? { accent: 'success' } : {}) }
    const parsed = parseChoice(source); expect(parsed).toEqual(source)
    if (!parsed) throw new Error('Expected mixed styles')
    expect(Object.hasOwn(parsed.actions[3], 'style')).toBe(false)
    Reflect.set(parsed.actions[0], 'style', 'changed'); expect(actions[0].style).toBe('primary')
    for (const patch of [{ url: 'https://external.invalid' }, { color: 'error' }, { className: 'MuiButton-contained' }, { variant: 'contained' }, { approved: true }, { onClick: 'execute()' }, { ['__proto__']: { style: 'primary' } }]) expect(parseChoice({ ...source, actions: [{ ...actions[0], ...patch }] })).toBeUndefined()
  })
  it('counts all nested action styles with context in exact serialized code-unit AND UTF8 caps', () => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const source = { kind: 'show_card', title: 'Caps', subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), accent: 'success', body: '\u0001'.repeat(3800), fields, actions: [{ id: 'a', label: 'A', style: 'primary' }, { id: 'b', label: 'B', style: 'secondary' }, { id: 'c', label: 'C', style: 'danger' }] }
    const remaining = 32768 - new TextEncoder().encode(JSON.stringify(source)).length
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(source).length).toBe(32768); expect(parseChoice(source)).toEqual(source)
    fields[2].value += 'x'; expect(parseChoice(source)).toBeUndefined()
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(source).length).toBe(32768); expect(new TextEncoder().encode(JSON.stringify(source)).length).toBe(32770)
    expect(parseChoice(source)).toBeUndefined()
  })
  it('serializes inherited or ownundefined action styles as omission, not a new default', () => {
    for (const action of [{ id: 'a', label: 'A', style: undefined }, Object.assign(Object.create({ style: 'link' }), { id: 'a', label: 'A' })]) expect(parseChoice({ kind: 'show_card', title: 'Own only', actions: [action] })?.actions).toEqual([{ id: 'a', label: 'A' }])
  })
  it.each(['primary', 'secondary', 'danger'])('preserves only the literal non-link action style as detached choice context style=%s', style => {
    for (const count of [1, 2, 4]) {
      const source = { kind: 'show_card', title: 'Style is not approval', actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Explicit feedback', style })) }
      const parsed = parseChoice(source)
      expect(parsed).toEqual(source)
      if (!parsed) throw new Error('Expected a styled choice')
      Reflect.set(parsed.actions[0], 'style', 'changed-copy'); expect(source.actions[0].style).toBe(style)
      expect(parse(source)).toBeUndefined()
    }
    expect(parse({ ...receipt(), card: { title: 'No actions in provided receipt', actions: [{ id: 'a', label: 'A', style }] } })).toBeUndefined()
  })
  it.each([null, 1, false, [], {}, ['primary'], '', 'link', 'error', 'Primary', 'primary ', '#f00', 'url(https://external.invalid)', 'constructor', '__proto__'])('rejects invalid serialized action styles and URL authority %#', style => {
    expect(parseChoice({ ...choice(), actions: [{ id: 'a', label: 'A', style }] })).toBeUndefined()
    expect(parseChoice({ ...choice(), actions: [{ id: 'a', label: 'A', style: 'primary', url: 'https://external.invalid' }] })).toBeUndefined()
  })
  it.each([null, false, 1, [], {}, ['primary'], { name: 'primary' }, '', 'error', 'Primary', 'primary ', ' primary', 'dangerous', 'red', '#ff0000', 'url(https://external.invalid)', 'var(--color-error)', '__proto__', 'constructor', 'toString', '<style>body{display:none}</style>', 'primary\u0000'])('rejects nonliteral accent scalars, CSS, aliases and object/prototype/coercion attempts %#', accent => {
    expect(parse({ ...receipt(), card: { title: 'No raw styles', accent } })).toBeUndefined()
    for (const count of [1, 2, 4]) expect(parseChoice({ ...choice(), accent, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback' })) })).toBeUndefined()
  })
  it.each(['bare', 'fields', 'subtitle', 'footer', 'all'])('keeps each accent as detached inert context without creating default/approval data context=%s', variant => {
    for (const accent of ['primary', 'info', 'success', 'warning', 'danger', 'neutral']) {
      const card = { title: 'Visual only', accent, ...(['fields', 'all'].includes(variant) ? { fields: [{ label: 'State', value: 'No permission', inline: true }] } : {}), ...(['subtitle', 'all'].includes(variant) ? { subtitle: 'Smaller' } : {}), ...(['footer', 'all'].includes(variant) ? { footer: '' } : {}) }
      expect(parse({ ...receipt(), card })?.card).toEqual(card)
      expect(parseChoice({ ...choice(), ...card })).toEqual({ ...choice(), ...card })
    }
    for (const card of [{ title: 'Omitted' }, { title: 'Omitted', accent: undefined }, Object.assign(Object.create({ accent: 'error' }), { title: 'Omitted' })]) {
      expect(parse({ ...receipt(), card })?.card).toEqual({ title: 'Omitted' })
      expect(parseChoice({ ...choice(), ...card })).toEqual({ ...choice(), title: 'Omitted' })
    }
    for (const patch of [{ style: { color: 'red' } }, { className: 'accent-primary' }, { color: 'red' }, { approved: true }, { grantsPermission: true }, { answer: { accent: 'success' } }, { ['__proto__']: { accent: 'primary' } }]) {
      expect(parse({ ...receipt(), card: { title: 'No style authority', accent: 'success', ...patch } })).toBeUndefined()
      expect(parseChoice({ ...choice(), accent: 'success', ...patch })).toBeUndefined()
    }
  })
  it.each(['provided', 'choice'] as const)('includes accent plus footer/subtitle/fields in exact serialized unit AND UTF8 limits mode=%s', mode => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const card = { title: 'Caps', accent: 'warning', subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), body: '\u0001'.repeat(3800), fields }
    const source = mode === 'provided' ? { ...receipt(), card } : { ...choice(), ...card }
    const parser = mode === 'provided' ? parse : parseChoice
    const remaining = 32768 - new TextEncoder().encode(JSON.stringify(source)).length
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(source).length).toBe(32768); expect(new TextEncoder().encode(JSON.stringify(source)).length).toBe(32768)
    expect(parser(source)).toEqual(source)
    fields[2].value += 'x'; expect(parser(source)).toBeUndefined()
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(source).length).toBe(32768); expect(new TextEncoder().encode(JSON.stringify(source)).length).toBe(32770)
    expect(parser(source)).toBeUndefined()
  })
  it.each(['primary', 'info', 'success', 'warning', 'danger', 'neutral'])('keeps only the exact visual accent on detached provided/1–4choice data, never permission accent=%s', accent => {
    const card = { title: 'Visual hint only', accent }
    const source = { ...receipt(), card }, parsed = parse(source)
    expect(parsed).toEqual(source); expect(parsed!.grantsPermission).toBe(false)
    Reflect.set(parsed!.card, 'accent', 'changed-copy'); expect(card.accent).toBe(accent)
    for (const count of [1, 2, 3, 4]) {
      const prompt = { kind: 'show_card', ...card, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Explicit feedback' })) }
      const parsedChoice = parseChoice(prompt); expect(parsedChoice).toEqual(prompt)
      Reflect.set(parsedChoice!, 'accent', 'changed-copy'); expect(prompt.accent).toBe(accent)
    }
  })
  it.each(['', '  ', 'x'.repeat(200), '😀'.repeat(100), '\u0001'.repeat(200), '**plain** <a href="https://external.invalid">not a link</a>'])('preserves exact footer strings on provided/one-through-four choices without trim/coerce %#', footer => {
    expect(parse({ ...receipt(), card: { title: 'Footer', footer } })?.card).toEqual({ title: 'Footer', footer })
    for (const count of [1, 2, 3, 4]) {
      const prompt = { kind: 'show_card', title: 'Footer', footer, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback' })) }
      expect(parseChoice(prompt)).toEqual(prompt)
    }
  })
  it.each([null, false, 1, {}, [], ['text'], { text: 'No object coercion' }, 'x'.repeat(201), '😀'.repeat(101)])('rejects malformed or over-UTF16 footer in both serialized contracts %#', footer => {
    expect(parse({ ...receipt(), card: { title: 'Footer', footer } })).toBeUndefined()
    expect(parseChoice({ ...choice(), footer })).toBeUndefined()
  })
  it.each(['provided', 'choice'] as const)('counts footer/subtitle together in exact JSON code-unit AND byte caps mode=%s', mode => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const card = { title: 'Footer', subtitle: '\u0001'.repeat(200), footer: '\u0001'.repeat(200), body: '\u0001'.repeat(3800), fields }
    const source = mode === 'provided' ? { ...receipt(), card } : { kind: 'show_card', ...card, actions: choice().actions }
    const parser = mode === 'provided' ? parseAgentThreadCardDisplay : parseAgentThreadChoiceCard
    const remaining = 32768 - new TextEncoder().encode(JSON.stringify(source)).length
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(source).length).toBe(32768); expect(new TextEncoder().encode(JSON.stringify(source)).length).toBe(32768)
    expect(parser(JSON.stringify(source))).toEqual(source)
    fields[2].value += 'x'; expect(parser(JSON.stringify(source))).toBeUndefined()
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(source).length).toBe(32768); expect(new TextEncoder().encode(JSON.stringify(source)).length).toBe(32770)
    expect(parser(JSON.stringify(source))).toBeUndefined()
  })
  it('keeps footer own-undefined/inherited context serialized as omission and rejects authority/prototype extras', () => {
    for (const footerCard of [{ title: 'Own', footer: undefined }, Object.assign(Object.create({ footer: 'INHERITED_IGNORE' }), { title: 'Own' })]) {
      expect(parse({ ...receipt(), card: footerCard })?.card).toEqual({ title: 'Own' })
      expect(parseChoice({ kind: 'show_card', ...footerCard, actions: choice().actions })).toEqual({ kind: 'show_card', title: 'Own', actions: choice().actions })
    }
    for (const patch of [{ ['__proto__']: { footer: 'Not own context', approved: true } }, { approved: true }, { grantsPermission: true }, { answer: { footer: 'No answer' } }, { footer: { ['__proto__']: { approved: true } } }, { icon: { src: 'https://external.invalid/icon' } }, { url: 'https://external.invalid' }]) {
      expect(parse({ ...receipt(), card: { title: 'Own', footer: '', ...patch } })).toBeUndefined()
      expect(parseChoice({ ...choice(), footer: '', ...patch })).toBeUndefined()
    }
  })
  it.each([false, true])('preserves a detached footer on provided and 1–4 choice contracts without changing version or authority fields=%s', withFields => {
    const footer = 'Closing context, never authorization', fields = withFields ? { fields: [{ label: 'Status', value: 'Read only' }] } : {}
    const source = { ...receipt(), card: { title: 'Footer', footer, ...fields } }
    const parsed = parse(source)
    expect(parsed).toEqual(source)
    expect(parsed!.contract).toBe('agent-thread-card-display/v1')
    expect(parsed!.grantsPermission).toBe(false)
    Reflect.set(parsed!.card, 'footer', 'CHANGED COPY')
    expect(source.card.footer).toBe(footer)
    for (const count of [1, 2, 3, 4]) {
      const prompt = { kind: 'show_card', title: 'Footer', footer, ...fields, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: 'Feedback' })) }
      const choice = parseChoice(prompt)
      expect(choice).toEqual(prompt)
      Reflect.set(choice!, 'footer', 'CHANGED COPY')
      expect(prompt.footer).toBe(footer)
    }
  })
  it.each([1, 2, 3, 4])('keeps %s explicit actions, including exact ID/label/UTF-16 boundaries, detached and nonauthorizing', count => {
    const actions = Array.from({ length: count }, (_, i) => ({ id: i === 0 ? 'a'.repeat(64) : `a${i}`, label: '😀'.repeat(100) }))
    const source = { kind: 'show_card', title: '😀'.repeat(100), body: '😀'.repeat(2000), actions }
    const parsed = parseChoice(source)
    expect(parsed).toEqual(source)
    parsed!.actions[0].label = 'CHANGED COPY'
    expect(actions[0].label).toBe('😀'.repeat(100))
    expect(parse(source)).toBeUndefined()
  })
  it.each([null, [], {}, { id: '', label: 'A' }, { id: 'x'.repeat(65), label: 'A' }, { id: 'unsafe id', label: 'A' }, { id: 'a', label: '' }, { id: 'a', label: ' ' }, { id: 'a', label: '😀'.repeat(101) }, { id: 'a', label: 1 }, { id: 'a', label: 'A', style: 'link' }, { id: 'a', label: 'A', url: 'https://external.invalid' }, { id: 'a', label: 'A', approved: true }, { ['__proto__']: { id: 'a', label: 'Inherited' } }])('does not weaken strict single-action keys, labels or IDs %#', action => {
    expect(parseChoice({ kind: 'show_card', title: 'Only offered text', actions: [action] })).toBeUndefined()
  })
  it('bounds a single-action bare prompt by UTF-16 and a fielded prompt by exact serialized units/bytes', () => {
    const bare = { kind: 'show_card', title: 'One', actions: [{ id: 'a', label: 'A' }] }
    expect(parseChoice({ ...bare, title: '😀'.repeat(101) })).toBeUndefined()
    expect(parseChoice({ ...bare, body: '😀'.repeat(2001) })).toBeUndefined()
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const source = { ...bare, subtitle: '\u0001'.repeat(200), body: '\u0001'.repeat(4000), fields }
    const remaining = 32768 - new TextEncoder().encode(JSON.stringify(source)).length
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    expect(JSON.stringify(source).length).toBe(32768)
    expect(parseChoice(source)).toEqual(source)
    fields[2].value += 'x'; expect(parseChoice(source)).toBeUndefined()
    fields[2].value = fields[2].value.slice(2) + '漢'
    expect(JSON.stringify(source).length).toBe(32768)
    expect(new TextEncoder().encode(JSON.stringify(source)).length).toBe(32770)
    expect(parseChoice(source)).toBeUndefined()
  })
  it.each(['bare', 'fields', 'subtitle', 'both'] as const)('parses one explicitly offered plain action without manufacturing an answer context=%s', context => {
    const source = { kind: 'show_card', title: 'One explicit choice', actions: [{ id: 'approve', label: 'Conversation only' }],
      ...(['fields', 'both'].includes(context) ? { fields: [{ label: 'Status', value: 'Not authorization' }] } : {}),
      ...(['subtitle', 'both'].includes(context) ? { subtitle: 'Click is still required' } : {}) }
    const parsed = parseChoice(source)
    expect(parsed).toEqual(source)
    expect(parse(source)).toBeUndefined()
    expect(Object.hasOwn(parsed!, 'answer')).toBe(false)
    parsed!.actions[0].id = 'CHANGED COPY'
    expect(source.actions[0].id).toBe('approve')
    expect(parseChoice(source)).toEqual(source)
  })
  it.each(['', '  ', 'x'.repeat(200), '😀'.repeat(100), '\u0001'.repeat(200), '<a href="https://external.invalid">text only</a>'])('preserves exact valid subtitle text without coercion or truncation %#', subtitle => {
    expect(parse({ ...receipt(), card: { title: 'Subtitle', subtitle } })?.card).toEqual({ title: 'Subtitle', subtitle })
    expect(parseChoice({ kind: 'show_card', title: 'Subtitle', subtitle, actions: choice().actions })).toEqual({ kind: 'show_card', title: 'Subtitle', subtitle, actions: choice().actions })
  })
  it.each([null, false, 1, {}, [], ['text'], { text: 'Not a string' }, 'x'.repeat(201), '😀'.repeat(101)])('rejects invalid subtitle scalars/UTF-16 bounds in both serialized contracts %#', subtitle => {
    expect(parse({ ...receipt(), card: { title: 'Subtitle', subtitle } })).toBeUndefined()
    expect(parseChoice({ ...choice(), subtitle })).toBeUndefined()
  })
  it.each(['provided', 'choice'])('includes escaped subtitle in exact 32768-byte serialization without truncating %s', mode => {
    const fields = [{ label: '', value: '\u0001'.repeat(1000) }, { label: '', value: '' }, { label: '', value: '' }]
    const card = { title: 'B', subtitle: '\u0001'.repeat(200), body: '\u0001'.repeat(4000), fields }
    const source = mode === 'provided' ? { ...receipt(), card } : { kind: 'show_card', ...card, actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    const parser = mode === 'provided' ? parseAgentThreadCardDisplay : parseAgentThreadChoiceCard
    const remaining = 32768 - new TextEncoder().encode(JSON.stringify(source)).length
    expect(remaining).toBeGreaterThan(1000); expect(remaining).toBeLessThan(2000)
    fields[1].value = 'x'.repeat(1000); fields[2].value = 'x'.repeat(remaining - 1000)
    const exact = JSON.stringify(source)
    expect(exact.length).toBe(32768); expect(new TextEncoder().encode(exact).length).toBe(32768)
    expect(parser(exact)).toEqual(source)
    fields[2].value += 'x'
    expect(parser(JSON.stringify(source))).toBeUndefined()
    fields[2].value = fields[2].value.slice(1) + '漢'
    const byteOversize = JSON.stringify(source)
    expect(byteOversize.length).toBe(32769)
    fields[2].value = fields[2].value.slice(1)
    const shorterUnitsButMoreBytes = JSON.stringify(source)
    expect(shorterUnitsButMoreBytes.length).toBe(32768)
    expect(new TextEncoder().encode(shorterUnitsButMoreBytes).length).toBeGreaterThan(32768)
    expect(parser(shorterUnitsButMoreBytes)).toBeUndefined()
  })
  it.each([false, true])('preserves an optional detached subtitle on provided and choice data fields=%s', withFields => {
    const subtitle = 'Smaller line: <b>plain text</b>'
    const fields = withFields ? { fields: [{ label: 'Context', value: 'Not permission' }] } : {}
    const source = { ...receipt(), card: { title: 'Heading', subtitle, ...fields } }
    const parsed = parse(source)
    expect(parsed).toEqual(source)
    const prompt = { kind: 'show_card', title: 'Heading', subtitle, actions: choice().actions, ...fields }
    expect(parseChoice(prompt)).toEqual(prompt)
    Reflect.set(parsed!.card, 'subtitle', 'CHANGED COPY')
    expect(source.card.subtitle).toBe(subtitle)
    expect(parse(source)).toEqual(source)
  })
  it('accepts a bounded detached plain key/value/inline field array alongside legacy card data', () => {
    const fields = [{ label: 'Status', value: 'Read only', inline: true }, { label: '', value: '', inline: false }]
    const source = { ...receipt(), card: { title: 'Fields', fields } }, result = parse(source)
    expect(result).toEqual(source)
    result!.card.fields![0].value = 'MUTATED COPY'
    expect(fields[0].value).toBe('Read only')
    expect(parse(source)).toEqual(source)
  })
  it('accepts only the versioned nonauthorizing provided display contract and returns detached data', () => {
    const source = receipt(), result = parse(source)
    expect(result).toEqual(source)
    expect(parse({ ...source, card: { title: 'x' } })).toEqual({ ...source, card: { title: 'x' } })
    result!.card.title = 'mutated'
    expect(source.card.title).toBe('A read-only status')
    expect(parse(source)!.card.title).toBe('A read-only status')
    expect(parse({ ...source, card: { title: 'x'.repeat(200), body: 'x'.repeat(4000) } })).toBeDefined()
    expect(parse({ ...source, card: { title: '漢'.repeat(200), body: '漢'.repeat(4000) } })).toBeDefined()
  })
  it.each([
    undefined, null, true, 1, {}, [], '{not-json', 'x'.repeat(32769), new String('{}')
  ])('rejects nonserialized or malformed/oversized content %s', value => {
    expect(parseAgentThreadCardDisplay(value)).toBeUndefined()
  })
  it.each([
    { contract: 'agent-thread-card-display/v2' }, { status: 'answered' }, { status: 'displayed' }, { mode: 'interactive' },
    { grantsPermission: true }, { untrustedData: false }, { approval: true }, { actionId: 'approve' }, { actions: [] },
    { card: { title: 'x', actions: [] } }, { card: { title: 'x', html: '<script>bad()</script>' } },
    { card: { title: 'x', url: 'https://example.invalid' } }, { card: { title: 'x', fields: [null] } },
    { card: { title: 'x', body: null } }, { card: { title: ' ' } }, { card: { title: '' } }, { card: { title: 42 } },
    { card: { title: 'x'.repeat(201) } }, { card: { title: '😀'.repeat(101) } },
    { card: { title: 'x', body: 'x'.repeat(4001) } }, { card: { title: 'x', body: '😀'.repeat(2001) } }
  ])('rejects authority-like, unsupported, unsafe-size or non-provided receipt %j', patch => {
    expect(parse({ ...receipt(), ...patch })).toBeUndefined()
  })
  it.each(['contract', 'status', 'mode', 'card', 'untrustedData', 'grantsPermission'])('requires own %s and no prototype-shaped extensions', key => {
    const value: Record<string, unknown> = receipt()
    delete value[key]
    expect(parse(value)).toBeUndefined()
    expect(parse(JSON.parse(JSON.stringify({ ...receipt(), ['__proto__']: { title: 'inherited' } })))).toBeUndefined()
    expect(parse({ ...receipt(), card: { ['__proto__']: { title: 'inherited' } } })).toBeUndefined()
  })
  it.each([
    null, {}, '', true, [null], [[]], [1], [{}], [{ label: 'Only label' }], [{ value: 'Only value' }],
    [{ label: null, value: '' }], [{ label: '', value: 1 }], [{ label: '', value: '', inline: 'true' }],
    [{ label: '', value: '', inline: null }], [{ label: 'x'.repeat(201), value: '' }],
    [{ label: '😀'.repeat(101), value: '' }], [{ label: '', value: 'x'.repeat(1001) }],
    [{ label: '', value: '😀'.repeat(501) }], Array.from({ length: 9 }, () => ({ label: '', value: '' })),
    Array.from({ length: 4 }, () => ({ label: 'x'.repeat(200), value: 'x'.repeat(1000) })),
    [{ label: '', value: '', grantsPermission: true }], [{ label: '', value: '', html: '<script>not allowed</script>' }],
    [{ label: '', value: '', url: 'https://external.invalid' }], [{ label: '', value: '', ['__proto__']: { approval: true } }],
    [{ ['__proto__']: { label: 'fake own label' }, value: '' }]
  ].map(fields => ({ fields })))('rejects malformed/extended/oversized serialized fields %# without interpreting them as authority', ({ fields }) => {
    expect(parse({ ...receipt(), card: { title: 'Fields', fields } })).toBeUndefined()
    expect(parseChoice({ ...choice(), fields })).toBeUndefined()
  })
  it('accepts the empty/eight-row/UTF-16/aggregate boundaries, but not aggregate+1', () => {
    const aggregate = [...Array.from({ length: 3 }, () => ({ label: 'x'.repeat(200), value: 'x'.repeat(1000) })), { label: '', value: 'x'.repeat(496) }]
    for (const fields of [[], Array.from({ length: 8 }, () => ({ label: '', value: '', inline: false })), [{ label: '😀'.repeat(100), value: '😀'.repeat(500), inline: true }], aggregate]) {
      expect(parse({ ...receipt(), card: { title: 'Bounds', fields } })?.card.fields).toEqual(fields)
      expect(parseChoice({ ...choice(), fields })?.fields).toEqual(fields)
    }
    aggregate[3].value += 'x'
    expect(parse({ ...receipt(), card: { title: 'Bounds', fields: aggregate } })).toBeUndefined()
    expect(parseChoice({ ...choice(), fields: aggregate })).toBeUndefined()
  })
  it('enforces the exact 32KiB serialized cap even for individually valid escaped body and fields', () => {
    const value = { ...receipt(), card: { title: 'Bounds', body: '\u0001'.repeat(4000), fields: Array.from({ length: 4 }, () => ({ label: '', value: '\u0001'.repeat(1000) })) } }
    expect(JSON.stringify(value).length).toBeGreaterThan(32768)
    expect(parse(value)).toBeUndefined()
    const content = JSON.stringify({ ...receipt(), card: { title: 'Fields', fields: [{ label: '', value: '' }] } })
    expect(parseAgentThreadCardDisplay(content + ' '.repeat(32768 - content.length))).toBeDefined()
    expect(parseAgentThreadCardDisplay(content + ' '.repeat(32769 - content.length))).toBeUndefined()
  })
  it('caps serialized UTF8 bytes before parsing, not just code-unit length', () => {
    const content = ' '.repeat(1000) + JSON.stringify({ ...receipt(), card: { title: 'x', body: '漢'.repeat(11000) } })
    expect(content.length).toBeLessThan(32768)
    expect(new TextEncoder().encode(content).length).toBeGreaterThan(32768)
    expect(parseAgentThreadCardDisplay(content)).toBeUndefined()
  })
})

describe('bounded serialized choice-card prompt parser', () => {
  it('detaches field and action arrays, supports empty/omitted fields and never parses a choice as provided', () => {
    const source = choice(), parsed = parseChoice(source)!
    expect(parsed).toEqual(source)
    parsed.fields![0].value = 'Changed copy'; parsed.actions[0].id = 'changed'
    expect(parseChoice(source)).toEqual(source)
    expect(source.fields[0].value).toBe('Read only')
    expect(source.actions[0].id).toBe('approve')
    expect(parse(source)).toBeUndefined()
    expect(parseChoice(receipt())).toBeUndefined()
    expect(parseChoice({ ...source, fields: [] })).toEqual({ ...source, fields: [] })
    const legacy = { kind: source.kind, title: source.title, actions: source.actions }
    expect(parseChoice(legacy)).toEqual(legacy)
  })
  it.each([
    { kind: 'show_app' }, { status: 'provided' }, { grantsPermission: true }, { approved: true }, { answer: { actionId: 'approve' } },
    { title: '' }, { title: ' ' }, { title: 'x'.repeat(201) }, { title: '😀'.repeat(101) }, { body: null },
    { body: 'x'.repeat(4001) }, { body: '😀'.repeat(2001) },
    { actions: [] }, { actions: [{ id: '', label: 'Malformed single choice' }] }, { actions: null }, { actions: 'a' },
    { actions: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Duplicate' }] },
    { actions: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: 'Too many' })) },
    ...[{}, null, [], { id: '', label: 'A' }, { id: 'x'.repeat(65), label: 'A' }, { id: 'unsafe id', label: 'A' }, { id: 'a', label: ' ' }, { id: 'a', label: 'x'.repeat(201) }, { id: 'a', label: '😀'.repeat(101) }, { id: 'a', label: 1 }, { id: 'a', label: 'A', style: 'link', url: 'https://external.invalid' }, { id: 'a', label: 'A', approved: true }].map(action => ({ actions: [action, { id: 'b', label: 'B' }] }))
  ])('rejects malformed or authority-bearing choice prompt %#', patch => {
    expect(parseChoice({ ...choice(), ...patch })).toBeUndefined()
  })
  it.each([undefined, null, true, 1, {}, [], '{not-json', 'x'.repeat(32769), new String('{}')])('rejects nonserialized or malformed choice content %#', value => {
    expect(parseAgentThreadChoiceCard(value)).toBeUndefined()
  })
  it.each(['kind', 'title', 'actions'])('requires own %s and rejects prototype-shaped extensions', key => {
    const value: Record<string, unknown> = choice(); delete value[key]
    expect(parseChoice(value)).toBeUndefined()
    expect(parseChoice({ ...choice(), ['__proto__']: { approved: true } })).toBeUndefined()
    expect(parseChoice({ ...choice(), actions: [{ ['__proto__']: { id: 'inherited', label: 'Inherited' } }, { id: 'b', label: 'B' }] })).toBeUndefined()
  })
  it('keeps serialized code-unit/UTF8 caps exact and rejects escaped over-limit combinations', () => {
    const value = { ...choice(), body: '\u0001'.repeat(4000), fields: Array.from({ length: 4 }, () => ({ label: '', value: '\u0001'.repeat(1000) })) }
    expect(JSON.stringify(value).length).toBeGreaterThan(32768)
    expect(parseChoice(value)).toBeUndefined()
    const content = JSON.stringify(choice())
    expect(parseAgentThreadChoiceCard(content + ' '.repeat(32768 - content.length))).toBeDefined()
    expect(parseAgentThreadChoiceCard(content + ' '.repeat(32769 - content.length))).toBeUndefined()
    const bytes = JSON.stringify({ ...choice(), body: '漢'.repeat(4000) })
    const padded = bytes + ' '.repeat(32768 - new TextEncoder().encode(bytes).byteLength)
    expect(parseAgentThreadChoiceCard(padded)).toBeDefined()
    expect(parseAgentThreadChoiceCard(padded + ' ')).toBeUndefined()
    expect(parseAgentThreadChoiceCard(choice())).toBeUndefined()
  })
})
