import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import type { AgentGoalMutation, AgentGoalSpec } from '@shared/api/agentThreadGoal'
import { parseAgentGoalEventSource } from '@shared/api/agentThreadGoal'
import { canvasThreadStorageScopeOfRoute, getAgentSessionKey } from '@shared/agent'
import {
  AgentThreadGoalDriver,
  GOAL_STEP_TOOLS,
  GOAL_STEP_UNAVAILABLE,
  GoalBudgetExhausted,
  goalDriveLedgerOpener,
  goalStepBackoffMs,
  goalStepEnd,
  type GoalInboxPort,
  type GoalStep
} from './agentThreadGoalDrive'
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { applyModelGoalMutation, normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'

/**
 * S5: goals that advance by themselves (KohakuTerrarium 2.2.3 goal drives), with all three budgets
 * enforced in MAIN, steps only while the project is open and the session is not held, and the
 * user's sole authority over autonomy, completion policy and budgets.
 */
const roots: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.useRealTimers()
})
const routeKey = getAgentSessionKey(scope.route)
const storageScope = canvasThreadStorageScopeOfRoute(scope.route)!
const cancelled = () => new Error('Conversation cancelled by the user.')

function setup(options: { open?: boolean; held?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'goal-drive-'))
  roots.push(root)
  const store = new AgentThreadGoalStore(sideTestCodec(), path.join(root, 'goals.sqlite'))
  let clock = 1_000_000
  const state = { open: options.open ?? true, held: options.held ?? false }
  const pending = new Map<string, { id: string; source: string; text: string }>()
  const enqueued: Array<{ key: string; source: string; text: string }> = []
  const withdrawn: string[] = []
  const inbox: GoalInboxPort = {
    enqueue: (input) => {
      const duplicate = pending.has(input.idempotencyKey)
      const id = randomUUID()
      if (!duplicate) {
        pending.set(input.idempotencyKey, { id, source: input.source, text: input.text })
        enqueued.push({ key: input.idempotencyKey, source: input.source, text: input.text })
      }
      return { id, duplicate }
    },
    isPending: (_session, key) => pending.has(key),
    isOpen: (scopeName, key) => state.open && scopeName === storageScope && key === routeKey,
    isSessionHeld: () => state.held,
    withdraw: (_session, key) => {
      withdrawn.push(key)
      return pending.delete(key)
    }
  }
  const ledger = goalDriveLedgerOpener(path.join(root, 'drive.sqlite'))
  const driver = new AgentThreadGoalDriver({
    ledger,
    goals: async () => store,
    inbox,
    now: () => clock,
    random: () => 0.5
  })
  cleanups.push(() => {
    driver.dispose()
    store.close()
  })
  let op = 0
  const user = (command: Record<string, unknown>) =>
    store.mutateUser(
      scope,
      {
        ...command,
        expectedRevision: store.read(scope).revision,
        operationId: `user-${++op}`
      } as AgentGoalMutation,
      clock
    )
  const goal = (goalId: string) => store.read(scope).goals.find((item) => item.id === goalId)!
  /** A goal the user created and activated, then listed (the driver indexes the user's list). */
  const activeGoal = (spec: Partial<AgentGoalSpec> = {}) => {
    const goalId = randomUUID()
    user({
      action: 'create',
      goalId,
      title: 'Tidy the notes',
      spec: normalizeAgentGoalSpec({
        objective: 'Tidy the project notes',
        autonomy: 'continue_when_ready',
        budgets: { maxTurns: 3, maxToolCalls: 4, maxWalltimeSeconds: 600 },
        ...spec
      })
    })
    user({
      action: 'control',
      goalId,
      expectedGeneration: 1,
      status: 'active',
      reason: 'User activated it'
    })
    driver.sync(scope.route, scope.conversationId, store.read(scope).goals)
    return goalId
  }
  /** The renderer delivered the queued event and the session admitted it as this turn. */
  const admit = (key: string): Promise<GoalStep> => {
    pending.delete(key)
    return driver.bindStep(
      { route: scope.route, conversationId: scope.conversationId },
      { type: 'drive_ready', idempotencyKey: key, storageScope }
    )
  }
  const usage = (goalId: string) =>
    driver.usage(scope.route, scope.conversationId, store.read(scope).goals)?.[goalId]
  return {
    store,
    driver,
    state,
    pending,
    enqueued,
    withdrawn,
    user,
    goal,
    activeGoal,
    admit,
    usage,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock
  }
}

