import { describe, expect, it, vi } from 'vitest'
import type { FigPluginPlan } from '@shared/figplugin/plan'
import {
  bindFigPluginRenameTransactionCancellation,
  checkFigPluginRenameSnapshot,
  closeFigPluginRenameTransaction,
  createUnavailableFigPluginHostAdapter,
  inspectFigPluginAdapterCapabilityState,
  isFigPluginRenameTransactionTransition,
  normalizeFigPluginAdapterCapabilities,
  readFigPluginAdapterDescriptor,
  validateFigPluginAdapterCapabilities,
  type FigPluginRenameSnapshot
} from './hostAdapter'

const plan = (): FigPluginPlan => ({
  schemaVersion: 1,
  mode: 'plan-only',
  selectionRevision: 'selection-1',
  steps: [{ command: 'node.rename', targetId: 'target', name: 'Exact new name' }]
})
const snapshot = (): FigPluginRenameSnapshot => ({
  complete: true,
  document: { id: 'synthetic-document', openEpoch: 'open-1', revision: 'document-1' },
  selection: { revision: 'selection-1', ids: ['target', 'other'] },
  targets: [
    {
      id: 'target',
      type: 'FRAME',
      name: 'Exact old name',
      parentId: 'parent',
      locked: false,
      effectiveLocked: false,
      renameAllowed: true,
      ancestors: [
        { id: 'parent', parentId: 'root', locked: false },
        { id: 'root', parentId: null, locked: false }
      ]
    }
  ]
})
const check = (value: unknown = snapshot(), proposal: unknown = plan()) =>
  checkFigPluginRenameSnapshot(value, proposal)

