import { describe, expect, it, vi } from 'vitest'
import { parseStartupStorageMetadataRequest, parseStartupStorageMetadataResponse, startupStorageMetadataUnavailable } from './startupStorageMetadata'

const available = (source: 'default' | 'persisted' | 'env' = 'default') => ({ status: 'available', source, legacyLayout: false })
describe('pathless startup metadata wire data, never authority or storage health', () => {
  it.each([{}, Object.create(null)])('accepts only an exact empty own-data request and freezes a detached result %#', input => {
    const result = parseStartupStorageMetadataRequest(input)
    expect(result).toEqual({}); expect(Object.isFrozen(result)).toBe(true); expect(result).not.toBe(input)
  })
  it.each([null, undefined, [], 'read', 0, { path: '/fake' }, { actor: 'user' }, { policy: 'allow' }, { route: '/agent-management' }, { extra: undefined }, { [Symbol('claim')]: true }, Object.create({ route: '/agent-management' })])('rejects invalid/extra claims before normalization %#', input => {
    expect(() => parseStartupStorageMetadataRequest(input)).toThrow('Invalid startup storage metadata request.')
  })
  it('does not strip hidden or accessor authority claims and never invokes a getter', () => {
    const getter = vi.fn(() => 'allow')
    for (const input of [Object.defineProperty({}, 'policy', { get: getter }), Object.defineProperty({}, 'path', { value: '/fake' })]) expect(() => parseStartupStorageMetadataRequest(input)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it.each(['default', 'persisted', 'env'] as const)('projects the exact available shape for %s without customness, time, paths or backup claims', source => {
    const input = available(source), result = parseStartupStorageMetadataResponse(input)
    expect(result).toEqual({ status: 'available', source, legacyLayout: false }); expect(result).not.toBe(input)
    expect(Object.isFrozen(result)).toBe(true); expect(Reflect.ownKeys(result).sort()).toEqual(['legacyLayout', 'source', 'status'])
    input.legacyLayout = true; expect(result).toEqual({ status: 'available', source, legacyLayout: false })
    expect(JSON.stringify(result)).not.toMatch(/path|root|backup|healthy|saved|isCustom|observedAt|envValue/i)
  })
  it('normalizes only the exact fixed unavailable alternative to its immutable singleton', () => {
    expect(parseStartupStorageMetadataResponse({ status: 'unavailable', reason: 'unavailable' })).toBe(startupStorageMetadataUnavailable)
    expect(Object.isFrozen(startupStorageMetadataUnavailable)).toBe(true)
  })
  it.each([null, undefined, [], {}, { status: 'available' }, { ...available(), source: 'custom' }, { ...available(), source: 'default ' }, { ...available(), legacyLayout: 'false' }, { ...available(), legacyLayout: 0 }, { ...available(), path: '/private' }, { ...available(), observedAt: 1 }, { ...available(), isCustom: true }, { ...available(), then: undefined }, { ...available(), [Symbol('extra')]: true }, { status: 'unavailable', reason: 'missing path /private' }, { status: 'unavailable', reason: 'unavailable', source: 'env' }])('rejects malformed or expanded response %#', input => {
    expect(() => parseStartupStorageMetadataResponse(input)).toThrow('Invalid startup storage metadata response.')
  })
  it('rejects inherited/nonenumerable/accessor data without reading getters or traversing nested secrets', () => {
    const getter = vi.fn(() => { throw new Error('private getter') })
    for (const input of [Object.create(available()), Object.defineProperty({ source: 'default', legacyLayout: false }, 'status', { value: 'available' }), { ...available(), get extra() { return getter() } }, { get status() { return getter() }, source: 'default', legacyLayout: false }, { ...available(), source: { get value() { return getter() } } }]) expect(() => parseStartupStorageMetadataResponse(input)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
})
