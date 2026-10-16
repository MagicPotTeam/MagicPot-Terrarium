import { StrictMode } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProjectTraceCanvasEvents } from './useProjectTraceCanvasEvents'
import type { CanvasItem, CanvasTextItem } from './types'

function createTextItem(overrides: Partial<CanvasTextItem> = {}): CanvasTextItem {
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
  }
}

function renderTraceHook(options: Partial<Parameters<typeof useProjectTraceCanvasEvents>[0]> = {}) {
  const emitRuntimeEvent = vi.fn()
  const props = {
    canvasId: 'canvas-1',
    projectName: 'Project One',
    items: [] as CanvasItem[],
    selectedIds: new Set<string>(),
    isChineseUi: false,
    debounceMs: 20,
    emitRuntimeEvent,
    ...options
  }
  const view = renderHook((nextProps: typeof props) => useProjectTraceCanvasEvents(nextProps), {
    initialProps: props
  })
  return { ...view, emitRuntimeEvent, props }
}

describe('useProjectTraceCanvasEvents', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('records only a minimal project-open event for the initial canvas snapshot', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender, props } = renderTraceHook({
      items: [createTextItem()],
      projectName: 'private@example.com C:\\Users\\private'
    })

    rerender({ ...props, items: [createTextItem()] })
    vi.advanceTimersByTime(50)

    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(emitRuntimeEvent).toHaveBeenCalledWith({
      projectId: 'canvas-1',
      scope: 'system',
      action: 'project_opened',
      status: 'info',
      safeSummary: 'Project opened.',
      canvasMutation: false
    })
    expect(JSON.stringify(emitRuntimeEvent.mock.calls)).not.toContain('private')
  })

  it('does not duplicate project-open events during StrictMode replay but records a real remount', () => {
    const emitRuntimeEvent = vi.fn()
    const options = {
      canvasId: 'canvas-1',
      projectName: 'Project',
      items: [],
      selectedIds: new Set<string>(),
      isChineseUi: false,
      emitRuntimeEvent
    }
    const first = renderHook(() => useProjectTraceCanvasEvents(options), { wrapper: StrictMode })
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    first.unmount()
    const second = renderHook(() => useProjectTraceCanvasEvents(options), { wrapper: StrictMode })
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    second.unmount()
  })

  it('emits a debounced add event after the canvas changes', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender, props } = renderTraceHook({ items: [createTextItem()] })
    emitRuntimeEvent.mockClear()

    rerender({
      ...props,
      items: [
        createTextItem(),
        {
          ...createTextItem({ id: 'item-2' }),
          type: 'annotation',
          shape: 'text-anno',
          stroke: '#fff',
          strokeWidth: 1,
          fillOpacity: 0,
          label: ''
        }
      ],
      selectedIds: new Set(['item-2'])
    })

    vi.advanceTimersByTime(19)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'canvas-1',
        projectName: 'Project One',
        scope: 'canvas',
        action: 'canvas_items_added',
        status: 'success',
        entityType: 'canvas_item',
        entityCount: 2,
        createdItemCount: 1,
        canvasMutation: true,
        outputKinds: expect.arrayContaining(['text', 'annotation'])
      })
    )
    expect(emitRuntimeEvent.mock.calls[0]?.[0].safeSummary).toContain(
      'Canvas has 2 item(s), 1 selected.'
    )
  })

  it('emits selection-only changes as non-mutating canvas selection events', () => {
    vi.useFakeTimers()
    const item = createTextItem()
    const { emitRuntimeEvent, rerender, props } = renderTraceHook({ items: [item] })
    emitRuntimeEvent.mockClear()

    rerender({ ...props, selectedIds: new Set(['item-1']) })
    vi.advanceTimersByTime(20)

    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'canvas_selection_changed',
        canvasMutation: false,
        createdItemCount: 0,
        riskSignals: []
      })
    )
  })

  it.each([
    { name: 'same-count replacement', before: ['old'], after: ['new'], created: 1, removed: 1 },
    {
      name: 'net addition with a deletion',
      before: ['old'],
      after: ['new-a', 'new-b'],
      created: 2,
      removed: 1
    },
    {
      name: 'net deletion with an addition',
      before: ['old-a', 'old-b'],
      after: ['new'],
      created: 1,
      removed: 2
    }
  ])(
    'retains both operation counts and deletion risk for $name',
    ({ before, after, created, removed }) => {
      vi.useFakeTimers()
      const makeItem = (id: string) => createTextItem({ id, text: `private-body-${id}` })
      const { emitRuntimeEvent, rerender, props } = renderTraceHook({ items: before.map(makeItem) })
      emitRuntimeEvent.mockClear()
      rerender({ ...props, items: after.map(makeItem) })
      vi.advanceTimersByTime(20)
      expect(emitRuntimeEvent).toHaveBeenCalledOnce()
      const event = emitRuntimeEvent.mock.calls[0][0]
      expect(event).toMatchObject({
        projectId: props.canvasId,
        scope: 'canvas',
        action: 'canvas_items_changed',
        createdItemCount: created,
        removedItemCount: removed,
        affectedItemCount: created + removed,
        canvasMutation: true,
        riskSignals: ['destructive_action']
      })
      expect(event.safeSummary).toContain(`Added ${created} canvas item(s)`)
      expect(event.safeSummary).toContain(`Removed ${removed} canvas item(s)`)
      expect(JSON.stringify(event)).not.toContain('private-body-')
    }
  )

  it('counts a coalesced replacement against its original baseline and flushes to its original project', () => {
    vi.useFakeTimers()
    const original = createTextItem({ id: 'old' })
    const replacement = createTextItem({ id: 'new' })
    const { emitRuntimeEvent, rerender, props, unmount } = renderTraceHook({ items: [original] })
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [original, replacement] })
    vi.advanceTimersByTime(10)
    rerender({ ...props, items: [replacement] })
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    rerender({ ...props, canvasId: 'next-project', items: [] })
    const mutations = emitRuntimeEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.scope === 'canvas')
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      projectId: props.canvasId,
      action: 'canvas_items_changed',
      createdItemCount: 1,
      removedItemCount: 1,
      riskSignals: ['destructive_action']
    })
    unmount()
    vi.advanceTimersByTime(100)
    expect(emitRuntimeEvent.mock.calls.filter(([event]) => event.scope === 'canvas')).toHaveLength(
      1
    )
  })

  it('records no mutation when a replacement is reverted within the debounce', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender, props, unmount } = renderTraceHook({
      items: [createTextItem({ id: 'old' })]
    })
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [createTextItem({ id: 'new' })] })
    vi.advanceTimersByTime(10)
    rerender(props)
    unmount()
    vi.advanceTimersByTime(100)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
  })

  it('keeps the original baseline while debounce coalesces multiple changes', () => {
    vi.useFakeTimers()
    const base = createTextItem({ id: 'base' })
    const moved = createTextItem({ id: 'base', x: 40 })
    const added = createTextItem({ id: 'added' })
    const { emitRuntimeEvent, rerender, unmount, props } = renderTraceHook({ items: [base] })
    emitRuntimeEvent.mockClear()

    rerender({ ...props, items: [moved] })
    vi.advanceTimersByTime(10)
    rerender({ ...props, items: [moved, added] })
    vi.advanceTimersByTime(19)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    unmount()
    vi.advanceTimersByTime(50)

    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'canvas_items_added',
        createdItemCount: 1,
        movementDistancePx: 30
      })
    )
  })

  it('flushes a pending 700ms mutation exactly once on unmount', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender, unmount, props } = renderTraceHook({
      items: [createTextItem()],
      debounceMs: 700
    })
    emitRuntimeEvent.mockClear()

    rerender({ ...props, items: [createTextItem({ x: 40 })] })
    vi.advanceTimersByTime(699)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    unmount()
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'canvas-1',
        projectName: 'Project One',
        action: 'canvas_items_changed',
        movementDistancePx: 30,
        canvasMutation: true
      })
    )
    vi.advanceTimersByTime(1000)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes the original project before entering a new canvas with an independent baseline', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender, unmount, props } = renderTraceHook({
      items: [createTextItem()]
    })
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [createTextItem({ x: 40 })] })
    const emitNext = vi.fn()
    const next = {
      ...props,
      canvasId: 'canvas-2',
      projectName: 'Project Two',
      items: [createTextItem({ x: 1000 })],
      emitRuntimeEvent: emitNext
    }
    rerender(next)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'canvas-1',
        projectName: 'Project One',
        movementDistancePx: 30
      })
    )
    vi.advanceTimersByTime(50)
    expect(emitNext).toHaveBeenCalledOnce()
    expect(emitNext).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'canvas-2',
        action: 'project_opened',
        canvasMutation: false
      })
    )
    emitNext.mockClear()
    rerender({ ...next, items: [createTextItem({ x: 1005 })] })
    vi.advanceTimersByTime(20)
    unmount()
    expect(emitNext).toHaveBeenCalledOnce()
    expect(emitNext).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'canvas-2', movementDistancePx: 5, createdItemCount: 0 })
    )
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  })

  it('keeps pending work through a same-snapshot rerender', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender, props } = renderTraceHook({ items: [createTextItem()] })
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [createTextItem({ x: 40 })] })
    vi.advanceTimersByTime(10)
    rerender({ ...props, items: [createTextItem({ x: 40 })], selectedIds: new Set<string>() })
    vi.advanceTimersByTime(10)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ movementDistancePx: 30 })
    )
  })

  it('records same-length text-only edits once without emitting the text, labels, ids or hashes', () => {
    vi.useFakeTimers()
    const before = 'private body a'
    const after = 'private body b'
    const item = createTextItem({ id: 'sensitive-item-name', text: before })
    const { emitRuntimeEvent, rerender, props } = renderTraceHook({ items: [item] })
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [{ ...item, text: after }] })
    vi.advanceTimersByTime(20)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'canvas_items_changed',
        affectedItemCount: 1,
        canvasMutation: true,
        safeSummary: expect.stringContaining('Edited text on 1 canvas item(s)')
      })
    )
    const emitted = JSON.stringify(emitRuntimeEvent.mock.calls)
    for (const secret of [before, after, item.id, 'committedText', 'textSignature']) {
      expect(emitted).not.toContain(secret)
    }
    rerender({ ...props, items: [{ ...item, text: after }] })
    vi.advanceTimersByTime(40)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  })

  it('text edits and selection changes together remain a mutation rather than a selection-only event', () => {
    vi.useFakeTimers()
    const item = createTextItem()
    const { emitRuntimeEvent, rerender, props } = renderTraceHook({ items: [item] })
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [{ ...item, text: 'Changed' }], selectedIds: new Set([item.id]) })
    vi.advanceTimersByTime(20)
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'canvas_items_changed',
        canvasMutation: true,
        safeSummary: expect.stringContaining('Edited text on 1 canvas item(s)')
      })
    )
  })

  it('keeps reverted text within the debounce window out of operation history', () => {
    vi.useFakeTimers()
    const item = createTextItem()
    const { emitRuntimeEvent, rerender, props } = renderTraceHook({ items: [item] })
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [{ ...item, text: 'Temporary' }] })
    vi.advanceTimersByTime(5)
    rerender({ ...props, items: [item] })
    vi.advanceTimersByTime(40)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
  })

  it('flushes a text edit to its original project and never attributes it to the next one', () => {
    vi.useFakeTimers()
    const item = createTextItem()
    const { emitRuntimeEvent, rerender, props } = renderTraceHook({ items: [item] })
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [{ ...item, text: 'Committed' }] })
    rerender({ ...props, canvasId: 'project-2', items: [item] })
    vi.advanceTimersByTime(40)
    const edits = emitRuntimeEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.scope === 'canvas')
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({ projectId: props.canvasId, action: 'canvas_items_changed' })
  })

  it('does not invent a first mutation for an empty baseline and records the first real addition', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender, props } = renderTraceHook()
    emitRuntimeEvent.mockClear()
    rerender({ ...props, items: [], selectedIds: new Set<string>() })
    vi.advanceTimersByTime(50)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    rerender({ ...props, items: [createTextItem()] })
    vi.advanceTimersByTime(20)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'canvas_items_added',
        createdItemCount: 1,
        canvasMutation: true
      })
    )
    expect(emitRuntimeEvent.mock.calls[0][0].movementDistancePx).toBeUndefined()
  })
})
