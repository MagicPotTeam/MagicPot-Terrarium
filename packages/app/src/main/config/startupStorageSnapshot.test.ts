import { describe, expect, it, vi } from 'vitest'
import { createStartupStorageSnapshot } from './startupStorageSnapshot'

const valid = () => ({ source: 'persisted' as const, legacyLayout: false })

describe('MAIN-only startup storage snapshot, no initialization fallback', () => {
  it('starts unavailable and never fabricates source, layout, paths, health or backup state', () => {
    const owner = createStartupStorageSnapshot()
    expect(owner.capture()).toBeNull(); expect(owner.capture()).toBeNull()
    expect(Object.keys(owner).sort()).toEqual(['capture', 'invalidate', 'publish'])
    expect(Object.isFrozen(owner)).toBe(true)
  })
  it.each(['default', 'persisted', 'env'] as const)('publishes only the exact immutable successful-startup projection for %s', source => {
    const owner = createStartupStorageSnapshot(), input = { source, legacyLayout: true }
    expect(owner.publish(input)).toBe(true)
    const first = owner.capture(), second = owner.capture()
    expect(first?.snapshot).toEqual({ source, legacyLayout: true })
    expect(Reflect.ownKeys(first!.snapshot).sort()).toEqual(['legacyLayout', 'source'])
    expect(first?.isCurrent()).toBe(true); expect(second?.isCurrent()).toBe(true)
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first!.snapshot)).toBe(true)
    input.legacyLayout = false
    expect(first!.snapshot.legacyLayout).toBe(true)
    expect(() => { Object.assign(first!.snapshot, { source: 'env' }) }).toThrow()
    expect(JSON.stringify(first!.snapshot)).not.toMatch(/path|root|health|backup|isCustom|observedAt/i)
  })
  it('invalidates before any publication and does not re-arm until a new owner/process', () => {
    const owner = createStartupStorageSnapshot()
    owner.invalidate(); owner.invalidate()
    expect(owner.publish(valid())).toBe(false); expect(owner.capture()).toBeNull()
    const restarted = createStartupStorageSnapshot()
    expect(restarted.publish(valid())).toBe(true); expect(restarted.capture()?.isCurrent()).toBe(true)
  })
  it('revokes all captured freshness predicates synchronously and never resurrects on retry', () => {
    const owner = createStartupStorageSnapshot()
    expect(owner.publish(valid())).toBe(true)
    const first = owner.capture()!, second = owner.capture()!
    owner.invalidate()
    expect(first.isCurrent()).toBe(false); expect(second.isCurrent()).toBe(false)
    expect(first.snapshot).toEqual(valid()); expect(owner.capture()).toBeNull()
    expect(owner.publish({ source: 'env', legacyLayout: true })).toBe(false)
    expect(first.isCurrent()).toBe(false)
  })
  it('treats duplicate publication, even identical scalar fields, as terminal replacement rather than fresh authority', () => {
    const owner = createStartupStorageSnapshot()
    expect(owner.publish(valid())).toBe(true); const first = owner.capture()!
    expect(owner.publish(valid())).toBe(false)
    expect(first.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
    expect(owner.publish(valid())).toBe(false)
  })
  const invalid: Array<{ name: string; value: unknown }> = [
    { name: 'null', value: null }, { name: 'undefined', value: undefined }, { name: 'string', value: 'default' }, { name: 'array', value: ['default', false] },
    { name: 'missing boolean', value: { source: 'default' } }, { name: 'missing source', value: { legacyLayout: false } },
    { name: 'wrong source alias', value: { source: 'custom', legacyLayout: false } }, { name: 'unknown source', value: { source: 'unknown', legacyLayout: false } },
    { name: 'boolean string', value: { source: 'default', legacyLayout: 'false' } }, { name: 'numeric boolean', value: { source: 'default', legacyLayout: 0 } },
    { name: 'path extra', value: { source: 'default', legacyLayout: false, path: 'NO_PATH_ALLOWED' } },
    { name: 'symbol extra', value: { source: 'default', legacyLayout: false, [Symbol('extra')]: true } },
    { name: 'inherited fields', value: Object.create({ source: 'default', legacyLayout: false }) },
    { name: 'non-enumerable field', value: Object.defineProperty({ legacyLayout: false }, 'source', { value: 'default' }) }
  ]
  it.each(invalid)('rejects $name without a fallback default and consumes the only publication attempt', ({ value }) => {
    const owner = createStartupStorageSnapshot()
    expect(owner.publish(value)).toBe(false); expect(owner.capture()).toBeNull()
    expect(owner.publish(valid())).toBe(false); expect(owner.capture()).toBeNull()
  })
  it('rejects accessor metadata without invoking its getter or a reentrant attempted publish', () => {
    const owner = createStartupStorageSnapshot(), getter = vi.fn(() => { owner.publish(valid()); return 'default' })
    const input = Object.defineProperty({ legacyLayout: false }, 'source', { enumerable: true, get: getter })
    expect(owner.publish(input)).toBe(false); expect(getter).not.toHaveBeenCalled()
    expect(owner.capture()).toBeNull(); expect(owner.publish(valid())).toBe(false)
  })
  it('rejects proxies including revoked proxies without triggering any traps', () => {
    const owner = createStartupStorageSnapshot(), trap = vi.fn(() => { throw new Error('Do not traverse a proxy') })
    const input = new Proxy(valid(), { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap })
    expect(owner.publish(input)).toBe(false); expect(trap).not.toHaveBeenCalled()
    const revoked = Proxy.revocable(valid(), {}); revoked.revoke()
    expect(createStartupStorageSnapshot().publish(revoked.proxy)).toBe(false)
  })
  it('accepts a plain null-prototype data projection, never a caller path or whole startup result', () => {
    const owner = createStartupStorageSnapshot(), input = Object.assign(Object.create(null), valid())
    expect(owner.publish(input)).toBe(true); expect(owner.capture()?.snapshot).toEqual(valid())
    expect(createStartupStorageSnapshot().publish({ ...valid(), path: 'not-a-grant', storageRoot: 'not-a-grant' })).toBe(false)
  })
})
