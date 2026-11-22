import { describe, expect, it } from 'vitest'
import {
  collectCanvasTargetRunWrittenIds,
  createCanvasTargetRunPendingWrites,
  mergeCanvasTargetRunChange,
  rebaseCanvasTargetRunView
} from './canvasTargetRunCanvasMerge'

type Entry = { id: string; x: number; z: number; ids?: string[]; note?: string }

const a: Entry = { id: 'a', x: 0, z: 1 }
const b: Entry = { id: 'b', x: 10, z: 2 }
const user: Entry = { id: 'user', x: 50, z: 3 }

describe('rebaseCanvasTargetRunView', () => {
  const rebase = (view: Entry[], live: Entry[] | undefined, removedByRun: string[] = [], keepFromView: string[] = []) =>
    rebaseCanvasTargetRunView(view, live, { removedByRun: new Set(removedByRun), keepFromView: new Set(keepFromView) })

  it('adds live entries the run view does not hold', () => {
    expect(rebase([a, b], [a, b, user])).toEqual([a, b, user])
  })

  it('keeps the view itself when the live list holds the same entries', () => {
    const view = [a, b]
    expect(rebase(view, [a, b])).toBe(view)
    expect(rebase(view, undefined)).toBe(view)
  })

  it('does not bring back an entry the run removed while the live list lags behind', () => {
    expect(rebase([b], [a, b], ['a'])).toEqual([b])
  })

  // The user keeps working while the run goes on: every entry the run knows
  // takes its live value, so the run's next action starts from it.
  it('takes the live value of an entry the user changed after the run saw it', () => {
    const movedByUser = { ...b, x: 500 }
    const rebased = rebase([a, b], [a, movedByUser])
    expect(rebased[1]).toBe(movedByUser)
  })

  it('drops an entry the user deleted during the run', () => {
    expect(rebase([a, b], [a])).toEqual([a])
  })

  it('keeps the run\'s value of a write the live list has not rendered yet', () => {
    const movedByRun = { ...b, x: 40 }
    const created: Entry = { id: 'created', x: 0, z: 9 }
    const rebased = rebase([a, movedByRun, created], [a, b, user], [], ['b', 'created'])
    expect(rebased).toEqual([a, movedByRun, user, created])
  })

  it('follows the live order', () => {
    expect(rebase([a, b], [b, a]).map((entry) => entry.id)).toEqual(['b', 'a'])
  })
})

describe('createCanvasTargetRunPendingWrites', () => {
  it('keeps a committed write pending until a render after React processed it', () => {
    let renders = 3
    const pending = createCanvasTargetRunPendingWrites(() => renders)
    const record = pending.addCommitted(['a'])
    expect(pending.unrendered()).toEqual(new Set(['a']))
    // The functional update ran (during render 3's successor, or eagerly).
    pending.stamp(record)
    expect(pending.unrendered()).toEqual(new Set(['a']))
    renders += 1
    expect(pending.unrendered()).toEqual(new Set())
  })

  it('never counts a write as rendered while its update has not run', () => {
    let renders = 0
    const pending = createCanvasTargetRunPendingWrites(() => renders)
    pending.addCommitted(['a'])
    renders += 10
    expect(pending.unrendered()).toEqual(new Set(['a']))
  })

  it('counts an item the canvas placed as rendered after the next render, unless a commit still holds it', () => {
    let renders = 1
    const pending = createCanvasTargetRunPendingWrites(() => renders)
    pending.addCommitted(['extracted'])
    pending.addPlaced(['extracted', 'placed'])
    expect(pending.unrendered()).toEqual(new Set(['extracted', 'placed']))
    renders += 1
    expect(pending.unrendered()).toEqual(new Set(['extracted']))
  })
})

describe('collectCanvasTargetRunWrittenIds', () => {
  it('lists created and changed entries only', () => {
    const created: Entry = { id: 'new', x: 0, z: 4 }
    expect(collectCanvasTargetRunWrittenIds([a, b, user], [a, { ...b }, { ...user, x: 1 }, created])).toEqual(['user', 'new'])
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
