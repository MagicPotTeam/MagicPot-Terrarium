import { act, renderHook } from '@testing-library/react'
import { useEffect, useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as canvasHistory from './canvasHistory'
import { useCanvasLayerRuntime } from './useCanvasLayerRuntime'
import { useProjectCanvasPageRuntimeState } from './useProjectCanvasPageRuntimeState'
import type { CanvasItem, CanvasTextItem } from './types'

// Real hook/private reducer, not an exported reducer or an eager fake setter. No persistence calls.
function text(id: string, value = id): CanvasTextItem {
  return {
    id, type: 'text', text: value, fontSize: 16, fontFamily: 'sans-serif', fill: '#fff',
    x: 0, y: 0, width: 100, height: 32, rotation: 0, scaleX: 1, scaleY: 1,
    zIndex: 0, locked: false
  }
}
function tracked(strict: boolean) {
  const lifetime: string[] = []
  const hook = renderHook(() => {
    const state = useProjectCanvasPageRuntimeState()
    // Both witnesses register AFTER the actual hook, before any fixture actions.
    useLayoutEffect(() => {
      lifetime.push('layout setup')
      return () => { lifetime.push('layout cleanup') }
    }, [])
    useEffect(() => {
      lifetime.push('passive setup')
      return () => { lifetime.push('passive cleanup') }
    }, [])
    return state
  }, { reactStrictMode: strict })
  expect(lifetime).toEqual(strict ? [
    'layout setup', 'passive setup', 'layout cleanup', 'passive cleanup',
    'layout setup', 'passive setup'
  ] : ['layout setup', 'passive setup'])
  return { ...hook, lifetime }
}
type Hook = ReturnType<typeof tracked>
type State = ReturnType<typeof useProjectCanvasPageRuntimeState>
function observed(state: State) {
  return {
    items: state.items,
    history: state.historySnapshots.map((entry) => ({ index: entry.index, items: entry.items })),
    count: state.historyCount,
    revision: state.historyRevision,
    selected: state.selectedHistoryRevision,
    ids: state.selectedIds,
    idsRef: state.selectedIdsRef.current
  }
}
function unchanged(state: State, before: ReturnType<typeof observed>) {
  expect(state.items).toBe(before.items)
  expect(state.historySnapshots).toEqual(before.history)
  expect(state.historyCount).toBe(before.count)
  expect(state.historyRevision).toBe(before.revision)
  expect(state.selectedHistoryRevision).toBe(before.selected)
  expect(state.selectedIds).toBe(before.ids)
  expect(state.selectedIdsRef.current).toBe(before.idsRef)
}
function seedRedo(hook: Hook) {
  const first = text('a', 'first'), second = text('a', 'second')
  act(() => {
    hook.result.current.setItemsWithHistory([first])
    hook.result.current.setItemsWithHistory([second])
  })
  act(() => { hook.result.current.handleUndo() })
  act(() => {
    hook.result.current.setSelectedHistoryRevision(0)
    hook.result.current.setSelectedIds(new Set(['keep']))
  })
  expect(hook.result.current.items).toEqual([first])
  expect(hook.result.current.historyCount).toBe(1)
  expect(hook.result.current.historyRevision).toBe(3)
  expect(hook.result.current.selectedHistoryRevision).toBe(0)
  return { first, second }
}
function proveRedo(hook: Hook, second: CanvasTextItem, previousRevision: number) {
  act(() => { hook.result.current.handleRedo() })
  expect(hook.result.current.items).toEqual([second])
  expect(hook.result.current.historyRevision).toBe(previousRevision + 1)
  expect(hook.result.current.historyCount).toBe(2)
  expect(hook.result.current.selectedHistoryRevision).toBeNull()
}
afterEach(() => { vi.restoreAllMocks() })

for (const strict of [false, true]) {
  describe(`real history identity (${strict ? 'root StrictMode replay' : 'ordinary root'})`, () => {
    for (const direct of [false, true]) {
      it(`${direct ? 'direct' : 'functional'} identity edit preserves the initial history state`, () => {
        const hook = tracked(strict), before = observed(hook.result.current)
        act(() => { hook.result.current.setItemsWithHistory(direct ? before.items : (prev) => prev) })
        unchanged(hook.result.current, before)
      })
      it(`${direct ? 'direct' : 'functional'} identity edit preserves selected history and executable redo`, () => {
        const hook = tracked(strict), { second } = seedRedo(hook)
        const before = observed(hook.result.current)
        act(() => { hook.result.current.setItemsWithHistory(direct ? before.items : (prev) => prev) })
        unchanged(hook.result.current, before)
        proveRedo(hook, second, before.revision)
      })
      it(`${direct ? 'direct' : 'functional'} identity edit does not call the actual snapshot helper`, () => {
        const snapshot = vi.spyOn(canvasHistory, 'createCanvasHistorySnapshot')
        const hook = tracked(strict)
        seedRedo(hook)
        expect(snapshot).toHaveBeenCalled() // positive activity before clearing only this counter
        snapshot.mockClear()
        const previous = hook.result.current.items
        act(() => { hook.result.current.setItemsWithHistory(direct ? previous : (prev) => prev) })
        expect(snapshot).not.toHaveBeenCalled()
      })
    }

    it('fresh equal-content array is still an edit and invalidates redo', () => {
      const hook = tracked(strict)
      seedRedo(hook)
      const before = observed(hook.result.current)
      act(() => { hook.result.current.setItemsWithHistory((prev) => [...prev]) })
      const committed = observed(hook.result.current)
      expect(committed.items).not.toBe(before.items)
      expect(committed.items).toEqual(before.items)
      expect(committed.count).toBe(before.count + 1)
      expect(committed.revision).toBe(before.revision + 1)
      expect(committed.selected).toBeNull()
      expect(committed.ids).toBe(before.ids)
      expect(committed.history).toEqual([
        { index: 1, items: before.items }, ...before.history
      ])
      act(() => { hook.result.current.handleRedo() })
      expect(hook.result.current.items).toBe(committed.items)
      expect(hook.result.current.historyRevision).toBe(committed.revision)
      expect(hook.result.current.historySnapshots).toEqual(committed.history)
    })

    for (const direct of [false, true]) {
      it(`${direct ? 'direct' : 'functional'} identity set still clears selected history but preserves redo`, () => {
        const hook = tracked(strict), { second } = seedRedo(hook)
        const before = observed(hook.result.current)
        act(() => { hook.result.current.setItems(direct ? before.items : (prev) => prev) })
        expect(hook.result.current.items).toBe(before.items)
        expect(hook.result.current.historySnapshots).toEqual(before.history)
        expect(hook.result.current.historyCount).toBe(before.count)
        expect(hook.result.current.historyRevision).toBe(before.revision)
        expect(hook.result.current.selectedHistoryRevision).toBeNull()
        expect(hook.result.current.selectedIds).toBe(before.ids)
        expect(hook.result.current.selectedIdsRef.current).toBe(before.idsRef)
        proveRedo(hook, second, before.revision)
      })
    }

    it('selection setter remains stable and accepts permissive direct and functional values', () => {
      const hook = tracked(strict), setter = hook.result.current.setSelectedHistoryRevision
      const before = observed(hook.result.current)
      act(() => { setter(-7); setter((prev) => (prev ?? 0) + 1000) })
      expect(hook.result.current.selectedHistoryRevision).toBe(993)
      expect(hook.result.current.setSelectedHistoryRevision).toBe(setter)
      act(() => { setter(null); setter((prev) => prev === null ? 1234 : -1) })
      expect(hook.result.current.selectedHistoryRevision).toBe(1234)
      expect(hook.result.current.items).toBe(before.items)
      expect(hook.result.current.historySnapshots).toEqual(before.history)
      expect(hook.result.current.historyRevision).toBe(before.revision)
      expect(hook.result.current.setSelectedHistoryRevision).toBe(setter)
    })

    it('selection setter retains NaN and signed-zero Object.is distinctions', () => {
      const hook = tracked(strict), setter = hook.result.current.setSelectedHistoryRevision
      act(() => { setter(Number.NaN) })
      expect(hook.result.current.selectedHistoryRevision).toBeNaN()
      act(() => { setter((prev) => Number.isNaN(prev) ? -0 : 9) })
      expect(Object.is(hook.result.current.selectedHistoryRevision, -0)).toBe(true)
      act(() => { setter(0) })
      expect(Object.is(hook.result.current.selectedHistoryRevision, 0)).toBe(true)
      act(() => { setter((prev) => Object.is(prev, 0) ? -0 : 9) })
      expect(Object.is(hook.result.current.selectedHistoryRevision, -0)).toBe(true)
      expect(hook.result.current.historyRevision).toBe(0)
      expect(hook.result.current.historyCount).toBe(0)
      expect(hook.result.current.setSelectedHistoryRevision).toBe(setter)
    })

    it('batched selection then identity edit then functional selection uses the preserved value', () => {
      const hook = tracked(strict), before = observed(hook.result.current)
      act(() => {
        hook.result.current.setSelectedHistoryRevision(7)
        hook.result.current.setItemsWithHistory((prev) => prev)
        hook.result.current.setSelectedHistoryRevision((prev) => (prev ?? 100) + 1)
      })
      expect(hook.result.current.selectedHistoryRevision).toBe(8)
      expect(hook.result.current.items).toBe(before.items)
      expect(hook.result.current.historyCount).toBe(before.count)
      expect(hook.result.current.historyRevision).toBe(before.revision)
    })

    it('batched fresh edit clears selection before the next functional selection update', () => {
      const hook = tracked(strict)
      act(() => {
        hook.result.current.setSelectedHistoryRevision(7)
        hook.result.current.setItemsWithHistory((prev) => [...prev])
        hook.result.current.setSelectedHistoryRevision((prev) => (prev ?? 100) + 1)
      })
      expect(hook.result.current.selectedHistoryRevision).toBe(101)
      expect(hook.result.current.historyCount).toBe(1)
      expect(hook.result.current.historyRevision).toBe(1)
    })

    it('batched identity set clears selection before the next functional selection update', () => {
      const hook = tracked(strict)
      act(() => {
        hook.result.current.setSelectedHistoryRevision(7)
        hook.result.current.setItems((prev) => prev)
        hook.result.current.setSelectedHistoryRevision((prev) => (prev ?? 100) + 1)
      })
      expect(hook.result.current.selectedHistoryRevision).toBe(101)
      expect(hook.result.current.historyCount).toBe(0)
      expect(hook.result.current.historyRevision).toBe(0)
    })

    for (const operation of ['handleUndo', 'handleRedo'] as const) {
      for (const available of [false, true]) {
        it(`batched selection then ${operation} (${available ? 'available' : 'empty'}) then functional selection observes the cleared node`, () => {
          const hook = tracked(strict), first = text('a', 'first'), second = text('a', 'second')
          if (available) {
            act(() => {
              hook.result.current.setItemsWithHistory([first])
              hook.result.current.setItemsWithHistory([second])
            })
            if (operation === 'handleRedo') act(() => { hook.result.current.handleUndo() })
          }
          act(() => { hook.result.current.setSelectedIds(new Set(['keep'])) })
          const before = observed(hook.result.current)
          const setter = hook.result.current.setSelectedHistoryRevision
          act(() => {
            setter(7)
            hook.result.current[operation]()
            setter((prev) => prev === null ? 41 : (prev ?? 0) + 1000)
          })
          expect(hook.result.current.selectedHistoryRevision).toBe(41)
          expect(hook.result.current.setSelectedHistoryRevision).toBe(setter)
          expect(hook.result.current.selectedIds.size).toBe(0)
          expect(hook.result.current.selectedIdsRef.current.size).toBe(0)
          if (available) {
            expect(hook.result.current.items).toEqual(operation === 'handleUndo' ? [first] : [second])
            expect(hook.result.current.historyRevision).toBe(before.revision + 1)
            expect(hook.result.current.historyCount).toBe(before.count + (operation === 'handleUndo' ? -1 : 1))
          } else {
            expect(hook.result.current.items).toBe(before.items)
            expect(hook.result.current.historySnapshots).toEqual(before.history)
            expect(hook.result.current.historyRevision).toBe(before.revision)
          }
        })
      }
    }

    it('batched successful restore selects its admitted node before the next functional selection update', () => {
      const hook = tracked(strict), first = text('a', 'first'), second = text('a', 'second')
      act(() => {
        hook.result.current.setItemsWithHistory([first])
        hook.result.current.setItemsWithHistory([second])
      })
      act(() => { hook.result.current.setSelectedIds(new Set(['keep'])) })
      const before = observed(hook.result.current)
      const restore = hook.result.current.restoreHistoryRevision
      act(() => {
        hook.result.current.setSelectedHistoryRevision(70)
        restore(1)
        hook.result.current.setSelectedHistoryRevision((prev) => prev === 1 ? 17 : -999)
      })
      expect(hook.result.current.selectedHistoryRevision).toBe(17)
      expect(hook.result.current.items).toEqual([first])
      expect(hook.result.current.historySnapshots).toEqual(before.history)
      expect(hook.result.current.historyRevision).toBe(before.revision + 1)
      expect(hook.result.current.selectedIds.size).toBe(0)
      expect(hook.result.current.selectedIdsRef.current.size).toBe(0)
      act(() => { hook.result.current.handleRedo() })
      expect(hook.result.current.items).toEqual([second])
      expect(hook.result.current.historyRevision).toBe(before.revision + 2)
    })

    it('queued edit then identity updater then edit records exactly the two real transitions', () => {
      const hook = tracked(strict), first = text('first'), second = text('second')
      act(() => {
        hook.result.current.setItemsWithHistory((prev) => [...prev, first])
        hook.result.current.setItemsWithHistory((prev) => prev)
        hook.result.current.setItemsWithHistory((prev) => [...prev, second])
      })
      expect(hook.result.current.items).toEqual([first, second])
      expect(hook.result.current.historyCount).toBe(2)
      expect(hook.result.current.historyRevision).toBe(2)
      expect(hook.result.current.historySnapshots.map((entry) => entry.items)).toEqual([[first], []])
    })

    it('queued selected no-op edit preserves the node until a later real edit clears it', () => {
      const hook = tracked(strict)
      const initial = hook.result.current.items
      act(() => {
        hook.result.current.setSelectedHistoryRevision(9)
        hook.result.current.setItemsWithHistory((prev) => prev)
      })
      expect(hook.result.current.selectedHistoryRevision).toBe(9)
      expect(hook.result.current.items).toBe(initial)
      expect(hook.result.current.historyRevision).toBe(0)
      act(() => { hook.result.current.setItemsWithHistory((prev) => [...prev]) })
      expect(hook.result.current.selectedHistoryRevision).toBeNull()
      expect(hook.result.current.historyRevision).toBe(1)
    })

    for (const operation of ['handleUndo', 'handleRedo'] as const) {
      it(`${operation} with an empty stack still clears history and item selection`, () => {
        const hook = tracked(strict)
        act(() => {
          hook.result.current.setSelectedHistoryRevision(88)
          hook.result.current.setSelectedIds(new Set(['keep']))
        })
        const before = observed(hook.result.current)
        act(() => { hook.result.current[operation]() })
        expect(hook.result.current.items).toBe(before.items)
        expect(hook.result.current.historySnapshots).toEqual(before.history)
        expect(hook.result.current.historyRevision).toBe(before.revision)
        expect(hook.result.current.selectedHistoryRevision).toBeNull()
        expect(hook.result.current.selectedIds.size).toBe(0)
        expect(hook.result.current.selectedIdsRef.current.size).toBe(0)
      })
    }

    it('wrapper-admitted restore still selects its index after queued undo removes reducer history', () => {
      const hook = tracked(strict)
      act(() => { hook.result.current.setItemsWithHistory([text('first')]) })
      act(() => { hook.result.current.setSelectedIds(new Set(['keep'])) })
      const saved = hook.result.current.restoreHistoryRevision
      act(() => { hook.result.current.handleUndo(); saved(0) })
      expect(hook.result.current.items).toEqual([])
      expect(hook.result.current.historyCount).toBe(0)
      expect(hook.result.current.historyRevision).toBe(2) // rejected restore adds no data revision
      expect(hook.result.current.selectedHistoryRevision).toBe(0)
      expect(hook.result.current.selectedIds.size).toBe(0)
      expect(hook.result.current.selectedIdsRef.current.size).toBe(0)
      act(() => { hook.result.current.handleRedo() })
      expect(hook.result.current.items).toEqual([text('first')])
      expect(hook.result.current.historyRevision).toBe(3)
    })

    it('captured-empty restore still refuses after a queued edit could create that history index', () => {
      const hook = tracked(strict), saved = hook.result.current.restoreHistoryRevision
      act(() => { hook.result.current.setSelectedIds(new Set(['keep'])) })
      const ids = hook.result.current.selectedIds, ref = hook.result.current.selectedIdsRef.current
      act(() => {
        hook.result.current.setItemsWithHistory([text('first')])
        hook.result.current.setSelectedHistoryRevision(77)
        saved(0)
      })
      expect(hook.result.current.items).toEqual([text('first')])
      expect(hook.result.current.historyCount).toBe(1)
      expect(hook.result.current.historyRevision).toBe(1)
      expect(hook.result.current.selectedHistoryRevision).toBe(77)
      expect(hook.result.current.selectedIds).toBe(ids)
      expect(hook.result.current.selectedIdsRef.current).toBe(ref)
    })

    it('invalid captured restore preserves data, selected history, selectedIds and redo', () => {
      const hook = tracked(strict), { second } = seedRedo(hook)
      const before = observed(hook.result.current)
      act(() => { hook.result.current.restoreHistoryRevision(999) })
      unchanged(hook.result.current, before)
      proveRedo(hook, second, before.revision)
    })

    it('identity edit after successful restore preserves selection and the restored redo branch', () => {
      const hook = tracked(strict), first = text('a', 'first'), second = text('a', 'second')
      act(() => { hook.result.current.setItemsWithHistory([first]); hook.result.current.setItemsWithHistory([second]) })
      act(() => { hook.result.current.restoreHistoryRevision(1) })
      expect(hook.result.current.items).toEqual([first])
      expect(hook.result.current.selectedHistoryRevision).toBe(1)
      const before = observed(hook.result.current)
      act(() => { hook.result.current.setItemsWithHistory((prev) => prev) })
      unchanged(hook.result.current, before)
      act(() => { hook.result.current.handleRedo() })
      expect(hook.result.current.items).toEqual([second])
      expect(hook.result.current.historyRevision).toBe(before.revision + 1)
    })

    it('identity edit at capacity never evicts snapshots or consumes a revision', () => {
      const hook = tracked(strict)
      act(() => {
        for (let i = 0; i < canvasHistory.CANVAS_HISTORY_LIMIT + 3; i++) {
          hook.result.current.setItemsWithHistory([text('a', `version-${i}`)])
        }
      })
      act(() => { hook.result.current.setSelectedHistoryRevision(12) })
      const before = observed(hook.result.current)
      expect(before.count).toBe(canvasHistory.CANVAS_HISTORY_LIMIT)
      act(() => {
        for (let i = 0; i < 3; i++) hook.result.current.setItemsWithHistory((prev) => prev)
      })
      unchanged(hook.result.current, before)
    })

    it('fresh equal edit at capacity still advances history and evicts only the oldest snapshot', () => {
      const hook = tracked(strict)
      act(() => {
        for (let i = 0; i < canvasHistory.CANVAS_HISTORY_LIMIT + 3; i++) {
          hook.result.current.setItemsWithHistory([text('a', `version-${i}`)])
        }
      })
      const before = observed(hook.result.current)
      act(() => { hook.result.current.setItemsWithHistory((prev) => [...prev]) })
      expect(hook.result.current.historyCount).toBe(canvasHistory.CANVAS_HISTORY_LIMIT)
      expect(hook.result.current.historyRevision).toBe(before.revision + 1)
      expect(hook.result.current.historySnapshots.map((entry) => entry.items)).toEqual([
        before.items, ...before.history.slice(0, -1).map((entry) => entry.items)
      ])
      expect(hook.result.current.items).not.toBe(before.items)
      expect(hook.result.current.items).toEqual(before.items)
    })

    it('a deferred guarded updater reads current input and preserves the complete rejected state', () => {
      const hook = tracked(strict), { second } = seedRedo(hook)
      let retired = false
      const updater = (prev: CanvasItem[]) => retired ? prev : [...prev, text('late')]
      const before = observed(hook.result.current)
      act(() => {
        hook.result.current.setItemsWithHistory(updater)
        hook.result.current.setItemsWithHistory(updater)
        retired = true // retire after enqueue, before React evaluates the queued reducer actions
      })
      unchanged(hook.result.current, before)
      proveRedo(hook, second, before.revision)
    })

    it('real missing-target layer drag is a history no-op while existing-target zero-distance drag remains an edit', () => {
      const hook = renderHook(() => {
        const state = useProjectCanvasPageRuntimeState()
        const layer = useCanvasLayerRuntime({
          canvasContainerRef: { current: null }, lastViewportPointRef: { current: null },
          selectedIds: state.selectedIds, setItems: state.setItems,
          setItemsWithHistory: state.setItemsWithHistory, setSelectedIds: state.setSelectedIds,
          tryHandleCanvasExternalDropRef: { current: () => false }
        })
        return { ...state, layer }
      }, { reactStrictMode: strict })
      act(() => { hook.result.current.setItemsWithHistory([text('a')]) })
      act(() => { hook.result.current.setSelectedHistoryRevision(0) })
      const before = observed(hook.result.current)
      act(() => { hook.result.current.layer.handleDragEnd('missing', 0, 0) })
      unchanged(hook.result.current, before)
      act(() => { hook.result.current.layer.handleDragEnd('a', 0, 0) })
      expect(hook.result.current.items).not.toBe(before.items)
      expect(hook.result.current.items).toEqual(before.items)
      expect(hook.result.current.historyRevision).toBe(before.revision + 1)
      expect(hook.result.current.selectedHistoryRevision).toBeNull()
    })
  })
}
