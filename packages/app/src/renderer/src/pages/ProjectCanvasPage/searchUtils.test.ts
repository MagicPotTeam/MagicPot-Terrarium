import { describe, expect, it } from 'vitest'
import { searchCanvasItems } from './searchUtils'
import type { CanvasItem } from './types'

const baseItem = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  locked: false
}

describe('searchCanvasItems', () => {
  it('matches text and annotation content', () => {
    const items: CanvasItem[] = [
      {
        ...baseItem,
        id: 'text-1',
        type: 'text',
        zIndex: 1,
        text: 'Forest concept art',
        fontSize: 16,
        fontFamily: 'system-ui',
        fill: '#fff'
      },
      {
        ...baseItem,
        id: 'anno-1',
        type: 'annotation',
        zIndex: 2,
        shape: 'text-anno',
        stroke: '#fff',
        fillOpacity: 0,
        strokeWidth: 2,
        label: 'Callout',
        text: 'Main subject'
      }
    ]

    const results = searchCanvasItems(items, 'subject')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('anno-1')
  })

  it('matches media by type keywords and filenames', () => {
    const items: CanvasItem[] = [
      {
        ...baseItem,
        id: 'img-1',
        type: 'image',
        zIndex: 3,
        src: 'data:image/png;base64,abc',
        fileName: 'hero-shot.png'
      },
      {
        ...baseItem,
        id: 'video-1',
        type: 'video',
        zIndex: 4,
        src: 'blob:test',
        fileName: 'turntable.mp4',
        playing: false,
        muted: true,
        volume: 0.5
      },
      {
        ...baseItem,
        id: 'model-1',
        type: 'model3d',
        zIndex: 5,
        src: 'blob:model',
        fileName: 'character.glb'
      }
    ]

    expect(searchCanvasItems(items, 'hero-shot')[0]?.id).toBe('img-1')
    expect(searchCanvasItems(items, 'video')[0]?.id).toBe('video-1')
    expect(searchCanvasItems(items, '3d')[0]?.id).toBe('model-1')
  })

  it('supports browsing by filter when query is empty', () => {
    const items: CanvasItem[] = [
      {
        ...baseItem,
        id: 'img-1',
        type: 'image',
        zIndex: 3,
        src: 'data:image/png;base64,abc'
      },
      {
        ...baseItem,
        id: 'video-1',
        type: 'video',
        zIndex: 4,
        src: 'blob:test',
        fileName: 'turntable.mp4',
        playing: false,
        muted: true,
        volume: 0.5
      }
    ]

    const results = searchCanvasItems(items, '', 'image')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('img-1')
  })
})
