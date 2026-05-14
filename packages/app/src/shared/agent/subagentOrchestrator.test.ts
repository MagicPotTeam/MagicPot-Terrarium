import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resumeOrchestratedSubagents,
  runOrchestratedSubagents,
  spawnSubagent,
  type OrchestratedSubagentTask
} from './subagentOrchestrator'
import { subagentRegistry } from './subagentRegistry'

describe('subagentOrchestrator', () => {
  beforeEach(() => {
    for (const run of subagentRegistry.getAllRuns()) {
      subagentRegistry.cleanupRun(run.runId)
    }
  })

  it('keeps spawnSubagent compatible with the single-shot API', async () => {
    const response = await spawnSubagent(
      async ({ messages }) => `done:${messages[0]?.content ?? ''}`,
      {
        requesterSessionId: 'session-1',
        task: 'Write a summary',
        modelName: 'test-model'
      }
    )

    expect(response).toContain('Write a summary')
    const [run] = subagentRegistry.getAllRuns()
    expect(run.tasks).toHaveLength(1)
    expect(run.tasks[0].status).toBe('completed')
  })

  it('runs independent tasks in parallel before dependent tasks', async () => {
    let activeCount = 0
    let maxActiveCount = 0
    const callOrder: string[] = []

    const tasks: OrchestratedSubagentTask[] = [
      { id: 'research-a', task: 'Research board A' },
      { id: 'research-b', task: 'Research board B' },
      { id: 'merge', task: 'Merge findings', dependsOn: ['research-a', 'research-b'] }
    ]

    const run = await runOrchestratedSubagents(
      async ({ messages }) => {
        const label = messages[0]?.content ?? 'unknown'
        callOrder.push(`start:${label}`)
        activeCount += 1
        maxActiveCount = Math.max(maxActiveCount, activeCount)
        await new Promise((resolve) => setTimeout(resolve, label.includes('Merge') ? 5 : 20))
        activeCount -= 1
        callOrder.push(`end:${label}`)
        return label
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Prepare a board',
        modelName: 'test-model',
        parallelism: 2,
        tasks
      }
    )

    expect(run.outcome?.status).toBe('ok')
    expect(maxActiveCount).toBeGreaterThanOrEqual(2)
    const mergeStartIndex = callOrder.findIndex((entry) => entry.includes('Merge findings'))
    const researchAEndIndex = callOrder.findIndex(
      (entry) => entry.includes('Research board A') && entry.startsWith('end')
    )
    const researchBEndIndex = callOrder.findIndex(
      (entry) => entry.includes('Research board B') && entry.startsWith('end')
    )
    expect(mergeStartIndex).toBeGreaterThan(researchAEndIndex)
    expect(mergeStartIndex).toBeGreaterThan(researchBEndIndex)
  })

  it('serializes runnable tasks that share an ownership scope', async () => {
    let activeCount = 0
    let maxActiveCount = 0

    const run = await runOrchestratedSubagents(
      async ({ messages }) => {
        activeCount += 1
        maxActiveCount = Math.max(maxActiveCount, activeCount)
        await new Promise((resolve) => setTimeout(resolve, 20))
        activeCount -= 1
        return messages[0]?.content ?? ''
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Apply non-conflicting edits safely',
        modelName: 'test-model',
        parallelism: 3,
        tasks: [
          {
            id: 'edit-assistant',
            task: 'Edit assistant runtime',
            ownershipScopes: ['packages/app/src/main/assistantRuntime']
          },
          {
            id: 'edit-assistant-followup',
            task: 'Edit assistant storage',
            ownershipScopes: ['packages/app/src/main/assistantRuntime']
          },
          {
            id: 'edit-renderer',
            task: 'Edit renderer settings',
            ownershipScopes: ['packages/app/src/renderer/src/pages/SettingsPage']
          }
        ]
      }
    )

    expect(run.outcome?.status).toBe('ok')
    expect(maxActiveCount).toBe(2)
  })

  it('honors the parallelism limit when selecting runnable task batches', async () => {
    let activeCount = 0
    let maxActiveCount = 0

    const run = await runOrchestratedSubagents(
      async () => {
        activeCount += 1
        maxActiveCount = Math.max(maxActiveCount, activeCount)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeCount -= 1
        return 'done'
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Run one task at a time',
        modelName: 'test-model',
        parallelism: 1,
        tasks: [
          { id: 'task-1', task: 'Task 1' },
          { id: 'task-2', task: 'Task 2' },
          { id: 'task-3', task: 'Task 3' }
        ]
      }
    )

    expect(run.outcome?.status).toBe('ok')
    expect(maxActiveCount).toBe(1)
  })

  it('includes task context, dependency output, and wildcard ownership in subagent prompts', async () => {
    const systemPrompts: string[] = []
    let activeCount = 0
    let maxActiveCount = 0

    const run = await runOrchestratedSubagents(
      async ({ messages, systemPrompt }) => {
        activeCount += 1
        maxActiveCount = Math.max(maxActiveCount, activeCount)
        systemPrompts.push(systemPrompt || '')
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeCount -= 1
        return `result:${messages[0]?.content ?? ''}`
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Verify context plumbing',
        modelName: 'test-model',
        parallelism: 3,
        tasks: [
          {
            id: 'collect',
            task: 'Collect files',
            ownershipScopes: ['*'],
            context: {
              files: ['src/a.ts', 'src/b.ts'],
              htmlContent: '<main>Preview</main>',
              note: 'keep this',
              blank: '   ',
              objectValue: { nested: true },
              skipped: null
            }
          },
          {
            id: 'blocked-by-wildcard',
            task: 'Should not run in parallel with wildcard',
            ownershipScopes: ['src/a.ts']
          },
          {
            id: 'merge',
            task: 'Merge dependency output',
            dependsOn: ['collect']
          }
        ]
      }
    )

    expect(run.outcome?.status).toBe('ok')
    expect(maxActiveCount).toBeGreaterThanOrEqual(2)
    expect(systemPrompts[0]).toContain('Files in context:')
    expect(systemPrompts[0]).toContain('HTML/UI Context:')
    expect(systemPrompts[0]).toContain('note: keep this')
    expect(systemPrompts[0]).toContain('"nested": true')
    expect(systemPrompts.at(-1)).toContain('Dependency outputs:')
    expect(systemPrompts.at(-1)).toContain('Collect files')
  })

  it('omits dependency context when dependency outputs are unavailable', async () => {
    const systemPrompts: string[] = []

    const emptyOutputRun = await runOrchestratedSubagents(
      async ({ messages, systemPrompt }) => {
        systemPrompts.push(systemPrompt || '')
        const content = messages[0]?.content ?? ''
        return content.includes('Return empty output') ? '' : 'merged result'
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Merge sparse dependency output',
        modelName: 'test-model',
        tasks: [
          { id: 'empty-output', task: 'Return empty output' },
          { id: 'merge-empty-output', task: 'Merge empty output', dependsOn: ['empty-output'] }
        ]
      }
    )

    expect(emptyOutputRun.outcome?.status).toBe('ok')
    expect(systemPrompts.at(-1)).not.toContain('Dependency outputs:')

    const staleRunId = 'stale-dependency-run'
    const originalGetRunnableTasks = subagentRegistry.getRunnableTasks.bind(subagentRegistry)
    const spy = vi
      .spyOn(subagentRegistry, 'getRunnableTasks')
      .mockImplementation((candidateRunId) => {
        const runnable = originalGetRunnableTasks(candidateRunId)
        const run = subagentRegistry.getRun(candidateRunId)
        const staleTask = run?.tasks.find((task) => task.id === 'stale-dependent')
        if (
          candidateRunId === staleRunId &&
          runnable.length === 0 &&
          staleTask?.status === 'pending'
        ) {
          return [staleTask]
        }
        return runnable
      })

    const stalePrompts: string[] = []
    const staleRun = await runOrchestratedSubagents(
      async ({ systemPrompt }) => {
        stalePrompts.push(systemPrompt || '')
        return 'recovered'
      },
      {
        runId: staleRunId,
        requesterSessionId: 'session-1',
        goal: 'Recover stale dependency metadata',
        modelName: 'test-model',
        tasks: [
          {
            id: 'stale-dependent',
            task: 'Run despite stale dependency metadata',
            dependsOn: ['missing-dependency']
          }
        ]
      }
    )

    expect(staleRun.outcome?.status).toBe('ok')
    expect(stalePrompts[0]).not.toContain('Dependency outputs:')
    spy.mockRestore()
  })

  it('retries a task when the quality gate fails and then succeeds', async () => {
    let attempt = 0

    const run = await runOrchestratedSubagents(
      async () => {
        attempt += 1
        return attempt === 1 ? 'draft answer' : 'approved answer'
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Produce a validated answer',
        modelName: 'test-model',
        tasks: [
          {
            id: 'validated-task',
            task: 'Answer with the approved keyword',
            maxAttempts: 2,
            qualityGate: {
              validate: (resultText) => ({
                ok: resultText.includes('approved'),
                summary: 'Result must include the approved keyword.'
              })
            }
          }
        ]
      }
    )

    const task = run.tasks[0]
    expect(task.status).toBe('completed')
    expect(task.attempts).toBe(2)
    expect(task.qualityGate.status).toBe('passed')
  })

  it('notifies observers when retries are scheduled after gate and execution failures', async () => {
    let gateAttempt = 0
    const failures: string[] = []

    const gateRun = await runOrchestratedSubagents(
      async () => {
        gateAttempt += 1
        return gateAttempt === 1 ? 'draft' : 'approved'
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Notify gate failure',
        modelName: 'test-model',
        tasks: [
          {
            id: 'gate-task',
            task: 'Pass after gate failure',
            maxAttempts: 2,
            qualityGate: {
              validate: (resultText) => ({
                ok: resultText === 'approved',
                summary: 'gate failed once'
              })
            }
          }
        ],
        observer: {
          onTaskFailed: (_task, _run, error, exhausted) => {
            failures.push(`${error}:${exhausted}`)
          }
        }
      }
    )

    let executionAttempt = 0
    const executionRun = await runOrchestratedSubagents(
      async () => {
        executionAttempt += 1
        if (executionAttempt === 1) {
          throw new Error('execution failed once')
        }
        return 'ok'
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Notify execution failure',
        modelName: 'test-model',
        tasks: [{ id: 'exec-task', task: 'Pass after execution failure', maxAttempts: 2 }],
        observer: {
          onTaskFailed: (_task, _run, error, exhausted) => {
            failures.push(`${error}:${exhausted}`)
          }
        }
      }
    )

    expect(gateRun.outcome?.status).toBe('ok')
    expect(executionRun.outcome?.status).toBe('ok')
    expect(failures).toEqual(['gate failed once:false', 'execution failed once:false'])
  })

  it('stringifies non-error task failures before retrying', async () => {
    let attempt = 0
    const failures: string[] = []

    const run = await runOrchestratedSubagents(
      async () => {
        attempt += 1
        if (attempt === 1) {
          throw 'string failure'
        }
        return 'ok'
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Retry after a string failure',
        modelName: 'test-model',
        tasks: [{ id: 'string-failure', task: 'Recover from a string throw', maxAttempts: 2 }],
        observer: {
          onTaskFailed: (_task, _run, error, exhausted) => {
            failures.push(`${error}:${exhausted}`)
          }
        }
      }
    )

    expect(run.outcome?.status).toBe('ok')
    expect(failures).toEqual(['string failure:false'])
  })

  it('returns an error outcome when a boolean quality gate is exhausted', async () => {
    const run = await runOrchestratedSubagents(async () => 'draft only', {
      requesterSessionId: 'session-1',
      goal: 'Reject draft answers',
      modelName: 'test-model',
      tasks: [
        {
          id: 'draft-task',
          task: 'Must pass boolean gate',
          qualityGate: {
            validate: () => false
          }
        }
      ]
    })

    expect(run.outcome).toEqual({
      status: 'error',
      error: 'Quality gate failed for draft-task'
    })
    expect(run.tasks[0]).toMatchObject({
      status: 'failed',
      qualityGate: { status: 'failed' }
    })
  })

  it('finalizes already-failed task records without rerunning them', async () => {
    const runId = 'pending-failure-run'
    const originalGetRun = subagentRegistry.getRun.bind(subagentRegistry)
    const spy = vi.spyOn(subagentRegistry, 'getRun').mockImplementation((candidateRunId) => {
      const run = originalGetRun(candidateRunId)
      if (candidateRunId === runId && run) {
        run.tasks[0].status = 'failed'
        run.tasks[0].attempts = 1
        run.tasks[0].maxAttempts = 1
        run.tasks[0].error = undefined
      }
      return run
    })

    const run = await runOrchestratedSubagents(async () => 'unused', {
      runId,
      requesterSessionId: 'session-1',
      goal: 'Already failed',
      modelName: 'test-model',
      tasks: [{ id: 'task-1', task: 'Do not run' }]
    })

    expect(run.outcome).toEqual({
      status: 'error',
      error: 'Task task-1 failed'
    })
    spy.mockRestore()
  })

  it('times out a stalled task attempt and retries within the configured watchdog window', async () => {
    let attempt = 0

    const run = await runOrchestratedSubagents(
      async () => {
        attempt += 1
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return 'late first attempt'
        }
        return 'fast second attempt'
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Recover from a stalled task',
        modelName: 'test-model',
        runTimeoutSeconds: 0.01,
        tasks: [
          {
            id: 'stalled-task',
            task: 'Return promptly after a stalled first attempt',
            maxAttempts: 2
          }
        ]
      }
    )

    expect(run.outcome?.status).toBe('ok')
    expect(run.tasks[0].attempts).toBe(2)
    expect(run.tasks[0].resultText).toBe('fast second attempt')
  })

  it('resumes an interrupted run without rerunning completed tasks', async () => {
    let shouldFailMerge = true

    const tasks: OrchestratedSubagentTask[] = [
      { id: 'collect', task: 'Collect notes' },
      { id: 'merge', task: 'Merge notes', dependsOn: ['collect'], maxAttempts: 1 }
    ]

    const firstRun = await runOrchestratedSubagents(
      async ({ messages }) => {
        const content = messages[0]?.content ?? ''
        if (content.includes('Merge notes') && shouldFailMerge) {
          throw new Error('temporary merge failure')
        }
        return content
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Produce merged notes',
        modelName: 'test-model',
        tasks
      }
    )

    expect(firstRun.outcome?.status).toBe('error')
    expect(firstRun.tasks.find((task) => task.id === 'collect')?.status).toBe('completed')
    expect(firstRun.tasks.find((task) => task.id === 'merge')?.status).toBe('failed')

    shouldFailMerge = false

    const resumedRun = await resumeOrchestratedSubagents(
      async ({ messages }) => messages[0]?.content ?? '',
      firstRun.runId,
      tasks
    )

    expect(resumedRun.outcome?.status).toBe('ok')
    expect(resumedRun.tasks.find((task) => task.id === 'collect')?.attempts).toBe(1)
    expect(resumedRun.tasks.find((task) => task.id === 'merge')?.attempts).toBe(2)
  })

  it('rejects resume requests for unknown runs', async () => {
    await expect(
      resumeOrchestratedSubagents(async () => 'unused', 'missing-run', [])
    ).rejects.toThrow('Subagent run missing-run does not exist.')
  })

  it('fails resumed runs when a task definition is missing', async () => {
    const firstRun = await runOrchestratedSubagents(
      async () => {
        throw new Error('needs resume')
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Create failed run',
        modelName: 'test-model',
        tasks: [{ id: 'failed-task', task: 'Fail first', maxAttempts: 1 }]
      }
    )

    await expect(
      resumeOrchestratedSubagents(async () => 'unused', firstRun.runId, [])
    ).rejects.toThrow('Task definition failed-task is missing.')
  })

  it('fails when a runnable task disappears from the registry before execution', async () => {
    const originalGetTask = subagentRegistry.getTask.bind(subagentRegistry)
    const spy = vi.spyOn(subagentRegistry, 'getTask').mockImplementation((runId, taskId) => {
      if (runId === 'missing-task-record' && taskId === 'task-1') {
        return undefined
      }
      return originalGetTask(runId, taskId)
    })

    const run = await runOrchestratedSubagents(async () => 'unused', {
      runId: 'missing-task-record',
      requesterSessionId: 'session-1',
      goal: 'Missing task record',
      modelName: 'test-model',
      tasks: [{ id: 'task-1', task: 'Task disappears' }]
    })

    expect(run.outcome).toEqual({ status: 'ok', resultText: '' })

    spy.mockRestore()
  })

  it('supports async quality gates and lifecycle observers', async () => {
    const lifecycle: string[] = []

    const run = await runOrchestratedSubagents(async ({ messages }) => messages[0]?.content ?? '', {
      requesterSessionId: 'session-1',
      goal: 'Produce an observed answer',
      modelName: 'test-model',
      tasks: [
        {
          id: 'observed-task',
          task: 'Observed task',
          qualityGate: {
            validate: async (resultText) => ({
              ok: resultText.includes('Observed task'),
              summary: 'Result must include the task text.'
            })
          }
        }
      ],
      observer: {
        onTaskStarted: async (task) => {
          lifecycle.push(`start:${task.id}`)
        },
        onTaskCompleted: async (task) => {
          lifecycle.push(`complete:${task.id}`)
        },
        onRunFinished: async (finishedRun) => {
          lifecycle.push(`finish:${finishedRun.runId}`)
        }
      }
    })

    expect(run.outcome?.status).toBe('ok')
    expect(lifecycle[0]).toBe('start:observed-task')
    expect(lifecycle[1]).toBe('complete:observed-task')
    expect(lifecycle[2]).toBe(`finish:${run.runId}`)
  })

  it('cancels an in-flight run and does not start dependent tasks afterward', async () => {
    const abortController = new AbortController()
    const startedLabels: string[] = []

    const runPromise = runOrchestratedSubagents(
      async ({ messages, signal }) => {
        const label = messages[0]?.content ?? ''
        startedLabels.push(label)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50)
          const onAbort = () => {
            clearTimeout(timer)
            const error = new Error('Cancelled from test')
            error.name = 'AbortError'
            reject(error)
          }
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
        return label
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Cancel the current subagent run',
        modelName: 'test-model',
        signal: abortController.signal,
        tasks: [
          {
            id: 'first-task',
            task: 'Run the first task'
          },
          {
            id: 'second-task',
            task: 'Run the dependent second task',
            dependsOn: ['first-task']
          }
        ]
      }
    )

    setTimeout(() => {
      abortController.abort('Cancelled from test')
    }, 5)

    const run = await runPromise
    const firstTask = run.tasks.find((task) => task.id === 'first-task')
    const secondTask = run.tasks.find((task) => task.id === 'second-task')

    expect(run.outcome?.status).toBe('cancelled')
    expect(firstTask?.status).toBe('pending')
    expect(secondTask?.attempts).toBe(0)
    expect(startedLabels.some((label) => label.includes('dependent second task'))).toBe(false)
  })

  it('cancels before work starts when the signal is already aborted', async () => {
    const abortController = new AbortController()
    abortController.abort('already cancelled')

    const run = await runOrchestratedSubagents(async () => 'unused', {
      requesterSessionId: 'session-1',
      goal: 'Pre-cancelled run',
      modelName: 'test-model',
      signal: abortController.signal,
      tasks: [{ id: 'task-1', task: 'Should not start' }]
    })

    expect(run.outcome).toEqual({ status: 'cancelled', error: 'already cancelled' })
    expect(run.tasks[0].attempts).toBe(0)
  })

  it('uses the default cancellation text for blank abort reasons and notifies finish observers', async () => {
    const abortController = new AbortController()
    const finished: string[] = []
    abortController.abort('   ')

    const run = await runOrchestratedSubagents(async () => 'unused', {
      requesterSessionId: 'session-1',
      goal: 'Blank cancellation reason',
      modelName: 'test-model',
      signal: abortController.signal,
      tasks: [{ id: 'task-1', task: 'Should not start' }],
      observer: {
        onRunFinished: (finishedRun) => {
          finished.push(finishedRun.outcome?.status || 'missing')
        }
      }
    })

    expect(run.outcome).toEqual({
      status: 'cancelled',
      error: 'Subagent run cancelled.'
    })
    expect(finished).toEqual(['cancelled'])
  })

  it('uses the default cancellation text for abort errors without a message', async () => {
    const run = await runOrchestratedSubagents(
      async () => {
        const error = new Error('')
        error.name = 'AbortError'
        throw error
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Cancel with an empty abort message',
        modelName: 'test-model',
        tasks: [{ id: 'task-1', task: 'Abort without message' }]
      }
    )

    expect(run.outcome).toEqual({
      status: 'cancelled',
      error: 'Subagent run cancelled.'
    })
  })

  it('cancels when the signal is aborted after a task starts but before chat resolves', async () => {
    const abortController = new AbortController()

    const run = await runOrchestratedSubagents(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return 'late'
      },
      {
        requesterSessionId: 'session-1',
        goal: 'Abort after start',
        modelName: 'test-model',
        signal: abortController.signal,
        tasks: [{ id: 'task-1', task: 'Start then abort' }],
        observer: {
          onTaskStarted: () => {
            abortController.abort('aborted after start')
          }
        }
      }
    )

    expect(run.outcome).toEqual({ status: 'cancelled', error: 'aborted after start' })
    expect(run.tasks[0].attempts).toBe(1)
  })

  it('finishes with an error when dependencies can never become runnable', async () => {
    const run = await runOrchestratedSubagents(async () => 'unused', {
      requesterSessionId: 'session-1',
      goal: 'Blocked dependency',
      modelName: 'test-model',
      tasks: [{ id: 'blocked', task: 'Blocked forever', dependsOn: ['missing-dependency'] }]
    })

    expect(run.outcome).toEqual({ status: 'ok', resultText: '' })
    expect(run.tasks[0].status).toBe('pending')
  })

  it('throws from spawnSubagent when the default task produces no result text', async () => {
    await expect(
      spawnSubagent(async () => '', {
        requesterSessionId: 'session-1',
        task: 'Return an empty response',
        modelName: 'test-model'
      })
    ).rejects.toThrow('Subagent failed without a result.')
  })

  it('surfaces non-abort observer failures to the caller', async () => {
    await expect(
      runOrchestratedSubagents(async () => 'done', {
        requesterSessionId: 'session-1',
        goal: 'Observer failure',
        modelName: 'test-model',
        tasks: [{ id: 'task-1', task: 'Complete then observer fails' }],
        observer: {
          onRunFinished: () => {
            throw new Error('observer failed')
          }
        }
      })
    ).rejects.toThrow('observer failed')
  })

  it('surfaces a missing run at the start of the orchestrated loop', async () => {
    const originalGetRun = subagentRegistry.getRun.bind(subagentRegistry)
    const spy = vi.spyOn(subagentRegistry, 'getRun').mockImplementation((runId) => {
      if (runId === 'unavailable-run') {
        return undefined
      }
      return originalGetRun(runId)
    })

    await expect(
      runOrchestratedSubagents(async () => 'unused', {
        runId: 'unavailable-run',
        requesterSessionId: 'session-1',
        goal: 'Unavailable run',
        modelName: 'test-model',
        tasks: [{ id: 'task-1', task: 'Cannot start' }]
      })
    ).rejects.toThrow('Subagent run unavailable-run is unavailable.')

    spy.mockRestore()
  })

  it('surfaces a missing run during finalization', async () => {
    const runId = 'missing-finalize-run'
    const originalGetRunnableTasks = subagentRegistry.getRunnableTasks.bind(subagentRegistry)
    const spy = vi
      .spyOn(subagentRegistry, 'getRunnableTasks')
      .mockImplementation((candidateRunId) => {
        if (candidateRunId === runId) {
          subagentRegistry.cleanupRun(runId)
          return []
        }
        return originalGetRunnableTasks(candidateRunId)
      })

    await expect(
      runOrchestratedSubagents(async () => 'unused', {
        runId,
        requesterSessionId: 'session-1',
        goal: 'Remove before finalize',
        modelName: 'test-model',
        tasks: []
      })
    ).rejects.toThrow('Subagent run missing-finalize-run no longer exists.')

    spy.mockRestore()
  })

  it('propagates abort errors when the run record disappears during cancellation', async () => {
    const runId = 'disappearing-run'
    await expect(
      runOrchestratedSubagents(
        async () => {
          subagentRegistry.cleanupRun(runId)
          const error = new Error('lost run cancelled')
          error.name = 'AbortError'
          throw error
        },
        {
          runId,
          requesterSessionId: 'session-1',
          goal: 'Disappear during abort',
          modelName: 'test-model',
          tasks: [{ id: 'task-1', task: 'Abort and remove run' }]
        }
      )
    ).rejects.toThrow('lost run cancelled')
  })
})
