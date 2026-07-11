import { describe, expect, it } from 'vitest'

import {
  getCanvasExportableItems,
  getSelectedCanvasExportableItems
} from './canvasExportableSelectionUtils'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'

function baseItem(id: string) {
  return {
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function imageItem(id: string, src = `${id}.png`): CanvasImageItem {
  return {
    ...baseItem(id),
    type: 'image',
    src
  }
}

function videoItem(id: string): CanvasVideoItem {
  return {
    ...baseItem(id),
    type: 'video',
    src: `${id}.mp4`,
    fileName: `${id}.mp4`,
    playing: false,
    muted: true,
    volume: 1
  }
}

function modelItem(id: string): CanvasModel3DItem {
  return {
    ...baseItem(id),
    type: 'model3d',
    src: `${id}.glb`,
    fileName: `${id}.glb`
  }
}

function textItem(id: string): CanvasTextItem {
  return {
    ...baseItem(id),
    type: 'text',
    text: 'caption',
    fontSize: 16,
    fontFamily: 'system-ui, sans-serif',
    fill: '#fff'
  }
}

function annotationItem(id: string): CanvasAnnotationItem {
  return {
    ...baseItem(id),
    type: 'annotation',
    shape: 'rect',
    stroke: '#fff',
    strokeWidth: 2,
    fillOpacity: 0,
    label: ''
  }
}

function fileItem(id: string): CanvasFileItem {
  return {
    ...baseItem(id),
    type: 'file',
    src: `${id}.txt`,
    fileName: `${id}.txt`,
    mimeType: 'text/plain',
    fileKind: 'text',
    editable: true
  }
}

describe('canvasExportableSelectionUtils', () => {
  it('returns only canvas items that the export workflow can render as media', () => {
    const image = imageItem('image-1')
    const video = videoItem('video-1')
    const model = modelItem('model-1')
    const items: CanvasItem[] = [
      image,
      textItem('text-1'),
      annotationItem('annotation-1'),
      fileItem('file-1'),
      imageItem('image-without-src', ''),
      video,
      model
    ]

    expect(getCanvasExportableItems(items)).toEqual([image, video, model])
  })

  it('intersects selected ids with exportable media items', () => {
    const image = imageItem('image-1')
    const video = videoItem('video-1')
    const model = modelItem('model-1')
    const items: CanvasItem[] = [
      image,
      textItem('text-1'),
      video,
      annotationItem('annotation-1'),
      model
    ]

    expect(
      getSelectedCanvasExportableItems(items, new Set(['text-1', 'video-1', 'missing']))
    ).toEqual([video])
  })

  it('returns an empty selected export set when selection contains only non-exportable ids', () => {
    const items: CanvasItem[] = [textItem('text-1'), annotationItem('annotation-1')]

    expect(getSelectedCanvasExportableItems(items, new Set(['text-1', 'annotation-1']))).toEqual([])
  })
})
