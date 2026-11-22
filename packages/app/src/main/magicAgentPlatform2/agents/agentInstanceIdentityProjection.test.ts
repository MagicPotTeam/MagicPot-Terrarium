import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_INSTANCE_IDENTITY_PROJECTION_LIMITS as limits, projectAgentInstanceIdentityRow as project } from './agentInstanceIdentityProjection'

// Synthetic plain text only. Never imports/constructs EventStore, SQLite, runtime or configuration.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const instance = (extra: Record<string, unknown> = {}) => ({ id: 'instance-a', definitionId: 'package.p.agent', configVersion: 'config-v7', status: 'created', ...extra })
const config = (extra: Record<string, unknown> = {}) => ({ version: 'config-v7', definitionId: 'package.p.agent', contentDigest: 'INTENTIONALLY-NOT-VALIDATED', prompt: 'DO-NOT-RETURN-PROMPT', model: { credential: 'DO-NOT-RETURN-CREDENTIAL' }, workspaceRoots: ['DO-NOT-RETURN-PATH'], ...extra })
const row = (extra: Record<string, unknown> = {}) => ({ instanceId: 'instance-a', instanceRevision: 9, instanceDeleted: 0, instanceStateJson: canonical(instance()), configId: 'config-v7', configRevision: 2, configDeleted: 0, configStateJson: canonical(config()), ...extra })
const expected = { status: 'available', instanceId: 'instance-a', definitionId: 'package.p.agent', configVersion: 'config-v7', instanceRevision: 9, configRevision: 2 }
const denied = Object.freeze({ status: 'unavailable', reason: 'unavailable' })
const unavailable = (value: unknown) => { expect(value).toEqual(denied); expect(Object.isFrozen(value)).toBe(true); expect(Object.keys(value as object).sort()).toEqual(['reason', 'status']) }
const expectAvailable = (value: ReturnType<typeof project>, extra: Record<string, unknown> = {}) => {
  expect(value).toEqual({ ...expected, ...extra }); expect(Object.isFrozen(value)).toBe(true)
  expect(Object.keys(value).sort()).toEqual(['configRevision', 'configVersion', 'definitionId', 'instanceId', 'instanceRevision', 'status'])
}
const padded = (base: Record<string, unknown>, cap: number, multibyte = false) => {
  const empty = canonical({ ...base, padding: '' }), space = cap - Buffer.byteLength(empty)
  const padding = multibyte ? '界'.repeat(Math.floor(space / 3)) + 'x'.repeat(space % 3) : 'x'.repeat(space)
  const text = canonical({ ...base, padding }); expect(Buffer.byteLength(text)).toBe(cap); return text
}
afterEach(() => vi.restoreAllMocks())

