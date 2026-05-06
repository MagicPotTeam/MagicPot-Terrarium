import { describe, expect, it, vi } from 'vitest'
import {
  canvasTargetCanvasActionRequiresResolvedSource,
  canvasTargetSemanticCanvasActionRequiresResolvedSource,
  executeCanvasTargetSemanticCanvasAction,
  resolveCanvasTargetSemanticCanvasActionSourceIds
} from './canvasTargetCanvasActions'
import {
  CANVAS_TARGET_CANVAS_ACTIONS,
  normalizeCanvasTargetCapabilityActions,
  type CanvasTargetCanvasAction
} from './canvasTargetCapabilities'
import type {
  CanvasAnnotationItem,
  CanvasGroup,
  CanvasImageItem,
  CanvasItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'

function createTextItem(
  id: string,
  x: number,
  y: number,
  zIndex: number,
  width = 100,
  height = 50
): CanvasTextItem {
  return {
    id,
    type: 'text',
    text: id,
    fontSize: 16,
    fontFamily: 'system-ui',
    fill: '#ffffff',
    x,
    y,
    width,
    height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex,
    locked: false
  }
}

function createImageItem(id: string, x = 0, y = 0, zIndex = 1): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `blob:${id}`,
    fileName: `${id}.png`,
    x,
    y,
    width: 100,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex,
    locked: false
  }
}

function createAnnotationItem(id: string, x = 0, y = 0, zIndex = 1): CanvasAnnotationItem {
  return {
    id,
    type: 'annotation',
    shape: 'rect',
    stroke: '#ef4444',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    x,
    y,
    width: 100,
    height: 50,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex,
    locked: false
  }
}

function createVideoItem(id: string, x = 0, y = 0, zIndex = 1): CanvasVideoItem {
  return {
    id,
    type: 'video',
    src: `blob:${id}`,
    fileName: `${id}.mp4`,
    playing: false,
    muted: true,
    volume: 0.5,
    x,
    y,
    width: 160,
    height: 90,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex,
    locked: false
  }
}

function createGroup(id: string, itemIds: string[], name = id): CanvasGroup {
  return {
    id,
    name,
    itemIds,
    createdAt: '2026-05-03T00:00:00.000Z'
  }
}

function createCanvasAction(
  action: CanvasTargetCanvasAction['action'],
  patch: Partial<CanvasTargetCanvasAction> = {}
): CanvasTargetCanvasAction {
  return {
    type: 'canvas',
    id: `${action}-1`,
    action,
    phase: 'after_summary',
    outputTarget: 'canvas',
    ...patch
  }
}

