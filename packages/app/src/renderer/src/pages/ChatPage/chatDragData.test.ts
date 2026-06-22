import { describe, expect, it } from 'vitest'
import {
  AGENT_IMAGE_DRAG_MIME,
  AGENT_VIDEO_DRAG_MIME,
  AGENT_MODEL3D_DRAG_MIME,
  setAgentAttachmentDragPayload,
  setAgentImageDragPayload,
  setAgentVideoDragPayload,
  setAgentModel3DDragPayload
} from './chatDragData'
import { INTERNAL_IMAGE_DRAG_PREFIX, QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'

const createDataTransferMock = () => {
  const data = new Map<string, string>()
  const target = {
    effectAllowed: 'none' as DataTransfer['effectAllowed'],
    setData: (type: string, value: string) => {
      data.set(type, value)
    }
  }

  return { data, target }
}

describe('chatDragData', () => {
  it('sets image drag payloads with normalized file urls', () => {
    const { data, target } = createDataTransferMock()

    const normalized = setAgentImageDragPayload(target, 'file:///C:/demo/image.png')

    expect(normalized).toBe('local-media:///C:/demo/image.png')
    expect(data.get(AGENT_IMAGE_DRAG_MIME)).toBe('local-media:///C:/demo/image.png')
    expect(data.get(QAPP_IMAGE_DRAG_MIME)).toBe(
      JSON.stringify({
        objectUrl: 'local-media:///C:/demo/image.png',
        itemTypes: ['image'],
        attachments: [
          {
            type: 'image',
            url: 'local-media:///C:/demo/image.png',
            fileName: 'image.png'
          }
        ]
      })
    )
    expect(data.get('text/uri-list')).toBe('local-media:///C:/demo/image.png')
    expect(data.get('text/plain')).toBe('local-media:///C:/demo/image.png')
    expect(target.effectAllowed).toBe('copy')
  })

  it('sets model drag payloads with the model mime key', () => {
    const { data, target } = createDataTransferMock()

    setAgentModel3DDragPayload(target, 'https://example.com/model.glb')

    expect(data.get(AGENT_MODEL3D_DRAG_MIME)).toBe('https://example.com/model.glb')
    expect(data.get('text/uri-list')).toBe('https://example.com/model.glb')
    expect(data.get('text/plain')).toBe('https://example.com/model.glb')
    expect(target.effectAllowed).toBe('copy')
  })

  it('sets video drag payloads with the video mime key and file name', () => {
    const { data, target } = createDataTransferMock()

    const normalized = setAgentVideoDragPayload(target, 'file:///C:/demo/video.mp4', 'clip.mp4')

    expect(normalized).toBe('local-media:///C:/demo/video.mp4')
    expect(data.get(AGENT_VIDEO_DRAG_MIME)).toBe(
      JSON.stringify({
        url: 'local-media:///C:/demo/video.mp4',
        fileName: 'clip.mp4'
      })
    )
    expect(data.get('text/uri-list')).toBe('local-media:///C:/demo/video.mp4')
    expect(data.get('text/plain')).toBe('local-media:///C:/demo/video.mp4')
    expect(target.effectAllowed).toBe('copy')
  })

  it('sets file attachment drag payloads using the shared internal drag format', () => {
    const { data, target } = createDataTransferMock()

    setAgentAttachmentDragPayload(target, {
      type: 'file',
      url: 'file:///C:/demo/result.xlsx',
      fileName: 'result.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })

    const payload = JSON.stringify({
      itemTypes: ['file'],
      attachments: [
        {
          type: 'file',
          url: 'local-media:///C:/demo/result.xlsx',
          fileName: 'result.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }
      ]
    })

    expect(data.get(QAPP_IMAGE_DRAG_MIME)).toBe(payload)
    expect(data.get('text/plain')).toBe(`${INTERNAL_IMAGE_DRAG_PREFIX}${payload}`)
    expect(data.get('text/uri-list')).toBe('local-media:///C:/demo/result.xlsx')
    expect(target.effectAllowed).toBe('copy')
  })

  it('includes OCR result metadata in file attachment drag payloads when present', () => {
    const { data, target } = createDataTransferMock()

    const ocrResult = {
      kind: 'table' as const,
      sourceImageUrl: 'file:///C:/demo/source.png',
      boxes: [{ id: 'box-1', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
      sheets: [
        {
          id: 'sheet-1',
          name: 'Sheet 1',
          rows: 1,
          cols: 1,
          cells: [{ id: 'cell-1', row: 0, col: 0, text: 'Alpha', bboxIds: ['box-1'] }]
        }
      ]
    }

    setAgentAttachmentDragPayload(target, {
      type: 'file',
      url: 'file:///C:/demo/result.xlsx',
      fileName: 'result.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ocrResult
    })

    const payload = JSON.parse(data.get(QAPP_IMAGE_DRAG_MIME) || '{}')

    expect(payload.attachments).toEqual([
      {
        type: 'file',
        url: 'local-media:///C:/demo/result.xlsx',
        fileName: 'result.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ocrResult
      }
    ])
    expect(payload.ocrResult).toEqual(ocrResult)
    expect(data.get('text/plain')).toContain(INTERNAL_IMAGE_DRAG_PREFIX)
  })

  it('preserves image resolution metadata inside shared drag payloads', () => {
    const { data, target } = createDataTransferMock()

    setAgentAttachmentDragPayload(target, {
      type: 'image',
      url: 'file:///C:/demo/reference.png',
      fileName: 'reference.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      sourceWidth: 1536,
      sourceHeight: 1024
    })

    const payload = JSON.parse(data.get(QAPP_IMAGE_DRAG_MIME) || '{}')

    expect(payload.attachments).toEqual([
      {
        type: 'image',
        url: 'local-media:///C:/demo/reference.png',
        fileName: 'reference.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        sourceWidth: 1536,
        sourceHeight: 1024
      }
    ])
  })
})
