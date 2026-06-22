import { describe, expect, it } from 'vitest'
import {
  getChatAttachmentMaxSizeMB,
  getChatAttachmentTypeForFile,
  getLocalFilePath,
  summarizeChatAttachmentsForLog
} from './chatAttachmentUtils'

describe('chatAttachmentUtils', () => {
  it('classifies files by mime type before falling back to model extensions', () => {
    expect(getChatAttachmentTypeForFile({ name: 'photo.bin', type: 'image/png' })).toBe('image')
    expect(getChatAttachmentTypeForFile({ name: 'clip.dat', type: 'video/mp4' })).toBe('video')
    expect(getChatAttachmentTypeForFile({ name: 'mesh.GLB', type: '' })).toBe('model3d')
    expect(getChatAttachmentTypeForFile({ name: 'notes.pdf', type: 'application/pdf' })).toBe(
      'file'
    )
  })

  it('keeps existing upload size limits per attachment type', () => {
    expect(getChatAttachmentMaxSizeMB('video')).toBe(500)
    expect(getChatAttachmentMaxSizeMB('model3d')).toBe(200)
    expect(getChatAttachmentMaxSizeMB('image')).toBe(50)
    expect(getChatAttachmentMaxSizeMB('file')).toBe(50)
  })

  it('normalizes local file paths and avoids logging full data urls', () => {
    const file = { path: 'C:\\Users\\me\\image.png' } as unknown as File

    expect(getLocalFilePath(file)).toBe('C:/Users/me/image.png')
    expect(
      summarizeChatAttachmentsForLog([
        { type: 'image', url: `data:image/png;base64,${'a'.repeat(32)}`, fileName: 'image.png' }
      ])
    ).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'image.png',
        url: '[data-url length=54]'
      })
    ])
  })
})
