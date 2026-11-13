import { describe, expect, it, vi } from 'vitest'
import { installedCatalogUnavailable, parseInstalledCatalogReadRequest as request, parseInstalledCatalogReadResponse as response } from './installedCatalog'

const entry = () => ({ id: 'demo', name: '演示 Demo', version: '1.2.3-beta.build', installedAt: '2026-01-01T00:00:00.000Z' })
const snapshot = () => ({ status: 'available', entries: [entry()] })
const rejects = (value: unknown) => expect(() => response(value)).toThrow('Invalid installed catalog response.')

describe('platform-neutral installed-catalog strict wire contract (not endpoint authority)', () => {
  it.each([{}, Object.create(null)])('accepts only an exact empty record and detaches a frozen request %#', value => {
    const result = request(value)
    expect(result).toEqual({}); expect(result).not.toBe(value); expect(Object.isFrozen(result)).toBe(true)
  })
  it.each([null, undefined, false, 1, '', [], new Date(0), Object.create({ claimed: true }), { actor: {} }, { path: 'PRIVATE' }, { transport: 'electron-ipc' }, { policy: 'allow' }, { enabled: true }])('rejects malformed/extra request %# instead of stripping authority claims', value => {
    expect(() => request(value)).toThrow('Invalid installed catalog request.')
  })
  it('rejects symbol/nonenumerable/accessor request claims without evaluating accessor or toJSON', () => {
    const getter = vi.fn(() => 'PRIVATE'), toJSON = vi.fn(() => ({}))
    for (const value of [{ [Symbol('authority')]: true }, Object.defineProperty({}, 'path', { value: 'PRIVATE' }), Object.defineProperty({}, 'actor', { get: getter, enumerable: true }), { toJSON }]) {
      expect(() => request(value)).toThrow('Invalid installed catalog request.')
    }
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled()
  })
  it('accepts only the bounded static unavailable shape and freezes a detached result', () => {
    const raw = { status: 'unavailable', reason: 'unavailable' }, parsed = response(raw)
    expect(parsed).toEqual(installedCatalogUnavailable); expect(parsed).not.toBe(raw); expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(installedCatalogUnavailable)).toBe(true)
  })
  it('projects exactly four immutable fields from detached public data, no persisted paths or envelope', () => {
    const raw = snapshot(), value = response(raw)
    expect(value).toEqual(raw); expect(value).not.toBe(raw); expect(Object.isFrozen(value)).toBe(true)
    if (value.status !== 'available') throw new Error('Expected available fixture')
    expect(value.entries).not.toBe(raw.entries); expect(Object.isFrozen(value.entries)).toBe(true)
    expect(value.entries[0]).not.toBe(raw.entries[0]); expect(Object.isFrozen(value.entries[0])).toBe(true)
    expect(Reflect.ownKeys(value.entries[0]!)).toEqual(['id', 'name', 'version', 'installedAt'])
    raw.entries[0]!.name = 'Changed'; raw.entries.push(entry()); expect(value.entries).toHaveLength(1); expect(value.entries[0]?.name).toBe('演示 Demo')
  })
  it.each([0, 64])('accepts bounded actual available snapshots with %s entries', count => {
    const entries = Array.from({ length: count }, (_, i) => ({ ...entry(), id: 'demo-' + i }))
    expect(response({ status: 'available', entries })).toEqual({ status: 'available', entries })
  })
  it.each(['demo.txt', 'a'.repeat(64), 'com0'])('accepts writer-compatible exact legal ID %s', id => {
    expect(response({ status: 'available', entries: [{ ...entry(), id }] }).status).toBe('available')
  })
  it('accepts null-prototype passive records, maximum display/version lengths, canonical leap day', () => {
    const item = Object.assign(Object.create(null), { ...entry(), name: '名'.repeat(120), version: '1.2.3-' + 'x'.repeat(122), installedAt: '2024-02-29T00:00:00.000Z' })
    expect(response(Object.assign(Object.create(null), { status: 'available', entries: [item] }))).toEqual({ status: 'available', entries: [item] })
  })
  it.each([null, undefined, false, [], new Date(0), { status: 'available' }, { status: 'unavailable' }, { status: 'unknown', entries: [] }, { status: 'unavailable', reason: 'PRIVATE' }, { status: 'unavailable', reason: 'missing-root' }, { status: 'unavailable', reason: 'unavailable', path: 'PRIVATE' }, { ok: true, value: { status: 'available', entries: [] } }, { status: 'available', entries: [], sourcePath: 'PRIVATE' }])('rejects malformed/extra/envelope response %# with a static error', value => { rejects(value) })
  it.each(['../demo', 'demo..a', 'Demo', '', 'x'.repeat(65), 'demo.', 'demo ', 'demo:ads', 'con', 'nul.txt', 'com1', 'lpt9.json', '.install-demo-1-a'])('rejects unsupported/alias/artifact ID %s', id => { rejects({ status: 'available', entries: [{ ...entry(), id }] }) })
  it.each(['', ' x', 'x ', 'x'.repeat(121), 'line\nbreak', 'tab\tname', 'nul\u0000name', 'del\u007fname', 'replacement\ufffd'])('rejects out-of-contract name %#', name => { rejects({ status: 'available', entries: [{ ...entry(), name }] }) })
  it.each(['v1.2.3', '1.2', '1.2.3.4', '', '1.2.3-' + 'x'.repeat(123), '1.2.3\n'])('rejects out-of-contract version %#', version => { rejects({ status: 'available', entries: [{ ...entry(), version }] }) })
  it.each([0, '', '2026-01-01', '2026-01-01T00:00:00Z', '2026-02-30T00:00:00.000Z', '2023-02-29T00:00:00.000Z', '2026-01-01T00:00:00.000+00:00', '2026-99-99T00:00:00.000Z'])('rejects noncanonical installedAt %#', installedAt => { rejects({ status: 'available', entries: [{ ...entry(), installedAt }] }) })
  it.each(['duplicate', 'too-many', 'hole', 'accessor', 'array-extra', 'array-symbol', 'array-prototype', 'not-array'] as const)('rejects invalid entries collection %s without reading collection accessors', kind => {
    const getter = vi.fn(entry)
    let entries: unknown = [entry()]
    if (kind === 'duplicate') entries = [entry(), entry()]
    if (kind === 'too-many') entries = Array.from({ length: 65 }, (_, i) => ({ ...entry(), id: 'demo-' + i }))
    if (kind === 'hole') entries = new Array(1)
    if (kind === 'accessor') entries = Object.defineProperty([entry()], '0', { get: getter })
    if (kind === 'array-extra') entries = Object.assign([entry()], { path: 'PRIVATE' })
    if (kind === 'array-symbol') entries = Object.assign([entry()], { [Symbol('path')]: 'PRIVATE' })
    if (kind === 'array-prototype') entries = Object.setPrototypeOf([entry()], null)
    if (kind === 'not-array') entries = { 0: entry(), length: 1 }
    rejects({ status: 'available', entries }); expect(getter).not.toHaveBeenCalled()
  })
  it('rejects extra/missing/hidden/inherited/symbol entry fields, status getters and callbacks without executing them', () => {
    const getter = vi.fn(() => 'PRIVATE'), toJSON = vi.fn(() => entry()), then = vi.fn()
    const { name: _name, ...missing } = entry()
    for (const item of [missing, { ...entry(), sourcePath: 'PRIVATE' }, { ...entry(), packagePath: 'PRIVATE' }, { ...entry(), manifest: {} }, { ...entry(), toJSON }, { ...entry(), then }, Object.assign(Object.create({ inherited: true }), entry()), { ...entry(), [Symbol('path')]: true }, Object.defineProperty(entry(), 'name', { value: 'PRIVATE', enumerable: false }), Object.defineProperty(entry(), 'name', { get: getter })]) {
      rejects({ status: 'available', entries: [item] })
    }
    rejects(Object.defineProperty(snapshot(), 'status', { get: getter })); rejects({ ...snapshot(), toJSON }); rejects({ ...snapshot(), then })
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled(); expect(then).not.toHaveBeenCalled()
  })
  it('caps total serialized characters even when individual fields meet limits', () => {
    const entries = Array.from({ length: 64 }, (_, i) => ({ ...entry(), id: 'demo-' + i, name: '"'.repeat(120), version: '1.2.3-' + 'x'.repeat(122) }))
    // Four-field/batch bounds are stronger than the output limit today; preserve the explicit output contract.
    const value = response({ status: 'available', entries })
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(131072)
  })
})
