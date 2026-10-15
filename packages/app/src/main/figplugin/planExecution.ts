import { createHash, randomBytes } from 'node:crypto'
import { types } from 'node:util'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import { FIGPLUGIN_PLAN_MAX_BYTES, snapshotFigPluginPlanData } from '@shared/figplugin/plan'
import {
  checkFigPluginRenameSnapshot,
  readFigPluginAdapterDescriptor,
  type FigPluginAdapterDescriptor,
  type FigPluginHostAdapter,
  type FigPluginRenameSnapshot,
  type FigPluginRenameTransaction
} from './hostAdapter'
import {
  createFigPluginPlanPreview,
  matchesFigPluginPlanPreview,
  type FigPluginPlanPreview,
  type FigPluginPlanScope
} from './planPreview'

// Main-only synthetic foundation, optionally owned by the controller. No native adapter, IPC
// or provider parsing. Production controllers supply no adapter, so preparation is unavailable.
// Digest possession is NOT approval. All authorities/callbacks below must be selected by main.
export type FigPluginExecutionEffect =
  'not-applied' | 'applied' | 'rolled-back' | 'partial' | 'unknown'
type Stop = 'CANCELLED' | 'REVOKED' | 'EXPIRED' | 'TIMED_OUT' | 'DISPOSED'
type Reason = Stop | 'SUCCESS' | 'DECLINED' | 'ERROR' | 'INVALID_PREVIEW'
type PreparationCode =
  | Stop
  | 'UNAVAILABLE'
  | 'BUSY'
  | 'QUARANTINED'
  | 'INVALID_PLAN'
  | 'INVALID_SCOPE'
  | 'NO_CHANGES'
  | 'ERROR'
type Observation = { index: number; state: 'original' | 'requested' | 'other' }
export type FigPluginExecutionOutcome = {
  attemptId?: string
  synthetic: true
  reason: Reason
  effect: FigPluginExecutionEffect
  observations: readonly Observation[]
}
export type FigPluginExecutionPreview = {
  envelope: {
    domain: 'figplugin-node-rename-preview/v1'
    attemptId: string
    createdAt: number
    expiresAt: number
    authorityEpoch: string
    adapter: FigPluginAdapterDescriptor
    scope: FigPluginPlanScope
    plan: FigPluginPlanPreview['envelope']['plan']
    before: FigPluginRenameSnapshot
    rollback: 'transaction-only'
  }
  payloadSha256: string
  synthetic: true
  display: readonly { index: number; oldName: string; newName: string }[]
}
export type FigPluginExecutionScope = {
  scope: FigPluginPlanScope
  authorityEpoch: string
  adapter: FigPluginHostAdapter
}
type Options = {
  resolveScope?: (signal: AbortSignal) => Promise<FigPluginExecutionScope | undefined>
  isCurrent?: (authorityEpoch: string) => boolean
  confirm?: (preview: FigPluginExecutionPreview) => Promise<boolean>
  now?: () => number
}
type Phase = 'preparing' | 'ready' | 'confirming' | 'running' | 'recovering' | 'closing'
type Audit = {
  attemptId: string
  phase: Phase | 'settled'
  reason?: Reason
  effect?: FigPluginExecutionEffect
  at: number
}
type Slot = {
  id: string
  generation: number
  phase: Phase
  abort: AbortController
  stop?: Stop
  timer?: ReturnType<typeof setTimeout>
  adapter?: FigPluginHostAdapter
  inert?: FigPluginPlanPreview
  preview?: FigPluginExecutionPreview
  promise?: Promise<FigPluginExecutionOutcome>
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const same = (left: unknown, right: unknown): boolean =>
  canonicalFigPluginJson(left) === canonicalFigPluginJson(right)
// Reversible full display, including bidi/non-ASCII UTF-16 units. Never silently elides old values.
const escaped = (text: string): string =>
  JSON.stringify(text).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
const revision = (raw: unknown): string | undefined => {
  const data = snapshotFigPluginPlanData(raw, 1024, types.isProxy)
  if (!data.ok || !data.data || typeof data.data !== 'object' || Array.isArray(data.data))
    return undefined
  const result = data.data as Record<string, unknown>
  return Object.keys(result).length === 1 &&
    typeof result.revision === 'string' &&
    result.revision.length > 0 &&
    result.revision.length <= 128
    ? result.revision
    : undefined
}

const ownIdentifier = (raw: unknown, key: string): string | undefined => {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) || Array.isArray(raw)) return undefined
  const own = Object.getOwnPropertyDescriptor(raw, key)
  return own &&
    'value' in own &&
    typeof own.value === 'string' &&
    own.value.length > 0 &&
    own.value.length <= 128
    ? own.value
    : undefined
}

