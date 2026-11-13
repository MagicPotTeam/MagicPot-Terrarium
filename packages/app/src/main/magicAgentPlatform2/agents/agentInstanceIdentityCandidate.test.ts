import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeAgentInstanceIdentityCandidate as decode } from './agentInstanceIdentityCandidate'
import { AGENT_INSTANCE_IDENTITY_PROJECTION_LIMITS as limits, projectAgentInstanceIdentityRow as finalProjection } from './agentInstanceIdentityProjection'

// Pure synthetic instance/config TEXT only, no EventStore/SQLite/runtime/config initialization.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const state = (extra: Record<string, unknown> = {}) => ({ id: 'instance-a', definitionId: 'definition-a', configVersion: 'config-v7', status: 'created', ...extra })
const row = (extra: Record<string, unknown> = {}) => ({ instanceId: 'instance-a', instanceRevision: 9, instanceDeleted: 0, instanceStateJson: canonical(state()), ...extra })
const expected = { stage: 'provisional', instanceId: 'instance-a', definitionId: 'definition-a', configVersion: 'config-v7', instanceRevision: 9 }
const candidate = (value: ReturnType<typeof decode>, extra: Record<string, unknown> = {}) => {
  expect(value).toEqual({ ...expected, ...extra }); expect(Object.isFrozen(value)).toBe(true)
  expect(Object.keys(value! as object).sort()).toEqual(['configVersion', 'definitionId', 'instanceId', 'instanceRevision', 'stage'])
}
const completePair = (instance: ReturnType<typeof row>, configState: Record<string, unknown> = { version: 'config-v7', definitionId: 'definition-a', prompt: 'INERT-SECRET-CANARY' }) => ({ ...instance, configId: 'config-v7', configRevision: 2, configDeleted: 0, configStateJson: canonical(configState) })
const padded = (multibyte: boolean) => {
  const empty = canonical(state({ padding: '' })), bytes = limits.instanceBytes - Buffer.byteLength(empty)
  const padding = multibyte ? '界'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3) : 'x'.repeat(bytes)
  const text = canonical(state({ padding })); expect(Buffer.byteLength(text)).toBe(limits.instanceBytes); return text
}
afterEach(() => vi.restoreAllMocks())