/** Queues the next step and admits it as a turn. */
async function nextStep(t: ReturnType<typeof setup>) {
  const [id] = await t.driver.tick()
  expect(id).toBeTruthy()
  const last = t.enqueued[t.enqueued.length - 1]
  return { step: await t.admit(last.key), queued: last }
}

describe('goal steps: queueing (KohakuTerrarium drive readiness)', () => {
  it('queues one drive_ready step at a time for an active continue_when_ready goal, with a goal banner source', async () => {
    const t = setup()
    const goalId = t.activeGoal()
    expect(await t.driver.tick()).toHaveLength(1)
    // The step waits in the inbox: no second step is queued beside it.
    expect(await t.driver.tick()).toHaveLength(0)
    expect(t.enqueued).toHaveLength(1)
    expect(t.enqueued[0].key).toBe(`goal:${goalId}:1`)
    expect(parseAgentGoalEventSource(t.enqueued[0].source)).toEqual({
      step: 1,
      maxTurns: 3,
      title: 'Tidy the notes'
    })
    expect(t.enqueued[0].text).toContain(`Goal ID: ${goalId}`)
    expect(t.enqueued[0].text).toContain('Step 1 of 3')
    const step = await t.admit(t.enqueued[0].key)
    // Running: still nothing more until it settles.
    expect(await t.driver.tick()).toHaveLength(0)
    await step.settle({ kind: 'success' })
    expect(await t.driver.tick()).toHaveLength(1)
    expect(parseAgentGoalEventSource(t.enqueued[1].source)?.step).toBe(2)
  })

  it('never steps a manual goal (user decision B), a draft or a paused goal', async () => {
    const t = setup()
    const manual = randomUUID()
    t.user({
      action: 'create',
      goalId: manual,
      title: 'Manual',
      spec: normalizeAgentGoalSpec({ objective: 'Manual record' })
    })
    t.user({
      action: 'control',
      goalId: manual,
      expectedGeneration: 1,
      status: 'active',
      reason: 'go'
    })
    const draft = randomUUID()
    t.user({
      action: 'create',
      goalId: draft,
      title: 'Draft',
      spec: normalizeAgentGoalSpec({
        objective: 'Not yet',
        autonomy: 'continue_when_ready',
        budgets: { maxTurns: 2, maxToolCalls: 2, maxWalltimeSeconds: 60 }
      })
    })
    t.driver.sync(scope.route, scope.conversationId, t.store.read(scope).goals)
    expect(await t.driver.tick()).toEqual([])
    const paused = t.activeGoal()
    t.user({
      action: 'control',
      goalId: paused,
      expectedGeneration: 2,
      status: 'paused',
      reason: 'wait'
    })
    expect(await t.driver.tick()).toEqual([])
    expect(t.enqueued).toEqual([])
  })

  it('steps only while the project pane is open and the session is not held (choice B)', async () => {
    const t = setup({ open: false })
    t.activeGoal()
    expect(await t.driver.tick()).toEqual([])
    t.state.open = true
    t.state.held = true
    expect(await t.driver.tick()).toEqual([])
    t.state.held = false
    expect(await t.driver.tick()).toHaveLength(1)
  })

  it('pauses steps while a user_confirm proposal waits, and a rejection resumes them (decision C)', async () => {
    const t = setup()
    const goalId = t.activeGoal()
    const { step } = await nextStep(t)
    await step.provider.callTool(
      'drive_transition',
      { status: 'completed', summary: 'Done', evidence: ['notes.md tidy'] },
      { route: scope.route } as never
    )
    expect(t.goal(goalId)).toMatchObject({ status: 'active', proposal: { outcome: 'completed' } })
    await step.settle({ kind: 'success' })
    expect(await t.driver.tick()).toEqual([])
    expect(t.usage(goalId)?.stepPending).toBe(false)
    t.user({ action: 'reject-proposal', goalId, expectedGeneration: t.goal(goalId).generation })
    expect(await t.driver.tick()).toHaveLength(1)
  })

  it('withdraws a queued step when the goal changes before it ran (no stale step)', async () => {
    const t = setup()
    const goalId = t.activeGoal()
    await t.driver.tick()
    const key = t.enqueued[0].key
    t.user({ action: 'control', goalId, expectedGeneration: 2, status: 'paused', reason: 'stop' })
    await t.driver.tick()
    expect(t.withdrawn).toContain(key)
    expect(t.pending.has(key)).toBe(false)
  })

  it('refuses to bind a step whose goal changed, a forged key, or another event type', async () => {
    const t = setup()
    const goalId = t.activeGoal()
    await t.driver.tick()
    const key = t.enqueued[0].key
    const req = { route: scope.route, conversationId: scope.conversationId }
    await expect(
      t.driver.bindStep(req, { type: 'trigger_fire', idempotencyKey: key, storageScope })
    ).rejects.toThrow(GOAL_STEP_UNAVAILABLE)
    await expect(
      t.driver.bindStep(req, {
        type: 'drive_ready',
        idempotencyKey: `goal:${goalId}:9`,
        storageScope
      })
    ).rejects.toThrow(GOAL_STEP_UNAVAILABLE)
    await expect(
      t.driver.bindStep(req, {
        type: 'drive_ready',
        idempotencyKey: key,
        storageScope: 'canvas:other'
      })
    ).rejects.toThrow(GOAL_STEP_UNAVAILABLE)
    t.user({ action: 'control', goalId, expectedGeneration: 2, status: 'paused', reason: 'stop' })
    await expect(t.admit(key)).rejects.toThrow(GOAL_STEP_UNAVAILABLE)
    expect(t.usage(goalId)?.turnsUsed).toBe(0)
  })
})

