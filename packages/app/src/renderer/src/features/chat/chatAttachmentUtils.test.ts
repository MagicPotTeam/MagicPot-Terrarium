import { describe, expect, it, vi } from 'vitest'
import {
  getChatAttachmentMaxSizeMB,
  getChatAttachmentTypeForFile,
  getLocalFilePath,
  resolveChatAttachmentSource,
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

  it('resolves direct and managed attachment sources', () => {
    expect(resolveChatAttachmentSource({ type: 'image', url: 'file:///preview.png' })).toEqual({
      status: 'resolved',
      url: 'file:///preview.png',
      source: 'url'
    })

    const media = {
      id: 'media-1',
      kind: 'image' as const,
      mimeType: 'image/png',
      originalFileName: 'preview.png',
      relativePath: 'images/preview.png',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    const mediaLookup = vi.fn().mockReturnValue('file:///managed/preview.png')

    expect(resolveChatAttachmentSource({ type: 'image', media }, { mediaLookup })).toEqual({
      status: 'resolved',
      url: 'file:///managed/preview.png',
      source: 'media'
    })
    expect(mediaLookup).toHaveBeenCalledWith(media)
  })

  it('reports a missing attachment source', () => {
    expect(resolveChatAttachmentSource({ type: 'file' })).toEqual({
      status: 'unavailable',
      reason: 'missing-source'
    })
  })
})
