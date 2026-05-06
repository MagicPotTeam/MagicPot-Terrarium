import { beforeEach, describe, expect, it, vi } from 'vitest'

const getViewMock = vi.fn()

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: getViewMock
    }
  })
}))

import { QAPP_IMAGE_DRAG_MIME, UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE } from './droppedImageUtils'
import {
  getDroppedVideoDropError,
  getDroppedVideoFile,
  isVideoOnlyInternalDragPayload
} from './droppedVideoUtils'

const createDataTransfer = (data: Record<string, string>, files: File[] = []) =>
  ({
    files,
    getData: (key: string) => data[key] || ''
  }) as unknown as DataTransfer

describe('droppedVideoUtils', () => {
  beforeEach(() => {
    getViewMock.mockReset()
  })

  it('accepts internal payloads that advertise video semantics', () => {
    expect(
      isVideoOnlyInternalDragPayload({
        objectUrl: 'blob:video-card',
        itemTypes: ['video']
      })
    ).toBe(true)
  })

  it('rejects non-video internal payloads for video consumers', () => {
    expect(
      getDroppedVideoDropError(
        createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            objectUrl: 'blob:image-card',
            itemTypes: ['image']
          })
        })
      )
    ).toContain('image')
  })

  it('rejects internal file payloads for video consumers with the unified message', () => {
    expect(
      getDroppedVideoDropError(
        createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            objectUrl: 'blob:file-card',
            itemTypes: ['file']
          })
        })
      )
    ).toBe(UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE)
  })

  it('prefers comfy file items for internal video drags', async () => {
    getViewMock.mockResolvedValue({
      result: new Uint8Array([1, 2, 3, 4])
    })

    const file = await getDroppedVideoFile(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:stale-video',
          promptId: 'prompt-7',
          fileItem: {
            filename: 'result.mp4',
            type: 'output'
          },
          itemTypes: ['video']
        })
      })
    )

    expect(getViewMock).toHaveBeenCalledWith({
      filename: 'result.mp4',
      type: 'output'
    })
    expect(file?.name).toBe('result.mp4')
    expect(file?.type).toBe('video/mp4')
    expect(file?.size).toBe(4)
  })

  it('accepts dropped video files from the OS', async () => {
    const file = new File(['video-bytes'], 'demo.mp4', { type: 'video/mp4' })

    const dropped = await getDroppedVideoFile(createDataTransfer({}, [file]))

    expect(dropped).toBe(file)
  })
})
