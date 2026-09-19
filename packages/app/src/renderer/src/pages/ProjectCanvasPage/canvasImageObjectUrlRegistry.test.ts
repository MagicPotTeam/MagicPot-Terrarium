import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasImageObjectUrlRegistry } from './canvasImageObjectUrlRegistry'

describe('CanvasImageObjectUrlRegistry', () => {
  afterEach(() => vi.restoreAllMocks())

  it('tracks active bytes and revokes each URL exactly once', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:one')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const registry = new CanvasImageObjectUrlRegistry()
    const handle = registry.create('one', new Blob(['1234']))
    expect(handle?.url).toBe('blob:one')
    expect(registry.getMetrics()).toMatchObject({ activeCount: 1, activeBytes: 4, createdCount: 1 })
    handle?.revoke()
    handle?.revoke()
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(registry.getMetrics()).toMatchObject({ activeCount: 0, revokedCount: 1 })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate active ownership until the original handle is revoked', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:one')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const registry = new CanvasImageObjectUrlRegistry()
    const oldHandle = registry.create('same-owner', new Blob(['old']))
    expect(registry.create('same-owner', new Blob(['new']))).toBeNull()
    oldHandle?.revoke()
    expect(registry.create('same-owner', new Blob(['new']))?.url).toBe('blob:one')
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('allows identical source URLs when callers provide distinct owners', () => {
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second')
    const registry = new CanvasImageObjectUrlRegistry()
    const first = registry.create('item:first', new Blob(['same']))
    const second = registry.create('item:second', new Blob(['same']))
    expect(first?.url).toBe('blob:first')
    expect(second?.url).toBe('blob:second')
    expect(registry.getMetrics()).toMatchObject({ activeCount: 2, activeBytes: 8 })
    first?.revoke()
    second?.revoke()
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('hard rejects new URLs at the configured count budget', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:one')
    const registry = new CanvasImageObjectUrlRegistry()
    registry.setMaxCount(1)
    expect(registry.create('one', new Blob(['1']))).not.toBeNull()
    expect(registry.create('two', new Blob(['2']))).toBeNull()
    expect(registry.getMetrics()).toMatchObject({ activeCount: 1, rejectedCount: 1 })
  })

  it('releases a URL by value without double-revoking', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:value')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const registry = new CanvasImageObjectUrlRegistry()
    const handle = registry.create('value-owner', new Blob(['value']))
    expect(registry.release(handle?.url ?? '')).toBe(true)
    handle?.revoke()
    expect(registry.release(handle?.url ?? '')).toBe(true)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(registry.getMetrics()).toMatchObject({ activeCount: 0, revokedCount: 1 })
  })

  it('revokeAll clears active entries and remains safe', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:one').mockReturnValueOnce('blob:two')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const registry = new CanvasImageObjectUrlRegistry()
    registry.create('one', new Blob(['1']))
    registry.create('two', new Blob(['22']))
    registry.revokeAll()
    registry.revokeAll()
    expect(registry.getMetrics()).toMatchObject({ activeCount: 0, activeBytes: 0, revokedCount: 2 })
    expect(revoke).toHaveBeenCalledTimes(2)
  })

  describe('URL ownership transfer', () => {
    afterEach(() => vi.restoreAllMocks())
    it('adopts an existing allocation at capacity without allocating or double releasing', () => {
      const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:transfer')
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const registry = new CanvasImageObjectUrlRegistry()
      registry.setMaxCount(1)
      const source = registry.create('source', new Blob(['png']))!
      const adopted = registry.adopt('canvas', source.url)!
      expect(adopted.url).toBe(source.url)
      expect(create).toHaveBeenCalledTimes(1)
      expect(registry.getMetrics().activeCount).toBe(1)
      source.revoke()
      expect(revoke).not.toHaveBeenCalled()
      adopted.revoke()
      source.revoke()
      registry.release(source.url)
      expect(revoke).toHaveBeenCalledExactlyOnceWith(source.url)
    })
    it.each([false, true])(
      'keeps adopter leases independent at capacity (reverse=%s)',
      (reverse) => {
        const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shared')
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        const registry = new CanvasImageObjectUrlRegistry()
        registry.setMaxCount(1)
        const source = registry.create('source', new Blob(['1234']))!
        const first = registry.adopt('first', source.url)!
        const second = registry.adopt('second', source.url)!
        expect(registry.getMetrics()).toMatchObject({ activeCount: 1, activeBytes: 4 })
        expect(registry.create('other', new Blob(['other']))).toBeNull()
        expect(create).toHaveBeenCalledTimes(1)
        source.revoke()
        const [early, late] = reverse ? [second, first] : [first, second]
        early.revoke()
        early.revoke()
        expect(revoke).not.toHaveBeenCalled()
        expect(registry.getMetrics()).toMatchObject({ activeCount: 1, activeBytes: 4 })
        late.revoke()
        late.revoke()
        expect(revoke).toHaveBeenCalledExactlyOnceWith(source.url)
        expect(registry.getMetrics()).toMatchObject({
          activeCount: 0,
          activeBytes: 0,
          revokedCount: 1
        })
      }
    )

    it('does not revoke an existing URL when an adopter id is already in use', () => {
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const registry = new CanvasImageObjectUrlRegistry()
      const first = registry.adopt('first', 'blob:external', 4)!
      const second = registry.adopt('second', first.url)!
      expect(registry.adopt('first', first.url)).toBeNull()
      expect(registry.adopt('second', 'blob:rejected')).toBeNull()
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:rejected')
      first.revoke()
      expect(registry.getMetrics()).toMatchObject({ activeCount: 1, activeBytes: 4 })
      second.revoke()
      expect(revoke).toHaveBeenCalledTimes(2)
    })

    it.each(['release', 'revokeAll'] as const)(
      'explicit %s disposes all leases exactly once',
      (method) => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
        const registry = new CanvasImageObjectUrlRegistry()
        const first = registry.adopt('first', 'blob:external', 4)!
        const second = registry.adopt('second', first.url)!
        if (method === 'release') expect(registry.release(first.url)).toBe(true)
        else registry.revokeAll()
        first.revoke()
        second.revoke()
        registry.release(first.url)
        registry.revokeAll()
        expect(revoke).toHaveBeenCalledExactlyOnceWith(first.url)
        expect(registry.getMetrics()).toMatchObject({ activeCount: 0, activeBytes: 0 })
      }
    )

    it('keeps stale transferred handles from revoking a reused owner and URL', () => {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reused')
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const registry = new CanvasImageObjectUrlRegistry()
      const source = registry.create('source', new Blob(['old']))!
      registry.adopt('canvas', source.url)!.revoke()
      const replacement = registry.create('source', new Blob(['new']))!
      source.revoke()
      expect(registry.getMetrics().activeCount).toBe(1)
      expect(revoke).toHaveBeenCalledTimes(1)
      replacement.revoke()
      expect(revoke).toHaveBeenCalledTimes(2)
    })

    it('releases rejected owned transfers but never unknown borrowed URLs', () => {
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const registry = new CanvasImageObjectUrlRegistry()
      registry.setMaxCount(0)
      expect(registry.adopt('owner', 'blob:owned')).toBeNull()
      expect(registry.adopt('owner', 'blob:owned')).toBeNull()
      expect(registry.release('blob:borrowed')).toBe(false)
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned')
      expect(registry.getMetrics().activeCount).toBe(0)
    })
  })
})
