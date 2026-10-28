import { describe, expect, it } from 'vitest'

import {
  buildProjectTraceCanvasItemMetrics,
  buildProjectTraceCanvasItemSignature,
  measureProjectTraceCanvasRuleMetrics,
  summarizeProjectTraceCanvasChange,
  summarizeProjectTraceCanvasItemTypes
} from './projectTraceCanvasMetrics'
import type { CanvasItem } from './types'

function createTextItem(overrides: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id: 'item-1',
    type: 'text',
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    text: 'Label',
    fontSize: 16,
    fontFamily: 'system-ui',
    fill: '#fff',
    ...overrides
  } as CanvasItem
}

describe('projectTraceCanvasMetrics', () => {
  it('builds rounded item metrics and deterministic signatures', () => {
    const metrics = buildProjectTraceCanvasItemMetrics([
      createTextItem({ id: 'b', x: 10.04, width: 99.96, zIndex: 2 }),
      createTextItem({ id: 'a', y: 20.08, height: 40.04, zIndex: 1 })
    ])

    expect(metrics.b).toMatchObject({ x: 10, width: 100, zIndex: 2 })
    expect(metrics.a).toMatchObject({ y: 20.1, height: 40, zIndex: 1 })
    expect(buildProjectTraceCanvasItemSignature(metrics).split('|')[0]?.startsWith('a:text')).toBe(
      true
    )
  })

  it('summarizes geometry, layer, and selection changes consistently', () => {
    const previous = buildProjectTraceCanvasItemMetrics([createTextItem({ id: 'item-1' })])
    const next = buildProjectTraceCanvasItemMetrics([
      createTextItem({ id: 'item-1', x: 30, width: 120, rotation: 10, zIndex: 3 }),
      createTextItem({ id: 'item-2' })
    ])

    expect(summarizeProjectTraceCanvasChange(previous, next, 2, true, false)).toMatchObject({
      affectedItemCount: 7,
      movementDistancePx: 20
    })
    expect(summarizeProjectTraceCanvasChange(previous, next, 2, true, false).summary).toContain(
      'Added 1 canvas item(s)'
    )
    expect(summarizeProjectTraceCanvasChange(previous, next, 2, true, true).summary).toContain(
      'Added 1 canvas item(s)'
    )
  })

  it('detects committed text on text nodes and annotations but emits only a count', () => {
    for (const shape of [undefined, 'text-anno', 'rect'] as const) {
      const item = shape
        ? createTextItem({ type: 'annotation', shape, text: 'sensitive-a' } as Partial<CanvasItem>)
        : createTextItem({ text: 'sensitive-a' })
      const previous = buildProjectTraceCanvasItemMetrics([item])
      const next = buildProjectTraceCanvasItemMetrics([
        { ...item, text: 'sensitive-b' } as CanvasItem
      ])
      const summary = summarizeProjectTraceCanvasChange(previous, next, 0, false, false)
      expect(summary).toMatchObject({
        summary: 'Edited text on 1 canvas item(s)',
        affectedItemCount: 1
      })
      expect(JSON.stringify(summary)).not.toContain('sensitive')
      expect(summarizeProjectTraceCanvasChange(next, next, 0, false, true).affectedItemCount).toBe(
        0
      )
    }
  })

  it('does not treat creation or image metadata as a committed text edit', () => {
    const added = buildProjectTraceCanvasItemMetrics([createTextItem({ text: 'secret' })])
    expect(summarizeProjectTraceCanvasChange({}, added, 0, false, false).summary).toBe(
      'Added 1 canvas item(s)'
    )
    const image = createTextItem({
      type: 'image',
      src: 'owned-image',
      fileName: 'private-a'
    } as Partial<CanvasItem>)
    const before = buildProjectTraceCanvasItemMetrics([image])
    const after = buildProjectTraceCanvasItemMetrics([
      { ...image, fileName: 'private-b' } as CanvasItem
    ])
    expect(
      summarizeProjectTraceCanvasChange(before, after, 0, false, false).affectedItemCount
    ).toBe(0)
  })

  it('measures rule metrics and summarizes item types', () => {
    const previous = buildProjectTraceCanvasItemMetrics([
      createTextItem({ id: 'removed' }),
      createTextItem({ id: 'kept', width: 100, height: 50, rotation: 350, zIndex: 1 })
    ])
    const next = buildProjectTraceCanvasItemMetrics([
      createTextItem({ id: 'kept', width: 150, height: 50, rotation: 10, zIndex: 4 }),
      createTextItem({
        id: 'new',
        type: 'annotation',
        shape: 'rect',
        stroke: '#f00',
        fillOpacity: 0,
        strokeWidth: 1,
        label: ''
      } as Partial<CanvasItem>)
    ])

    expect(measureProjectTraceCanvasRuleMetrics(previous, next)).toEqual({
      removedItemCount: 1,
      resizedItemCount: 1,
      rotatedItemCount: 1,
      reorderedItemCount: 1,
      maxScaleChangeRatio: 0.5,
      maxRotationDeltaDeg: 20,
      maxLayerDelta: 3
    })
    expect(
      summarizeProjectTraceCanvasItemTypes([
        createTextItem({ id: 'text' }),
        createTextItem({
          id: 'anno',
          type: 'annotation',
          shape: 'rect',
          stroke: '#f00',
          fillOpacity: 0,
          strokeWidth: 1,
          label: ''
        } as Partial<CanvasItem>)
      ])
    ).toBe('annotation:1, text:1')
  })
})
