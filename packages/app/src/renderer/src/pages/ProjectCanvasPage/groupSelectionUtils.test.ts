import { describe, expect, it } from 'vitest'
import {
  canCreateNewGroupFromSelection,
  getConflictingGroupIdsForSelection
} from './groupSelectionUtils'

describe('getConflictingGroupIdsForSelection', () => {
  it('returns the ids of groups that already contain selected items', () => {
    expect(
      getConflictingGroupIdsForSelection(
        [
          { id: 'group-a', itemIds: ['item-1', 'item-2'] },
          { id: 'group-b', itemIds: ['item-3'] }
        ],
        ['item-2', 'item-4']
      )
    ).toEqual(['group-a'])
  })

  it('returns an empty list when the selection does not overlap any group', () => {
    expect(
      getConflictingGroupIdsForSelection(
        [{ id: 'group-a', itemIds: ['item-1', 'item-2'] }],
        ['item-3', 'item-4']
      )
    ).toEqual([])
  })
})

describe('canCreateNewGroupFromSelection', () => {
  it('allows group creation only for multi-item selections with no overlap', () => {
    expect(
      canCreateNewGroupFromSelection([{ id: 'group-a', itemIds: ['item-1'] }], ['item-2', 'item-3'])
    ).toBe(true)
  })

  it('rejects overlapping selections and single-item selections', () => {
    expect(
      canCreateNewGroupFromSelection([{ id: 'group-a', itemIds: ['item-1'] }], ['item-1', 'item-2'])
    ).toBe(false)
    expect(canCreateNewGroupFromSelection([], ['item-1'])).toBe(false)
  })
})