describe('goal steps: budgets enforced in MAIN (decision D)', () => {
  it('turns: charged before the turn runs; below, at and over max_turns', async () => {
    const t = setup()
    const goalId = t.activeGoal({
      budgets: { maxTurns: 2, maxToolCalls: 50, maxWalltimeSeconds: 600 }
    })
    const first = await nextStep(t)
    // Charged on admission, before any provider call.
    expect(t.usage(goalId)?.turnsUsed).toBe(1)
    await first.step.settle({ kind: 'success' })
    expect(t.usage(goalId)?.exhausted).toBeUndefined()
    const second = await nextStep(t)
    expect(t.usage(goalId)).toMatchObject({ turnsUsed: 2, exhausted: 'turns' })
    await second.step.settle({ kind: 'success' })
    // At the limit: no third step is queued, and a forged third key never binds.
    expect(await t.driver.tick()).toEqual([])
    await expect(t.admit(`goal:${goalId}:3`)).rejects.toThrow(GOAL_STEP_UNAVAILABLE)
    expect(t.goal(goalId).status).toBe('active')
    // Only the user raises it; then steps go on.
    t.user({
      action: 'update',
      goalId,
      expectedGeneration: t.goal(goalId).generation,
      title: t.goal(goalId).title,
      spec: { ...t.goal(goalId).spec, budgets: { ...t.goal(goalId).spec.budgets, maxTurns: 3 } }
    })
    expect(await t.driver.tick()).toHaveLength(1)
  })

  it('tool calls: charged before each call; the call past max_tool_calls is refused and the turn stopped', async () => {
    const t = setup()
    const goalId = t.activeGoal({
      budgets: { maxTurns: 5, maxToolCalls: 2, maxWalltimeSeconds: 600 }
    })
    const { step } = await nextStep(t)
    const abort = vi.fn()
    step.start(abort)
    step.chargeToolCall('files.read')
    expect(t.usage(goalId)?.toolCallsUsed).toBe(1)
    step.chargeToolCall('files.read')
    expect(t.usage(goalId)).toMatchObject({ toolCallsUsed: 2, exhausted: 'toolCalls' })
    expect(abort).not.toHaveBeenCalled()
    expect(() => step.chargeToolCall('files.write')).toThrow(GoalBudgetExhausted)
    expect(abort).toHaveBeenCalledWith(expect.any(GoalBudgetExhausted))
    expect(t.usage(goalId)?.toolCallsUsed).toBe(2)
    await step.settle({ kind: 'aborted', reason: abort.mock.calls[0][0] })
    // A budget stop is neither a failure nor a pause.
    expect(t.goal(goalId).status).toBe('active')
    expect(t.usage(goalId)?.failures).toBe(0)
    expect(await t.driver.tick()).toEqual([])
  })

  it('walltime: the turn is stopped when the remaining time runs out; below and at the limit', async () => {
    vi.useFakeTimers()
    const t = setup()
    const goalId = t.activeGoal({
      budgets: { maxTurns: 5, maxToolCalls: 50, maxWalltimeSeconds: 60 }
    })
    const { step } = await nextStep(t)
    const abort = vi.fn()
    step.start(abort)
    t.advance(59_000)
    vi.advanceTimersByTime(59_000)
    expect(abort).not.toHaveBeenCalled()
    step.chargeToolCall('files.read')
    expect(t.usage(goalId)?.walltimeUsedSeconds).toBe(59)
    t.advance(1_000)
    vi.advanceTimersByTime(1_000)
    expect(abort).toHaveBeenCalledTimes(1)
    const reason = abort.mock.calls[0][0]
    expect(reason).toBeInstanceOf(GoalBudgetExhausted)
    expect((reason as GoalBudgetExhausted).budget).toBe('walltime')
    expect(() => step.chargeToolCall('files.read')).toThrow(GoalBudgetExhausted)
    await step.settle({ kind: 'aborted', reason })
    expect(t.usage(goalId)).toMatchObject({ walltimeUsedSeconds: 60, exhausted: 'walltime' })
    expect(await t.driver.tick()).toEqual([])
  })

  it('a later step only gets the walltime that is left', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.activeGoal({ budgets: { maxTurns: 5, maxToolCalls: 50, maxWalltimeSeconds: 10 } })
    const first = await nextStep(t)
    first.step.start(vi.fn())
    t.advance(7_000)
    await first.step.settle({ kind: 'success' })
    const second = await nextStep(t)
    const abort = vi.fn()
    second.step.start(abort)
    t.advance(2_999)
    vi.advanceTimersByTime(2_999)
    expect(abort).not.toHaveBeenCalled()
    t.advance(1)
    vi.advanceTimersByTime(1)
    expect(abort).toHaveBeenCalledWith(expect.any(GoalBudgetExhausted))
  })
})

