import { describe, expect, it } from 'vitest'
import { mergeCanvasTargetRunChange, withLiveOnlyCanvasEntries } from './canvasTargetRunCanvasMerge'

type Entry = { id: string; x: number; z: number; ids?: string[]; note?: string }

const a: Entry = { id: 'a', x: 0, z: 1 }
const b: Entry = { id: 'b', x: 10, z: 2 }
const user: Entry = { id: 'user', x: 50, z: 3 }

describe('withLiveOnlyCanvasEntries', () => {
  it('adds live entries the run view does not hold', () => {
    expect(withLiveOnlyCanvasEntries([a, b], [a, b, user], new Set())).toEqual([a, b, user])
  })

  it('keeps the view when the live list holds nothing new', () => {
    const view = [a, b]
    expect(withLiveOnlyCanvasEntries(view, [a], new Set())).toBe(view)
    expect(withLiveOnlyCanvasEntries(view, undefined, new Set())).toBe(view)
  })

  it('does not bring back an entry the run removed while the live list lags behind', () => {
    expect(withLiveOnlyCanvasEntries([b], [a, b], new Set(['a']))).toEqual([b])
  })
})

describe('mergeCanvasTargetRunChange', () => {
  it('returns the live list itself when the action changed nothing', () => {
    const live = [a, b, user]
    expect(mergeCanvasTargetRunChange(live, [a, b], [a, b])).toBe(live)
    const view = [a, b]
    expect(mergeCanvasTargetRunChange(live, view, view)).toBe(live)
  })

  it('removes what the action removed and keeps entries it never saw', () => {
    expect(mergeCanvasTargetRunChange([a, b, user], [a, b], [b])).toEqual([b, user])
  })

  it('clears only what the action saw', () => {
    expect(mergeCanvasTargetRunChange([a, b, user], [a, b], [])).toEqual([user])
  })

  it('appends what the action created', () => {
    const created: Entry = { id: 'new', x: 1, z: 4 }
    const merged = mergeCanvasTargetRunChange([a, b, user], [a, b], [a, b, created])
    expect(merged).toEqual([a, b, user, created])
    expect(merged[2]).toBe(user)
  })

  it('writes only the changed fields onto an entry the user also changed', () => {
    const movedByUser = { ...b, x: 900 }
    const renumbered = { ...b, z: 1 }
    const merged = mergeCanvasTargetRunChange(
      [a, movedByUser],
      [a, b],
      [{ ...a, z: 2 }, renumbered]
    )
    expect(merged).toEqual([
      { ...a, z: 2 },
      { ...b, x: 900, z: 1 }
    ])
  })

  it('uses the action result as is when the live entry is the one the action saw', () => {
    const moved = { ...a, x: 40 }
    expect(mergeCanvasTargetRunChange([a, user], [a], [moved])[0]).toBe(moved)
  })

  it('treats a copied array with the same members as unchanged', () => {
    const grouped: Entry = { id: 'g', x: 0, z: 0, ids: ['a', 'b'] }
    const userEdited = { ...grouped, note: 'user' }
    const merged = mergeCanvasTargetRunChange(
      [userEdited],
      [grouped],
      [{ ...grouped, ids: ['a', 'b'] }]
    )
    expect(merged[0]).toBe(userEdited)
  })

  it('removes a field the action removed', () => {
    const noted: Entry = { ...a, note: 'old' }
    const merged = mergeCanvasTargetRunChange([{ ...noted, x: 7 }], [noted], [a])
    expect(merged).toEqual([{ ...a, x: 7 }])
  })

  it('does not bring back an entry the user deleted that the action changed', () => {
    expect(mergeCanvasTargetRunChange([a], [a, b], [a, { ...b, x: 99 }])).toEqual([a])
  })
})
