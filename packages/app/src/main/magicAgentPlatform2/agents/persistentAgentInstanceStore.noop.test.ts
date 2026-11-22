import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MagicAgentInstanceState } from '../../../shared/magicAgentPlatform2/agentInstance'
import { canonicalJson, MagicAgentEventStore } from '../persistence/eventStore'
import { sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import { PersistentAgentInstanceStore, captureAgentLifecycleCommand } from './persistentAgentInstanceStore'

vi.mock('node:fs', async importActual => importActual())
const directories: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const state: MagicAgentInstanceState = { id: 'worker', name: 'Worker', definitionId: 'agent', configVersion: 'v1', status: 'created', depth: 0, limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 1000, allowedToolNames: [], workspaceRoots: [] } }
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'magic-agent-noop-')); directories.push(directory)
  const path = join(directory, 'events.sqlite'), events = new MagicAgentEventStore(path), store = new PersistentAgentInstanceStore(events)
  store.create({ instance: state, createdAt: 1, idempotencyKey: 'create' })
  const running = store.start({ instanceId: state.id, expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'start' })
  const command = captureAgentLifecycleCommand('resume', { instanceId: state.id, expectedRevision: 1, actor: { kind: 'user', id: 'owner' }, idempotencyKey: 'noop', grantId: 'grant', expectedGrantUseCount: 0 })
  return { path, events, store, running, command }
}

