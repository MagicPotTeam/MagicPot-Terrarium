import { describe, expect, it, vi } from 'vitest'

vi.mock('../config/buildEnv', () => ({
  getBuildEnv: vi.fn()
}))
vi.mock('../config/config', () => ({
  getConfig: vi.fn()
}))

import { runDuplicateCheckWorkerProcess } from './svcDuplicateCheckImpl'

const runNodeWorker = (
  source: string,
  options: Partial<Parameters<typeof runDuplicateCheckWorkerProcess>[2]> = {}
): Promise<void> =>
  runDuplicateCheckWorkerProcess(process.execPath, ['-e', source], {
    cwd: process.cwd(),
    env: process.env,
    deadlineMs: 2_000,
    terminationGraceMs: 100,
    forceKillWaitMs: 1_000,
    ...options
  })

describe('duplicate-check worker lifecycle', () => {
  it('runs a lightweight worker to completion and clears the active handle', async () => {
    const activeStates: boolean[] = []

    await expect(
      runNodeWorker('process.exit(0)', {
        setActiveWorker: (worker) => activeStates.push(worker !== null)
      })
    ).resolves.toBeUndefined()

    expect(activeStates).toEqual([true, false])
  })

  it('bounds captured stderr while retaining the useful tail', async () => {
    await expect(
      runNodeWorker("process.stderr.write('x'.repeat(4096) + 'useful-tail'); process.exit(7)", {
        maxStderrBytes: 64
      })
    ).rejects.toThrow(/stderr truncated to last 64 bytes[\s\S]*useful-tail/)
  })

  it('rejects at the deadline after terminating and waiting for the worker', async () => {
    const startedAt = Date.now()

    await expect(
      runNodeWorker('setInterval(() => {}, 1000)', {
        deadlineMs: 50,
        terminationGraceMs: 50,
        forceKillWaitMs: 1_000
      })
    ).rejects.toThrow('Visual model worker exceeded its 50 ms deadline')

    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('supports explicit graceful termination through the active handle', async () => {
    await expect(
      runNodeWorker('setInterval(() => {}, 1000)', {
        deadlineMs: 2_000,
        setActiveWorker: (worker) => {
          if (worker) {
            setTimeout(() => void worker.terminate(new Error('test cancellation')), 25)
          }
        }
      })
    ).rejects.toThrow('test cancellation')
  })
})
