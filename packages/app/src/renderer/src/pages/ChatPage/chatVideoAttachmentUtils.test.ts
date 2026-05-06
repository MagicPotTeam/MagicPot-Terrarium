import { describe, expect, it, vi } from 'vitest'
import { augmentAttachmentsWithVideoBoundaryFrames } from './chatVideoAttachmentUtils'
import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

const videoAttachment: ChatAttachment = {
  type: 'video',
  url: 'blob:video-1',
  mimeType: 'video/mp4',
  fileName: 'clip.mp4'
}

describe('augmentAttachmentsWithVideoBoundaryFrames', () => {
  it('adds first and last frame images plus readable notes for a video attachment', async () => {
    const extractFrames = vi.fn().mockResolvedValue({
      firstFrameDataUrl: 'data:image/png;base64,AAA',
      lastFrameDataUrl: 'data:image/png;base64,BBB'
    })

    const result = await augmentAttachmentsWithVideoBoundaryFrames(
      [videoAttachment],
      'Please analyze this clip.',
      extractFrames
    )

    expect(extractFrames).toHaveBeenCalledWith('blob:video-1')
    expect(result.attachments).toEqual([
      videoAttachment,
      {
        type: 'image',
        url: 'data:image/png;base64,AAA',
        mimeType: 'image/png',
        fileName: 'clip-first-frame.png'
      },
      {
        type: 'image',
        url: 'data:image/png;base64,BBB',
        mimeType: 'image/png',
        fileName: 'clip-last-frame.png'
      }
    ])
    expect(result.content).toContain('Included the first frame from video "clip.mp4".')
    expect(result.content).toContain('Included the last frame from video "clip.mp4".')
  })

  it('skips extraction when the attachment and notes already exist', async () => {
    const extractFrames = vi.fn()
    const existingFirstFrame: ChatAttachment = {
      type: 'image',
      url: 'data:image/png;base64,AAA',
      mimeType: 'image/png',
      fileName: 'clip-first-frame.png'
    }
    const existingLastFrame: ChatAttachment = {
      type: 'image',
      url: 'data:image/png;base64,BBB',
      mimeType: 'image/png',
      fileName: 'clip-last-frame.png'
    }
    const content = [
      'Please analyze this clip.',
      'Included the first frame from video "clip.mp4".',
      'Included the last frame from video "clip.mp4".'
    ].join('\n\n')

    const result = await augmentAttachmentsWithVideoBoundaryFrames(
      [videoAttachment, existingFirstFrame, existingLastFrame],
      content,
      extractFrames
    )

    expect(extractFrames).not.toHaveBeenCalled()
    expect(result.attachments).toEqual([videoAttachment, existingFirstFrame, existingLastFrame])
    expect(result.content).toBe(content)
  })

  it('returns the original payload when there are no video attachments', async () => {
    const imageAttachment: ChatAttachment = {
      type: 'image',
      url: 'data:image/png;base64,IMG',
      mimeType: 'image/png',
      fileName: 'image.png'
    }
    const extractFrames = vi.fn()

    const result = await augmentAttachmentsWithVideoBoundaryFrames(
      [imageAttachment],
      'No video here.',
      extractFrames
    )

    expect(extractFrames).not.toHaveBeenCalled()
    expect(result).toEqual({
      attachments: [imageAttachment],
      content: 'No video here.'
    })
  })
})
