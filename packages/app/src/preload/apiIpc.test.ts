import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newApiIpc } from './apiIpc'

const { invokeMock, postMessageMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  postMessageMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: invokeMock,
    postMessage: postMessageMock
  }
}))

describe('newApiIpc', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    postMessageMock.mockReset()
  })

  it('exposes unary IPC methods through the preload API client', async () => {
    invokeMock.mockResolvedValueOnce({ config: {} })

    const api = newApiIpc()

    expect(typeof api.svcState.getConfig).toBe('function')

    await api.svcState.getConfig({})

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'svcState.getConfig', {})
  })
})
