import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async importActual => importActual())
import type { MagicAgentInstanceState } from '../../../shared/magicAgentPlatform2/agentInstance'
import { MagicAgentEventStore, type StoredResource } from '../persistence/eventStore'
import { _crashTesting } from '../persistence/crashHooks'
import { NodeSQLiteAdapter } from '../persistence/sqliteAdapter'
import { AgentInstanceCommandService } from './agentInstanceCommandService'
import { AgentInstanceOrdinaryCommitFence, AgentInstanceOrdinaryEventCommitFence } from './agentInstanceOrdinaryCommitFence'
import { PersistentAgentInstanceStore, prepareAgentInstanceTransition } from './persistentAgentInstanceStore'
import { MANAGED_AGENT_COVERAGE_KIND, PersistentManagedAgentInstanceStore } from './persistentManagedAgentInstanceStore'
import { PersistentAgentConfigStore, createMagicAgentConfigContent } from './persistentAgentConfigStore'
import { ProductionAgentInstanceLifecycleService } from './productionAgentInstanceLifecycle'

const stores: MagicAgentEventStore[] = [], directories: string[] = []
const state = (id: string): MagicAgentInstanceState => ({
  id, name: id, definitionId: 'definition', configVersion: 'config', depth: 0, status: 'created',
  limits: { maxChildren: 1, maxDepth: 1, maxConcurrency: 1, maxRuntimeMs: 1000, allowedToolNames: [], workspaceRoots: [] }
})
const birth = (id: string) => ({ instance: state(id), createdAt: 1, idempotencyKey: `birth:${id}` })
const actor = { kind: 'user', id: 'owner' } as const
const request = { route: { channel: 'generic', scopeType: 'dm', scopeId: 'owned' }, text: 'one local request' } as const
const blocked = /managed.*(?:ordinary|quarantin)|ordinary.*managed/i
function fixture(file = ':memory:') {
  const events = new MagicAgentEventStore(file); stores.push(events)
  const plain = new PersistentAgentInstanceStore(events), managed = new PersistentManagedAgentInstanceStore(events)
  const authorize = vi.fn(() => { throw Error('ordinary policy reached') }), consumeExecutionPermit = vi.fn(), run = vi.fn()
  const lifecycle = new ProductionAgentInstanceLifecycleService(plain, { authorize, consumeExecutionPermit } as never, run, () => 10)
  const configs = new PersistentAgentConfigStore(events)
  return { events, plain, managed, lifecycle, configs, authorize, consumeExecutionPermit, run, commands: new AgentInstanceCommandService(plain, lifecycle, configs) }
}
function accept(f: ReturnType<typeof fixture>, id: string) {
  f.managed.createRoot(birth(id))
  return f.managed.startFirstAttempt({ instanceId: id, expectedRevision: 0, expectedCoverageRevision: 0,
    authorizedRequestDigest: 'a'.repeat(64), sessionKey: `generic:dm:${id}`, startedAt: 2, idempotencyKey: `first:${id}` })
}
// Historical/unsupported records are fixture-only EventStore writes. They do not
// obtain a production owner, approval, closure or a bypass flag on the plain API.
function historicalTransition(f: ReturnType<typeof fixture>, row: StoredResource<MagicAgentInstanceState>, status: MagicAgentInstanceState['status']) {
  return f.events.mutateResource<MagicAgentInstanceState>(prepareAgentInstanceTransition(row, status, 3, `historical:${status}`)).resource
}
function alterCoverage(f: ReturnType<typeof fixture>, row: ReturnType<typeof accept>['coverage'], tombstone: boolean) {
  f.events.mutateResource({ operation: tombstone ? 'delete' : 'update', kind: row.kind, id: row.id, expectedRevision: row.revision,
    ...(tombstone ? {} : { state: { protocolVersion: 999, instanceId: 'wrong-identity', status: 'unsupported' } }),
    createdAt: 4, idempotencyKey: `unsupported:${row.id}`, event: { protocolVersion: '2.0.0', id: `unsupported:${row.id}:event`,
      type: 'fixture.unsupported-coverage', envelopeKind: 'event', streamId: `${row.kind}:${row.id}:stream`, sequence: row.revision + 1, createdAt: 4, payload: {} } })
}
afterEach(() => { _crashTesting.setHook(null); vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const actions = ['start', 'pause', 'resume', 'stop', 'remove', 'transition', 'stage', 'activate', 'rollback', 'replace', 'reserve-child', 'create-replay', 'transition-replay', 'replacement-replay', 'noop-replay'] as const
describe('durable managed identity excludes every ordinary wrapper, not just the production singleton', () => {
  it.each(actions)('rejects ordinary %s before writes or replay on a managed newborn', action => {
    const f = fixture(), born = f.managed.createRoot(birth('root'))
    const plain = new PersistentAgentInstanceStore(f.events), before = f.events.listResources({ includeDeleted: true }), count = f.events.countEvents()
    const command = { instanceId: 'root', expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'ordinary' }
    const invoke = () => {
      switch (action) {
        case 'start': return plain.start(command)
        case 'pause': return plain.pause(command)
        case 'resume': return plain.resume(command)
        case 'stop': return plain.stop(command)
        case 'remove': return plain.remove(command)
        case 'transition': return plain.transition({ ...command, status: 'stopped' })
        case 'stage': return plain.stageConfig({ id: 'root', expectedRevision: 0, configVersion: 'v2', stagedAt: 2, idempotencyKey: 'ordinary' })
        case 'activate': return plain.activateStagedConfig({ id: 'root', expectedRevision: 0, activatedAt: 2, idempotencyKey: 'ordinary' })
        case 'rollback': return plain.rollbackConfig({ id: 'root', expectedRevision: 0, rolledBackAt: 2, idempotencyKey: 'ordinary' })
        case 'replace': return plain.replace({ instanceId: 'root', expectedRevision: 0, name: 'new', definitionId: 'new', configVersion: 'v2', replacedAt: 2, idempotencyKey: 'ordinary' })
        case 'reserve-child': return plain.reserveChild({ parentInstanceId: 'root', parentExpectedRevision: 0, child: { ...state('child'), parentInstanceId: 'root', depth: 1 }, createdAt: 2, idempotencyKey: 'ordinary' })
        case 'create-replay': return plain.getCreateReplay({ ...birth('root'), idempotencyKey: born.coverage.state.birth.commandKey })
        case 'transition-replay': return plain.getTransitionReplay('root', 'running', 'ordinary')
        case 'replacement-replay': return plain.getReplaceReplay('root', 'ordinary')
        case 'noop-replay': return plain.getLifecycleNoopReplay({ action: 'resume', instanceId: 'root', expectedRevision: 0, actor, idempotencyKey: 'ordinary' })
      }
    }
    expect(invoke).toThrow(blocked)
    expect(f.events.listResources({ includeDeleted: true })).toEqual(before); expect(f.events.countEvents()).toBe(count)
  })
  it.each(['create', 'create-replay'] as const)('rejects %s even with the exact historical managed birth command key', action => {
    const f = fixture(), born = f.managed.createRoot(birth('root')), command = { ...birth('root'), idempotencyKey: born.coverage.state.birth.commandKey }, count = f.events.countEvents()
    expect(() => action === 'create' ? f.plain.create(command) : f.plain.getCreateReplay(command)).toThrow(blocked)
    expect(f.events.countEvents()).toBe(count)
  })
  it.each(['virgin', 'dirty', 'unsupported', 'tombstone'] as const)('never treats %s coverage as an inactive config/replacement safe point', kind => {
    const f = fixture(), born = kind === 'virgin' ? f.managed.createRoot(birth('root')) : accept(f, 'root')
    if (kind === 'unsupported' || kind === 'tombstone') alterCoverage(f, born.coverage, kind === 'tombstone')
    const before = f.events.listResources({ includeDeleted: true }), count = f.events.countEvents()
    expect(f.lifecycle.isAtSafePoint('root')).toBe(false)
    expect(() => f.lifecycle.activateStagedConfigAtSafePoint({ instanceId: 'root', expectedRevision: born.instance.revision, activatedAt: 5, idempotencyKey: 'activate' })).toThrow()
    expect(() => f.lifecycle.rollbackConfigAtSafePoint({ instanceId: 'root', expectedRevision: born.instance.revision, rolledBackAt: 5, idempotencyKey: 'rollback' })).toThrow()
    expect(f.events.listResources({ includeDeleted: true })).toEqual(before); expect(f.events.countEvents()).toBe(count)
  })
  it.each(['start', 'pause', 'resume', 'stop', 'replacement', 'config'] as const)('rejects production ordinary %s before policy consumption or owner creation', async action => {
    const f = fixture(), accepted = accept(f, 'root'), input = { instanceId: 'root', expectedRevision: accepted.instance.revision, actor, idempotencyKey: 'ordinary' }
    const invoke = () => {
      switch (action) {
        case 'start': return f.lifecycle.start({ ...input, request })
        case 'pause': return f.lifecycle.pause(input)
        case 'resume': return f.lifecycle.resume(input)
        case 'stop': return f.lifecycle.stop(input)
        case 'replacement': return f.commands.replace({ ...input, name: 'new', definitionId: 'new', configVersion: 'new', replacedAt: 4 })
        case 'config': return f.lifecycle.authorizeConfigMutation({ ...input, action: 'stage-config', configVersion: 'new' })
      }
    }
    const before = f.events.listResources({ includeDeleted: true }), count = f.events.countEvents()
    await expect((async () => { await invoke() })()).rejects.toThrow(blocked)
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.consumeExecutionPermit).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
    expect(f.events.countEvents()).toBe(count); expect(f.events.listResources({ includeDeleted: true })).toEqual(before)
    await f.lifecycle.close()
  })
  it('does not mutate a managed target substituted after the first ordinary identity check', () => {
    const f = fixture(); f.plain.create(birth('legacy')); const managed = f.managed.createRoot(birth('root'))
    const input = { instanceId: 'legacy', expectedRevision: 0, status: 'stopped' as const, transitionedAt: 2, idempotencyKey: 'ordinary-stop' }
    const list = f.events.listResourceMutations.bind(f.events)
    vi.spyOn(f.events, 'listResourceMutations').mockImplementation((...args) => { input.instanceId = 'root'; return list(...args) })
    const count = f.events.countEvents()
    expect(() => f.plain.transition(input)).toThrow(blocked)
    expect(f.plain.get('root')).toEqual(managed.instance); expect(f.events.countEvents()).toBe(count)
    expect(f.events.getResourceMutation('agent-instance:legacy:transition:ordinary-stop')).toBeUndefined()
  })
  it('selects an ordinary sibling for config creation instead of a quarantined same-definition first row', () => {
    const f = fixture(); f.managed.createRoot(birth('a-managed')); f.plain.create(birth('z-legacy'))
    const authorizeConfig = vi.spyOn(f.lifecycle, 'authorizeConfigMutation').mockReturnValue(true)
    const config = createMagicAgentConfigContent({ version: 'new-config', definitionId: 'definition', model: { profileId: 'local-fixture' }, systemPrompt: '', inference: {},
      tools: { allowedToolNames: [] }, memory: { allowHistory: false, contextMessageLimit: 0, scope: 'session' }, policy: { policyIds: [], workspaceRoots: [] },
      channels: { channelIds: [] }, budgets: { maxRuntimeMs: 1000 }, createdAt: 2, createdBy: actor })
    expect(f.commands.createConfigVersion({ config, idempotencyKey: 'ordinary-new-config' }).state).toEqual(config)
    expect(authorizeConfig).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: 'z-legacy' }))
  })
  it('rejects exact config-content replay selected through a managed definition before ordinary policy', () => {
    const f = fixture(); f.managed.createRoot(birth('root'))
    const config = createMagicAgentConfigContent({ version: 'config', definitionId: 'definition', model: { profileId: 'local-fixture' }, systemPrompt: '', inference: {},
      tools: { allowedToolNames: [] }, memory: { allowHistory: false, contextMessageLimit: 0, scope: 'session' }, policy: { policyIds: [], workspaceRoots: [] },
      channels: { channelIds: [] }, budgets: { maxRuntimeMs: 1000 }, createdAt: 1, createdBy: actor })
    f.configs.create({ config, idempotencyKey: 'historical-config' }); const count = f.events.countEvents()
    expect(() => f.commands.createConfigVersion({ config, idempotencyKey: 'historical-config' })).toThrow(blocked)
    expect(f.events.countEvents()).toBe(count); expect(f.authorize).not.toHaveBeenCalled()
  })
  it.each(['resource', 'stream'] as const)('treats raw %s namespace evidence as managed without strict body/receipt validation', kind => {
    const f = fixture(); f.plain.create(birth('root'))
    const rootKey = `managed-coverage:${createHash('sha256').update(JSON.stringify('root')).digest('hex')}`
    if (kind === 'stream') f.events.appendBatch([{ protocolVersion: '2.0.0', id: 'orphan-coverage:event', type: 'fixture.orphan-coverage',
      envelopeKind: 'event', streamId: `${MANAGED_AGENT_COVERAGE_KIND}:${rootKey}:stream`, sequence: 0, createdAt: 2, payload: {} }])
    else f.events.mutateResource({ operation: 'create', kind: MANAGED_AGENT_COVERAGE_KIND, id: rootKey, state: { unsupported: true },
      createdAt: 2, idempotencyKey: 'orphan-coverage', event: { protocolVersion: '2.0.0', id: 'orphan-coverage:event', type: 'fixture.orphan-coverage',
        envelopeKind: 'event', streamId: `${MANAGED_AGENT_COVERAGE_KIND}:${rootKey}:stream`, sequence: 0, createdAt: 2, payload: {} } })
    vi.spyOn(f.events, 'getResource').mockImplementation(() => { throw Error('strict body read forbidden') })
    vi.spyOn(f.events, 'getResourceMutation').mockImplementation(() => { throw Error('strict receipt read forbidden') })
    expect(() => f.plain.start({ instanceId: 'root', expectedRevision: 0, transitionedAt: 3, idempotencyKey: 'ordinary' })).toThrow(blocked)
    expect(f.lifecycle.isAtSafePoint('root')).toBe(false)
  })
  it('rechecks ordinary replay exclusion after a reentrant store-read callout', () => {
    const f = fixture(); f.plain.create(birth('root')); f.plain.stop({ instanceId: 'root', expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'old-stop' })
    const get = f.events.getEvent.bind(f.events); let marked = false
    vi.spyOn(f.events, 'getEvent').mockImplementation(id => {
      if (!marked) { marked = true; const rootKey = `managed-coverage:${createHash('sha256').update(JSON.stringify('root')).digest('hex')}`
        f.events.appendBatch([{ protocolVersion: '2.0.0', id: 'reentrant-coverage:event', type: 'fixture.reentrant-coverage',
          envelopeKind: 'event', streamId: `${MANAGED_AGENT_COVERAGE_KIND}:${rootKey}:stream`, sequence: 0, createdAt: 3, payload: {} }]) }
      return get(id)
    })
    expect(() => f.plain.getTransitionReplay('root', 'stopped', 'old-stop')).toThrow(blocked)
    expect(marked).toBe(true); expect(f.plain.get('root')?.revision).toBe(1)
  })
  it('rechecks durable exclusion inside an ordinary transaction after its last precommit callout', () => {
    const f = fixture(), born = f.plain.create(birth('root'))
    const rootKey = `managed-coverage:${createHash('sha256').update(JSON.stringify('root')).digest('hex')}`
    const get = NodeSQLiteAdapter.prototype.get; let duringCommit = false
    // A read-only fixture view exposes newly observed managed evidence at the
    // supported COMMIT boundary without unsupported nested SQLite transactions.
    vi.spyOn(NodeSQLiteAdapter.prototype, 'get').mockImplementation(function (this: NodeSQLiteAdapter, sql, ...params) {
      if (duringCommit && params.includes(MANAGED_AGENT_COVERAGE_KIND) && params.includes(rootKey)) return { present: 1 }
      return get.call(this, sql, ...params)
    })
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') duringCommit = true })
    expect(() => f.plain.stop({ instanceId: 'root', expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'ordinary-stop' })).toThrow(blocked)
    _crashTesting.setHook(null); duringCommit = false
    expect(f.plain.get('root')).toEqual(born); expect(f.events.countEvents()).toBe(1)
    expect(f.events.getResourceMutation('agent-instance:root:transition:ordinary-stop')).toBeUndefined()
  })
  it.each(['before-append', 'before-commit'] as const)('rejects the materialized no-op parent identity at %s without a durable success receipt', boundary => {
    const f = fixture(); f.plain.create(birth('parent'))
    const child = f.plain.reserveChild({ parentInstanceId: 'parent', parentExpectedRevision: 0,
      child: { ...state('child'), parentInstanceId: 'parent', depth: 1 }, createdAt: 2, idempotencyKey: 'child' }).child
    const running = f.plain.start({ instanceId: child.id, expectedRevision: 0, transitionedAt: 3, idempotencyKey: 'start-child' })
    const command = { action: 'resume' as const, instanceId: child.id, expectedRevision: running.revision, actor, idempotencyKey: `noop:${boundary}` }
    const parentKey = `managed-coverage:${createHash('sha256').update(JSON.stringify('parent')).digest('hex')}`
    const count = f.events.countEvents(), before = f.events.listResources({ includeDeleted: true })
    const get = NodeSQLiteAdapter.prototype.get; let excluded = boundary === 'before-append'
    vi.spyOn(NodeSQLiteAdapter.prototype, 'get').mockImplementation(function (this: NodeSQLiteAdapter, sql, ...params) {
      if (excluded && params.includes(MANAGED_AGENT_COVERAGE_KIND) && params.includes(parentKey)) return { present: 1 }
      return get.call(this, sql, ...params)
    })
    _crashTesting.setHook(stage => { if (stage === 'event.before-commit') excluded = true })
    expect(() => f.plain.recordLifecycleNoopCompletion({ command, result: running, completedAt: 4 })).toThrow(blocked)
    _crashTesting.setHook(null); excluded = false
    expect(f.events.countEvents()).toBe(count); expect(f.events.listResources({ includeDeleted: true })).toEqual(before)
    expect(f.plain.getLifecycleNoopReplay(command)).toBeUndefined()
  })
  it.each(['copy', 'proxy', 'store', 'target', 'body', 'batch'] as const)('rejects a %s substituted concrete mutation fence before any write', kind => {
    const f = fixture(), born = f.plain.create(birth('root'))
    const input = prepareAgentInstanceTransition(born, 'stopped', 2, 'fenced-stop')
    const fence = new AgentInstanceOrdinaryCommitFence(f.events, [input]), count = f.events.countEvents()
    const selected = kind === 'copy' ? { ...fence } : kind === 'proxy' ? new Proxy(fence, {}) : fence
    const target = kind === 'store' ? fixture().events : f.events
    const changed = kind === 'target' ? { ...input, id: 'another' } : kind === 'body' ? { ...input, state: { ...born.state, name: 'changed', status: 'stopped' } } : input
    const batch = kind === 'batch' ? [input, prepareAgentInstanceTransition(born, 'stopped', 3, 'extra-stop')] : [changed]
    expect(() => target.mutateResourcesBatch(batch, selected)).toThrow()
    expect(f.events.countEvents()).toBe(count); expect(f.plain.get('root')).toEqual(born)
    if (target !== f.events) expect(target.countEvents()).toBe(0)
  })
  it.each(['copy', 'proxy', 'store', 'snapshot', 'batch'] as const)('rejects a %s substituted concrete no-op event fence before any append', kind => {
    const f = fixture(); f.plain.create(birth('root'))
    const running = f.plain.start({ instanceId: 'root', expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'start' })
    const event = { protocolVersion: '2.0.0', id: 'fenced-noop', type: 'agent-instance.lifecycle-noop-completed',
      createdAt: 3, envelopeKind: 'event' as const, streamId: 'fenced-noop:stream', sequence: 0,
      extensions: { instanceId: running.id }, payload: { result: running } }
    const fence = new AgentInstanceOrdinaryEventCommitFence(f.events, [event], running.id), count = f.events.countEvents()
    const selected = kind === 'copy' ? { ...fence } : kind === 'proxy' ? new Proxy(fence, {}) : fence
    const target = kind === 'store' ? fixture().events : f.events
    const changed = kind === 'snapshot' ? { ...event, payload: { result: { ...running, state: { ...running.state, name: 'changed' } } } } : event
    const events = kind === 'batch' ? [event, { ...event, id: 'extra-event', streamId: 'extra-event:stream' }] : [changed]
    expect(() => target.appendBatch(events, selected)).toThrow()
    expect(f.events.countEvents()).toBe(count); expect(f.plain.get('root')).toEqual(running)
    if (target !== f.events) expect(target.countEvents()).toBe(0)
  })
  it('does not replay a plain stop command after durable managed identity was installed', () => {
    const f = fixture(), born = f.plain.create(birth('root'))
    const stopped = f.plain.stop({ instanceId: 'root', expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'old-stop' })
    // An unsupported legacy-shaped row is still a managed identity exclusion,
    // not a migration/repair API or a valid managed birth.
    const rootKey = `managed-coverage:${createHash('sha256').update(JSON.stringify('root')).digest('hex')}`
    f.events.mutateResource({ operation: 'create', kind: MANAGED_AGENT_COVERAGE_KIND, id: rootKey, state: { unsupported: true }, createdAt: 3, idempotencyKey: 'unsupported-root',
      event: { protocolVersion: '2.0.0', id: 'unsupported-root:event', type: 'fixture.unsupported-coverage', envelopeKind: 'event', streamId: `${MANAGED_AGENT_COVERAGE_KIND}:${rootKey}:stream`, sequence: 0, createdAt: 3, payload: {} } })
    const count = f.events.countEvents()
    expect(() => f.plain.getTransitionReplay('root', 'stopped', 'old-stop')).toThrow(blocked)
    expect(() => f.plain.transition({ instanceId: 'root', expectedRevision: born.revision, status: 'stopped', transitionedAt: 2, idempotencyKey: 'old-stop' })).toThrow(blocked)
    expect(f.plain.get('root')).toEqual(stopped); expect(f.events.countEvents()).toBe(count)
  })
})

