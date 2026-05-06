import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { addLogListenerMock, emitLog } = vi.hoisted(() => {
  let listener: ((entry: { level: string; message: string; timestamp: number }) => void) | null =
    null

  return {
    addLogListenerMock: vi.fn((nextListener: typeof listener) => {
      listener = nextListener
      return () => {
        if (listener === nextListener) {
          listener = null
        }
      }
    }),
    emitLog: (entry: { level: string; message: string; timestamp: number }) => {
      listener?.(entry)
    }
  }
})

vi.mock('../utils/loggingOverride', () => ({
  addLogListener: addLogListenerMock
}))

import { LogSvcImpl } from './svcLogImpl'

describe('LogSvcImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    addLogListenerMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('streams normal app info logs while keeping noisy sources filtered', async () => {
    const svc = new LogSvcImpl()
    const onData = vi.fn()
    let aborted = false

    const watchPromise = svc.watchAppLogs(
      {},
      {
        onData,
        abortReceiver: {
          isAborted: () => aborted,
          onAbort: () => {}
        }
      }
    )

    expect(addLogListenerMock).toHaveBeenCalledTimes(1)

    emitLog({ level: 'info', message: '[LLMProxy] request started', timestamp: 1 })
    emitLog({ level: 'warn', message: '[SidePanel] something interesting', timestamp: 2 })
    emitLog({ level: 'info', message: '[comfyui] hidden in dedicated panel', timestamp: 3 })
    emitLog({
      level: 'info',
      message: 'svcPhotoshop.getRealtimeGenerationStatus polling',
      timestamp: 4
    })

    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData).toHaveBeenNthCalledWith(1, {
      level: 'info',
      message: '[LLMProxy] request started',
      timestamp: 1
    })
    expect(onData).toHaveBeenNthCalledWith(2, {
      level: 'warn',
      message: '[SidePanel] something interesting',
      timestamp: 2
    })

    aborted = true
    await vi.advanceTimersByTimeAsync(1000)
    await watchPromise
  })

  it('streams comfyui logs through the dedicated watcher', async () => {
    const svc = new LogSvcImpl()
    const onData = vi.fn()
    let aborted = false

    const watchPromise = svc.watchComfyLogs(
      {},
      {
        onData,
        abortReceiver: {
          isAborted: () => aborted,
          onAbort: () => {}
        }
      }
    )

    expect(addLogListenerMock).toHaveBeenCalledTimes(1)

    emitLog({ level: 'info', message: '[comfyui] startup line', timestamp: 11 })
    emitLog({ level: 'error', message: '[comfyui] import failed', timestamp: 12 })
    emitLog({ level: 'info', message: '[LLMProxy] request started', timestamp: 13 })

    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData).toHaveBeenNthCalledWith(1, {
      level: 'info',
      message: '[comfyui] startup line',
      timestamp: 11
    })
    expect(onData).toHaveBeenNthCalledWith(2, {
      level: 'error',
      message: '[comfyui] import failed',
      timestamp: 12
    })

    aborted = true
    await vi.advanceTimersByTimeAsync(1000)
    await watchPromise
  })
})
