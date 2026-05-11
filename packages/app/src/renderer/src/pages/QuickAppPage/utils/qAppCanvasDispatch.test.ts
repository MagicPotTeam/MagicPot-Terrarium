import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchQAppResultsToCanvas } from './qAppCanvasDispatch'

describe('dispatchQAppResultsToCanvas', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dispatches image and video results to their matching canvas events', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const sourceBlob = new Blob(['image-bytes'], { type: 'image/png' })

    const counts = dispatchQAppResultsToCanvas(
      [
        {
          id: 'img-1',
          type: 'image',
          objectUrl: 'blob:image-1',
          promptId: 'prompt-1',
          fileItem: { filename: 'image-1.png', type: 'output' },
          sourceBlob,
          sourceWidth: 3136,
          sourceHeight: 2624
        },
        {
          id: 'video-1',
          type: 'video',
          objectUrl: 'blob:video-1',
          promptId: 'prompt-1',
          fileItem: { filename: 'video-1.mp4', type: 'output' }
        }
      ],
      'project-1',
      'generation-session-1'
    )

    expect(counts).toEqual({
      imageCount: 1,
      videoCount: 1,
      totalCount: 2
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dispatchSpy).toHaveBeenCalledTimes(2)

    const imageEvent = dispatchSpy.mock.calls[0][0] as CustomEvent
    expect(imageEvent.type).toBe('canvas:add-image')
    expect(imageEvent.detail).toMatchObject({
      src: 'blob:image-1',
      fileName: 'image-1.png',
      projectId: 'project-1',
      generationSessionId: 'generation-session-1',
      newResultHint: 'quickapp',
      select: false,
      promptId: 'prompt-1',
      fileItem: { filename: 'image-1.png', type: 'output' },
      sourceFile: sourceBlob,
      sourceWidth: 3136,
      sourceHeight: 2624
    })

    const videoEvent = dispatchSpy.mock.calls[1][0] as CustomEvent
    expect(videoEvent.type).toBe('canvas:add-video')
    expect(videoEvent.detail).toMatchObject({
      src: 'blob:video-1',
      fileName: 'video-1.mp4',
      projectId: 'project-1',
      generationSessionId: 'generation-session-1',
      select: false,
      promptId: 'prompt-1',
      fileItem: { filename: 'video-1.mp4', type: 'output' }
    })
  })

  it('skips canvas dispatch for empty object urls and non-canvas result types', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    const counts = dispatchQAppResultsToCanvas([
      {
        id: 'img-empty',
        type: 'image',
        objectUrl: '   ',
        promptId: 'prompt-2',
        fileItem: { filename: 'image-empty.png', type: 'output' }
      },
      {
        id: 'video-empty',
        type: 'video',
        objectUrl: '',
        promptId: 'prompt-2',
        fileItem: { filename: 'video-empty.mp4', type: 'output' }
      },
      {
        id: 'text-1',
        type: 'text',
        promptId: 'prompt-2',
        text: 'done',
        nodeId: 'node-1'
      }
    ])

    expect(counts).toEqual({
      imageCount: 0,
      videoCount: 0,
      totalCount: 0
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dispatchSpy).not.toHaveBeenCalled()
  })
})