describe('goal steps: failures, stops and retries (KohakuTerrarium retry policy)', () => {
  it('backs off 2 s doubling to 300 s and blocks the goal after 5 failures in a row', async () => {
    expect([1, 2, 3, 9, 20].map((n) => goalStepBackoffMs(n, () => 0.5))).toEqual([
      2_000, 4_000, 8_000, 300_000, 300_000
    ])
    const t = setup()
    const goalId = t.activeGoal({
      budgets: { maxTurns: 20, maxToolCalls: 50, maxWalltimeSeconds: 6_000 }
    })
    for (let failure = 1; failure <= 5; failure++) {
      const { step } = await nextStep(t)
      await step.settle({ kind: 'error', error: new Error('provider down') })
      expect(t.usage(goalId)?.failures).toBe(failure)
      if (failure < 5) {
        // Not before its backoff.
        expect(await t.driver.tick()).toEqual([])
        t.advance(goalStepBackoffMs(failure, () => 0.5))
      }
    }
    expect(t.goal(goalId)).toMatchObject({ status: 'blocked' })
    t.advance(1_000_000)
    expect(await t.driver.tick()).toEqual([])
    // The user resumes it: retries start over (one more failure does not block it again).
    t.user({
      action: 'control',
      goalId,
      expectedGeneration: t.goal(goalId).generation,
      status: 'active',
      reason: 'retry'
    })
    const { step } = await nextStep(t)
    await step.settle({ kind: 'error', error: new Error('once more') })
    expect(t.goal(goalId).status).toBe('active')
    expect(t.usage(goalId)?.failures).toBe(1)
  })

  it('a user stop pauses the goal; only the user resumes it', async () => {
    const t = setup()
    const goalId = t.activeGoal()
    const { step } = await nextStep(t)
    await step.settle({ kind: 'aborted', reason: cancelled() })
    expect(t.goal(goalId)).toMatchObject({ status: 'paused' })
    expect(await t.driver.tick()).toEqual([])
  })

  it('a turn ended by a closed window is neither a failure nor a stop', async () => {
    const t = setup()
    const goalId = t.activeGoal()
    const { step } = await nextStep(t)
    await step.settle({ kind: 'aborted', reason: new Error('The renderer was closed.') })
    expect(t.goal(goalId).status).toBe('active')
    expect(t.usage(goalId)?.failures).toBe(0)
  })

  it('reads the end of a turn from its signal first', () => {
    const controller = new AbortController()
    expect(goalStepEnd(controller.signal, true, undefined)).toEqual({ kind: 'success' })
    expect(goalStepEnd(controller.signal, false, 'x')).toEqual({ kind: 'error', error: 'x' })
    controller.abort(cancelled())
    expect(goalStepEnd(controller.signal, true, undefined).kind).toBe('aborted')
  })

  it('removing the session forgets its goal steps', async () => {
    const t = setup()
    const goalId = t.activeGoal()
    expect(t.driver.removeSession(scope.route, scope.conversationId)).toBe(1)
    expect(t.usage(goalId)).toBeUndefined()
    expect(await t.driver.tick()).toEqual([])
  })
})