describe('provisional identity header from bounded supplied text only', () => {
  it('returns a detached fresh frozen provisional candidate only, not final availability or config proof', () => {
    const source = row({ instanceStateJson: canonical(state({ prompt: 'DO-NOT-RETURN-PROMPT', workspaceRoots: ['DO-NOT-RETURN-PATH'], model: { credential: 'DO-NOT-RETURN-CREDENTIAL' } })) }), before = JSON.stringify(source)
    const first = decode('instance-a', source), second = decode('instance-a', source)
    candidate(first); candidate(second); expect(first === second).toBe(false)
    expect(JSON.stringify(first)).not.toMatch(/DO-NOT|available|status|prompt|workspace|model|credential|configRevision/)
    expect(JSON.stringify(source)).toBe(before); expect(Object.isFrozen(source)).toBe(false)
    source.instanceId = 'changed'; source.instanceRevision = 100; candidate(first)
  })
  it.each(['created', 'running', 'paused', 'stopped'])('accepts stored %s without returning runtime status', status => candidate(decode('instance-a', row({ instanceStateJson: canonical(state({ status })) }))))
  it('accepts frozen null-prototype own-data rows', () => candidate(decode('instance-a', Object.freeze(Object.assign(Object.create(null), row())))))
  it.each([0, -0, Number.MAX_SAFE_INTEGER])('accepts independent safe instance revision %s (case %#)', revision => candidate(decode('instance-a', row({ instanceRevision: revision })), { instanceRevision: revision }))
  it.each(['ascii', 'multibyte'])('accepts all three identities exactly at the 256 UTF8 byte %s boundary', mode => {
    const id = mode === 'ascii' ? 'a'.repeat(256) : '界'.repeat(85) + 'a'; expect(Buffer.byteLength(id)).toBe(256)
    candidate(decode(id, row({ instanceId: id, instanceStateJson: canonical(state({ id, definitionId: id, configVersion: id })) })), { instanceId: id, definitionId: id, configVersion: id })
  })
  it.each(['ascii', 'multibyte'])('accepts complete instance JSON at the exact 16KiB %s cap', mode => {
    candidate(decode('instance-a', row({ instanceStateJson: padded(mode === 'multibyte') })))
  })
  it('accepts root-zero depth32 and 4096 values, rejecting their immediate successors', () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 31; depth++) nested = [nested]
    candidate(decode('instance-a', row({ instanceStateJson: canonical(state({ x: nested })) })))
    expect(decode('instance-a', row({ instanceStateJson: canonical(state({ x: [nested] })) }))).toBeNull()
    candidate(decode('instance-a', row({ instanceStateJson: canonical(state({ x: Array(4090).fill(0) })) })))
    expect(decode('instance-a', row({ instanceStateJson: canonical(state({ x: Array(4091).fill(0) })) }))).toBeNull()
  })
  it('uses literal canonical JSON independent of the fixture serializer, including scientific numeric form', () => {
    candidate(decode('instance-a', row({ instanceStateJson: '{"configVersion":"config-v7","definitionId":"definition-a","id":"instance-a","n":1e+21,"status":"created"}' })))
  })
  it('agrees on identity fields with the existing final decoder only when given a complete real synthetic pair', () => {
    const source = row(), value = decode('instance-a', source), final = finalProjection('instance-a', completePair(source))
    candidate(value); expect(final.status).toBe('available')
    if (final.status !== 'available') throw new Error('Synthetic complete pair must be accepted')
    expect(value).toEqual({ stage: 'provisional', instanceId: final.instanceId, definitionId: final.definitionId, configVersion: final.configVersion, instanceRevision: final.instanceRevision })
    expect(Object.keys(value! as object)).not.toContain('configRevision')
  })
  it('does not upgrade a provisional candidate to config-present/final authority when the actual config mismatches', () => {
    const source = row(); candidate(decode('instance-a', source))
    expect(finalProjection('instance-a', completePair(source, { version: 'different', definitionId: 'definition-a' }))).toEqual({ status: 'unavailable', reason: 'unavailable' })
  })
  it.each([null, undefined, '', ' ', ' instance-a', 'instance-a ', 'x\u0000y', 'x\u007fy', 1, true, Symbol('id'), {}, 'x'.repeat(257), '界'.repeat(86), '\ud800'])('rejects invalid expected ID before any row hooks (case %#)', value => {
    const touched = vi.fn((): never => { throw new Error('No row hooks') }), hostile = new Proxy({}, { get: touched, getPrototypeOf: touched, ownKeys: touched, getOwnPropertyDescriptor: touched })
    expect(decode(value, hostile)).toBeNull(); expect(touched).not.toHaveBeenCalled()
  })
  it.each([null, undefined, 1, true, 'row', [], () => null, new Date(0)])('rejects nonplain rows (case %#)', source => expect(decode('instance-a', source)).toBeNull())
  it('rejects proxy/revoked rows before invoking traps', () => {
    const touched = vi.fn((): never => { throw new Error('No row traps') }), hostile = new Proxy(row(), { get: touched, getPrototypeOf: touched, ownKeys: touched, getOwnPropertyDescriptor: touched })
    expect(decode('instance-a', hostile)).toBeNull(); const revoked = Proxy.revocable({}, {}); revoked.revoke(); expect(decode('instance-a', revoked.proxy)).toBeNull()
    expect(touched).not.toHaveBeenCalled()
  })
  it.each(Object.keys(row()))('rejects missing %s', field => { const source: Record<string, unknown> = row(); delete source[field]; expect(decode('instance-a', source)).toBeNull() })
  it.each(Object.keys(row()))('rejects accessor %s without invoking it', field => {
    const getter = vi.fn((): never => { throw new Error('No getter') }), source = row(); Object.defineProperty(source, field, { enumerable: true, get: getter })
    expect(decode('instance-a', source)).toBeNull(); expect(getter).not.toHaveBeenCalled()
  })
  it('rejects symbols/extras/nonenumerable/inherited fields and the final eight-field row, never stripping', () => {
    for (const source of [{ ...row(), extra: 'no' }, { ...row(), [Symbol('extra')]: true }, completePair(row()), Object.assign(Object.create(row()), row())]) expect(decode('instance-a', source)).toBeNull()
    const source = row(); Object.defineProperty(source, 'instanceRevision', { enumerable: false }); expect(decode('instance-a', source)).toBeNull()
    const touched = vi.fn((): never => { throw new Error('No diagnostics') }), diagnostic = row(); Object.defineProperty(diagnostic, 'message', { enumerable: true, get: touched })
    expect(decode('instance-a', diagnostic)).toBeNull(); expect(touched).not.toHaveBeenCalled()
  })
  it.each([-1, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '9', null, undefined, true, 1n, {}])('rejects invalid revisions (case %#)', value => expect(decode('instance-a', row({ instanceRevision: value }))).toBeNull())
  it.each([1, 2, '0', false, null, undefined, NaN])('requires numeric live flag zero (case %#)', value => expect(decode('instance-a', row({ instanceDeleted: value }))).toBeNull())
  it.each(['removed', 'unknown', '', 0, null, undefined])('rejects removed/invalid stored status (case %#)', status => expect(decode('instance-a', row({ instanceStateJson: canonical(state({ status })) }))).toBeNull())
  it('rejects mismatch between expected/row/state instance identity', () => {
    expect(decode('different', row())).toBeNull(); expect(decode('instance-a', row({ instanceId: 'different' }))).toBeNull()
    expect(decode('instance-a', row({ instanceStateJson: canonical(state({ id: 'different' })) }))).toBeNull()
  })
  it.each(['id', 'definitionId', 'configVersion'])('bounds decoded identity %s exactly without coercion', field => {
    for (const value of ['', ' ', ' padded ', 'x\u0000y', 'x\u007fy', 'x'.repeat(257), '界'.repeat(86), '\ud800', '\udfff', 1, null, true]) expect(decode('instance-a', row({ instanceStateJson: canonical(state({ [field]: value })) }))).toBeNull()
  })
  it.each([null, undefined, 1, true, {}, new String('{}'), '', '{', '[]', 'null', 'true', '1', '"text"'])('requires primitive valid object JSON (case %#)', value => expect(decode('instance-a', row({ instanceStateJson: value }))).toBeNull())
  it('rejects duplicate/order/whitespace/escape/numeric noncanonical spellings', () => {
    const text = canonical(state()), n = canonical(state({ x: 1 }))
    for (const value of [' ' + text, text + '\n', JSON.stringify(state()), text.slice(0, -1) + ',"definitionId":"definition-a"}', text.replace('definition-a', 'definition-\\u0061'), ...['1.0', '1e0', '1E0', '-0', '0.0', '1e21', '1e-07'].map(number => n.replace('"x":1', `"x":${number}`))]) expect(decode('instance-a', row({ instanceStateJson: value }))).toBeNull()
  })
  it.each(['__proto__', 'prototype', 'constructor'])('rejects dangerous nested key %s', key => {
    const extra = Object.create(null); extra[key] = 'inert'; expect(decode('instance-a', row({ instanceStateJson: canonical(state({ extra: [extra] })) }))).toBeNull()
  })
  it.each(['\ud800', '\udfff', 'before\ud800after'])('rejects malformed UTF16 keys and values (case %#)', key => {
    expect(decode('instance-a', row({ instanceStateJson: canonical(state({ extra: [{ [key]: 'inert' }] })) }))).toBeNull()
    expect(decode('instance-a', row({ instanceStateJson: canonical(state({ extra: key })) }))).toBeNull()
  })
  it('rejects nonfinite parsed numbers', () => expect(decode('instance-a', row({ instanceStateJson: canonical(state({ x: null })).replace('"x":null', '"x":1e999') }))).toBeNull())
  it('rejects oversized ASCII/multibyte inputs before any JSON.parse, not truncating', () => {
    const parse = vi.spyOn(JSON, 'parse')
    for (const text of ['x'.repeat(limits.instanceBytes + 1), '界'.repeat(Math.floor(limits.instanceBytes / 3) + 1)]) expect(decode('instance-a', row({ instanceStateJson: text }))).toBeNull()
    expect(parse).not.toHaveBeenCalled()
  })
  it.each(['\ud800', '\udfff'])('rejects literal malformed UTF16 keys and values before JSON.parse (case %#)', unit => {
    const texts = [canonical(state({ extra: 'RAW-MARKER' })).replace('RAW-MARKER', unit), canonical(state({ 'RAW-MARKER': 'inert' })).replace('RAW-MARKER', unit)]
    const sources = texts.map(text => row({ instanceStateJson: text })), parse = vi.spyOn(JSON, 'parse')
    for (const source of sources) expect(decode('instance-a', source)).toBeNull()
    expect(parse).not.toHaveBeenCalled()
  })
  it('skips Buffer.byteLength for overlong UTF16 text and identities, not just JSON.parse', () => {
    const texts = ['x'.repeat(limits.instanceBytes + 1), '界'.repeat(limits.instanceBytes + 1)], overlongId = 'i'.repeat(limits.identityBytes + 1)
    const sources = texts.map(text => row({ instanceStateJson: text })), normal = row(), bytes = vi.spyOn(Buffer, 'byteLength'), parse = vi.spyOn(JSON, 'parse')
    for (const source of sources) expect(decode('instance-a', source)).toBeNull()
    expect(decode(overlongId, normal)).toBeNull()
    const measured = bytes.mock.calls.map(call => call[0]); expect(measured).toContain('instance-a')
    for (const text of [...texts, overlongId]) expect(measured).not.toContain(text)
    expect(parse).not.toHaveBeenCalled()
  })
  it('rejects extreme nesting inside the byte cap without recursive diagnostics', () => {
    const text = canonical(state()).slice(0, -1) + ',"x":' + '['.repeat(500) + '0' + ']'.repeat(500) + '}'
    expect(Buffer.byteLength(text)).toBeLessThan(limits.instanceBytes); expect(decode('instance-a', row({ instanceStateJson: text }))).toBeNull()
  })
  it('catches the original raw parse exception without inspecting proxy diagnostics and restores the global', () => {
    const touched = vi.fn((): never => { throw new Error('No diagnostic inspection') }), error = new Proxy({}, { get: touched, getPrototypeOf: touched, ownKeys: touched })
    const original = Object.getOwnPropertyDescriptor(JSON, 'parse')!, source = row(); let calls = 0, value: ReturnType<typeof decode> | undefined
    try {
      Object.defineProperty(JSON, 'parse', { ...original, value: () => { calls++; throw error } }); value = decode('instance-a', source)
    } finally { Object.defineProperty(JSON, 'parse', original) }
    expect(value).toBeNull(); expect(calls).toBe(1); expect(touched).not.toHaveBeenCalled(); expect(Object.getOwnPropertyDescriptor(JSON, 'parse')).toEqual(original)
  })
})