describe('immutable lifecycle no-op completion receipts (not transitions or authority)', () => {
  it('records one event without changing the instance revision and replays after a later transition and reopen', () => {
    const s = setup(), before = s.events.countEvents()
    const result = s.store.recordLifecycleNoopCompletion({ command: s.command, result: s.running, completedAt: 3 })
    expect(result).toEqual(s.running); expect(s.store.get(state.id)).toEqual(s.running)
    expect(s.events.countEvents()).toBe(before + 1)
    expect(s.store.getTransitionReplay(state.id, 'running', 'runtime-resume:noop')).toBeUndefined()
    s.store.pause({ instanceId: state.id, expectedRevision: 1, transitionedAt: 4, idempotencyKey: 'pause' })
    expect(s.store.getLifecycleNoopReplay(s.command)).toEqual(s.running)
    const count = s.events.countEvents(); s.events.close()
    const reopened = new MagicAgentEventStore(s.path), store = new PersistentAgentInstanceStore(reopened)
    try {
      expect(store.getLifecycleNoopReplay(s.command)).toEqual(s.running)
      expect(store.get(state.id)?.state.status).toBe('paused'); expect(reopened.countEvents()).toBe(count)
      expect(store.recordLifecycleNoopCompletion({ command: s.command, result: s.running, completedAt: 99 })).toEqual(s.running)
      expect(reopened.countEvents()).toBe(count)
    } finally { reopened.close() }
  })

  it.each(['actor', 'revision', 'grant', 'uses'])('rejects a reused receipt key with changed %s content before replay', field => {
    const s = setup()
    try {
      s.store.recordLifecycleNoopCompletion({ command: s.command, result: s.running, completedAt: 3 })
      const changed = { ...s.command, ...(field === 'actor' ? { actor: { kind: 'user', id: 'other' } } : field === 'revision' ? { expectedRevision: 0 } : field === 'grant' ? { grantId: 'other' } : { expectedGrantUseCount: 1 }) }
      expect(() => s.store.getLifecycleNoopReplay(changed)).toThrow(/idempotency conflict/i)
      expect(s.store.get(state.id)).toEqual(s.running)
    } finally { s.events.close() }
  })

  it('does not find another action, instance or command key receipt', () => {
    const s = setup()
    try {
      s.store.recordLifecycleNoopCompletion({ command: s.command, result: s.running, completedAt: 3 })
      expect(s.store.getLifecycleNoopReplay({ ...s.command, action: 'pause' })).toBeUndefined()
      expect(s.store.getLifecycleNoopReplay({ ...s.command, instanceId: 'foreign' })).toBeUndefined()
      expect(s.store.getLifecycleNoopReplay({ ...s.command, idempotencyKey: 'different' })).toBeUndefined()
    } finally { s.events.close() }
  })

  it.each(['wrong-status', 'changed-resource', 'past-time'])('does not record %s as successful completion', field => {
    const s = setup(), before = s.events.countEvents()
    try {
      expect(() => s.store.recordLifecycleNoopCompletion({ command: s.command, result: field === 'wrong-status' ? { ...s.running, state: { ...s.running.state, status: 'paused' } } : field === 'changed-resource' ? { ...s.running, revision: 0 } : s.running, completedAt: field === 'past-time' ? 0 : 3 })).toThrow()
      expect(s.events.countEvents()).toBe(before); expect(s.store.getLifecycleNoopReplay(s.command)).toBeUndefined()
    } finally { s.events.close() }
  })

  it.each(['before', 'after'])('distinguishes append failure %s commit without repairing or repeating effects', side => {
    const s = setup(), append = s.events.appendBatch.bind(s.events), failure = new Error('append failed')
    vi.spyOn(s.events, 'appendBatch').mockImplementationOnce(events => { if (side === 'after') append(events); throw failure })
    try {
      expect(() => s.store.recordLifecycleNoopCompletion({ command: s.command, result: s.running, completedAt: 3 })).toThrow(failure)
      expect(s.store.getLifecycleNoopReplay(s.command)).toEqual(side === 'after' ? s.running : undefined)
      expect(s.store.get(state.id)).toEqual(s.running)
    } finally { s.events.close() }
  })

  it('captures a deep immutable strict command before the caller can mutate it', () => {
    const actor = { kind: 'user', id: 'owner', extra: { nested: 'original' } }
    const input = { instanceId: state.id, expectedRevision: 1, actor, idempotencyKey: 'captured', grantId: undefined }
    const captured = captureAgentLifecycleCommand('pause', input)
    actor.id = 'changed'; actor.extra.nested = 'changed'; input.idempotencyKey = 'changed'
    expect(captured.actor).toEqual({ kind: 'user', id: 'owner', extra: { nested: 'original' } })
    expect(captured.idempotencyKey).toBe('captured'); expect(Object.hasOwn(captured, 'grantId')).toBe(false)
    expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.actor)).toBe(true)
    expect(Object.isFrozen(captured.actor.extra)).toBe(true)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe command revisions/use counts %s', value => {
    const input = { instanceId: state.id, expectedRevision: 1, actor: { kind: 'user', id: 'owner' }, idempotencyKey: 'bad' }
    expect(() => captureAgentLifecycleCommand('pause', { ...input, expectedRevision: value })).toThrow()
    expect(() => captureAgentLifecycleCommand('resume', { ...input, expectedGrantUseCount: value })).toThrow()
  })

  it.each(['type', 'stream', 'sequence', 'extensions', 'snapshot', 'digest', 'revision', 'time', 'status', 'body'])('fails closed on a malformed stored %s receipt without changing current state', field => {
    const s = setup()
    try {
      s.store.recordLifecycleNoopCompletion({ command: s.command, result: s.running, completedAt: 3 })
      const read = s.events.getEvent.bind(s.events)
      vi.spyOn(s.events, 'getEvent').mockImplementation(id => {
        const receipt = read(id)
        if (!receipt || receipt.type !== 'agent-instance.lifecycle-noop-completed') return receipt
        const copy = JSON.parse(JSON.stringify(receipt))
        if (field === 'type') copy.type = 'foreign.type'
        else if (field === 'stream') copy.streamId = 'foreign:stream'
        else if (field === 'sequence') copy.sequence = 1
        else if (field === 'extensions') copy.extensions.instanceId = 'foreign'
        else if (field === 'snapshot') copy.payload.result.id = 'foreign'
        else if (field === 'digest') copy.payload.resultDigest = 'bad'
        else {
          if (field === 'revision') copy.payload.result.revision = 0
          if (field === 'time') copy.payload.result.updatedAt = 4
          if (field === 'status') copy.payload.result.state.status = 'paused'
          if (field === 'body') copy.payload.result.state.limits.allowedToolNames = ['duplicate', 'duplicate']
          copy.payload.resultDigest = sha256PolicyText(canonicalJson(copy.payload.result))
        }
        return copy
      })
      expect(() => s.store.getLifecycleNoopReplay(s.command)).toThrow()
      expect(s.store.get(state.id)).toEqual(s.running)
    } finally { s.events.close() }
  })

  it('rejects getters without invoking them and rejects cyclic/non-JSON actors', () => {
    const getter = vi.fn(() => 'owner'), actor = Object.defineProperty({ kind: 'user' }, 'id', { enumerable: true, get: getter })
    const input = { instanceId: state.id, expectedRevision: 1, actor, idempotencyKey: 'bad' }
    expect(() => captureAgentLifecycleCommand('pause', input as never)).toThrow(); expect(getter).not.toHaveBeenCalled()
    expect(() => captureAgentLifecycleCommand('pause', { ...input, actor: { kind: 'user', id: 'owner', bad: () => undefined } } as never)).toThrow()
    const cycle = { kind: 'user', id: 'owner' } as Record<string, unknown>; cycle.self = cycle
    expect(() => captureAgentLifecycleCommand('pause', { ...input, actor: cycle } as never)).toThrow()
  })
})
