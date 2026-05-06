import { describe, expect, it } from 'vitest'
import {
  buildVisibleGroupSummaries,
  canPlayGroupSummary,
  normalizeGroupNameDraft,
  type CanvasGroupSummary
} from './groupMenuUtils'
import type { CanvasGroup, CanvasImageItem, CanvasItem, CanvasTextItem } from './types'

function createTextItem(id: string): CanvasTextItem {
  return {
    id,
    type: 'text',
    text: id,
    fontSize: 16,
    fontFamily: 'sans-serif',
    fill: '#fff',
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

function createImageItem(id: string): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `${id}.png`,
    x: 0,
    y: 0,
    width: 120,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

describe('buildVisibleGroupSummaries', () => {
  it('filters out groups whose elements no longer exist', () => {
    const groups: CanvasGroup[] = [
      {
        id: 'missing-group',
        name: 'missing',
        itemIds: ['missing-1'],
        createdAt: '2026-03-25T00:00:00.000Z'
      },
      {
        id: 'valid-group',
        name: 'valid',
        itemIds: ['text-1'],
        createdAt: '2026-03-25T00:00:00.000Z'
      }
    ]
    const items: CanvasItem[] = [createTextItem('text-1')]

    expect(buildVisibleGroupSummaries(groups, items).map((group) => group.id)).toEqual([
      'valid-group'
    ])
  })

  it('preserves the stored item order inside each group summary', () => {
    const groups: CanvasGroup[] = [
      {
        id: 'ordered-group',
        name: 'ordered',
        itemIds: ['image-2', 'image-1'],
        createdAt: '2026-03-25T00:00:00.000Z'
      }
    ]
    const items: CanvasItem[] = [createImageItem('image-1'), createImageItem('image-2')]

    const [summary] = buildVisibleGroupSummaries(groups, items)

    expect(summary.validItems.map((item) => item.id)).toEqual(['image-2', 'image-1'])
    expect(summary.validCount).toBe(2)
    expect(summary.totalCount).toBe(2)
  })
})

describe('canPlayGroupSummary', () => {
  it('hides playback for groups without image, video, or 3d items', () => {
    const summary: CanvasGroupSummary = {
      id: 'text-group',
      name: 'text-group',
      itemIds: ['text-1'],
      createdAt: '2026-03-25T00:00:00.000Z',
      validItems: [createTextItem('text-1')],
      validCount: 1,
      totalCount: 1
    }

    expect(canPlayGroupSummary(summary)).toBe(false)
  })

  it('keeps playback when a playable item exists in the group', () => {
    const summary: CanvasGroupSummary = {
      id: 'image-group',
      name: 'image-group',
      itemIds: ['image-1'],
      createdAt: '2026-03-25T00:00:00.000Z',
      validItems: [createImageItem('image-1')],
      validCount: 1,
      totalCount: 1
    }

    expect(canPlayGroupSummary(summary)).toBe(true)
  })
})

describe('normalizeGroupNameDraft', () => {
  it('trims surrounding whitespace from renamed group names', () => {
    expect(normalizeGroupNameDraft('  Team Alpha  ', 'Group 1')).toBe('Team Alpha')
  })

  it('falls back to the existing name when the draft is blank', () => {
    expect(normalizeGroupNameDraft('   ', 'Group 1')).toBe('Group 1')
  })
})
