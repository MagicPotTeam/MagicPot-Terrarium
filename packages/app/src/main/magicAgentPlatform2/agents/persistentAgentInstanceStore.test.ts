import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
import type { MagicAgentInstanceState } from '../../../shared/magicAgentPlatform2/agentInstance'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'

const directories: string[] = []
const open = (databasePath?: string) => {
  const directory = databasePath ? undefined : mkdtempSync(join(tmpdir(), 'magic-agent-instance-'))
  if (directory) directories.push(directory)
  const path = databasePath ?? join(directory!, 'events.sqlite')
  const eventStore = new MagicAgentEventStore(path)
  return { eventStore, store: new PersistentAgentInstanceStore(eventStore), databasePath: path }
}
const instance = (): MagicAgentInstanceState => ({
  id: 'instance-1',
  name: 'Researcher',
  definitionId: 'agent-1',
  depth: 0,
  configVersion: 'config-v1',
  status: 'created',
  limits: {
    maxChildren: 3,
    maxDepth: 2,
    maxConcurrency: 1,
    maxRuntimeMs: 60_000,
    allowedToolNames: ['read'],
    workspaceRoots: ['C:\\workspace']
  }
})
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('PersistentAgentInstanceStore', () => {
  it('replaces a quiescent Agent identity/config with exact replay', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentInstanceStore(eventStore)
    const created = store.create({
      instance: { ...instance(), id: 'replace' },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    const input = {
      instanceId: created.id,
      expectedRevision: created.revision,
      definitionId: 'definition-new',
      name: 'New',
      configVersion: 'v2',
      replacedAt: 2,
      idempotencyKey: 'replace'
    }
    const replaced = store.replace(input)
    expect(replaced.state).toMatchObject({
      definitionId: 'definition-new',
      name: 'New',
      configVersion: 'v2',
      previousConfigVersion: 'config-v1',
      status: 'stopped'
    })
    expect(store.replace(input)).toEqual(replaced)
    expect(() => store.replace({ ...input, definitionId: 'changed' })).toThrow(/conflict/)
    eventStore.close()
  })
  it('atomically reserves parent revision with child creation and rejects stale contenders', () => {
    const { eventStore, store } = open()
    const parent = store.create({ instance: instance(), createdAt: 1, idempotencyKey: 'parent' })
    const child = {
      ...instance(),
      id: 'child-1',
      name: 'Child',
      parentInstanceId: parent.id,
      depth: 1
    }
    const reserved = store.reserveChild({
      parentInstanceId: parent.id,
      parentExpectedRevision: 0,
      child,
      createdAt: 2,
      idempotencyKey: 'child-1'
    })
    expect(reserved.parent.revision).toBe(1)
    expect(reserved.child.state.parentInstanceId).toBe(parent.id)
    expect(() =>
      store.reserveChild({
        parentInstanceId: parent.id,
        parentExpectedRevision: 0,
        child: { ...child, id: 'child-2' },
        createdAt: 3,
        idempotencyKey: 'child-2'
      })
    ).toThrow(/revision conflict/i)
    expect(store.get('child-2')).toBeUndefined()
    eventStore.close()
  })

  it('rolls back parent reservation when child creation conflicts', () => {
    const { eventStore, store } = open()
    const parent = store.create({ instance: instance(), createdAt: 1, idempotencyKey: 'parent' })
    store.create({
      instance: { ...instance(), id: 'child-existing' },
      createdAt: 2,
      idempotencyKey: 'existing'
    })
    expect(() =>
      store.reserveChild({
        parentInstanceId: parent.id,
        parentExpectedRevision: 0,
        child: { ...instance(), id: 'child-existing', parentInstanceId: parent.id, depth: 1 },
        createdAt: 3,
        idempotencyKey: 'conflict'
      })
    ).toThrow(/already exists/i)
    expect(store.get(parent.id)?.revision).toBe(0)
    eventStore.close()
  })

  it('stages config, activates only at an explicit safe point, and rolls back', () => {
    const { eventStore, store } = open()
    const created = store.create({ instance: instance(), createdAt: 1, idempotencyKey: 'create' })
    const staged = store.stageConfig({
      id: created.id,
      expectedRevision: created.revision,
      configVersion: 'config-v2',
      stagedAt: 2,
      idempotencyKey: 'stage'
    })
    expect(staged.state.configVersion).toBe('config-v1')
    expect(staged.state.pendingConfigVersion).toBe('config-v2')
    const activated = store.activateStagedConfig({
      id: staged.id,
      expectedRevision: staged.revision,
      activatedAt: 3,
      idempotencyKey: 'activate'
    })
    expect(activated.state).toMatchObject({
      configVersion: 'config-v2',
      previousConfigVersion: 'config-v1',
      configActivatedAt: 3
    })
    const rolledBack = store.rollbackConfig({
      id: activated.id,
      expectedRevision: activated.revision,
      rolledBackAt: 4,
      idempotencyKey: 'rollback'
    })
    expect(rolledBack.state).toMatchObject({
      configVersion: 'config-v1',
      previousConfigVersion: 'config-v2',
      configActivatedAt: 4
    })
    eventStore.close()
  })

  it('creates and exactly replays while rejecting changed input', () => {
    const { eventStore, store } = open()
    const command = { instance: instance(), createdAt: 10, idempotencyKey: 'create' }
    const created = store.create(command)
    expect(created.revision).toBe(0)
    expect(store.create(command)).toEqual(created)
    expect(() => store.create({ ...command, createdAt: 11 })).toThrow(/idempotency conflict/i)
    eventStore.close()
  })

  it('enforces revision-checked lifecycle transitions and exact replay', () => {
    const { eventStore, store } = open()
    const created = store.create({ instance: instance(), createdAt: 10, idempotencyKey: 'create' })
    const running = store.start({
      instanceId: created.id,
      expectedRevision: 0,
      transitionedAt: 20,
      idempotencyKey: 'start'
    })
    const paused = store.pause({
      instanceId: running.id,
      expectedRevision: 1,
      transitionedAt: 30,
      idempotencyKey: 'pause'
    })
    expect(
      store.pause({
        instanceId: running.id,
        expectedRevision: 1,
        transitionedAt: 30,
        idempotencyKey: 'pause'
      })
    ).toEqual(paused)
    const resumed = store.resume({
      instanceId: paused.id,
      expectedRevision: 2,
      transitionedAt: 40,
      idempotencyKey: 'resume'
    })
    const stopped = store.stop({
      instanceId: resumed.id,
      expectedRevision: 3,
      transitionedAt: 50,
      idempotencyKey: 'stop'
    })
    const removed = store.remove({
      instanceId: stopped.id,
      expectedRevision: 4,
      transitionedAt: 60,
      idempotencyKey: 'remove'
    })
    expect(removed.state.status).toBe('removed')
    expect(() =>
      store.start({
        instanceId: removed.id,
        expectedRevision: 5,
        transitionedAt: 70,
        idempotencyKey: 'restart'
      })
    ).toThrow(/Invalid Agent instance transition/)
    expect(() =>
      store.stop({
        instanceId: removed.id,
        expectedRevision: 4,
        transitionedAt: 70,
        idempotencyKey: 'stale'
      })
    ).toThrow(/revision conflict/)
    eventStore.close()
  })

  it('validates root/child depth and limits', () => {
    const { eventStore, store } = open()
    expect(() =>
      store.create({
        instance: { ...instance(), depth: 1 },
        createdAt: 1,
        idempotencyKey: 'bad-depth'
      })
    ).toThrow(/Root Agent depth/)
    expect(() =>
      store.create({
        instance: { ...instance(), limits: { ...instance().limits, maxConcurrency: -1 } },
        createdAt: 1,
        idempotencyKey: 'bad-limit'
      })
    ).toThrow(/non-negative integer/)
    eventStore.close()
  })

  it('reopens SQLite with state and mutation replay intact', () => {
    const first = open()
    const created = first.store.create({
      instance: instance(),
      createdAt: 10,
      idempotencyKey: 'create'
    })
    const command = {
      instanceId: created.id,
      expectedRevision: 0,
      transitionedAt: 20,
      idempotencyKey: 'start'
    }
    const running = first.store.start(command)
    first.eventStore.close()
    const reopened = open(first.databasePath)
    expect(reopened.store.get(created.id)).toEqual(running)
    expect(reopened.store.start(command)).toEqual(running)
    reopened.eventStore.close()
  })
})
