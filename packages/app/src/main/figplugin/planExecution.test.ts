import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginPlan } from '@shared/figplugin/plan'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import type { FigPluginPlanScope } from './planPreview'
import {
  createUnavailableFigPluginHostAdapter,
  type FigPluginHostAdapter,
  type FigPluginRenameSnapshot
} from './hostAdapter'
import { createFigPluginPlanExecutor, type FigPluginExecutionPreview } from './planExecution'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const proposal = (): FigPluginPlan => ({
  schemaVersion: 1,
  mode: 'plan-only',
  selectionRevision: 'selection-1',
  steps: [{ command: 'node.rename', targetId: 'target', name: 'New label' }]
})
const scope = (): FigPluginPlanScope => ({
  context: {
    selectionRevision: 'selection-1',
    nodes: [{ id: 'target', name: 'display only', type: 'FRAME', locked: false }]
  },
  binding: {
    pluginId: 'synthetic.figma',
    host: 'figma',
    generation: 2,
    artifactSha256: 'a'.repeat(64),
    signerFingerprint: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64),
    bridgeOrigin: 'http://127.0.0.1:43117',
    projectId: 'synthetic-project',
    profileId: 'synthetic-profile',
    profileRevision: 'd'.repeat(64)
  },
  callId: 'e'.repeat(32)
})
const snapshot = (): FigPluginRenameSnapshot => ({
  complete: true,
  document: { id: 'private-document', openEpoch: 'open-1', revision: 'revision-1' },
  selection: { revision: 'selection-1', ids: ['target'] },
  targets: [
    {
      id: 'target',
      type: 'FRAME',
      name: 'Old\n\u202e label',
      parentId: null,
      locked: false,
      ancestors: [],
      effectiveLocked: false,
      renameAllowed: true
    }
  ]
})

// Test-only memory transaction. Native fixtures model a registry-selected transport; no host
// globals or IPC are faked here.
const fixture = (
  confirm = vi.fn(async (_preview: FigPluginExecutionPreview) => true),
  native = false
) => {
  let live = snapshot(),
    revision = 1
  const currentScope = scope()
  let epoch = 'epoch-1'
  const calls: string[] = []
  const cancel = vi.fn(async (_signal: AbortSignal) => {})
  const transaction = {
    cancel,
    applyNext: vi.fn(async (_signal: AbortSignal) => {
      calls.push('apply')
      live.targets[0].name = 'New label'
    }),
    commit: vi.fn(async (_signal: AbortSignal) => {
      calls.push('commit')
      live.document.revision = `revision-${++revision}`
      return { revision: live.document.revision }
    }),
    undo: vi.fn(async (_signal: AbortSignal) => {
      calls.push('undo')
      live.targets[0].name = snapshot().targets[0].name
      live.document.revision = `revision-${++revision}`
      return { revision: live.document.revision }
    }),
    readback: vi.fn(async (_signal: AbortSignal) => {
      calls.push('readback')
      return structuredClone(live)
    }),
    close: vi.fn(async () => {
      calls.push('close')
    })
  }
  const descriptor = native
    ? ({
        contractVersion: 1 as const,
        implementationVersion: 'figma-native-1',
        instanceEpoch: 'f'.repeat(32),
        kind: 'native' as const,
        host: 'figma' as const,
        capabilities: ['node.rename'] as const,
        isolation: 'compare-acquire-through-readback' as const,
        rollback: 'transaction-only' as const,
        revision: 'all-relevant-mutations' as const
      } satisfies FigPluginHostAdapter['descriptor'])
    : ({
        contractVersion: 1 as const,
        implementationVersion: 'synthetic-1',
        instanceEpoch: 'f'.repeat(32),
        kind: 'synthetic' as const,
        capabilities: ['node.rename'] as const,
        isolation: 'compare-acquire-through-readback' as const,
        rollback: 'transaction-only' as const,
        revision: 'all-relevant-mutations' as const
      } satisfies FigPluginHostAdapter['descriptor'])
  const adapter: FigPluginHostAdapter = {
    descriptor,
    capture: vi.fn(async (_ids, _signal) => {
      calls.push('capture')
      return structuredClone(live)
    }),
    beginRename: vi.fn(async (_id, expected, _steps, _signal) => {
      calls.push('begin')
      // Synthetic final compare/acquire checks all data, not just document revision.
      if (canonicalFigPluginJson(expected) !== canonicalFigPluginJson(live)) {
        throw new Error('PRIVATE stale')
      }
      return transaction
    })
  }
  const resolveScope = vi.fn(async (_signal: AbortSignal) => ({
    scope: currentScope,
    authorityEpoch: epoch,
    adapter
  }))
  const executor = createFigPluginPlanExecutor({
    resolveScope,
    isCurrent: (value) => value === epoch,
    confirm,
    allowNativeAdapter: native
  })
  const prepare = async () => {
    const result = await executor.prepare(proposal())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Synthetic prepare failed')
    return result.preview
  }
  const execute = (preview: FigPluginExecutionPreview) =>
    executor.execute(preview.envelope.attemptId, preview.payloadSha256)
  return {
    executor,
    adapter,
    transaction,
    resolveScope,
    confirm,
    calls,
    prepare,
    execute,
    currentScope,
    live: () => live,
    setEpoch: (value: string) => {
      epoch = value
    },
    replaceLive: (value: FigPluginRenameSnapshot) => {
      live = value
    },
    cancel
  }
}
afterEach(() => vi.useRealTimers())

