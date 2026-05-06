import { beforeEach, describe, expect, it } from 'vitest'
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
})
