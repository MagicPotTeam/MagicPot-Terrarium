import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentGoalMutation } from '@shared/api/agentThreadGoal'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'

const roots: string[] = [], stores: AgentThreadGoalStore[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})
const spec = normalizeAgentGoalSpec({ objective: 'fixture objective' })
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'goal-compat-')); roots.push(root)
  const file = path.join(root, 'goals.sqlite'), codec = sideTestCodec()
  const first = new AgentThreadGoalStore(codec, file), second = new AgentThreadGoalStore(codec, file)
  stores.push(first, second)
  const goalId = randomUUID(), autoId = randomUUID()
  const create: AgentGoalMutation = { action: 'create', goalId, expectedRevision: 0, operationId: 'create', title: 'fixture', spec }
  first.mutateUser(scope, create, 10)
  first.mutateUser(scope, { action: 'control', goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'activate', status: 'active', reason: 'fixture' }, 11)
  return { first, second, file, codec, goalId, autoId, create }
}
function arm(t: ReturnType<typeof setup>) {
  return t.first.mutateAuto(scope, 2, { action: 'arm', id: t.autoId, goalId: t.goalId, generation: 2, deadlineAt: 1000 }, 12)
}

it('preserves old manual revisions and receipts across v1 to v2 and reopened stores', () => {
  const t = setup(), original = t.second.read(scope)
  expect(original.revision).toBe(2)
  arm(t)
  const otherId = randomUUID()
  const create: AgentGoalMutation = { action: 'create', goalId: otherId, expectedRevision: 2, operationId: 'other', title: 'other', spec }
  const created = t.second.mutateUser(scope, create, 13)
  expect(created.revision).toBe(3)
  expect(t.first.readAuto(scope).record?.state).toBe('armed')
  expect(t.first.mutateUser(scope, create, 14)).toEqual(created)
  expect(() => t.first.mutateUser(scope, { ...create, title: 'changed' }, 15)).toThrow('replay conflict')
  const removed = t.first.mutateUser(scope, { action: 'delete', goalId: otherId, expectedRevision: 3, expectedGeneration: 1, operationId: 'delete' }, 16)
  expect(removed).toMatchObject({ revision: 4, retiredIds: [otherId] })
  const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
  expect(reopened.read(scope)).toEqual(removed)
  expect(reopened.mutateUser(scope, create, 17)).toEqual(removed)
  expect(() => reopened.mutateUser(scope, { ...create, expectedRevision: 4, operationId: 'recreate' }, 18)).toThrow('retired')
})

it('allows a stale storage snapshot after auto-only claim but rejects stale manual edits', () => {
  const t = setup(); arm(t)
  const before = t.second.read(scope)
  t.first.mutateAuto(scope, 3, { action: 'claim', id: t.autoId }, 20)
  const edit: AgentGoalMutation = { action: 'update', goalId: t.goalId, expectedRevision: before.revision, expectedGeneration: 2, operationId: 'edit', title: 'updated', spec }
  const updated = t.second.mutateUser(scope, edit, 21)
  expect(updated).toMatchObject({ revision: 3, goals: [{ id: t.goalId, title: 'updated' }] })
  expect(t.first.readAuto(scope).record?.state).toBe('unknown')
  expect(() => t.first.mutateUser(scope, { ...edit, operationId: 'stale', title: 'stale' }, 22)).toThrow('revision conflict')
  expect(t.first.read(scope)).toEqual(updated)
})

it.each(['armed', 'claimed'] as const)('keeps unrelated manual edits and retains the fence through pause and deletion from %s', state => {
  const t = setup(); arm(t)
  if (state === 'claimed') t.first.mutateAuto(scope, 3, { action: 'claim', id: t.autoId }, 20)
  const otherId = randomUUID()
  t.second.mutateUser(scope, { action: 'create', goalId: otherId, expectedRevision: 2, operationId: 'other', title: 'other', spec }, 21)
  expect(t.first.readAuto(scope).record?.state).toBe(state)
  expect(() => t.second.mutateUser(scope, { action: 'delete', goalId: t.goalId, expectedRevision: 3, expectedGeneration: 2, operationId: 'delete-active' }, 22)).toThrow('Pause the goal before deleting it')
  const paused = t.second.mutateUser(scope, { action: 'control', goalId: t.goalId, expectedRevision: 3, expectedGeneration: 2, operationId: 'pause-bound', status: 'paused', reason: 'fixture' }, 23)
  expect(paused.revision).toBe(4)
  expect(t.first.readAuto(scope).record?.state).toBe(state === 'armed' ? 'stopped' : 'unknown')
  const pausedGoal = paused.goals.find(goal => goal.id === t.goalId)!
  const removed = t.second.mutateUser(scope, { action: 'delete', goalId: t.goalId, expectedRevision: 4, expectedGeneration: pausedGoal.generation, operationId: 'delete-bound' }, 24)
  expect(removed).toMatchObject({ revision: 5, retiredIds: [t.goalId] })
  expect(t.first.readAuto(scope).record?.state).toBe(state === 'armed' ? 'stopped' : 'unknown')
  const reopened = new AgentThreadGoalStore(t.codec, t.file); stores.push(reopened)
  expect(reopened.read(scope)).toEqual(removed)
  expect(reopened.readAuto(scope).record?.state).toBe(state === 'armed' ? 'stopped' : 'unknown')
})