// Negative evidence survives a rejected readback: safely retain the exact document's revision
// even when targets/selection/other fields are invalid. This never certifies a valid snapshot.
const sameDocumentRevision = (
  raw: unknown,
  expected: FigPluginRenameSnapshot['document']
): string | undefined => {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) || Array.isArray(raw)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'document')
  if (!descriptor || !('value' in descriptor)) return undefined
  const document: unknown = descriptor.value
  if (
    !document ||
    typeof document !== 'object' ||
    types.isProxy(document) ||
    Array.isArray(document)
  )
    return undefined
  // Only three bounded primitive fields, with no enumeration/stringification. Schema-valid
  // UTF-16 IDs may use six JSON bytes per unit; extra invalid fields must not erase evidence.
  return ownIdentifier(document, 'id') === expected.id &&
    ownIdentifier(document, 'openEpoch') === expected.openEpoch
    ? ownIdentifier(document, 'revision')
    : undefined
}

export const createFigPluginPlanExecutor = (options: Options = {}) => {
  const now = options.now ?? Date.now
  const isCurrent = options.isCurrent ?? (() => false)
  const quarantined = new WeakSet<FigPluginHostAdapter>()
  const receipts = new Map<string, { hash: string; outcome: FigPluginExecutionOutcome }>()
  const events: Audit[] = []
  let active: Slot | undefined
  let generation = 0
  let disposed = false
  const record = (
    slot: Slot,
    phase: Audit['phase'],
    reason?: Reason,
    effect?: FigPluginExecutionEffect
  ): void => {
    events.push(freeze({ attemptId: slot.id, phase, reason, effect, at: now() }))
    if (events.length > 128) events.shift()
  }
  const outcome = (
    reason: Reason,
    effect: FigPluginExecutionEffect = 'not-applied',
    slot?: Slot,
    observations: readonly Observation[] = []
  ): FigPluginExecutionOutcome =>
    freeze({
      ...(slot ? { attemptId: slot.id } : {}),
      synthetic: true,
      reason,
      effect,
      observations
    })
  const finish = (slot: Slot, result: FigPluginExecutionOutcome): FigPluginExecutionOutcome => {
    clearTimeout(slot.timer)
    if (slot.preview) {
      receipts.set(slot.id, { hash: slot.preview.payloadSha256, outcome: result })
      if (receipts.size > 32) receipts.delete(receipts.keys().next().value!)
    }
    record(slot, 'settled', result.reason, result.effect)
    slot.preview = undefined
    slot.inert = undefined
    slot.adapter = undefined
    if (active === slot) active = undefined
    return result
  }
  const stop = (slot: Slot, reason: Stop): void => {
    if (!slot.stop) slot.stop = reason
    slot.abort.abort()
    record(slot, slot.phase, slot.stop)
    if (slot.phase === 'ready') finish(slot, outcome(slot.stop, 'not-applied', slot))
  }
  const deadline = (slot: Slot, milliseconds: number, reason: Stop): void => {
    clearTimeout(slot.timer)
    slot.timer = setTimeout(() => stop(slot, reason), milliseconds)
    slot.timer.unref?.()
  }
  const guard = (slot: Slot): void => {
    if (slot.stop) throw new Error(slot.stop)
    if (disposed || slot.generation !== generation || active !== slot) {
      stop(slot, disposed ? 'DISPOSED' : 'REVOKED')
      throw new Error('REVOKED')
    }
    if (slot.preview && now() >= slot.preview.envelope.expiresAt) {
      stop(slot, 'EXPIRED')
      throw new Error('EXPIRED')
    }
    if (slot.preview) {
      const descriptor = slot.adapter && readFigPluginAdapterDescriptor(slot.adapter.descriptor)
      if (
        !isCurrent(slot.preview.envelope.authorityEpoch) ||
        !descriptor ||
        !same(descriptor, slot.preview.envelope.adapter)
      ) {
        stop(slot, 'REVOKED')
        throw new Error('REVOKED')
      }
    }
    // Trusted callbacks may synchronously cancel/invalidate even when returning true.
    if (slot.stop) throw new Error(slot.stop)
  }
  const prepare = async (
    proposal: unknown
  ): Promise<
    { ok: true; preview: FigPluginExecutionPreview } | { ok: false; code: PreparationCode }
  > => {
    if (disposed) return { ok: false, code: 'DISPOSED' }
    if (active) return { ok: false, code: 'BUSY' }
    if (!options.resolveScope) return { ok: false, code: 'UNAVAILABLE' }
    const input = snapshotFigPluginPlanData(proposal, FIGPLUGIN_PLAN_MAX_BYTES, types.isProxy)
    if (!input.ok) return { ok: false, code: 'INVALID_PLAN' }
    const slot: Slot = {
      id: randomBytes(16).toString('hex'),
      generation,
      phase: 'preparing',
      abort: new AbortController()
    }
    active = slot
    record(slot, 'preparing')
    deadline(slot, 30_000, 'TIMED_OUT')
    let failure: PreparationCode = 'ERROR'
    try {
      const authority = await options.resolveScope(slot.abort.signal)
      guard(slot)
      if (!authority) {
        failure = 'UNAVAILABLE'
        throw new Error(failure)
      }
      // Retain independently resolved identity values before any adapter await.
      const { adapter, authorityEpoch } = authority
      const descriptor = readFigPluginAdapterDescriptor(adapter.descriptor)
      if (!descriptor || descriptor.kind !== 'synthetic') {
        failure = 'UNAVAILABLE'
        throw new Error(failure)
      }
      if (quarantined.has(adapter)) {
        failure = 'QUARANTINED'
        throw new Error(failure)
      }
      if (
        typeof authorityEpoch !== 'string' ||
        !authorityEpoch.length ||
        authorityEpoch.length > 128 ||
        !isCurrent(authorityEpoch)
      ) {
        failure = 'REVOKED'
        throw new Error(failure)
      }
      guard(slot)
      const inert = createFigPluginPlanPreview(input.data, authority.scope, authority.scope.context)
      if (!inert.ok) {
        failure = 'INVALID_PLAN'
        throw new Error(failure)
      }
      const raw = await adapter.capture(
        inert.preview.envelope.plan.steps.map((step) => step.targetId),
        slot.abort.signal
      )
      guard(slot)
      const currentDescriptor = readFigPluginAdapterDescriptor(adapter.descriptor)
      if (
        !isCurrent(authorityEpoch) ||
        !currentDescriptor ||
        !same(descriptor, currentDescriptor)
      ) {
        failure = 'REVOKED'
        throw new Error(failure)
      }
      guard(slot)
      const checked = checkFigPluginRenameSnapshot(raw, inert.preview.envelope.plan)
      if (!checked.ok) {
        failure = 'INVALID_SCOPE'
        throw new Error(failure)
      }
      if (
        checked.snapshot.targets.every(
          (target, index) => target.name === inert.preview.envelope.plan.steps[index].name
        )
      ) {
        failure = 'NO_CHANGES'
        throw new Error(failure)
      }
      const createdAt = now()
      guard(slot)
      const envelope: FigPluginExecutionPreview['envelope'] = {
        domain: 'figplugin-node-rename-preview/v1',
        attemptId: slot.id,
        createdAt,
        expiresAt: createdAt + 60_000,
        authorityEpoch,
        adapter: descriptor,
        scope: {
          context: inert.preview.envelope.context,
          binding: inert.preview.envelope.binding,
          callId: inert.preview.envelope.callId
        },
        plan: inert.preview.envelope.plan,
        before: checked.snapshot,
        rollback: 'transaction-only'
      }
      if (!snapshotFigPluginPlanData(envelope, 64 * 1024).ok) {
        failure = 'INVALID_SCOPE'
        throw new Error(failure)
      }
      slot.adapter = adapter
      slot.inert = inert.preview
      slot.preview = freeze({
        envelope,
        payloadSha256: createHash('sha256')
          .update(canonicalFigPluginJson(envelope), 'utf8')
          .digest('hex'),
        synthetic: true,
        display: envelope.plan.steps.map((step, index) => ({
          index,
          oldName: escaped(envelope.before.targets[index].name),
          newName: escaped(step.name)
        }))
      })
      slot.phase = 'ready'
      record(slot, 'ready')
      deadline(slot, 60_000, 'EXPIRED')
      return { ok: true, preview: slot.preview }
    } catch {
      clearTimeout(slot.timer)
      if (active === slot) active = undefined
      record(slot, 'settled', slot.stop ?? 'ERROR', 'not-applied')
      slot.inert = undefined
      slot.preview = undefined
      slot.adapter = undefined
      return { ok: false, code: slot.stop ?? failure }
    }
  }
  // A full validated readback establishes per-step observations; identity/structural mismatch is unknown.
  const observe = (
    raw: unknown,
    preview: FigPluginExecutionPreview
  ): { snapshot: FigPluginRenameSnapshot; observations: Observation[] } | undefined => {
    const checked = checkFigPluginRenameSnapshot(raw, preview.envelope.plan)
    if (!checked.ok) return undefined
    const after = checked.snapshot,
      before = preview.envelope.before
    if (
      !same(
        {
          ...after,
          document: { ...after.document, revision: before.document.revision },
          targets: after.targets.map((target, index) => ({
            ...target,
            name: before.targets[index].name
          }))
        },
        before
      )
    )
      return undefined
    return {
      snapshot: after,
      observations: after.targets.map((target, index) => ({
        index,
        state:
          target.name === before.targets[index].name
            ? 'original'
            : target.name === preview.envelope.plan.steps[index].name
              ? 'requested'
              : 'other'
      }))
    }
  }
  const run = async (slot: Slot): Promise<FigPluginExecutionOutcome> => {
    const preview = slot.preview!,
      adapter = slot.adapter!,
      inert = slot.inert!
    const signal = slot.abort.signal
    let transaction: FigPluginRenameTransaction | undefined
    let dispatched = false
    let effect: FigPluginExecutionEffect = 'not-applied'
    let reason: Reason = 'SUCCESS'
    let observations: Observation[] = []
    // Revisions identify states, not restorable content hashes. A committed/observed change
    // followed by a reused undo revision cannot attest fresh recovery, even if names look old.
    const knownRevisions = new Set([preview.envelope.before.document.revision])
    const knownSnapshots = new Map([
      [preview.envelope.before.document.revision, preview.envelope.before]
    ])
    try {
      guard(slot)
      const accepted = await (options.confirm?.(preview) ?? Promise.resolve(false))
      guard(slot)
      if (accepted !== true) {
        reason = 'DECLINED'
        throw new Error(reason)
      }
      const authority = await options.resolveScope!(signal)
      guard(slot)
      if (
        !authority ||
        authority.adapter !== adapter ||
        authority.authorityEpoch !== preview.envelope.authorityEpoch ||
        !same(readFigPluginAdapterDescriptor(adapter.descriptor), preview.envelope.adapter) ||
        !matchesFigPluginPlanPreview(inert, inert.payloadSha256, authority.scope)
      ) {
        stop(slot, 'REVOKED')
        throw new Error('REVOKED')
      }
      const current = await adapter.capture(
        preview.envelope.plan.steps.map((step) => step.targetId),
        signal
      )
      guard(slot)
      const checked = checkFigPluginRenameSnapshot(current, preview.envelope.plan)
      if (!checked.ok || !same(checked.snapshot, preview.envelope.before)) {
        stop(slot, 'REVOKED')
        throw new Error('REVOKED')
      }
      slot.phase = 'running'
      record(slot, 'running')
      transaction = await adapter.beginRename(
        slot.id,
        preview.envelope.before,
        preview.envelope.plan.steps,
        signal
      )
      guard(slot)
      for (let index = 0; index < preview.envelope.plan.steps.length; index++) {
        guard(slot)
        dispatched = true
        await transaction.applyNext(signal)
        guard(slot)
      }
      const rawCommit = await transaction.commit(signal)
      const commitRevision = ownIdentifier(rawCommit, 'revision')
      if (commitRevision) knownRevisions.add(commitRevision)
      const committed = revision(rawCommit)
      guard(slot)
      if (!committed || committed === preview.envelope.before.document.revision)
        throw new Error('INVALID_RECEIPT')
      const rawReadback = await transaction.readback(signal)
      const observedRevision = sameDocumentRevision(rawReadback, preview.envelope.before.document)
      if (observedRevision) knownRevisions.add(observedRevision)
      const readback = observe(rawReadback, preview)
      if (readback) {
        knownRevisions.add(readback.snapshot.document.revision)
        knownSnapshots.set(readback.snapshot.document.revision, readback.snapshot)
      }
      guard(slot)
      if (!readback) throw new Error('INVALID_READBACK')
      observations = readback.observations
      if (
        readback.snapshot.document.revision !== committed ||
        !readback.snapshot.targets.every(
          (target, index) => target.name === preview.envelope.plan.steps[index].name
        )
      )
        throw new Error('POSTCONDITION_FAILED')
      effect = 'applied'
    } catch {
      reason = slot.stop ?? (reason === 'DECLINED' ? reason : 'ERROR')
      if (transaction && dispatched) {
        slot.phase = 'recovering'
        record(slot, 'recovering', reason)
        const cleanup = new AbortController()
        const timer = setTimeout(() => cleanup.abort(), 10_000)
        timer.unref?.()
        effect = 'unknown'
        observations = []
        let undone: string | undefined
        try {
          undone = revision(await transaction.undo(cleanup.signal))
        } catch {
          /* No raw adapter errors enter the receipt or audit. */
        }
        try {
          const readback = observe(await transaction.readback(cleanup.signal), preview)
          if (readback) {
            const observedRevision = readback.snapshot.document.revision
            const previous = knownSnapshots.get(observedRevision)
            const contradictsKnown = previous && !same(previous, readback.snapshot)
            const reusedUndo = undone !== undefined && knownRevisions.has(undone)
            const staleOriginal =
              knownRevisions.size > 1 &&
              observedRevision === preview.envelope.before.document.revision
            const staleRollback = reusedUndo && knownRevisions.size > 1
            if (contradictsKnown || staleOriginal || staleRollback)
              throw new Error('STALE_RECOVERY')
            observations = readback.observations
            effect =
              undone &&
              !reusedUndo &&
              !cleanup.signal.aborted &&
              readback.snapshot.document.revision === undone &&
              readback.snapshot.targets.every(
                (target, index) => target.name === preview.envelope.before.targets[index].name
              )
                ? 'rolled-back'
                : 'partial'
          }
        } catch {
          /* Unknown effects remain quarantined. */
        }
        clearTimeout(timer)
      }
    } finally {
      if (transaction) {
        slot.phase = 'closing'
        record(slot, 'closing', slot.stop ?? reason, effect)
        try {
          await transaction.close()
        } catch {
          effect = dispatched ? 'unknown' : 'not-applied'
          reason = slot.stop ?? 'ERROR'
          quarantined.add(adapter)
        }
      }
    }
    if (effect === 'unknown' || effect === 'partial') quarantined.add(adapter)
    return finish(slot, outcome(slot.stop ?? reason, effect, slot, observations))
  }
  const execute = (id: unknown, presentedHash: unknown): Promise<FigPluginExecutionOutcome> => {
    if (
      typeof id !== 'string' ||
      id.length !== 32 ||
      !/^[a-f0-9]{32}$/.test(id) ||
      typeof presentedHash !== 'string' ||
      presentedHash.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(presentedHash)
    )
      return Promise.resolve(outcome('INVALID_PREVIEW'))
    const receipt = receipts.get(id)
    if (receipt)
      return Promise.resolve(
        receipt.hash === presentedHash ? receipt.outcome : outcome('INVALID_PREVIEW')
      )
    const slot = active
    if (!slot?.preview || slot.id !== id || slot.preview.payloadSha256 !== presentedHash)
      return Promise.resolve(outcome('INVALID_PREVIEW'))
    if (slot.promise) return slot.promise
    // Reserve before guard/isCurrent/clock/confirmation callbacks, not just before the await.
    // Cancellation in this microtask gap must retain the slot until this one run settles.
    slot.phase = 'confirming'
    slot.promise = Promise.resolve().then(() => {
      try {
        guard(slot)
        record(slot, 'confirming')
        const remaining = slot.preview!.envelope.expiresAt - now()
        deadline(slot, Math.min(30_000, remaining), remaining <= 30_000 ? 'EXPIRED' : 'TIMED_OUT')
      } catch {
        return finish(slot, outcome(slot.stop ?? 'REVOKED', 'not-applied', slot))
      }
      return run(slot)
    })
    return slot.promise
  }
  return {
    prepare,
    execute,
    cancel: (id: unknown): void => {
      if (active && id === active.id) stop(active, 'CANCELLED')
    },
    invalidate: (): void => {
      generation++
      if (active) stop(active, 'REVOKED')
    },
    dispose: (): void => {
      disposed = true
      generation++
      if (active) stop(active, 'DISPOSED')
    },
    status: (): { state: 'idle' } | { state: 'pending'; phase: Phase; stopping?: Stop } =>
      active
        ? {
            state: 'pending',
            phase: active.phase,
            ...(active.stop ? { stopping: active.stop } : {})
          }
        : { state: 'idle' },
    audit: (): readonly Audit[] => Object.freeze([...events])
  }
}