describe('startup classifies managed evidence before ordinary interrupted recovery', () => {
  it('quarantines virgin/running/paused/stopped and malformed/tombstoned coverage, but recovers unrelated legacy runs', () => {
    const f = fixture(), managedIds = ['virgin', 'running', 'paused', 'stopped', 'unsupported', 'tombstone']
    f.managed.createRoot(birth('virgin'))
    for (const id of managedIds.slice(1)) {
      const accepted = accept(f, id)
      if (id === 'paused' || id === 'stopped') historicalTransition(f, accepted.instance, id)
      if (id === 'unsupported' || id === 'tombstone') alterCoverage(f, accepted.coverage, id === 'tombstone')
    }
    for (const id of ['legacy-running', 'legacy-paused']) {
      const born = f.plain.create(birth(id)), running = f.plain.start({ instanceId: born.id, expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'legacy-start' })
      if (id === 'legacy-paused') f.plain.pause({ instanceId: id, expectedRevision: running.revision, transitionedAt: 3, idempotencyKey: 'legacy-pause' })
    }
    const before = f.events.listResources({ includeDeleted: true }), count = f.events.countEvents()
    const recovered = f.lifecycle.recoverInterrupted(10)
    expect(recovered.map(row => row.id).sort()).toEqual(['legacy-paused', 'legacy-running'])
    expect(recovered.every(row => row.state.status === 'stopped')).toBe(true)
    const after = f.events.listResources({ includeDeleted: true })
    expect(after.filter(row => !row.id.startsWith('legacy-'))).toEqual(before.filter(row => !row.id.startsWith('legacy-')))
    expect(f.events.countEvents()).toBe(count + 2)
    const diagnostics = f.lifecycle.getRecoveryDiagnostics()
    expect(diagnostics.map(row => row.instanceId).sort()).toEqual(managedIds.sort())
    expect(diagnostics.every(row => row.code === 'managed-instance-quarantined')).toBe(true)
    expect(f.lifecycle.recoverInterrupted(11)).toEqual([]); expect(f.events.countEvents()).toBe(count + 2)
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })
  it('quarantines a historical child of a managed parent without aborting unrelated legacy recovery', () => {
    const f = fixture(); f.plain.create(birth('parent'))
    const child = f.plain.reserveChild({ parentInstanceId: 'parent', parentExpectedRevision: 0,
      child: { ...state('a-child'), parentInstanceId: 'parent', depth: 1 }, createdAt: 2, idempotencyKey: 'child' }).child
    f.plain.start({ instanceId: child.id, expectedRevision: 0, transitionedAt: 3, idempotencyKey: 'start-child' })
    f.plain.create(birth('z-unrelated')); f.plain.start({ instanceId: 'z-unrelated', expectedRevision: 0, transitionedAt: 4, idempotencyKey: 'start-unrelated' })
    const parentKey = `managed-coverage:${createHash('sha256').update(JSON.stringify('parent')).digest('hex')}`
    f.events.appendBatch([{ protocolVersion: '2.0.0', id: 'historical-parent-coverage', type: 'fixture.orphan-coverage',
      envelopeKind: 'event', streamId: `${MANAGED_AGENT_COVERAGE_KIND}:${parentKey}:stream`, sequence: 0, createdAt: 5, payload: {} }])
    const before = f.plain.get(child.id), count = f.events.countEvents()
    expect(f.lifecycle.recoverInterrupted(10).map(row => row.id)).toEqual(['z-unrelated'])
    expect(f.plain.get(child.id)).toEqual(before); expect(f.events.countEvents()).toBe(count + 1)
    expect(f.lifecycle.getRecoveryDiagnostics().map(row => row.instanceId).sort()).toEqual(['a-child', 'parent'])
  })
  it('preserves quarantine and managed records through same-file reopen without adopting an owner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'managed-exclusion-')); directories.push(directory)
    const file = join(directory, 'owned.sqlite'), first = fixture(file); accept(first, 'root')
    const before = first.events.listResources({ includeDeleted: true }), count = first.events.countEvents()
    await first.lifecycle.close(); first.events.close(); stores.splice(stores.indexOf(first.events), 1)
    const reopened = fixture(file)
    expect(reopened.lifecycle.recoverInterrupted(10)).toEqual([])
    expect(reopened.events.listResources({ includeDeleted: true })).toEqual(before); expect(reopened.events.countEvents()).toBe(count)
    expect(reopened.lifecycle.isAtSafePoint('root')).toBe(false)
    await expect(reopened.lifecycle.start({ instanceId: 'root', expectedRevision: 1, actor, request, idempotencyKey: 'reopen' })).rejects.toThrow(blocked)
    expect(reopened.authorize).not.toHaveBeenCalled(); expect(reopened.run).not.toHaveBeenCalled()
  })
  it('propagates actual persistence read failure instead of treating it as legacy absence', () => {
    const f = fixture(); accept(f, 'root')
    const get = NodeSQLiteAdapter.prototype.get
    vi.spyOn(NodeSQLiteAdapter.prototype, 'get').mockImplementation(function (this: NodeSQLiteAdapter, sql, ...params) {
      if (params.includes(MANAGED_AGENT_COVERAGE_KIND)) throw Error('fixture database read failure')
      return get.call(this, sql, ...params)
    })
    expect(() => f.lifecycle.isAtSafePoint('root')).toThrow('fixture database read failure')
    expect(() => f.lifecycle.recoverInterrupted(10)).toThrow('fixture database read failure')
    expect(f.run).not.toHaveBeenCalled()
  })
})
