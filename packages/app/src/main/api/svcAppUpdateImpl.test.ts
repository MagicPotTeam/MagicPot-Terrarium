import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { addStatusListenerMock } = vi.hoisted(() => ({
  addStatusListenerMock: vi.fn()
}))

vi.mock('../appUpdate/updateManager', () => ({
  addAppUpdateStatusListener: addStatusListenerMock,
  checkForAppUpdates: vi.fn(),
  downloadAppUpdate: vi.fn(),
  getAppUpdateStatus: vi.fn(() => ({ state: 'idle' })),
  installAppUpdate: vi.fn()
}))

vi.mock('../appUpdate/launcherManagedState', () => ({
  getLauncherManagedState: vi.fn(),
  saveLauncherManagedSettings: vi.fn()
}))

vi.mock('../appUpdate/launcherCommand', () => ({
  readLauncherCommandResult: vi.fn(),
  writeLauncherCommand: vi.fn()
}))

import { AppUpdateSvcImpl } from './svcAppUpdateImpl'

describe('AppUpdateSvcImpl streaming lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    addStatusListenerMock.mockReset()
    addStatusListenerMock.mockImplementation(() => vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('unsubscribes immediately when the renderer aborts the status stream', async () => {
    let triggerAbort!: () => void
    const unsubscribe = vi.fn()
    addStatusListenerMock.mockImplementationOnce((listener) => {
      listener({ state: 'idle' })
      return unsubscribe
    })
    const onData = vi.fn()
    const watchPromise = new AppUpdateSvcImpl().watchStatus(
      {},
      {
        onData,
        abortReceiver: {
          isAborted: () => false,
          onAbort: (handler) => {
            triggerAbort = handler
          }
        }
      }
    )

    triggerAbort()
    await watchPromise

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(onData).toHaveBeenCalledOnce()
  })

  it('uses the polling fallback for direct callers with an already-aborted stream', async () => {
    const unsubscribe = vi.fn()
    addStatusListenerMock.mockImplementationOnce(() => unsubscribe)
    const watchPromise = new AppUpdateSvcImpl().watchStatus(
      {},
      {
        onData: vi.fn(),
        abortReceiver: {
          isAborted: () => true,
          onAbort: () => {}
        }
      }
    )

    await watchPromise

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