describe('default-deny main-only FIGPLUGIN HostAdapter contract', () => {
  it('notifies a non-abortable native transaction immediately on cancellation', async () => {
    const cancel = vi.fn(async (_signal: AbortSignal) => {})
    const transaction = {
      cancel,
      applyNext: vi.fn(async () => {}),
      commit: vi.fn(async () => ({ revision: 'r2' })),
      undo: vi.fn(async () => ({ revision: 'r3' })),
      readback: vi.fn(async () => snapshot()),
      close: vi.fn(async () => {})
    }
    const controller = new AbortController()
    const binding = bindFigPluginRenameTransactionCancellation(transaction, controller.signal)
    expect(binding.wasRequested()).toBe(false)
    controller.abort()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(binding.wasRequested()).toBe(true)
    const cancelSignal = cancel.mock.calls[0][0]
    expect(cancelSignal).toBeInstanceOf(AbortSignal)
    expect(cancelSignal.aborted).toBe(false)
    binding.dispose()
    controller.abort()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not invoke a late cancellation callback after the transaction is disposed', () => {
    const cancel = vi.fn(async (_signal: AbortSignal) => {})
    const controller = new AbortController()
    const binding = bindFigPluginRenameTransactionCancellation(
      { cancel } as never,
      controller.signal
    )
    binding.dispose()
    controller.abort()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('bounds a host cancellation callback that ignores its signal', async () => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn((_signal: AbortSignal) => new Promise<void>(() => {}))
      const controller = new AbortController()
      const binding = bindFigPluginRenameTransactionCancellation(
        { cancel } as never,
        controller.signal,
        25
      )
      controller.abort()
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
      const settled = binding.settled()
      await vi.advanceTimersByTimeAsync(25)
      await expect(settled).resolves.toBeUndefined()
      binding.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a host close callback that never settles', async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn(() => new Promise<void>(() => {}))
      const closing = closeFigPluginRenameTransaction({ close } as never, 25)
      await vi.advanceTimersByTimeAsync(25)
      await expect(closing).resolves.toBe(false)
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('exposes a bounded transaction lifecycle and rejects phase skips/reuse', () => {
    expect(isFigPluginRenameTransactionTransition('acquired', 'applying')).toBe(true)
    expect(isFigPluginRenameTransactionTransition('applying', 'applying')).toBe(true)
    expect(isFigPluginRenameTransactionTransition('applying', 'committing')).toBe(true)
    expect(isFigPluginRenameTransactionTransition('committing', 'committed')).toBe(true)
    expect(isFigPluginRenameTransactionTransition('committed', 'reading')).toBe(true)
    expect(isFigPluginRenameTransactionTransition('recovering', 'reading')).toBe(true)
    expect(isFigPluginRenameTransactionTransition('reading', 'closing')).toBe(true)
    expect(isFigPluginRenameTransactionTransition('closing', 'closed')).toBe(true)
    expect(isFigPluginRenameTransactionTransition('acquired', 'committed')).toBe(false)
    expect(isFigPluginRenameTransactionTransition('closed', 'applying')).toBe(false)
    expect(isFigPluginRenameTransactionTransition('committing', 'applying')).toBe(false)
  })

  it('normalizes capability declarations and rejects duplicates or unknown commands fail-closed', () => {
    const normalized = normalizeFigPluginAdapterCapabilities(['node.rename'])
    expect(normalized).toEqual(['node.rename'])
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(normalizeFigPluginAdapterCapabilities(['node.rename', 'node.rename'])).toBeUndefined()
    expect(normalizeFigPluginAdapterCapabilities(['node.opacity'])).toBeUndefined()
    expect(normalizeFigPluginAdapterCapabilities({})).toBeUndefined()

    const descriptor = readFigPluginAdapterDescriptor({
      contractVersion: 1,
      implementationVersion: 'synthetic-1',
      instanceEpoch: 'b'.repeat(32),
      kind: 'synthetic',
      capabilities: ['node.rename'] as const,
      isolation: 'compare-acquire-through-readback',
      rollback: 'transaction-only',
      revision: 'all-relevant-mutations'
    })
    expect(descriptor).toBeDefined()
    if (!descriptor) return
    expect(inspectFigPluginAdapterCapabilityState(descriptor, plan())).toMatchObject({
      state: 'ready',
      capabilities: ['node.rename']
    })
    expect(
      inspectFigPluginAdapterCapabilityState(descriptor, {
        ...plan(),
        steps: [{ command: 'node.opacity', targetId: 'target', opacity: 0.5 }]
      } as never)
    ).toEqual({ state: 'unsupported', code: 'UNSUPPORTED_COMMAND', missing: ['node.opacity'] })
    expect(
      inspectFigPluginAdapterCapabilityState(
        { ...descriptor, capabilities: ['node.rename', 'node.rename'] } as never,
        plan()
      )
    ).toEqual({ state: 'unavailable', code: 'ADAPTER_UNAVAILABLE' })
    expect(
      inspectFigPluginAdapterCapabilityState(
        new Proxy(descriptor, {
          get() {
            throw new Error('descriptor getter')
          }
        }) as never,
        plan()
      )
    ).toEqual({ state: 'unavailable', code: 'ADAPTER_UNAVAILABLE' })
  })

  it('binds every plan command to the adapter declaration and keeps unavailable fail-closed', () => {
    const descriptor = readFigPluginAdapterDescriptor({
      contractVersion: 1,
      implementationVersion: 'synthetic-1',
      instanceEpoch: 'b'.repeat(32),
      kind: 'synthetic',
      capabilities: ['node.rename'],
      isolation: 'compare-acquire-through-readback',
      rollback: 'transaction-only',
      revision: 'all-relevant-mutations'
    })
    expect(descriptor).toBeDefined()
    if (!descriptor) return
    expect(validateFigPluginAdapterCapabilities(descriptor, plan())).toEqual({ ok: true })
    expect(
      validateFigPluginAdapterCapabilities(descriptor, {
        ...plan(),
        steps: [{ command: 'node.opacity', targetId: 'target', opacity: 0.5 }]
      } as never)
    ).toEqual({ ok: false, code: 'UNSUPPORTED_COMMAND' })

    const unavailable = createUnavailableFigPluginHostAdapter().descriptor
    expect(validateFigPluginAdapterCapabilities(unavailable, plan())).toEqual({
      ok: false,
      code: 'ADAPTER_UNAVAILABLE'
    })
  })

  it('defaults to no capabilities and cannot capture or acquire a native transaction', async () => {
    const adapter = createUnavailableFigPluginHostAdapter()
    expect(Object.isFrozen(adapter)).toBe(true)
    expect(adapter.descriptor.kind).toBe('unavailable')
    expect(adapter.descriptor.capabilities).toEqual([])
    expect(Object.isFrozen(adapter.descriptor.capabilities)).toBe(true)
    const signal = new AbortController().signal
    await expect(adapter.capture(['target'], signal)).rejects.toThrow('HOST_ADAPTER_UNAVAILABLE')
    await expect(
      adapter.beginRename('a'.repeat(32), snapshot(), plan().steps, signal)
    ).rejects.toThrow('HOST_ADAPTER_UNAVAILABLE')
    expect(createUnavailableFigPluginHostAdapter().descriptor.instanceEpoch).not.toBe(
      adapter.descriptor.instanceEpoch
    )
  })

  it('accepts only independently supplied synthetic descriptors with explicit transaction guarantees', () => {
    const descriptor = {
      contractVersion: 1,
      implementationVersion: 'synthetic-1',
      instanceEpoch: 'b'.repeat(32),
      kind: 'synthetic',
      capabilities: ['node.rename'],
      isolation: 'compare-acquire-through-readback',
      rollback: 'transaction-only',
      revision: 'all-relevant-mutations'
    }
    const result = readFigPluginAdapterDescriptor(descriptor)
    expect(result).toEqual(descriptor)
    expect(result).not.toBe(descriptor)
    for (const extra of [
      { kind: 'figma' },
      { contractVersion: 2 },
      { capabilities: ['script'] },
      { capabilities: ['node.rename', 'node.rename'] },
      { rollback: 'global-undo' },
      { revision: 'capture-nonce' },
      { identityAttested: true }
    ])
      expect(readFigPluginAdapterDescriptor({ ...descriptor, ...extra })).toBeUndefined()
  })

  it('retains complete long/control-containing old names exactly, never uses truncated v1 labels', () => {
    const current = snapshot()
    current.targets[0].name = '界'.repeat(500) + '\n\u202e old'
    expect(check(current)).toEqual({ ok: true, snapshot: current })
    expect(check({ selectionRevision: 'selection-1', nodes: [] })).toEqual({
      ok: false,
      code: 'INVALID_SNAPSHOT'
    })
    expect(check({ ...current, complete: false })).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
    current.targets[0].name = '界'.repeat(1366)
    expect(check(current)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it.each([
    (value: FigPluginRenameSnapshot) => {
      value.targets[0].parentId = null
    },
    (value: FigPluginRenameSnapshot) => {
      value.targets[0].ancestors[0].parentId = 'wrong'
    },
    (value: FigPluginRenameSnapshot) => {
      value.targets[0].ancestors[1].parentId = 'unresolved-parent'
    },
    (value: FigPluginRenameSnapshot) => {
      value.targets[0].ancestors[1].id = 'target'
    },
    (value: FigPluginRenameSnapshot) => {
      value.targets[0].ancestors.reverse()
    },
    (value: FigPluginRenameSnapshot) => {
      value.targets[0].ancestors[0].locked = true
    },
    (value: FigPluginRenameSnapshot) => {
      value.targets[0].effectiveLocked = true
    }
  ])('rejects incomplete/cyclic ancestor chains and false effective-lock claims', (change) => {
    const current = snapshot()
    change(current)
    expect(check(current)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it('rejects effective ancestor locks and native editability denial', () => {
    const current = snapshot()
    current.targets[0].ancestors[0].locked = true
    current.targets[0].effectiveLocked = true
    expect(check(current)).toEqual({ ok: false, code: 'LOCKED_TARGET' })
    current.targets[0].ancestors[0].locked = false
    current.targets[0].effectiveLocked = false
    current.targets[0].renameAllowed = false
    expect(check(current)).toEqual({ ok: false, code: 'TARGET_NOT_WRITABLE' })
  })

  it('requires exact ordered targets and current selection membership, not plan-provided permissions', () => {
    const current = snapshot()
    current.selection.ids = ['other']
    expect(check(current)).toEqual({ ok: false, code: 'OUT_OF_SCOPE' })
    expect(check({ ...snapshot(), targets: [] })).toEqual({ ok: false, code: 'OUT_OF_SCOPE' })
    const other = { ...snapshot().targets[0], id: 'other', parentId: null, ancestors: [] }
    expect(check({ ...snapshot(), targets: [...snapshot().targets, other] })).toEqual({
      ok: false,
      code: 'OUT_OF_SCOPE'
    })
    expect(check(snapshot(), { ...plan(), permissions: ['write'] })).toEqual({
      ok: false,
      code: 'INVALID_PLAN'
    })
  })

  it('rejects stale selection and duplicate identities', () => {
    const current = snapshot()
    current.selection.revision = 'changed'
    expect(check(current)).toEqual({ ok: false, code: 'STALE_CONTEXT' })
    current.selection.revision = 'selection-1'
    current.selection.ids.push('target')
    expect(check(current)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
    expect(
      check({ ...snapshot(), targets: [...snapshot().targets, ...snapshot().targets] })
    ).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it('bounds selection and rejects incomplete oversized snapshots rather than truncating them', () => {
    const current = snapshot()
    current.selection.ids = ['target', ...Array.from({ length: 99 }, (_, i) => `other-${i}`)]
    expect(check(current).ok).toBe(true)
    current.selection.ids.push('one-too-many')
    expect(check(current)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
    current.selection.ids = ['target']
    current.targets[0].ancestors = Array.from({ length: 33 }, (_, i) => ({
      id: `parent-${i}`,
      parentId: i < 32 ? `parent-${i + 1}` : null,
      locked: false
    }))
    current.targets[0].parentId = 'parent-0'
    expect(check(current)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it('rejects contradictory shared ancestors across otherwise valid targets', () => {
    const current = snapshot()
    current.targets.push({
      ...structuredClone(current.targets[0]),
      id: 'other'
    })
    const proposal = plan()
    proposal.steps.push({ command: 'node.rename', targetId: 'other', name: 'Second exact name' })
    expect(check(current, proposal).ok).toBe(true)
    current.targets[1].ancestors[0].locked = true
    current.targets[1].effectiveLocked = true
    expect(check(current, proposal)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it('retains bounded complete snapshots by value and freezes all nested data', () => {
    const current = snapshot()
    current.targets[0].name = 'x'.repeat(4096)
    const result = check(current)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot).not.toBe(current)
    expect(Object.isFrozen(result.snapshot.targets[0].ancestors[0])).toBe(true)
    current.targets[0].ancestors[0].locked = true
    expect(result.snapshot.targets[0].ancestors[0].locked).toBe(false)
    expect(result.snapshot.targets[0].name).toHaveLength(4096)
    current.targets[0].name += 'x'
    expect(check(current)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it('rejects total oversized full values and unknown nested authority fields', () => {
    const current = snapshot()
    current.targets = Array.from({ length: 20 }, (_, index) => ({
      ...current.targets[0],
      id: `target-${index}`,
      name: 'x'.repeat(4096)
    }))
    current.selection.ids = current.targets.map((target) => target.id)
    const proposal = plan()
    proposal.steps = current.targets.map((target) => ({
      command: 'node.rename',
      targetId: target.id,
      name: 'New name'
    }))
    expect(check(current, proposal)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
    expect(
      check({ ...snapshot(), document: { ...snapshot().document, identityAttested: true } })
    ).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it('rejects getters and Proxies before running caller code or exposing raw errors', () => {
    const trap = vi.fn(() => {
      throw new Error('PRIVATE snapshot detail')
    })
    const current = snapshot()
    Object.defineProperty(current.document, 'revision', { enumerable: true, get: trap })
    expect(check(current)).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
    expect(check(new Proxy(snapshot(), { ownKeys: trap, getPrototypeOf: trap }))).toEqual({
      ok: false,
      code: 'INVALID_SNAPSHOT'
    })
    expect(
      readFigPluginAdapterDescriptor(new Proxy({}, { get: trap, getPrototypeOf: trap }))
    ).toBeUndefined()
    expect(trap).not.toHaveBeenCalled()
  })
})