describe('executeCanvasTargetSemanticCanvasAction', () => {
  it('requires an explicit source for non-semantic image extraction actions', () => {
    const action = createCanvasAction('extract_image_region', {
      sourceStageId: 'model-returned-media',
      cropX: 0,
      cropY: 0,
      cropWidth: 1,
      cropHeight: 1
    })

    expect(canvasTargetCanvasActionRequiresResolvedSource(action)).toBe(true)
    expect(canvasTargetSemanticCanvasActionRequiresResolvedSource(action)).toBe(true)
  })

  it('duplicates explicit current selection instead of stale latest output state', () => {
    vi.spyOn(Date, 'now').mockReturnValue(900)
    const selected = createTextItem('selected-source', 20, 40, 1, 80, 60)
    const staleLastOutput = createTextItem('stale-output', 400, 500, 2, 80, 60)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('duplicate_items', {
        source: 'current_selection',
        count: 1,
        reason: 'duplicate to the right'
      }),
      {
        items: [selected, staleLastOutput],
        selectedIds: new Set([selected.id]),
        nextZIndex: 3
      }
    )

    const copy = result.items.find((item) => result.createdIds.includes(item.id))
    expect(result.affectedIds).toEqual([selected.id])
    expect(copy).toMatchObject({ x: 124, y: 40, zIndex: 3 })
  })

  it('spreads duplicate copies to the right when offsets are omitted', () => {
    vi.spyOn(Date, 'now').mockReturnValue(950)
    const source = createImageItem('image-1', 10, 20, 1)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('duplicate_items', {
        source: 'current_selection',
        count: 3,
        reason: 'duplicate three copies to the right'
      }),
      {
        items: [source],
        selectedIds: new Set([source.id]),
        nextZIndex: 2
      }
    )

    const copies = result.items.filter((item) => result.createdIds.includes(item.id))
    expect(copies).toHaveLength(3)
    expect(copies.map((item) => ({ x: item.x, y: item.y }))).toEqual([
      { x: 134, y: 20 },
      { x: 258, y: 20 },
      { x: 382, y: 20 }
    ])
  })

  it('spreads duplicate copies below only when explicit offsets request it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(975)
    const source = createImageItem('image-1', 10, 20, 1)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('duplicate_items', {
        source: 'current_selection',
        offsetX: 0,
        offsetY: 104,
        count: 2,
        reason: 'duplicate two copies below'
      }),
      {
        items: [source],
        selectedIds: new Set([source.id]),
        nextZIndex: 2
      }
    )

    const copies = result.items.filter((item) => result.createdIds.includes(item.id))
    expect(copies.map((item) => ({ x: item.x, y: item.y }))).toEqual([
      { x: 10, y: 124 },
      { x: 10, y: 228 }
    ])
  })

  it('duplicates an explicitly referenced artifact output by the requested count', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const source = createTextItem('generated-image', 20, 40, 1, 80, 60)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('duplicate_items', {
        artifactId: 'artifact-generated-image',
        count: 10,
        offsetX: 12,
        offsetY: 8
      }),
      {
        items: [source],
        selectedIds: new Set(),
        nextZIndex: 2,
        artifactCanvasItemIds: new Map([['artifact-generated-image', [source.id]]])
      }
    )

    expect(result.fallbackReason).toBeUndefined()
    expect(result.createdIds).toHaveLength(10)
    expect(result.items).toHaveLength(11)
    expect(result.resultIds).toHaveLength(10)
    expect(result.selectedIds.has(source.id)).toBe(false)
    expect(Array.from(result.selectedIds)).toEqual(result.createdIds)
    expect(result.items[1]).toMatchObject({ x: 32, y: 48, zIndex: 2 })
    expect(result.items[10]).toMatchObject({ x: 140, y: 120, zIndex: 11 })
    expect(result.nextZIndex).toBe(12)
  })

  it('does not fall back to current selection when an explicit source is missing', () => {
    const selected = createTextItem('selected-source', 20, 40, 1, 80, 60)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('duplicate_items', {
        count: 1
      }),
      {
        items: [selected],
        selectedIds: new Set([selected.id]),
        nextZIndex: 2
      }
    )

    expect(result.fallbackReason).toContain('No source items were available')
    expect(result.createdIds).toEqual([])
    expect(result.items).toHaveLength(1)
  })

  it('resolves artifactIds as an ordered deduped union without falling back to selection', () => {
    const first = createTextItem('first-artifact-item', 20, 40, 1, 80, 60)
    const second = createTextItem('second-artifact-item', 120, 40, 2, 80, 60)
    const selected = createTextItem('selected-source', 220, 40, 3, 80, 60)

    const resolvedIds = resolveCanvasTargetSemanticCanvasActionSourceIds(
      createCanvasAction('arrange_items', {
        artifactIds: ['artifact-a', 'missing-artifact', 'artifact-b'],
        source: 'current_selection'
      }),
      {
        items: [first, second, selected],
        selectedIds: new Set([selected.id]),
        nextZIndex: 4,
        artifactCanvasItemIds: new Map([
          ['artifact-a', [first.id, second.id]],
          ['artifact-b', [first.id]]
        ])
      }
    )

    expect(resolvedIds).toEqual([first.id, second.id])
  })

  it('selects only newly created duplicate copies to avoid cascading over the original selection', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1200)
    const source = createImageItem('image-1', 10, 20, 1)
    let items: CanvasItem[] = [source]
    let selectedIds = new Set([source.id])
    let nextZIndex = 2
    const createdIds: string[] = []

    for (let index = 0; index < 3; index += 1) {
      const result = executeCanvasTargetSemanticCanvasAction(
        createCanvasAction('duplicate_items', {
          source: 'current_selection',
          count: 1,
          offsetX: 120,
          offsetY: 0
        }),
        {
          items,
          selectedIds,
          nextZIndex
        }
      )
      items = result.items
      selectedIds = result.selectedIds
      nextZIndex = result.nextZIndex
      createdIds.push(...result.createdIds)
    }

    expect(createdIds).toHaveLength(3)
    expect(items).toHaveLength(4)
    expect(selectedIds.has(source.id)).toBe(false)
    expect(Array.from(selectedIds)).toEqual([createdIds[2]])
  })

  it('keeps duplicate stage outputs limited to new copies for follow-up edits', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2000)
    const source = createImageItem('image-1', 10, 20, 1)

    const duplicated = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('duplicate_items', {
        itemIds: [source.id],
        count: 1,
        offsetX: 120,
        offsetY: 0
      }),
      {
        items: [source],
        selectedIds: new Set([source.id]),
        nextZIndex: 2
      }
    )

    const copyId = duplicated.createdIds[0]
    expect(duplicated.resultIds).toEqual([copyId])

    const cropped = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('crop_image', {
        sourceStageId: 'copy-stage',
        coordinateSpace: 'source_item_normalized',
        cropX: 0,
        cropY: 0,
        cropWidth: 0.5,
        cropHeight: 1
      }),
      {
        items: duplicated.items,
        selectedIds: duplicated.selectedIds,
        nextZIndex: duplicated.nextZIndex,
        stageCanvasItemIds: new Map([['copy-stage', duplicated.resultIds]])
      }
    )

    const original = cropped.items.find((item) => item.id === source.id) as CanvasImageItem
    const copy = cropped.items.find((item) => item.id === copyId) as CanvasImageItem
    expect(original.crop).toBeUndefined()
    expect(copy.crop).toEqual({ x: 0, y: 0, width: 50, height: 80 })
    expect(copy).toMatchObject({ width: 50, height: 80 })
  })

  it('requires crop_image to specify coordinate space instead of guessing one', () => {
    const image: CanvasImageItem = {
      ...createImageItem('image-1', 20, 30, 1),
      width: 200,
      height: 100,
      sourceWidth: 1000,
      sourceHeight: 500
    }

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('crop_image', {
        itemIds: [image.id],
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100
      }),
      {
        items: [image],
        selectedIds: new Set([image.id]),
        nextZIndex: 2
      }
    )

    expect(result.fallbackReason).toContain('Missing coordinateSpace for crop_image')
    expect(result.items[0]).toEqual(image)
  })

  it('interprets source_item crop rectangles as display-local coordinates', () => {
    const image: CanvasImageItem = {
      ...createImageItem('image-1', 20, 30, 1),
      width: 200,
      height: 100,
      sourceWidth: 1000,
      sourceHeight: 500
    }

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('crop_image', {
        itemIds: [image.id],
        coordinateSpace: 'source_item',
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100
      }),
      {
        items: [image],
        selectedIds: new Set([image.id]),
        nextZIndex: 2
      }
    )

    const cropped = result.items[0] as CanvasImageItem
    expect(cropped.crop).toEqual({ x: 0, y: 0, width: 500, height: 500 })
    expect(cropped).toMatchObject({ x: 20, y: 30, width: 500, height: 500 })
  })

  it('arranges selected items into a row with stable spacing', () => {
    const first = createTextItem('item-1', 100, 100, 1, 40, 30)
    const second = createTextItem('item-2', 300, 400, 2, 60, 20)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('arrange_items', {
        source: 'current_selection',
        arrangement: 'row',
        gapX: 10,
        gapY: 10
      }),
      {
        items: [first, second],
        selectedIds: new Set([first.id, second.id]),
        nextZIndex: 3
      }
    )

    expect(result.items.find((item) => item.id === first.id)).toMatchObject({ x: 100, y: 100 })
    expect(result.items.find((item) => item.id === second.id)).toMatchObject({ x: 150, y: 100 })
    expect(Array.from(result.selectedIds)).toEqual([first.id, second.id])
  })

  it('arranges ordered outputs from multiple prior stages at an explicit anchor', () => {
    const first = createImageItem('copy-a', 300, 400, 1)
    const second = createImageItem('copy-b', 10, 20, 2)
    const third = createImageItem('copy-c', 600, 90, 3)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('arrange_items', {
        sourceStageIds: ['stage-a', 'stage-b', 'stage-c'],
        arrangement: 'row',
        x: 50,
        y: 70,
        gapX: 10
      }),
      {
        items: [first, second, third],
        selectedIds: new Set(),
        nextZIndex: 4,
        stageCanvasItemIds: new Map([
          ['stage-a', [first.id]],
          ['stage-b', [second.id]],
          ['stage-c', [third.id]]
        ])
      }
    )

    expect(result.items.find((item) => item.id === first.id)).toMatchObject({ x: 50, y: 70 })
    expect(result.items.find((item) => item.id === second.id)).toMatchObject({ x: 160, y: 70 })
    expect(result.items.find((item) => item.id === third.id)).toMatchObject({ x: 270, y: 70 })
    expect(Array.from(result.selectedIds)).toEqual([first.id, second.id, third.id])
  })

  it('transforms a single source item by absolute position and size', () => {
    const item = createTextItem('item-1', 10, 20, 1, 100, 50)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('transform_items', {
        itemIds: [item.id],
        x: 200,
        y: 240,
        width: 320,
        height: 180,
        rotation: 15,
        scaleX: 1.25,
        scaleY: 1.5
      }),
      {
        items: [item],
        selectedIds: new Set(),
        nextZIndex: 2
      }
    )

    expect(result.items[0]).toMatchObject({
      x: 200,
      y: 240,
      width: 320,
      height: 180,
      rotation: 15,
      scaleX: 1.25,
      scaleY: 1.5
    })
    expect(Array.from(result.selectedIds)).toEqual([item.id])
  })

  it('treats omitted coordinateSpace on stage-targeted normalized annotations as source-local', () => {
    const source = createImageItem('copy-boxed', 200, 100, 1)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('add_annotation', {
        sourceStageId: 'copy-stage',
        annotationShape: 'rect',
        x: 0.1,
        y: 0.25,
        width: 0.4,
        height: 0.5,
        stroke: '#ff0000'
      }),
      {
        items: [source],
        selectedIds: new Set(),
        nextZIndex: 2,
        stageCanvasItemIds: new Map([['copy-stage', [source.id]]])
      }
    )

    const box = result.items.find((item) => item.type === 'annotation') as CanvasAnnotationItem
    expect(box).toMatchObject({
      x: 210,
      y: 120,
      width: 40,
      height: 40,
      stroke: '#ff0000'
    })
  })

  it('creates text and annotation items relative to resolved source items', () => {
    const source: CanvasImageItem = {
      ...createImageItem('image-1', 50, 60, 1),
      width: 200,
      height: 100
    }
    const baseState = {
      items: [source],
      selectedIds: new Set<string>(),
      nextZIndex: 2,
      stageCanvasItemIds: new Map([['source-stage', [source.id]]])
    }

    const textCreated = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('add_text', {
        sourceStageId: 'source-stage',
        coordinateSpace: 'source_item',
        text: '123',
        x: 0,
        y: 112,
        width: 200,
        fontSize: 20,
        color: '#111111'
      }),
      baseState
    )

    const textItem = textCreated.items.find((item) => item.type === 'text') as CanvasTextItem
    expect(textItem).toMatchObject({
      text: '123',
      x: 50,
      y: 172,
      width: 200,
      fontSize: 20,
      fill: '#111111',
      zIndex: 2
    })
    expect(textCreated.resultIds).toEqual([textItem.id])

    const annotationCreated = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('add_annotation', {
        sourceStageId: 'source-stage',
        coordinateSpace: 'source_item_normalized',
        annotationShape: 'rect',
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        stroke: '#00ff00',
        strokeWidth: 4
      }),
      baseState
    )

    const annotationItem = annotationCreated.items.find(
      (item) => item.type === 'annotation'
    ) as CanvasAnnotationItem
    expect(annotationItem).toMatchObject({
      shape: 'rect',
      x: 70,
      y: 80,
      width: 60,
      height: 40,
      stroke: '#00ff00',
      strokeWidth: 4,
      fillOpacity: 0,
      zIndex: 2
    })
    expect(annotationCreated.resultIds).toEqual([annotationItem.id])
  })

  it('can execute a split canvas target with cropped, labeled, and boxed variants', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3000)
    const source = createImageItem('source-image', 10, 20, 1)
    let items: CanvasItem[] = [source]
    let selectedIds = new Set([source.id])
    let nextZIndex = 2
    const stageCanvasItemIds = new Map<string, string[]>()

    const run = (action: CanvasTargetCanvasAction) => {
      const result = executeCanvasTargetSemanticCanvasAction(action, {
        items,
        selectedIds,
        nextZIndex,
        stageCanvasItemIds
      })
      items = result.items
      selectedIds = result.selectedIds
      nextZIndex = result.nextZIndex
      stageCanvasItemIds.set(action.id, result.resultIds)
      return result
    }

    const copyA = run(
      createCanvasAction('duplicate_items', {
        id: 'copy-cropped',
        itemIds: [source.id],
        count: 1,
        offsetX: 0,
        offsetY: 120
      })
    )
    const copyB = run(
      createCanvasAction('duplicate_items', {
        id: 'copy-labeled',
        itemIds: [source.id],
        count: 1,
        offsetX: 130,
        offsetY: 120
      })
    )
    const copyC = run(
      createCanvasAction('duplicate_items', {
        id: 'copy-boxed',
        itemIds: [source.id],
        count: 1,
        offsetX: 260,
        offsetY: 120
      })
    )

    run(
      createCanvasAction('crop_image', {
        id: 'crop-copy',
        sourceStageId: 'copy-cropped',
        coordinateSpace: 'source_item_normalized',
        cropX: 0,
        cropY: 0,
        cropWidth: 0.5,
        cropHeight: 1
      })
    )
    run(
      createCanvasAction('add_text', {
        id: 'label-copy',
        sourceStageId: 'copy-labeled',
        coordinateSpace: 'source_item',
        text: '123',
        x: 0,
        y: 88,
        width: 100,
        fontSize: 18
      })
    )
    run(
      createCanvasAction('add_annotation', {
        id: 'box-copy',
        sourceStageId: 'copy-boxed',
        coordinateSpace: 'source_item_normalized',
        annotationShape: 'rect',
        x: 0,
        y: 0,
        width: 0.25,
        height: 0.8,
        stroke: '#ff0000'
      })
    )

    const cropped = items.find((item) => item.id === copyA.createdIds[0]) as CanvasImageItem
    const labeled = items.find((item) => item.id === copyB.createdIds[0]) as CanvasImageItem
    const boxed = items.find((item) => item.id === copyC.createdIds[0]) as CanvasImageItem
    const text = items.find((item) => item.type === 'text') as CanvasTextItem
    const box = items.find((item) => item.type === 'annotation') as CanvasAnnotationItem

    expect(source.crop).toBeUndefined()
    expect(cropped).toMatchObject({ x: 10, y: 140, width: 50, height: 80 })
    expect(cropped.crop).toEqual({ x: 0, y: 0, width: 50, height: 80 })
    expect(labeled).toMatchObject({ x: 140, y: 140, width: 100, height: 80 })
    expect(text).toMatchObject({ text: '123', x: 140, y: 228, width: 100 })
    expect(boxed).toMatchObject({ x: 270, y: 140, width: 100, height: 80 })
    expect(box).toMatchObject({ x: 270, y: 140, width: 25, height: 64, stroke: '#ff0000' })
  })

  it('moves selected items to the front while preserving their relative order', () => {
    const back = createTextItem('back', 0, 0, 1)
    const middle = createTextItem('middle', 0, 0, 2)
    const front = createTextItem('front', 0, 0, 3)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('set_z_order', {
        itemIds: [back.id, middle.id],
        zOrder: 'front'
      }),
      {
        items: [back, middle, front],
        selectedIds: new Set(),
        nextZIndex: 4
      }
    )

    const byId = new Map(result.items.map((item) => [item.id, item]))
    expect(byId.get(front.id)?.zIndex).toBe(1)
    expect(byId.get(back.id)?.zIndex).toBe(2)
    expect(byId.get(middle.id)?.zIndex).toBe(3)
    expect(result.nextZIndex).toBe(4)
  })

  it('deletes resolved items and prunes group membership', () => {
    const first = createTextItem('item-1', 0, 0, 1)
    const second = createTextItem('item-2', 100, 0, 2)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('delete_items', {
        itemIds: [first.id]
      }),
      {
        items: [first, second],
        groups: [createGroup('group-1', [first.id, second.id])],
        selectedIds: new Set([first.id, second.id]),
        nextZIndex: 3
      }
    )

    expect(result.items.map((item) => item.id)).toEqual([second.id])
    expect(result.groups).toEqual([expect.objectContaining({ itemIds: [second.id] })])
    expect(Array.from(result.selectedIds)).toEqual([second.id])
  })

  it('flips selected items while preserving their world center', () => {
    const image = createImageItem('image-1', 10, 20, 1)

    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('flip_items', {
        itemIds: [image.id],
        flipAxis: 'horizontal'
      }),
      {
        items: [image],
        selectedIds: new Set(),
        nextZIndex: 2
      }
    )

    expect(result.items[0]).toMatchObject({
      x: 110,
      y: 20,
      scaleX: -1,
      scaleY: 1
    })
  })

  it('applies image crop, text edits, annotation edits, and video playback state', () => {
    const image = createImageItem('image-1')
    const text = createTextItem('text-1', 0, 0, 2)
    const annotation = createAnnotationItem('annotation-1', 0, 0, 3)
    const video = createVideoItem('video-1', 0, 0, 4)

    const cropped = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('crop_image', {
        itemIds: [image.id],
        coordinateSpace: 'source_image_pixels',
        cropX: 4,
        cropY: 8,
        cropWidth: 40,
        cropHeight: 30
      }),
      {
        items: [image, text, annotation, video],
        selectedIds: new Set(),
        nextZIndex: 5
      }
    )
    expect(cropped.items[0]).toMatchObject({
      crop: { x: 4, y: 8, width: 40, height: 30 }
    })

    const textUpdated = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('update_text', {
        itemIds: [text.id],
        text: 'updated',
        color: '#111111',
        fontSize: 24,
        fontWeight: 'bold'
      }),
      {
        items: cropped.items,
        selectedIds: new Set(),
        nextZIndex: 5
      }
    )
    expect(textUpdated.items.find((item) => item.id === text.id)).toMatchObject({
      text: 'updated',
      fill: '#111111',
      fontSize: 24,
      fontWeight: 'bold'
    })

    const annotationUpdated = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('update_annotation', {
        itemIds: [annotation.id],
        itemLabel: 'callout',
        annotationShape: 'rounded-rect',
        stroke: '#222222',
        fillOpacity: 0.3,
        strokeWidth: 4
      }),
      {
        items: textUpdated.items,
        selectedIds: new Set(),
        nextZIndex: 5
      }
    )
    expect(annotationUpdated.items.find((item) => item.id === annotation.id)).toMatchObject({
      label: 'callout',
      shape: 'rounded-rect',
      stroke: '#222222',
      fillOpacity: 0.3,
      strokeWidth: 4
    })

    const playbackUpdated = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('set_media_playback', {
        itemIds: [video.id],
        playing: true,
        muted: false,
        volume: 0.75
      }),
      {
        items: annotationUpdated.items,
        selectedIds: new Set(),
        nextZIndex: 5
      }
    )
    expect(playbackUpdated.items.find((item) => item.id === video.id)).toMatchObject({
      playing: true,
      muted: false,
      volume: 0.75
    })
  })

  it('creates, renames, and deletes groups from semantic target actions', () => {
    const first = createTextItem('item-1', 0, 0, 1)
    const second = createTextItem('item-2', 100, 0, 2)

    const created = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('create_group', {
        itemIds: [first.id, second.id],
        groupName: 'Target group'
      }),
      {
        items: [first, second],
        groups: [createGroup('old-group', [first.id])],
        selectedIds: new Set(),
        nextZIndex: 3
      }
    )

    expect(created.groups).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        name: 'Target group',
        itemIds: [first.id, second.id]
      })
    ])

    const createdGroupId = created.groups?.[0].id || ''
    const renamed = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('rename_group', {
        groupId: createdGroupId,
        groupName: 'Renamed group'
      }),
      {
        items: created.items,
        groups: created.groups,
        selectedIds: created.selectedIds,
        nextZIndex: created.nextZIndex
      }
    )

    expect(renamed.groups?.[0]).toMatchObject({ id: createdGroupId, name: 'Renamed group' })

    const deleted = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('delete_group', {
        groupId: createdGroupId
      }),
      {
        items: renamed.items,
        groups: renamed.groups,
        selectedIds: renamed.selectedIds,
        nextZIndex: renamed.nextZIndex
      }
    )

    expect(deleted.groups).toEqual([])
    expect(deleted.items.map((item) => item.id)).toEqual([first.id, second.id])
  })

  it('returns toolbar side effects for background, grid, and tool state actions', () => {
    const state = {
      items: [createTextItem('item-1', 0, 0, 1)],
      selectedIds: new Set<string>(),
      nextZIndex: 2
    }

    const background = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('set_canvas_background', {
        bgColor: '#123456'
      }),
      state
    )
    expect(background.bgColor).toBe('#123456')
    expect(background.items).toBe(state.items)

    const grid = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('set_grid_visibility', {
        showGrid: false
      }),
      state
    )
    expect(grid.showGrid).toBe(false)

    const tool = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('set_canvas_tool', {
        tool: 'annotate',
        annotationShape: 'arrow',
        color: '#abcdef',
        strokeWidth: 6,
        fillOpacity: 0.2
      }),
      state
    )
    expect(tool).toMatchObject({
      tool: 'annotate',
      annotationShape: 'arrow',
      annotationColor: '#abcdef',
      annotationStrokeWidth: 6,
      annotationFillOpacity: 0.2
    })
  })

  it('falls back when no semantic source item can be resolved', () => {
    const result = executeCanvasTargetSemanticCanvasAction(
      createCanvasAction('duplicate_items', {
        itemIds: ['missing-item'],
        count: 1
      }),
      {
        items: [createTextItem('item-1', 0, 0, 1)],
        selectedIds: new Set(),
        nextZIndex: 2
      }
    )

    expect(result.fallbackReason).toContain('No source items')
    expect(result.items).toHaveLength(1)
    expect(result.createdIds).toHaveLength(0)
  })
})

