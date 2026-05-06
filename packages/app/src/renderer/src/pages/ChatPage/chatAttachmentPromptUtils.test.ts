import { describe, expect, it, vi } from 'vitest'
import { augmentMessageContentWithFileAttachments } from './chatAttachmentPromptUtils'
import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

describe('augmentMessageContentWithFileAttachments', () => {
  it('appends text previews for text-like file attachments', async () => {
    const attachment: ChatAttachment = {
      type: 'file',
      url: 'file:///demo/note.txt',
      fileName: 'note.txt',
      mimeType: 'text/plain'
    }

    const nextContent = await augmentMessageContentWithFileAttachments(
      [attachment],
      'Summarize this.',
      vi.fn(async () => 'hello from file')
    )

    expect(nextContent).toContain('Summarize this.')
    expect(nextContent).toContain('[Attached file] note.txt')
    expect(nextContent).toContain('hello from file')
  })

  it('skips file attachments that already have canvas summaries in content', async () => {
    const attachment: ChatAttachment = {
      type: 'file',
      url: 'file:///demo/spec.md',
      fileName: 'spec.md',
      mimeType: 'text/markdown'
    }
    const readAttachmentText = vi.fn(async () => 'should not be used')

    const nextContent = await augmentMessageContentWithFileAttachments(
      [attachment],
      '[Canvas file] spec.md\nexisting summary',
      readAttachmentText
    )

    expect(nextContent).toBe('[Canvas file] spec.md\nexisting summary')
    expect(readAttachmentText).not.toHaveBeenCalled()
  })

  it('falls back to binary summaries for non-text file attachments', async () => {
    const attachment: ChatAttachment = {
      type: 'file',
      url: 'file:///demo/slides.pptx',
      fileName: 'slides.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }

    const nextContent = await augmentMessageContentWithFileAttachments([attachment], '')

    expect(nextContent).toContain('[Attached file] slides.pptx')
    expect(nextContent).toContain('slides.pptx')
    expect(nextContent).toContain(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(nextContent).toContain('file attached: slides.pptx')
  })

  it('adds readable summaries for non-image video and 3D attachments', async () => {
    const nextContent = await augmentMessageContentWithFileAttachments(
      [
        {
          type: 'video',
          url: 'file:///demo/clip.mp4',
          fileName: 'clip.mp4',
          mimeType: 'video/mp4'
        },
        {
          type: 'model3d',
          url: 'file:///demo/model.glb',
          fileName: 'model.glb',
          mimeType: 'model/gltf-binary'
        }
      ],
      ''
    )

    expect(nextContent).toContain('[Attached video] clip.mp4')
    expect(nextContent).toContain('[Attached 3D model] model.glb')
    expect(nextContent).toContain('video attached: clip.mp4')
    expect(nextContent).toContain('3D model attached: model.glb')
  })

  it('adds explicit metadata summaries for image attachments', async () => {
    const nextContent = await augmentMessageContentWithFileAttachments(
      [
        {
          type: 'image',
          url: 'file:///demo/reference.png',
          fileName: 'reference.png',
          mimeType: 'image/png',
          sizeBytes: 2048,
          sourceWidth: 1536,
          sourceHeight: 1024
        }
      ],
      'Please tag this image.'
    )

    expect(nextContent).toContain('Please tag this image.')
    expect(nextContent).toContain('[Attached image] reference.png')
    expect(nextContent).toContain('fileName="reference.png"')
    expect(nextContent).toContain('sizeBytes=2048')
    expect(nextContent).toContain('resolution=1536x1024')
    expect(nextContent).toContain('image attached: reference.png')
  })

  it('skips attachments excluded by the caller', async () => {
    const attachment: ChatAttachment = {
      type: 'file',
      url: 'file:///demo/spec.md',
      fileName: 'spec.md',
      mimeType: 'text/markdown'
    }
    const readAttachmentText = vi.fn(async () => 'should not be used')

    const nextContent = await augmentMessageContentWithFileAttachments(
      [attachment],
      'Keep only the user instruction.',
      readAttachmentText,
      {
        skipAttachment: () => true
      }
    )

    expect(nextContent).toBe('Keep only the user instruction.')
    expect(readAttachmentText).not.toHaveBeenCalled()
  })
})
