import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newApiIpc } from './apiIpc'

const CANVAS_THUMBNAIL_METHODS = [
  'getSourceFileMetadata',
  'getThumbnailCacheRoot',
  'readThumbnailManifest',
  'writeThumbnailSet',
  'generateThumbnailSet',
  'createNativeThumbnail'
] as const

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

  it('exposes svcCanvasThumbnail unary methods through the preload API client', async () => {
    invokeMock.mockResolvedValue(undefined)

    const api = newApiIpc()

    for (const methodName of CANVAS_THUMBNAIL_METHODS) {
      expect(typeof api.svcCanvasThumbnail[methodName]).toBe('function')
      await api.svcCanvasThumbnail[methodName](undefined as never)
      expect(invokeMock).toHaveBeenLastCalledWith(`svcCanvasThumbnail.${methodName}`, undefined)
    }
  })
})