describe('goal steps: only the user holds autonomy, completion policy and budgets (addition 2)', () => {
  it('step tools are the goal-bound drive_status / drive_report / drive_transition only', async () => {
    expect(GOAL_STEP_TOOLS.map((tool) => tool.name)).toEqual([
      'drive_status',
      'drive_report',
      'drive_transition'
    ])
    const t = setup()
    const goalId = t.activeGoal()
    const { step } = await nextStep(t)
    const ctx = { route: scope.route } as never
    for (const [name, args] of [
      ['drive_create', { objective: 'new' }],
      ['drive_update', { autonomy: 'continue_when_ready' }],
      ['drive_transition', { status: 'active', summary: 'wake', evidence: ['x'] }],
      ['drive_transition', { status: 'paused', summary: 'x', evidence: ['x'] }],
      [
        'drive_transition',
        { status: 'completed', summary: 'x', evidence: ['x'], budgets: { maxTurns: 99 } }
      ],
      ['drive_report', { summary: 'x', autonomy: 'continue_when_ready' }],
      ['drive_report', { summary: 'x', goalId: randomUUID() }]
    ] as const)
      await expect(step.provider.callTool(name, args as never, ctx)).rejects.toThrow()
    const before = t.goal(goalId)
    const status = JSON.parse(
      (await step.provider.callTool('drive_status', {}, ctx)).content as string
    )
    expect(status).toMatchObject({ goalId, budgets: { turns: { used: 1, max: 3 } } })
    expect(t.goal(goalId).spec).toEqual(before.spec)
  })

  it('the model mutation path can only report or propose: never autonomy, budgets or a wake', () => {
    const t = setup()
    const goalId = t.activeGoal()
    const live = t.goal(goalId)
    const binding = { goalId, generation: live.generation }
    const base = {
      goalId,
      expectedGeneration: live.generation,
      expectedRevision: t.store.read(scope).revision,
      operationId: 'model'
    }
    for (const forged of [
      {
        ...base,
        action: 'update',
        title: 'x',
        spec: { ...live.spec, budgets: { ...live.spec.budgets, maxTurns: 100 } }
      },
      { ...base, action: 'control', status: 'active', reason: 'wake' },
      { ...base, action: 'create', title: 'x', spec: live.spec },
      { ...base, action: 'confirm', outcome: 'completed' }
    ])
      expect(() => t.store.mutateModel(scope, forged as never, binding)).toThrow()
    expect(() =>
      applyModelGoalMutation(
        t.store.read(scope),
        { ...base, action: 'control' } as never,
        binding,
        1
      )
    ).toThrow()
    expect(t.goal(goalId).spec).toEqual(live.spec)
  })

  it('the system path can only pause or block: it never wakes a goal or raises a budget', () => {
    const t = setup()
    const goalId = t.activeGoal()
    t.user({ action: 'control', goalId, expectedGeneration: 2, status: 'paused', reason: 'wait' })
    const live = t.goal(goalId)
    const base = {
      goalId,
      expectedGeneration: live.generation,
      expectedRevision: t.store.read(scope).revision,
      operationId: 'sys'
    }
    expect(() =>
      t.store.mutateSystem(scope, {
        ...base,
        action: 'control',
        status: 'active',
        reason: 'wake'
      } as never)
    ).toThrow()
    expect(() =>
      t.store.mutateSystem(scope, {
        ...base,
        action: 'update',
        title: 'x',
        spec: live.spec
      } as never)
    ).toThrow()
    expect(t.goal(goalId).status).toBe('paused')
  })

  it('rejects a switch to continue_when_ready without max_turns (addition 1)', () => {
    const t = setup()
    const goalId = randomUUID()
    t.user({
      action: 'create',
      goalId,
      title: 'Manual',
      spec: normalizeAgentGoalSpec({ objective: 'x' })
    })
    const spec = {
      ...t.goal(goalId).spec,
      autonomy: 'continue_when_ready',
      budgets: { maxToolCalls: 5, maxWalltimeSeconds: 60 }
    }
    expect(() =>
      t.user({ action: 'update', goalId, expectedGeneration: 1, title: 'Manual', spec })
    ).toThrow()
    expect(t.goal(goalId).spec.autonomy).toBe('manual')
  })

  it('self_propose accepts the proposal at once (nothing to pause); verifier needs evidence', async () => {
    const t = setup()
    const goalId = t.activeGoal({ completionPolicy: 'self_propose' })
    const { step } = await nextStep(t)
    const reply = await step.provider.callTool(
      'drive_transition',
      { status: 'completed', summary: 'Done', evidence: ['notes tidy'] },
      { route: scope.route } as never
    )
    expect(reply.content).toContain('completed')
    expect(t.goal(goalId)).toMatchObject({ status: 'completed' })
    await step.settle({ kind: 'success' })
    expect(await t.driver.tick()).toEqual([])
  })
})