describe('normalizeCanvasTargetCapabilityActions semantic canvas fields', () => {
  it('accepts duplicate item action fields from a control plan', () => {
    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'canvas',
          id: 'copy-after-upscale',
          action: 'duplicate-items',
          phase: 'after_summary',
          outputTarget: 'canvas',
          artifactId: 'artifact-upscale-output',
          count: 10,
          offsetX: 20,
          offsetY: 0,
          selectResult: true
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toEqual([
      {
        type: 'canvas',
        id: 'copy-after-upscale',
        action: 'duplicate_items',
        phase: 'after_summary',
        outputTarget: 'canvas',
        artifactId: 'artifact-upscale-output',
        count: 10,
        offsetX: 20,
        offsetY: 0,
        selectResult: true
      }
    ])
  })

  it('accepts toolbar and selection action fields from a control plan', () => {
    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'canvas',
          id: 'box-copy',
          action: 'add-annotation',
          phase: 'after_summary',
          outputTarget: 'canvas',
          sourceStageId: 'copy-stage',
          coordinateSpace: 'source-item-normalized',
          shape: 'rect',
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.4,
          stroke: '#ff0000',
          strokeWidth: 3
        },
        {
          type: 'canvas',
          id: 'style-selection',
          action: 'set-canvas-tool',
          phase: 'after_summary',
          outputTarget: 'canvas',
          tool: 'export_select',
          shape: 'text-anno',
          color: '#abcdef',
          strokeWidth: 5,
          fillOpacity: 0.2,
          showGrid: false,
          explicitUserIntent: true
        },
        {
          type: 'canvas',
          id: 'crop-selection',
          action: 'crop-image',
          outputTarget: 'canvas',
          itemIds: ['image-1'],
          cropX: 1,
          cropY: 2,
          cropWidth: 30,
          cropHeight: 40,
          flipAxis: 'horizontal',
          playing: true,
          muted: false,
          volume: 1.4
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'canvas',
        id: 'box-copy',
        action: 'add_annotation',
        sourceStageId: 'copy-stage',
        coordinateSpace: 'source_item_normalized',
        annotationShape: 'rect',
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        stroke: '#ff0000',
        strokeWidth: 3
      }),
      expect.objectContaining({
        type: 'canvas',
        id: 'style-selection',
        action: 'set_canvas_tool',
        tool: 'export-select',
        annotationShape: 'text-anno',
        color: '#abcdef',
        strokeWidth: 5,
        fillOpacity: 0.2,
        showGrid: false,
        explicitUserIntent: true
      }),
      expect.objectContaining({
        type: 'canvas',
        id: 'crop-selection',
        action: 'crop_image',
        itemIds: ['image-1'],
        cropX: 1,
        cropY: 2,
        cropWidth: 30,
        cropHeight: 40,
        flipAxis: 'horizontal',
        playing: true,
        muted: false,
        volume: 1
      })
    ])
  })

  it('accepts ordered sourceStageIds for multi-stage canvas layout actions', () => {
    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'canvas',
          id: 'arrange-variants',
          action: 'arrange_items',
          outputTarget: 'canvas',
          sourceStageIds: ['copy-cropped', 'copy-labeled', 'copy-boxed'],
          arrangement: 'row',
          x: 80,
          y: 120,
          gapX: 16
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'canvas',
        id: 'arrange-variants',
        action: 'arrange_items',
        sourceStageIds: ['copy-cropped', 'copy-labeled', 'copy-boxed'],
        arrangement: 'row',
        x: 80,
        y: 120,
        gapX: 16
      })
    ])
  })

  it('keeps stage-anchored capability actions for mid-run execution', () => {
    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'canvas',
          id: 'copy-after-stage',
          action: 'duplicate-items',
          phase: 'after-stage',
          stageId: 'upscale-stage',
          outputTarget: 'canvas',
          sourceStageId: 'upscale-stage',
          count: 10
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'canvas',
        id: 'copy-after-stage',
        action: 'duplicate_items',
        phase: 'after_stage',
        stageId: 'upscale-stage',
        sourceStageId: 'upscale-stage',
        count: 10
      })
    ])
  })

  it('exposes source resolution for preflight validation of source-consuming actions', () => {
    const source = createImageItem('source-stage-output')
    const state = {
      items: [source],
      selectedIds: new Set<string>(),
      nextZIndex: 2,
      stageCanvasItemIds: new Map([['stage-output', [source.id]]])
    }

    const transformAction = createCanvasAction('transform_items', {
      sourceStageId: 'stage-output',
      deltaX: 20
    })
    const missingAction = createCanvasAction('transform_items', {
      sourceStageId: 'missing-stage',
      deltaX: 20
    })

    expect(canvasTargetSemanticCanvasActionRequiresResolvedSource(transformAction)).toBe(true)
    expect(resolveCanvasTargetSemanticCanvasActionSourceIds(transformAction, state)).toEqual([
      source.id
    ])
    expect(resolveCanvasTargetSemanticCanvasActionSourceIds(missingAction, state)).toEqual([])
  })
})
