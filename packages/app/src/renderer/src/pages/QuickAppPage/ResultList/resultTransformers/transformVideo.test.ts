import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComfyHistory } from '@shared/comfy/types'
import { transformResults } from './index'

const getViewMock = vi.fn()

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: getViewMock
    }
  })
}))

describe('transformVideo', () => {
  const originalCreateObjectURL = URL.createObjectURL

  beforeEach(() => {
    getViewMock.mockResolvedValue({ result: new Uint8Array([1, 2, 3]) })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:video-result')
    })
  })

  it('converts comfy video outputs into video result items', async () => {
    const history: ComfyHistory = {
      prompt: [0, 'prompt-1', {} as ComfyHistory['prompt'][2], { client_id: 'client-1' }, []],
      outputs: {
        nodeA: {
          video: [
            {
              filename: 'clip.mp4',
              subfolder: 'outputs',
              type: 'output'
            }
          ]
        },
        nodeB: {
          videos: [
            {
              filename: 'clip-2.mp4',
              subfolder: 'outputs',
              type: 'output'
            }
          ]
        }
      },
      status: {
        status_str: 'success',
        completed: true,
        messages: []
      }
    }

    const results = await transformResults('prompt-1', history)

    expect(results).toHaveLength(2)
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'video',
          promptId: 'prompt-1',
          objectUrl: 'blob:video-result',
          fileItem: {
            filename: 'clip.mp4',
            subfolder: 'outputs',
            type: 'output'
          }
        }),
        expect.objectContaining({
          type: 'video',
          promptId: 'prompt-1',
          objectUrl: 'blob:video-result',
          fileItem: {
            filename: 'clip-2.mp4',
            subfolder: 'outputs',
            type: 'output'
          }
        })
      ])
    )
    expect(results[0]).toMatchObject({
      type: 'video',
      promptId: 'prompt-1',
      objectUrl: 'blob:video-result',
      fileItem: {
        filename: 'clip.mp4',
        subfolder: 'outputs',
        type: 'output'
      }
    })
    expect(getViewMock).toHaveBeenCalledWith({
      filename: 'clip.mp4',
      subfolder: 'outputs',
      type: 'output'
    })
    expect(getViewMock).toHaveBeenCalledWith({
      filename: 'clip-2.mp4',
      subfolder: 'outputs',
      type: 'output'
    })
  })

  it('prefers encoded video outputs over preview frame images from the same node', async () => {
    const history: ComfyHistory = {
      prompt: [0, 'prompt-2', {} as ComfyHistory['prompt'][2], { client_id: 'client-2' }, []],
      outputs: {
        nodeA: {
          images: [
            {
              filename: 'preview-frame.png',
              subfolder: 'outputs',
              type: 'output'
            }
          ],
          gifs: [
            {
              filename: 'clip-final.mp4',
              subfolder: 'outputs',
              type: 'output'
            }
          ]
        }
      },
      status: {
        status_str: 'success',
        completed: true,
        messages: []
      }
    }

    const results = await transformResults('prompt-2', history)

    expect(results).toHaveLength(1)
    expect(results).toEqual([
      expect.objectContaining({
        type: 'video',
        promptId: 'prompt-2',
        objectUrl: 'blob:video-result',
        fileItem: {
          filename: 'clip-final.mp4',
          subfolder: 'outputs',
          type: 'output'
        }
      })
    ])
    expect(getViewMock).toHaveBeenCalledWith({
      filename: 'clip-final.mp4',
      subfolder: 'outputs',
      type: 'output'
    })
    expect(getViewMock).not.toHaveBeenCalledWith({
      filename: 'preview-frame.png',
      subfolder: 'outputs',
      type: 'output'
    })
  })

  afterEach(() => {
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: originalCreateObjectURL
      })
    }
  })
})