describe('pure bounded identity-row projection, synthetic canonical text only', () => {
  it('projects exactly five identity primitives plus status, with independent config revision and no sensitive state', () => {
    const source = row(), before = JSON.stringify(source)
    const result = project('instance-a', source)
    expectAvailable(result); expect(JSON.stringify(result)).not.toMatch(/DO-NOT|INTENTIONALLY|StateJson|prompt|model|workspace|contentDigest|createdAt|health/)
    expect(JSON.stringify(source)).toBe(before); expect(Object.isFrozen(source)).toBe(false)
    source.instanceId = 'changed'; source.instanceRevision = 100
    expectAvailable(result)
  })
  it.each(['created', 'running', 'paused', 'stopped'])('accepts allowed stored status %s without returning execution health or status', status => {
    expectAvailable(project('instance-a', row({ instanceStateJson: canonical(instance({ status })) })))
  })
  it('accepts null-prototype/frozen input rows and returns detached fresh frozen DTOs', () => {
    const source = Object.freeze(Object.assign(Object.create(null), row()))
    const first = project('instance-a', source), second = project('instance-a', source)
    expectAvailable(first); expectAvailable(second); expect(first === second).toBe(false)
  })
  it.each(['instanceRevision', 'configRevision'])('accepts zero, negative-zero and maximum safe %s without conflating version IDs', field => {
    for (const value of [0, -0, Number.MAX_SAFE_INTEGER]) expectAvailable(project('instance-a', row({ [field]: value })), { [field]: value })
  })
  it.each(['ascii', 'multibyte'])('accepts all three identity fields at the exact 256-byte %s cap', mode => {
    const id = mode === 'ascii' ? 'a'.repeat(256) : '界'.repeat(85) + 'a'
    expect(Buffer.byteLength(id)).toBe(256)
    const source = row({ instanceId: id, configId: id, instanceStateJson: canonical(instance({ id, definitionId: id, configVersion: id })), configStateJson: canonical(config({ version: id, definitionId: id })) })
    expectAvailable(project(id, source), { instanceId: id, definitionId: id, configVersion: id })
  })
  it.each(['ascii', 'multibyte'])('accepts both complete state texts at their simultaneous exact %s byte caps', mode => {
    const source = row({ instanceStateJson: padded(instance(), limits.instanceBytes, mode === 'multibyte'), configStateJson: padded(config(), limits.configBytes, mode === 'multibyte') })
    expectAvailable(project('instance-a', source))
  })
  it('accepts canonical nested arrays, nulls, booleans and inert HTML-like nonidentity text then discards them', () => {
    expectAvailable(project('instance-a', row({ instanceStateJson: canonical(instance({ extra: { z: [null, true, false, 1.25, '<script>inert</script>'], a: [] } })) })))
  })
  it('accepts depth32 and node4096 exactly rather than rejecting all complex states', () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 31; depth++) nested = [nested]
    expectAvailable(project('instance-a', row({ instanceStateJson: canonical(instance({ x: nested })) })))
    expectAvailable(project('instance-a', row({ instanceStateJson: canonical(instance({ x: Array(4090).fill(0) })) })))
  })
  it.each([null, undefined, '', ' ', ' instance-a', 'instance-a ', '\ninstance-a', 1, true, Symbol('id'), {}, 'x'.repeat(257), '界'.repeat(86), '\ud800'])('rejects invalid expected ID %s before reflecting any row', invalid => {
    const touched = vi.fn((): never => { throw new Error('No row reflection') })
    const hostile = new Proxy({}, { get: touched, ownKeys: touched, getPrototypeOf: touched, getOwnPropertyDescriptor: touched })
    unavailable(project(invalid, hostile)); expect(touched).not.toHaveBeenCalled()
  })
  it.each([null, undefined, 1, true, 'row', [], () => null, new Date(0)])('rejects nonplain row %s (case %#)', source => unavailable(project('instance-a', source)))
  it('rejects proxy/revoked proxy rows without hooks or diagnostics', () => {
    const touched = vi.fn((): never => { throw new Error('No proxy hooks') })
    const proxy = new Proxy(row(), { get: touched, ownKeys: touched, getPrototypeOf: touched, getOwnPropertyDescriptor: touched })
    unavailable(project('instance-a', proxy)); const revoked = Proxy.revocable({}, {}); revoked.revoke()
    unavailable(project('instance-a', revoked.proxy)); expect(touched).not.toHaveBeenCalled()
  })
  it.each(Object.keys(row()))('rejects missing row data key %s', field => {
    const source: Record<string, unknown> = row(); delete source[field]; unavailable(project('instance-a', source))
  })
  it.each(Object.keys(row()))('rejects accessor row key %s without invoking it', field => {
    const getter = vi.fn((): never => { throw new Error('No accessor') }), source = row()
    Object.defineProperty(source, field, { enumerable: true, get: getter }); unavailable(project('instance-a', source)); expect(getter).not.toHaveBeenCalled()
  })
  it('rejects symbol/extra/nonenumerable/inherited fields without stripping or reading diagnostics', () => {
    unavailable(project('instance-a', { ...row(), extra: 'denied' }))
    unavailable(project('instance-a', { ...row(), [Symbol('extra')]: true }))
    const hidden = row(); Object.defineProperty(hidden, 'configRevision', { enumerable: false }); unavailable(project('instance-a', hidden))
    unavailable(project('instance-a', Object.assign(Object.create(row()), row())))
    const diagnostic = vi.fn((): never => { throw new Error('Do not inspect diagnostics') }), source = row()
    Object.defineProperty(source, 'message', { enumerable: true, get: diagnostic }); unavailable(project('instance-a', source)); expect(diagnostic).not.toHaveBeenCalled()
  })
  it.each(['instanceRevision', 'configRevision'])('rejects invalid revision types/values for %s', field => {
    for (const value of [-1, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '9', null, undefined, true, 1n, {}]) unavailable(project('instance-a', row({ [field]: value })))
  })
  it.each(['instanceDeleted', 'configDeleted'])('requires exact live numeric zero for %s', field => {
    for (const value of [1, 2, '0', false, null, undefined, NaN]) unavailable(project('instance-a', row({ [field]: value })))
  })
  it.each(['removed', 'unknown', '', 0, null, undefined])('rejects unavailable/invalid status %s even without a tombstone', status => unavailable(project('instance-a', row({ instanceStateJson: canonical(instance({ status })) }))))
  it('rejects all mismatched instance/config references and row state identities', () => {
    for (const source of [row({ instanceId: 'different' }), row({ instanceStateJson: canonical(instance({ id: 'different' })) }), row({ instanceStateJson: canonical(instance({ definitionId: 'different' })) }), row({ instanceStateJson: canonical(instance({ configVersion: 'different' })) }), row({ configId: 'different' }), row({ configStateJson: canonical(config({ version: 'different' })) }), row({ configStateJson: canonical(config({ definitionId: 'different' })) })]) unavailable(project('instance-a', source))
  })
  it.each(['id', 'definitionId', 'configVersion'])('strictly bounds instance identity field %s', field => {
    for (const invalid of ['', ' ', ' padded ', 'x\u0000y', 'x\u007fy', 'x'.repeat(257), '界'.repeat(86), '\ud800', 1, null, true]) unavailable(project('instance-a', row({ instanceStateJson: canonical(instance({ [field]: invalid })) })))
  })
  it.each(['version', 'definitionId'])('strictly bounds config identity field %s', field => {
    for (const invalid of ['', ' ', ' padded ', 'x\u0000y', 'x'.repeat(257), '界'.repeat(86), '\udfff', 1, null, true]) unavailable(project('instance-a', row({ configStateJson: canonical(config({ [field]: invalid })) })))
  })
  it.each(['instanceStateJson', 'configStateJson'])('requires primitive valid object JSON in %s', field => {
    for (const invalid of [null, undefined, 1, true, {}, new String('{}'), '', '{', '[]', 'null', 'true', '1', '"text"']) unavailable(project('instance-a', row({ [field]: invalid })))
  })
  it.each(['instanceStateJson', 'configStateJson'])('rejects whitespace/key-order/duplicate/noncanonical JSON in %s', field => {
    const base = field === 'instanceStateJson' ? instance() : config(), text = canonical(base), reverse = `{${Object.keys(base).reverse().map(key => `${JSON.stringify(key)}:${canonical((base as Record<string, unknown>)[key])}`).join(',')}}`
    for (const invalid of [' ' + text, text + '\n', reverse, text.slice(0, -1) + ',"definitionId":"package.p.agent"}', text.replace('package.p.agent', 'package.p.\\u0061gent')]) unavailable(project('instance-a', row({ [field]: invalid })))
  })
  it('accepts literal canonical numeric spellings independently of the fixture serializer', () => {
    expectAvailable(project('instance-a', row({ instanceStateJson: '{"configVersion":"config-v7","definitionId":"package.p.agent","id":"instance-a","n":1e+21,"status":"created"}', configStateJson: '{"definitionId":"package.p.agent","version":"config-v7","x":1e-7}' })))
  })
  it.each(['instanceStateJson', 'configStateJson'])('rejects noncanonical numeric spellings in %s', field => {
    const base = field === 'instanceStateJson' ? instance() : config(), text = canonical({ ...base, x: 1 })
    for (const spelling of ['1.0', '1e0', '1E0', '-0', '0.0', '1e21', '1e-07']) unavailable(project('instance-a', row({ [field]: text.replace('"x":1', `"x":${spelling}`) })))
  })
  it.each(['instanceStateJson', 'configStateJson'])('rejects malformed UTF-16 object keys at nested positions in %s', field => {
    const base = field === 'instanceStateJson' ? instance() : config()
    for (const key of ['\ud800', '\udfff', 'before\ud800after']) unavailable(project('instance-a', row({ [field]: canonical({ ...base, extra: [{ [key]: 'inert' }] }) })))
  })
  it.each(['__proto__', 'prototype', 'constructor'])('rejects dangerous nested key %s anywhere in either JSON', key => {
    for (const field of ['instanceStateJson', 'configStateJson']) {
      const base = field === 'instanceStateJson' ? instance() : config(), extra = Object.create(null); extra[key] = 'forbidden'
      unavailable(project('instance-a', row({ [field]: canonical({ ...base, extra: [extra] }) })))
    }
  })
  it.each(['instanceStateJson', 'configStateJson'])('rejects nonfinite/escaped malformed string content in %s', field => {
    const base = field === 'instanceStateJson' ? instance() : config()
    unavailable(project('instance-a', row({ [field]: canonical({ ...base, x: null }).replace('"x":null', '"x":1e999') })))
    unavailable(project('instance-a', row({ [field]: canonical({ ...base, x: '\ud800' }) })))
  })
  it.each(['instanceStateJson', 'configStateJson'])('rejects byte/UTF16 oversized %s before ANY JSON.parse', field => {
    const cap = field === 'instanceStateJson' ? limits.instanceBytes : limits.configBytes
    const parse = vi.spyOn(JSON, 'parse')
    for (const text of ['x'.repeat(cap + 1), '界'.repeat(Math.floor(cap / 3) + 1)]) {
      expect(text.length > cap || Buffer.byteLength(text) > cap).toBe(true)
      unavailable(project('instance-a', row({ [field]: text })))
    }
    expect(parse).not.toHaveBeenCalled()
  })
  it('rejects depth33 and node4097 before recursive canonicalization can run unbounded', () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 32; depth++) nested = [nested]
    unavailable(project('instance-a', row({ instanceStateJson: canonical(instance({ x: nested })) })))
    unavailable(project('instance-a', row({ instanceStateJson: canonical(instance({ x: Array(4091).fill(0) })) })))
  })
  it('independently accepts config depth32/node4096 and rejects depth33/node4097', () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 31; depth++) nested = [nested]
    expectAvailable(project('instance-a', row({ configStateJson: canonical(config({ x: nested })) })))
    unavailable(project('instance-a', row({ configStateJson: canonical(config({ x: [nested] })) })))
    // Nine values in the original config, plus the x array container and its elements.
    expectAvailable(project('instance-a', row({ configStateJson: canonical(config({ x: Array(4086).fill(0) })) })))
    unavailable(project('instance-a', row({ configStateJson: canonical(config({ x: Array(4087).fill(0) })) })))
  })
  it('rejects extreme nesting below text cap without leaking RangeError or recursion diagnostics', () => {
    const source = canonical(instance()).slice(0, -1) + ',"x":' + '['.repeat(500) + '0' + ']'.repeat(500) + '}'
    // Reorder to canonical lexicographic order (x is last). Parsing is capped; later tree scan must be iterative.
    expect(Buffer.byteLength(source)).toBeLessThan(limits.instanceBytes)
    unavailable(project('instance-a', row({ instanceStateJson: source })))
  })
  it('returns static unavailable without inspecting thrown parse diagnostics', () => {
    const touched = vi.fn((): never => { throw new Error('Diagnostic inspection forbidden') })
    const error = new Proxy({}, { get: touched, getPrototypeOf: touched, ownKeys: touched })
    const original = Object.getOwnPropertyDescriptor(JSON, 'parse')!, source = row()
    let calls = 0, result: ReturnType<typeof project> | undefined
    try {
      // A raw method is necessary: the installed spy's thrown-error instanceof check
      // itself reflects on this proxy before the decoder's catch could receive it.
      Object.defineProperty(JSON, 'parse', { ...original, value: () => { calls++; throw error } })
      result = project('instance-a', source)
    } finally { Object.defineProperty(JSON, 'parse', original) }
    unavailable(result); expect(calls).toBe(1); expect(touched).not.toHaveBeenCalled()
    expect(Object.getOwnPropertyDescriptor(JSON, 'parse')).toEqual(original)
  })
})
