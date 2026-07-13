import { beforeEach, describe, expect, it } from 'vitest'
import { subagentRegistry, type SubagentRunRecord } from './subagentRegistry'

const createRestoredRecord = (
  tasks: SubagentRunRecord['tasks'],
  runId = 'restored-run'
): SubagentRunRecord => ({
  runId,
  childSessionId: 'child-1',
  requesterSessionId: 'requester-1',
  task: 'Task',
  goal: 'Goal',
  createdAt: 1,
  parallelism: 1,
  messages: [],
  tasks
})

const createRestoredTask = (
  id: string,
  dependsOn: string[] = []
): SubagentRunRecord['tasks'][number] => ({
  id,
  task: `Task ${id}`,
  ownershipScopes: [],
  dependsOn,
  attempts: 0,
  maxAttempts: 1,
  status: 'pending',
  createdAt: 1,
  qualityGate: { status: 'pending' },
  messages: []
})

describe('subagentRegistry', () => {
  beforeEach(() => {
    for (const run of subagentRegistry.getAllRuns()) {
      subagentRegistry.cleanupRun(run.runId)
    }
  })

  it('registers legacy single-task runs with safe defaults', () => {
    subagentRegistry.registerRun({
      runId: 'run-1',
      childSessionId: 'child-1',
      requesterSessionId: 'requester-1',
      requesterOrigin: 'chat',
      task: 'Summarize the workspace',
      label: 'summary',
      modelName: 'test-model',
      runTimeoutSeconds: 5
    })

    const run = subagentRegistry.getRun('run-1')

    expect(run).toMatchObject({
      runId: 'run-1',
      childSessionId: 'child-1',
      requesterSessionId: 'requester-1',
      requesterOrigin: 'chat',
      goal: 'Summarize the workspace',
      parallelism: 1,
      cleanupHandled: false
    })
    expect(run?.tasks[0]).toMatchObject({
      id: 'default-task',
      status: 'pending',
      attempts: 0,
      maxAttempts: 1,
      qualityGate: { status: 'pending' }
    })
  })

  it('restores run records with cloned mutable collections', () => {
    const record: SubagentRunRecord = {
      runId: 'restored-run',
      childSessionId: 'child-1',
      requesterSessionId: 'requester-1',
      task: 'Task',
      goal: 'Goal',
      createdAt: 1,
      startedAt: 1,
      parallelism: 2,
      messages: [{ role: 'user', content: 'hello' }],
      tasks: [
        {
          id: 'task-1',
          task: 'Task 1',
          ownershipScopes: ['src/a'],
          dependsOn: [],
          attempts: 1,
          maxAttempts: 2,
          status: 'running',
          createdAt: 1,
          checkpoint: { cursor: 1 },
          qualityGate: { status: 'failed', summary: 'try again' },
          messages: [{ role: 'assistant', content: 'draft' }]
        },
        {
          id: 'task-2',
          task: 'Task 2',
          ownershipScopes: [],
          dependsOn: [],
          attempts: 0,
          maxAttempts: 1,
          status: 'pending',
          createdAt: 2,
          qualityGate: { status: 'pending' },
          messages: []
        }
      ]
    }

    subagentRegistry.restoreRun(record)
    record.messages.push({ role: 'assistant', content: 'mutated' })
    record.tasks[0].ownershipScopes.push('src/b')
    record.tasks[0].dependsOn.push('other')
    record.tasks[0].checkpoint = { cursor: 2 }
    record.tasks[0].qualityGate.status = 'passed'
    record.tasks[0].messages.push({ role: 'user', content: 'mutated' })

    const restored = subagentRegistry.getRun('restored-run')
    expect(restored?.messages).toHaveLength(1)
    expect(restored?.tasks[0].ownershipScopes).toEqual(['src/a'])
    expect(restored?.tasks[0].dependsOn).toEqual([])
    expect(restored?.tasks[0].checkpoint).toEqual({ cursor: 1 })
    expect(restored?.tasks[0].qualityGate).toEqual({ status: 'failed', summary: 'try again' })
    expect(restored?.tasks[0].messages).toHaveLength(1)
    expect(restored?.tasks[1].checkpoint).toBeUndefined()
  })

  it('rejects invalid restored task graphs', () => {
    const invalidGraphs: Array<[SubagentRunRecord, string]> = [
      [createRestoredRecord([]), 'at least one task'],
      [
        createRestoredRecord([createRestoredTask('duplicate'), createRestoredTask('duplicate')]),
        'Duplicate subagent task id: duplicate.'
      ],
      [
        createRestoredRecord([createRestoredTask('task-1', ['missing'])]),
        'depends on unknown task missing'
      ],
      [
        createRestoredRecord([
          createRestoredTask('task-1', ['task-2']),
          createRestoredTask('task-2', ['task-1'])
        ]),
        'must form a DAG'
      ]
    ]

    for (const [record, message] of invalidGraphs) {
      expect(() => subagentRegistry.restoreRun(record)).toThrow(message)
    }
    expect(subagentRegistry.getAllRuns()).toEqual([])
  })

  it('rejects duplicate restored run ids without overwriting the existing run', () => {
    const original = createRestoredRecord([createRestoredTask('original')], 'duplicate-run')
    const replacement = createRestoredRecord([createRestoredTask('replacement')], 'duplicate-run')

    subagentRegistry.restoreRun(original)

    expect(() => subagentRegistry.restoreRun(replacement)).toThrow(
      'Subagent run duplicate-run already exists.'
    )
    expect(subagentRegistry.getRun('duplicate-run')?.tasks[0].id).toBe('original')
  })

  it('normalizes restored retry and parallelism bounds', () => {
    const invalidTask = createRestoredTask('invalid')
    invalidTask.attempts = Number.NaN
    invalidTask.maxAttempts = Number.POSITIVE_INFINITY
    const fractionalTask = createRestoredTask('fractional')
    fractionalTask.attempts = 2.9
    fractionalTask.maxAttempts = 3.9
    const cappedTask = createRestoredTask('capped')
    cappedTask.attempts = 1_000_000
    cappedTask.maxAttempts = 1_000_000
    const record = createRestoredRecord([invalidTask, fractionalTask, cappedTask])
    record.parallelism = Number.POSITIVE_INFINITY

    subagentRegistry.restoreRun(record)

    expect(subagentRegistry.getRun(record.runId)).toMatchObject({
      parallelism: 1,
      tasks: [
        { attempts: 0, maxAttempts: 1 },
        { attempts: 2, maxAttempts: 3 },
        { attempts: 100, maxAttempts: 100 }
      ]
    })
  })

  it('normalizes registration limits to finite bounded integers', () => {
    subagentRegistry.registerOrchestratedRun({
      runId: 'normalized-run',
      childSessionId: 'child-1',
      requesterSessionId: 'requester-1',
      task: 'Overall task',
      goal: 'Overall goal',
      parallelism: 1_000_000.5,
      tasks: [
        { id: 'invalid', task: 'Invalid limit', maxAttempts: Number.NaN },
        { id: 'fractional', task: 'Fractional limit', maxAttempts: 3.9 },
        { id: 'unbounded', task: 'Unbounded limit', maxAttempts: Number.POSITIVE_INFINITY },
        { id: 'capped', task: 'Capped limit', maxAttempts: 1_000_000 }
      ]
    })

    expect(subagentRegistry.getRun('normalized-run')).toMatchObject({
      parallelism: 32,
      tasks: [{ maxAttempts: 1 }, { maxAttempts: 3 }, { maxAttempts: 1 }, { maxAttempts: 100 }]
    })
  })

  it('makes restored running crash snapshots runnable with a bounded retry', () => {
    const task = createRestoredTask('crashed')
    task.status = 'running'
    task.attempts = 100
    task.maxAttempts = 100
    const record = createRestoredRecord([task])

    subagentRegistry.restoreRun(record)

    expect(subagentRegistry.getTask(record.runId, task.id)).toMatchObject({
      status: 'pending',
      attempts: 99,
      maxAttempts: 100
    })
    expect(subagentRegistry.getRunnableTasks(record.runId)).toHaveLength(1)
  })

  it('updates runs, messages, checkpoints, quality gates, and requester indexes', () => {
    subagentRegistry.registerOrchestratedRun({
      runId: 'run-1',
      childSessionId: 'child-1',
      requesterSessionId: 'requester-1',
      task: 'Overall task',
      goal: 'Overall goal',
      resumedFromRunId: 'previous-run',
      parallelism: 0,
      tasks: [
        { id: 'task-1', task: 'First task', maxAttempts: 0 },
        { id: 'task-2', task: 'Second task', dependsOn: ['task-1'] }
      ]
    })

    subagentRegistry.updateRun('run-1', { label: 'updated' })
    subagentRegistry.updateRun('missing', { label: 'ignored' })
    subagentRegistry.appendMessage('run-1', { role: 'user', content: 'message' })
    subagentRegistry.appendTaskMessage('run-1', 'task-1', { role: 'assistant', content: 'reply' })
    subagentRegistry.appendTaskMessage('missing', 'task-1', { role: 'assistant', content: 'drop' })
    subagentRegistry.updateTaskCheckpoint('run-1', 'task-1', { offset: 10 })
    subagentRegistry.updateTaskCheckpoint('run-1', 'task-1')
    subagentRegistry.updateTaskCheckpoint('missing', 'task-1', { offset: 20 })
    subagentRegistry.updateTaskQualityGate('run-1', 'task-1', {
      status: 'failed',
      summary: 'needs review'
    })
    subagentRegistry.updateTaskQualityGate('missing', 'task-1', { status: 'passed' })

    const run = subagentRegistry.getRun('run-1')
    expect(run?.label).toBe('updated')
    expect(run?.resumedFromRunId).toBe('previous-run')
    expect(run?.parallelism).toBe(1)
    expect(run?.tasks[0].maxAttempts).toBe(1)
    expect(run?.messages.at(-1)).toEqual({ role: 'user', content: 'message' })
    expect(run?.tasks[0].messages.at(-1)).toEqual({ role: 'assistant', content: 'reply' })
    expect(run?.tasks[0].checkpoint).toBeUndefined()
    expect(run?.tasks[0].qualityGate).toEqual({ status: 'failed', summary: 'needs review' })
    expect(subagentRegistry.getRunsByRequester('requester-1')).toEqual([run])
    expect(subagentRegistry.getActiveRunsByRequester('requester-1')).toEqual([run])
    expect(subagentRegistry.getRunnableTasks('missing')).toEqual([])
  })

  it('transitions task and run lifecycle state', () => {
    subagentRegistry.registerOrchestratedRun({
      runId: 'run-1',
      childSessionId: 'child-1',
      requesterSessionId: 'requester-1',
      task: 'Overall task',
      goal: 'Overall goal',
      tasks: [{ id: 'task-1', task: 'First task', maxAttempts: 2 }]
    })

    subagentRegistry.startTask('run-1', 'task-1')
    subagentRegistry.startTask('missing', 'task-1')
    expect(subagentRegistry.getTask('run-1', 'task-1')).toMatchObject({
      status: 'running',
      attempts: 1,
      error: undefined,
      qualityGate: { status: 'pending' }
    })

    subagentRegistry.failTask('run-1', 'task-1', 'try again', false)
    subagentRegistry.failTask('missing', 'task-1', 'ignored', true)
    expect(subagentRegistry.getTask('run-1', 'task-1')).toMatchObject({
      status: 'pending',
      error: 'try again'
    })

    subagentRegistry.startTask('run-1', 'task-1')
    subagentRegistry.failTask('run-1', 'task-1', 'failed', true)
    expect(subagentRegistry.getTask('run-1', 'task-1')).toMatchObject({
      status: 'failed',
      error: 'failed'
    })

    subagentRegistry.finishRun('run-1', { status: 'error', error: 'failed' })
    subagentRegistry.finishRun('missing', { status: 'ok' })
    subagentRegistry.completeTask('missing', 'task-1', 'ignored')
    expect(subagentRegistry.getActiveRunsByRequester('requester-1')).toEqual([])
    expect(subagentRegistry.getRun('run-1')?.outcome).toEqual({ status: 'error', error: 'failed' })
  })

  it('cancels running tasks without downgrading passed quality gates', () => {
    subagentRegistry.registerOrchestratedRun({
      runId: 'run-1',
      childSessionId: 'child-1',
      requesterSessionId: 'requester-1',
      task: 'Overall task',
      goal: 'Overall goal',
      tasks: [{ id: 'task-1', task: 'First task' }]
    })

    subagentRegistry.startTask('run-1', 'task-1')
    subagentRegistry.updateTaskQualityGate('run-1', 'task-1', { status: 'passed' })
    subagentRegistry.cancelRun('run-1', 'cancelled')
    subagentRegistry.cancelRun('missing', 'ignored')

    expect(subagentRegistry.getRun('run-1')).toMatchObject({
      outcome: { status: 'cancelled', error: 'cancelled' }
    })
    expect(subagentRegistry.getTask('run-1', 'task-1')).toMatchObject({
      status: 'pending',
      error: 'cancelled',
      qualityGate: { status: 'passed' }
    })
  })
})
