import { describe, expect, it, vi } from 'vitest'
import type { FigPluginPlan } from '@shared/figplugin/plan'
import { createUnavailableFigPluginHostAdapter, type FigPluginHostAdapter } from './hostAdapter'
import {
  createFigPluginHostAdapterRegistry,
  createFigPluginProductionHostAdapterSessions
} from './hostAdapterRegistry'

const plan = (): FigPluginPlan => ({
  schemaVersion: 1,
  mode: 'plan-only',
  selectionRevision: 'selection-1',
  steps: [{ command: 'node.rename', targetId: 'target', name: 'New name' }]
})

const nativeAdapter = (epoch = 'a'.repeat(32), host: 'figma' | 'photoshop' = 'figma') => {
  const adapter = {
    descriptor: {
      contractVersion: 1 as const,
      implementationVersion: 'figma-native-1',
      instanceEpoch: epoch,
      kind: 'native' as const,
      host,
      capabilities: ['node.rename' as const],
      isolation: 'compare-acquire-through-readback' as const,
      rollback: 'transaction-only' as const,
      revision: 'all-relevant-mutations' as const
    },
    capture: vi.fn(),
    beginRename: vi.fn(),
    dispose: vi.fn(async () => {})
  }
  return adapter as unknown as FigPluginHostAdapter & { descriptor: Record<string, unknown> }
}

describe('production HostAdapter registry boundary', () => {
  it('registers native adapters, resolves capabilities, and enumerates descriptors only', () => {
    const registry = createFigPluginHostAdapterRegistry()
    const adapter = nativeAdapter()
    const registered = registry.register(adapter)
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    expect(registered.registration.key).toBe('a'.repeat(32))
    expect(registry.get('a'.repeat(32))).toBe(adapter)
    expect(registry.getForHost('a'.repeat(32), 'figma')).toBe(adapter)
    expect(registry.getForHost('a'.repeat(32), 'photoshop')).toBeUndefined()
    expect(registry.resolveForPlan('a'.repeat(32), plan())).toMatchObject({
      ok: true,
      descriptor: { kind: 'native', host: 'figma' },
      adapter
    })
    expect(registry.resolveForPlan('a'.repeat(32), plan(), 'photoshop')).toEqual({
      ok: false,
      code: 'HOST_MISMATCH'
    })
    const listed = registry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ key: 'a'.repeat(32), descriptor: { kind: 'native' } })
    expect(listed[0]).not.toHaveProperty('adapter')
    expect(Object.isFrozen(listed)).toBe(true)
  })

  it('rejects synthetic, unavailable, malformed, and duplicate registrations', () => {
    const registry = createFigPluginHostAdapterRegistry()
    const synthetic: FigPluginHostAdapter = {
      descriptor: {
        contractVersion: 1,
        implementationVersion: 'synthetic-1',
        instanceEpoch: 'b'.repeat(32),
        kind: 'synthetic',
        capabilities: ['node.rename'],
        isolation: 'compare-acquire-through-readback',
        rollback: 'transaction-only',
        revision: 'all-relevant-mutations'
      },
      capture: vi.fn(),
      beginRename: vi.fn()
    }
    expect(registry.register(synthetic)).toEqual({ ok: false, code: 'NOT_PRODUCTION_ADAPTER' })
    expect(registry.register(createUnavailableFigPluginHostAdapter())).toEqual({
      ok: false,
      code: 'ADAPTER_UNAVAILABLE'
    })
    expect(registry.register({ descriptor: {} })).toEqual({
      ok: false,
      code: 'INVALID_ADAPTER'
    })

    const adapter = nativeAdapter('c'.repeat(32))
    expect(registry.register(adapter).ok).toBe(true)
    expect(registry.register(adapter)).toEqual({ ok: false, code: 'DUPLICATE_INSTANCE' })
  })

  it('fails closed for unsupported plans and revokes changed descriptors', () => {
    const registry = createFigPluginHostAdapterRegistry()
    const adapter = nativeAdapter('d'.repeat(32))
    expect(registry.register(adapter).ok).toBe(true)
    expect(
      registry.resolveForPlan('d'.repeat(32), {
        ...plan(),
        steps: [{ command: 'node.opacity', targetId: 'target', opacity: 0.5 }]
      } as never)
    ).toEqual({ ok: false, code: 'UNSUPPORTED_COMMAND' })

    adapter.descriptor.implementationVersion = 'tampered'
    expect(registry.get('d'.repeat(32))).toBeUndefined()
    expect(registry.list()).toEqual([])
  })

  it('protects replacement teardown and disposes registered adapters exactly once', async () => {
    const registry = createFigPluginHostAdapterRegistry()
    const first = nativeAdapter('e'.repeat(32))
    const second = nativeAdapter('f'.repeat(32))
    expect(registry.register(first).ok).toBe(true)
    expect(registry.unregister('e'.repeat(32), second)).toBe(false)
    expect(registry.unregister('e'.repeat(32), first)).toBe(true)
    expect(registry.register(second).ok).toBe(true)
    await registry.dispose()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(registry.get('f'.repeat(32))).toBeUndefined()
    expect(registry.register(nativeAdapter('1'.repeat(32)))).toEqual({
      ok: false,
      code: 'ADAPTER_UNAVAILABLE'
    })
    await registry.dispose()
    expect(second.dispose).toHaveBeenCalledOnce()
  })

  it('binds a live scope resolver to one registered host and refuses ambiguity', async () => {
    const sessions = createFigPluginProductionHostAdapterSessions()
    const adapter = nativeAdapter('1'.repeat(32))
    const source = {
      target: { pluginId: 'demo.figma', expectedGeneration: 1 },
      projectId: 'project-1',
      context: {
        nodes: [],
        selectionRevision: 'selection-1'
      },
      callId: '2'.repeat(32)
    }
    const captureScope = vi.fn(async () => source)
    expect(sessions.register(adapter, captureScope).ok).toBe(true)
    await expect(sessions.captureScope(new AbortController().signal)).resolves.toMatchObject({
      ...source,
      adapterInstanceEpoch: '1'.repeat(32)
    })
    expect(captureScope).toHaveBeenCalledOnce()

    const second = nativeAdapter('2'.repeat(32))
    expect(sessions.register(second, async () => source).ok).toBe(true)
    await expect(sessions.captureScope(new AbortController().signal)).resolves.toBeUndefined()
    expect(sessions.unregister('2'.repeat(32), second)).toBe(true)
    expect(sessions.unregister('1'.repeat(32), second)).toBe(false)
    await sessions.clear()
    expect(adapter.dispose).toHaveBeenCalledOnce()
    expect(sessions.list()).toEqual([])
    await sessions.dispose()
  })

  it('drops a stale scope when its adapter descriptor changes or callback aborts', async () => {
    const sessions = createFigPluginProductionHostAdapterSessions()
    const adapter = nativeAdapter('3'.repeat(32))
    const gate = new AbortController()
    expect(sessions.register(adapter, async () => undefined).ok).toBe(true)
    await expect(sessions.captureScope(gate.signal)).resolves.toBeUndefined()
    adapter.descriptor.implementationVersion = 'tampered'
    await expect(sessions.captureScope(new AbortController().signal)).resolves.toBeUndefined()
    expect(sessions.list()).toEqual([])
    await sessions.dispose()
  })
})