describe('exact FIGPLUGIN rename executor', () => {
  it('defaults unavailable with no adapter resolver and never upgrades an inert digest', async () => {
    const executor = createFigPluginPlanExecutor()
    expect(await executor.prepare(proposal())).toEqual({ ok: false, code: 'UNAVAILABLE' })
    expect(await executor.execute('a'.repeat(32), 'b'.repeat(64))).toMatchObject({
      reason: 'INVALID_PREVIEW',
      effect: 'not-applied'
    })
    const unavailable = createFigPluginPlanExecutor({
      resolveScope: async () => ({
        scope: scope(),
        authorityEpoch: 'one',
        adapter: createUnavailableFigPluginHostAdapter()
      }),
      isCurrent: () => true
    })
    expect(await unavailable.prepare(proposal())).toEqual({ ok: false, code: 'UNAVAILABLE' })
  })

  it('binds exact full old values, labels synthetic, escapes reversibly, freezes the preview and never mutates during prepare', async () => {
    const f = fixture(),
      preview = await f.prepare()
    expect(preview.envelope.domain).toBe('figplugin-node-rename-preview/v1')
    expect(preview.envelope.adapter.kind).toBe('synthetic')
    expect(preview.envelope.before.targets[0].name).toBe('Old\n\u202e label')
    expect(preview.display[0].oldName).toBe('"Old\\n\\u202e label"')
    expect(JSON.parse(preview.display[0].oldName)).toBe(f.live().targets[0].name)
    expect(Object.isFrozen(preview.envelope.before.targets[0])).toBe(true)
    expect(f.calls).toEqual(['capture'])
    f.executor.dispose()
  })

  it('executes a registry-authorized native adapter without relabeling it synthetic', async () => {
    const f = fixture(
      vi.fn(async () => true),
      true
    )
    const preview = await f.prepare()
    expect(preview.synthetic).toBe(false)
    expect(preview.envelope.adapter).toMatchObject({ kind: 'native', host: 'figma' })
    const result = await f.execute(preview)
    expect(result).toMatchObject({ reason: 'SUCCESS', effect: 'applied', synthetic: false })
    expect(f.transaction.applyNext).toHaveBeenCalledOnce()
    f.executor.dispose()
  })

  it('rejects a native adapter when the registry-backed route is not enabled', async () => {
    const f = fixture(
      vi.fn(async () => true),
      true
    )
    const executor = createFigPluginPlanExecutor({
      resolveScope: f.resolveScope,
      isCurrent: () => true,
      confirm: f.confirm
    })
    expect(await executor.prepare(proposal())).toEqual({ ok: false, code: 'UNAVAILABLE' })
    expect(f.adapter.capture).not.toHaveBeenCalled()
    executor.dispose()
  })

  it('rejects a native adapter bound to a different host before capture', async () => {
    const f = fixture(
      vi.fn(async () => true),
      true
    )
    f.currentScope.binding.host = 'photoshop'
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'UNAVAILABLE' })
    expect(f.adapter.capture).not.toHaveBeenCalled()
    f.executor.dispose()
  })

  it('denies by default even with a valid main-owned synthetic scope', async () => {
    const f = fixture()
    const executor = createFigPluginPlanExecutor({
      resolveScope: f.resolveScope,
      isCurrent: () => true
    })
    const prepared = await executor.prepare(proposal())
    if (!prepared.ok) throw new Error('prepare')
    expect(
      await executor.execute(prepared.preview.envelope.attemptId, prepared.preview.payloadSha256)
    ).toMatchObject({ reason: 'DECLINED', effect: 'not-applied' })
    expect(f.transaction.applyNext).not.toHaveBeenCalled()
  })

  it('revalidates, applies, commits and verifies exact readback; duplicate calls never redispatch', async () => {
    const f = fixture(),
      preview = await f.prepare()
    const first = f.execute(preview),
      duplicate = f.execute(preview)
    expect(await first).toMatchObject({
      reason: 'SUCCESS',
      effect: 'applied',
      synthetic: true,
      observations: [{ index: 0, state: 'requested' }]
    })
    expect(await duplicate).toEqual(await first)
    expect(await f.execute(preview)).toEqual(await first)
    expect(f.calls).toEqual(['capture', 'capture', 'begin', 'apply', 'commit', 'readback', 'close'])
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(preview)
  })

  it('reserves execution before reentrant authority callbacks and never releases another run', async () => {
    const f = fixture()
    const entered = deferred<void>(),
      release = deferred<void>()
    let armed = false
    let reentrant: ReturnType<typeof f.execute> | undefined
    const executor = createFigPluginPlanExecutor({
      resolveScope: f.resolveScope,
      confirm: f.confirm,
      isCurrent: () => {
        if (armed) {
          armed = false
          reentrant = executor.execute(preview.envelope.attemptId, preview.payloadSha256)
        }
        return true
      }
    })
    const prepared = await executor.prepare(proposal())
    if (!prepared.ok) throw Error('prepare')
    const preview = prepared.preview
    let acquired = false
    vi.mocked(f.adapter.beginRename).mockImplementation(async () => {
      if (acquired) throw Error('PRIVATE already acquired')
      acquired = true
      return f.transaction
    })
    f.transaction.applyNext.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      f.live().targets[0].name = 'New label'
    })
    armed = true
    const first = executor.execute(preview.envelope.attemptId, preview.payloadSha256)
    await entered.promise
    try {
      expect(reentrant).toBe(first)
      expect(f.confirm).toHaveBeenCalledOnce()
      expect(f.adapter.beginRename).toHaveBeenCalledOnce()
      expect(executor.status()).toMatchObject({ state: 'pending', phase: 'running' })
      expect(await executor.prepare(proposal())).toEqual({ ok: false, code: 'BUSY' })
    } finally {
      release.resolve()
      await Promise.all([first, reentrant])
    }
    expect(await first).toMatchObject({ reason: 'SUCCESS', effect: 'applied' })
    expect(f.transaction.close).toHaveBeenCalledOnce()
  })

  it('keeps the slot through cancellation in the execution microtask gap without confirmation', async () => {
    const f = fixture(),
      preview = await f.prepare()
    const work = f.execute(preview)
    f.executor.cancel(preview.envelope.attemptId)
    expect(f.executor.status()).toMatchObject({ state: 'pending', stopping: 'CANCELLED' })
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'BUSY' })
    expect(await work).toMatchObject({ reason: 'CANCELLED', effect: 'not-applied' })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.adapter.beginRename).not.toHaveBeenCalled()
  })

  it('settles a confirmation that is cancelled before it resolves and ignores its late result', async () => {
    const confirmation = deferred<boolean>(),
      entered = deferred<void>(),
      f = fixture(
        vi.fn(async () => {
          entered.resolve()
          return confirmation.promise
        })
      ),
      preview = await f.prepare()
    const work = f.execute(preview)
    await entered.promise
    f.executor.cancel(preview.envelope.attemptId)
    expect(await work).toMatchObject({ reason: 'CANCELLED', effect: 'not-applied' })
    expect(f.executor.status()).toEqual({ state: 'idle' })
    expect(f.adapter.beginRename).not.toHaveBeenCalled()
    confirmation.reject(new Error('PRIVATE late confirmation rejection'))
    await Promise.resolve()
    expect(f.executor.status()).toEqual({ state: 'idle' })
  })

  it('settles a confirmation deadline and ignores a late accepted result', async () => {
    vi.useFakeTimers()
    const confirmation = deferred<boolean>(),
      entered = deferred<void>(),
      f = fixture(
        vi.fn(async () => {
          entered.resolve()
          return confirmation.promise
        })
      ),
      preview = await f.prepare()
    const work = f.execute(preview)
    await entered.promise
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await work).toMatchObject({ reason: 'TIMED_OUT', effect: 'not-applied' })
    expect(f.executor.status()).toEqual({ state: 'idle' })
    expect(f.adapter.beginRename).not.toHaveBeenCalled()
    confirmation.resolve(true)
    await Promise.resolve()
    expect(f.executor.status()).toEqual({ state: 'idle' })
  })

  it('rechecks revocation requested synchronously inside a trusted authority guard before confirmation', async () => {
    const f = fixture()
    let armed = false
    const executor = createFigPluginPlanExecutor({
      resolveScope: f.resolveScope,
      confirm: f.confirm,
      isCurrent: () => {
        if (armed) {
          armed = false
          executor.invalidate()
        }
        return true
      }
    })
    const prepared = await executor.prepare(proposal())
    if (!prepared.ok) throw Error('prepare')
    armed = true
    expect(
      await executor.execute(prepared.preview.envelope.attemptId, prepared.preview.payloadSha256)
    ).toMatchObject({ reason: 'REVOKED', effect: 'not-applied' })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.adapter.beginRename).not.toHaveBeenCalled()
  })

  it('stops before dispatch when the authority callback invalidates an acquired transaction', async () => {
    const f = fixture()
    let acquired = false
    const executor = createFigPluginPlanExecutor({
      resolveScope: f.resolveScope,
      confirm: f.confirm,
      isCurrent: () => {
        if (acquired) executor.invalidate()
        return true
      }
    })
    const prepared = await executor.prepare(proposal())
    if (!prepared.ok) throw Error('prepare')
    vi.mocked(f.adapter.beginRename).mockImplementationOnce(async () => {
      acquired = true
      return f.transaction
    })
    expect(
      await executor.execute(prepared.preview.envelope.attemptId, prepared.preview.payloadSha256)
    ).toMatchObject({ reason: 'REVOKED', effect: 'not-applied' })
    expect(f.transaction.applyNext).not.toHaveBeenCalled()
    expect(f.transaction.close).toHaveBeenCalledOnce()
  })

  it('does not capture after synchronous invalidation inside the preparation authority callback', async () => {
    const f = fixture()
    const executor = createFigPluginPlanExecutor({
      resolveScope: f.resolveScope,
      confirm: f.confirm,
      isCurrent: () => {
        executor.invalidate()
        return true
      }
    })
    expect(await executor.prepare(proposal())).toEqual({ ok: false, code: 'REVOKED' })
    expect(f.adapter.capture).not.toHaveBeenCalled()
  })

  it('preserves a mixed plan including unchanged steps and requires a fresh revision for its actual change', async () => {
    const f = fixture()
    f.live().targets.push({ ...snapshot().targets[0], id: 'second', name: 'Unchanged label' })
    f.live().selection.ids.push('second')
    f.currentScope.context.nodes.push({
      id: 'second',
      type: 'FRAME',
      locked: false,
      name: 'display only'
    })
    const plan = proposal()
    plan.steps.push({ command: 'node.rename', targetId: 'second', name: 'Unchanged label' })
    const prepared = await f.executor.prepare(plan)
    if (!prepared.ok) throw Error('prepare')
    expect(prepared.preview.envelope.plan.steps).toEqual(plan.steps)
    expect(await f.execute(prepared.preview)).toMatchObject({
      reason: 'SUCCESS',
      effect: 'applied',
      observations: [
        { index: 0, state: 'requested' },
        { index: 1, state: 'original' }
      ]
    })
    expect(f.transaction.applyNext).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.adapter.beginRename).mock.calls[0][2]).toEqual(plan.steps)
  })

  it('rejects all-no-op execution plans before review without rewriting the inert proposal', async () => {
    const f = fixture()
    f.live().targets[0].name = proposal().steps[0].name
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'NO_CHANGES' })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.adapter.beginRename).not.toHaveBeenCalled()
    expect(f.executor.status()).toEqual({ state: 'idle' })
  })

  it.each(['original', 'committed', 'observed'] as const)(
    'rejects a rollback receipt reusing the %s revision instead of certifying stale original data',
    async (reused) => {
      const f = fixture(),
        preview = await f.prepare()
      let reusedRevision = preview.envelope.before.document.revision
      f.transaction.readback.mockImplementationOnce(async () => {
        if (reused === 'committed') reusedRevision = f.live().document.revision
        if (reused === 'observed') {
          reusedRevision = 'unexpected-observed-revision'
          return {
            ...structuredClone(f.live()),
            document: { ...f.live().document, revision: reusedRevision }
          }
        }
        throw Error('PRIVATE primary readback')
      })
      f.transaction.undo.mockImplementationOnce(async () => ({ revision: reusedRevision }))
      f.transaction.readback.mockImplementationOnce(async () => ({
        ...structuredClone(preview.envelope.before),
        document: { ...preview.envelope.before.document, revision: reusedRevision }
      }))
      expect(await f.execute(preview)).toMatchObject({
        reason: 'ERROR',
        effect: 'unknown',
        observations: []
      })
      expect(f.live().targets[0].name).toBe('New label')
      expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'QUARANTINED' })
    }
  )

  it.each([
    'type',
    'locked',
    'selection',
    'extra',
    'accessor',
    'document-extra',
    'document-getter',
    'document-non-enumerable',
    'revision-non-enumerable'
  ] as const)(
    'retains same-document revision evidence from a rejected %s readback before recovery',
    async (invalid) => {
      const f = fixture(),
        preview = await f.prepare()
      const getter = vi.fn(() => {
        throw Error('PRIVATE getter')
      })
      f.transaction.readback.mockImplementationOnce(async () => {
        const raw = structuredClone(f.live())
        raw.document.revision = 'rejected-readback-revision'
        if (invalid === 'type') raw.targets[0].type = 'TEXT'
        if (invalid === 'locked') raw.targets[0].locked = true
        if (invalid === 'selection') raw.selection.revision = 'changed-selection'
        if (invalid === 'extra') Object.assign(raw, { unexpected: true })
        if (invalid === 'accessor') Object.defineProperty(raw, 'targets', { get: getter })
        if (invalid === 'document-extra') Object.assign(raw.document, { extra: 'x'.repeat(70_000) })
        if (invalid === 'document-getter')
          Object.defineProperty(raw.document, 'extra', { get: getter })
        if (invalid === 'document-non-enumerable')
          Object.defineProperty(raw, 'document', { enumerable: false })
        if (invalid === 'revision-non-enumerable')
          Object.defineProperty(raw.document, 'revision', { enumerable: false })
        return raw
      })
      f.transaction.undo.mockResolvedValueOnce({ revision: 'rejected-readback-revision' })
      f.transaction.readback.mockImplementationOnce(async () => ({
        ...structuredClone(preview.envelope.before),
        document: { ...preview.envelope.before.document, revision: 'rejected-readback-revision' }
      }))
      expect(await f.execute(preview)).toMatchObject({
        reason: 'ERROR',
        effect: 'unknown',
        observations: []
      })
      expect(getter).not.toHaveBeenCalled()
      expect(f.live().targets[0].name).toBe('New label')
      expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'QUARANTINED' })
    }
  )

  it.each(['界', '\ud800', '\u0000'])(
    'retains maximum-length escaped/UTF-8 same-document revision evidence (%s)',
    async (unit) => {
      const f = fixture()
      const state = (suffix: string) => unit.repeat(127) + suffix
      f.live().document = {
        id: unit.repeat(128),
        openEpoch: unit.repeat(128),
        revision: state('1')
      }
      const preview = await f.prepare()
      expect(Buffer.byteLength(JSON.stringify(f.live().document))).toBeGreaterThan(1024)
      f.transaction.commit.mockImplementationOnce(async () => {
        f.live().document.revision = state('2')
        return { revision: state('2') }
      })
      f.transaction.readback.mockImplementationOnce(async () => {
        const raw = structuredClone(f.live())
        raw.document.revision = state('3')
        raw.targets[0].type = 'TEXT'
        return raw
      })
      f.transaction.undo.mockResolvedValueOnce({ revision: state('3') })
      f.transaction.readback.mockImplementationOnce(async () => ({
        ...structuredClone(preview.envelope.before),
        document: { ...preview.envelope.before.document, revision: state('3') }
      }))
      expect(await f.execute(preview)).toMatchObject({
        reason: 'ERROR',
        effect: 'unknown',
        observations: []
      })
      expect(f.live().targets[0].name).toBe('New label')
      expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'QUARANTINED' })
    }
  )

  it.each(['extra', 'oversized-extra', 'getter-extra', 'non-enumerable'])(
    'does not erase negative revision evidence from an invalid %s commit receipt',
    async (invalid) => {
      const f = fixture(),
        preview = await f.prepare()
      const getter = vi.fn(() => {
        throw Error('PRIVATE getter')
      })
      f.transaction.commit.mockImplementationOnce(async () => {
        f.live().document.revision = 'committed-but-invalid-receipt'
        const receipt = { revision: f.live().document.revision }
        if (invalid === 'extra') Object.assign(receipt, { extra: true })
        if (invalid === 'oversized-extra') Object.assign(receipt, { extra: 'x'.repeat(4096) })
        if (invalid === 'getter-extra') Object.defineProperty(receipt, 'extra', { get: getter })
        if (invalid === 'non-enumerable')
          Object.defineProperty(receipt, 'revision', { enumerable: false })
        return receipt
      })
      f.transaction.undo.mockResolvedValueOnce({ revision: 'committed-but-invalid-receipt' })
      f.transaction.readback.mockImplementationOnce(async () => ({
        ...structuredClone(preview.envelope.before),
        document: { ...preview.envelope.before.document, revision: 'committed-but-invalid-receipt' }
      }))
      expect(await f.execute(preview)).toMatchObject({
        reason: 'ERROR',
        effect: 'unknown',
        observations: []
      })
      expect(getter).not.toHaveBeenCalled()
      expect(f.live().targets[0].name).toBe('New label')
      expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'QUARANTINED' })
    }
  )

  it('rejects hostile hash inputs without getters or consuming the actual preview', async () => {
    const f = fixture(),
      preview = await f.prepare(),
      trap = vi.fn(() => {
        throw Error('PRIVATE')
      })
    expect(
      await f.executor.execute(preview.envelope.attemptId, {
        get then() {
          return trap()
        }
      })
    ).toMatchObject({ reason: 'INVALID_PREVIEW', effect: 'not-applied' })
    expect(trap).not.toHaveBeenCalled()
    expect(await f.execute(preview)).toMatchObject({ effect: 'applied' })
  })

  it('reserves prepare capacity before the first await and cleans up cancelled preparation', async () => {
    const f = fixture(),
      gate = deferred<Awaited<ReturnType<typeof f.resolveScope>>>()
    f.resolveScope.mockImplementationOnce(() => gate.promise)
    const pending = f.executor.prepare(proposal())
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'BUSY' })
    f.executor.invalidate()
    gate.resolve({ scope: f.currentScope, authorityEpoch: 'epoch-1', adapter: f.adapter })
    expect(await pending).toEqual({ ok: false, code: 'REVOKED' })
    expect(f.adapter.capture).not.toHaveBeenCalled()
    expect(f.executor.status()).toEqual({ state: 'idle' })
  })

  it.each(['epoch', 'context', 'document', 'name', 'lock', 'adapter'])(
    'denies changed %s after confirmation, with no mutation',
    async (change) => {
      const f = fixture(),
        preview = await f.prepare()
      f.confirm.mockImplementationOnce(async () => {
        if (change === 'epoch') f.setEpoch('epoch-2')
        if (change === 'context') f.currentScope.context.nodes[0].name = 'changed'
        if (change === 'document') f.live().document.openEpoch = 'open-2'
        if (change === 'name') f.live().targets[0].name = 'Changed outside transaction'
        if (change === 'lock') f.live().targets[0].locked = true
        if (change === 'adapter') f.adapter.descriptor.implementationVersion = 'changed'
        return true
      })
      expect(await f.execute(preview)).toMatchObject({ effect: 'not-applied' })
      expect(f.transaction.applyNext).not.toHaveBeenCalled()
    }
  )

  it('invalidates A→B→A authority and refuses late accepted confirmation', async () => {
    const confirmation = deferred<boolean>(),
      entered = deferred<void>()
    const f = fixture(
        vi.fn(async () => {
          entered.resolve()
          return confirmation.promise
        })
      ),
      preview = await f.prepare()
    const work = f.execute(preview)
    await entered.promise
    f.setEpoch('other')
    f.executor.invalidate()
    f.setEpoch('epoch-1')
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'BUSY' })
    confirmation.resolve(true)
    expect(await work).toMatchObject({ reason: 'REVOKED', effect: 'not-applied' })
    expect(f.transaction.applyNext).not.toHaveBeenCalled()
  })

  it('expires retained previews and clears capacity without implicit consent', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      preview = await f.prepare()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(f.executor.status()).toEqual({ state: 'idle' })
    expect(await f.execute(preview)).toMatchObject({ reason: 'EXPIRED', effect: 'not-applied' })
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it('uses adapter-side final compare/acquire; stale refusal cannot mutate', async () => {
    const f = fixture(),
      preview = await f.prepare()
    vi.mocked(f.adapter.beginRename).mockRejectedValueOnce(new Error('PRIVATE atomic mismatch'))
    expect(await f.execute(preview)).toMatchObject({ reason: 'ERROR', effect: 'not-applied' })
    expect(f.transaction.applyNext).not.toHaveBeenCalled()
  })

  it('waits for abort-ignoring mutation, then undoes with a fresh signal before releasing its slot', async () => {
    const f = fixture(),
      preview = await f.prepare(),
      gate = deferred<void>(),
      entered = deferred<void>()
    let workSignal!: AbortSignal
    f.transaction.applyNext.mockImplementationOnce(async (signal) => {
      workSignal = signal
      entered.resolve()
      await gate.promise
      f.live().targets[0].name = 'New label'
    })
    const work = f.execute(preview)
    await entered.promise
    f.executor.cancel(preview.envelope.attemptId)
    expect(workSignal.aborted).toBe(true)
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce())
    expect(f.executor.status()).toMatchObject({ state: 'pending', stopping: 'CANCELLED' })
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'BUSY' })
    gate.resolve()
    expect(await work).toMatchObject({ reason: 'CANCELLED', effect: 'rolled-back' })
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.cancel.mock.calls[0][0].aborted).toBe(false)
    expect(f.transaction.undo.mock.calls[0][0].aborted).toBe(false)
    expect(f.transaction.commit).not.toHaveBeenCalled()
    expect(f.transaction.close).toHaveBeenCalledOnce()
  })

  it('keeps capacity and cancellation pending when the work deadline is ignored', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      preview = await f.prepare(),
      gate = deferred<void>(),
      entered = deferred<void>()
    f.transaction.applyNext.mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
    })
    const work = f.execute(preview)
    await entered.promise
    await vi.advanceTimersByTimeAsync(30_001)
    expect(f.executor.status()).toMatchObject({ state: 'pending', stopping: 'TIMED_OUT' })
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'BUSY' })
    gate.resolve()
    expect(await work).toMatchObject({ reason: 'TIMED_OUT', effect: 'rolled-back' })
  })

  it.each(['applyNext', 'commit', 'readback'] as const)(
    'recovers %s failure with own undo and verified original names',
    async (stage) => {
      const f = fixture(),
        preview = await f.prepare()
      f.transaction[stage].mockRejectedValueOnce(Error('PRIVATE native raw error'))
      expect(await f.execute(preview)).toMatchObject({ reason: 'ERROR', effect: 'rolled-back' })
      expect(f.transaction.undo).toHaveBeenCalledOnce()
      expect(f.transaction.close).toHaveBeenCalledOnce()
    }
  )

  it('classifies unknown effect on failed recovery readback and quarantines that adapter', async () => {
    const f = fixture(),
      preview = await f.prepare()
    f.transaction.applyNext.mockRejectedValueOnce(Error('PRIVATE'))
    f.transaction.undo.mockRejectedValueOnce(Error('PRIVATE undo'))
    f.transaction.readback.mockRejectedValueOnce(Error('PRIVATE readback'))
    const result = await f.execute(preview)
    expect(result).toMatchObject({ reason: 'ERROR', effect: 'unknown' })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private-document|Old|label/)
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'QUARANTINED' })
  })

  it('does not call a late post-close cancellation not-applied or ordinary success', async () => {
    const f = fixture(),
      preview = await f.prepare(),
      entered = deferred<void>(),
      gate = deferred<void>()
    f.transaction.close.mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
    })
    const work = f.execute(preview)
    await entered.promise
    f.executor.cancel(preview.envelope.attemptId)
    gate.resolve()
    expect(await work).toMatchObject({ reason: 'CANCELLED', effect: 'applied' })
  })

  it('rejects descriptor changes inside a pending recapture before acquiring any transaction', async () => {
    const f = fixture(),
      preview = await f.prepare()
    vi.mocked(f.adapter.capture).mockImplementationOnce(async () => {
      f.adapter.descriptor.implementationVersion = 'changed-during-capture'
      return structuredClone(f.live())
    })
    expect(await f.execute(preview)).toMatchObject({ reason: 'REVOKED', effect: 'not-applied' })
    expect(f.adapter.beginRename).not.toHaveBeenCalled()
  })

  it('does not claim successful mutation when the supposedly reliable revision did not advance', async () => {
    const f = fixture(),
      preview = await f.prepare()
    f.transaction.commit.mockImplementationOnce(async () => ({
      revision: f.live().document.revision
    }))
    expect(await f.execute(preview)).toMatchObject({ reason: 'ERROR', effect: 'rolled-back' })
    expect(f.transaction.undo).toHaveBeenCalledOnce()
  })

  it('stops between ordered steps and classifies verified partial effects without false rollback', async () => {
    const f = fixture()
    f.live().targets.push({ ...snapshot().targets[0], id: 'second', name: 'Second old name' })
    f.live().selection.ids.push('second')
    f.currentScope.context.nodes.push({
      id: 'second',
      type: 'FRAME',
      locked: false,
      name: 'second label'
    })
    const plan = proposal()
    plan.steps.push({ command: 'node.rename', targetId: 'second', name: 'Second new name' })
    const prepared = await f.executor.prepare(plan)
    if (!prepared.ok) throw Error('prepare')
    f.transaction.applyNext.mockImplementationOnce(async () => {
      f.live().targets[0].name = 'New label'
      f.live().document.revision = 'partial-mutation-revision'
      f.executor.cancel(prepared.preview.envelope.attemptId)
    })
    f.transaction.undo.mockRejectedValueOnce(Error('PRIVATE undo failure'))
    expect(await f.execute(prepared.preview)).toMatchObject({
      reason: 'CANCELLED',
      effect: 'partial',
      observations: [
        { index: 0, state: 'requested' },
        { index: 1, state: 'original' }
      ]
    })
    expect(f.transaction.applyNext).toHaveBeenCalledOnce()
    expect(f.transaction.commit).not.toHaveBeenCalled()
    expect(await f.executor.prepare(plan)).toEqual({ ok: false, code: 'QUARANTINED' })
  })

  it('retains capacity while timed-out cleanup ignores abort, and does not certify late rollback', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      preview = await f.prepare(),
      entered = deferred<void>(),
      gate = deferred<void>()
    f.transaction.applyNext.mockRejectedValueOnce(Error('PRIVATE'))
    let cleanupSignal!: AbortSignal
    f.transaction.undo.mockImplementationOnce(async (signal) => {
      cleanupSignal = signal
      entered.resolve()
      await gate.promise
      return { revision: f.live().document.revision }
    })
    const work = f.execute(preview)
    await entered.promise
    await vi.advanceTimersByTimeAsync(10_001)
    expect(cleanupSignal.aborted).toBe(true)
    expect(f.executor.status()).toMatchObject({ state: 'pending', phase: 'recovering' })
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'BUSY' })
    gate.resolve()
    expect(await work).toMatchObject({ effect: 'partial' })
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'QUARANTINED' })
  })

  it('closes cancelled acquisitions without dispatch and treats close failure as unsafe for reuse', async () => {
    const f = fixture(),
      preview = await f.prepare()
    vi.mocked(f.adapter.beginRename).mockImplementationOnce(async () => {
      f.executor.cancel(preview.envelope.attemptId)
      return f.transaction
    })
    f.transaction.close.mockRejectedValueOnce(Error('PRIVATE close'))
    expect(await f.execute(preview)).toMatchObject({ reason: 'CANCELLED', effect: 'not-applied' })
    expect(f.transaction.applyNext).not.toHaveBeenCalled()
    expect(f.transaction.undo).not.toHaveBeenCalled()
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.cancel.mock.calls[0][0].aborted).toBe(false)
    expect(f.transaction.close).toHaveBeenCalledOnce()
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'QUARANTINED' })
  })

  it('bounds receipts/audit and never records raw host values, identifiers or errors', async () => {
    const f = fixture(),
      first = await f.prepare()
    await f.execute(first)
    for (let index = 0; index < 34; index++) {
      f.replaceLive(snapshot())
      await f.execute(await f.prepare())
    }
    expect(await f.execute(first)).toMatchObject({ reason: 'INVALID_PREVIEW' })
    const audit = f.executor.audit()
    expect(audit.length).toBeLessThanOrEqual(128)
    expect(JSON.stringify(audit)).not.toMatch(
      /Old|label|private-document|target|synthetic.figma|artifactSha256/
    )
    expect(Object.isFrozen(audit)).toBe(true)
    f.executor.dispose()
    expect(await f.executor.prepare(proposal())).toEqual({ ok: false, code: 'DISPOSED' })
  })
})
