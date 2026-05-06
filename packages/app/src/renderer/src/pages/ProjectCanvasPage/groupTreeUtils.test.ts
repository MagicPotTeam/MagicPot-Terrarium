import { describe, expect, it } from 'vitest'

import type { CanvasGroup, CanvasGroupBranch, CanvasItem } from './types'
import {
  applyCanvasGroupBranchDeletion,
  buildCanvasGroupBranchSections,
  moveCanvasGroupToBranch,
  realignCanvasGroupsIntoBranchRow
} from './groupTreeUtils'

const createItem = (id: string, x: number, y: number, width: number, height: number): CanvasItem =>
  ({
    id,
    type: 'image',
    src: `${id}.png`,
    x,
    y,
    width,
    height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }) as CanvasItem

const createGroup = (
  id: string,
  itemIds: string[],
  branchId: string | null = null,
  name: string = id
): CanvasGroup => ({
  id,
  name,
  itemIds,
  branchId,
  createdAt: '2026-04-21T00:00:00.000Z'
})

const createBranch = (id: string, name: string): CanvasGroupBranch => ({
  id,
  name,
  createdAt: '2026-04-21T00:00:00.000Z'
})

describe('groupTreeUtils', () => {
  it('builds sections for branches and ungrouped groups', () => {
    const branches = [createBranch('branch-2d', '2D')]
    const groupSummaries = [
      {
        ...createGroup('group-a', ['item-a'], 'branch-2d', '角色立绘'),
        validItems: [createItem('item-a', 0, 0, 100, 100)],
        validCount: 1,
        totalCount: 1
      },
      {
        ...createGroup('group-b', ['item-b'], null, '临时组合'),
        validItems: [createItem('item-b', 0, 0, 100, 100)],
        validCount: 1,
        totalCount: 1
      }
    ]

    const sections = buildCanvasGroupBranchSections(branches, groupSummaries, '未归类')

    expect(sections).toEqual([
      expect.objectContaining({
        id: 'branch-2d',
        name: '2D',
        isUngrouped: false,
        groups: [expect.objectContaining({ id: 'group-a' })]
      }),
      expect.objectContaining({
        id: '__ungrouped__',
        name: '未归类',
        isUngrouped: true,
        groups: [expect.objectContaining({ id: 'group-b' })]
      })
    ])
  })

  it('moves a group into a branch right after that branch first group', () => {
    const branches = [createBranch('branch-2d', '2D'), createBranch('branch-3d', '3D')]
    const groups = [
      createGroup('group-1', ['item-1'], 'branch-2d'),
      createGroup('group-2', ['item-2'], 'branch-2d'),
      createGroup('group-3', ['item-3'], null)
    ]

    const result = moveCanvasGroupToBranch({
      groups,
      groupBranches: branches,
      groupId: 'group-3',
      targetBranchId: 'branch-2d'
    })

    expect(result.nextGroups.map((group) => group.id)).toEqual(['group-1', 'group-3', 'group-2'])
    expect(result.targetBranchGroupIds).toEqual(['group-1', 'group-3', 'group-2'])
  })

  it('removes ungrouped groups when deleting the ungrouped branch section', () => {
    const branches = [createBranch('branch-2d', '2D')]
    const groups = [
      createGroup('group-1', ['item-1'], 'branch-2d'),
      createGroup('group-2', ['item-2'], null),
      createGroup('group-3', ['item-3'])
    ]

    const result = applyCanvasGroupBranchDeletion({
      groups,
      groupBranches: branches,
      branchId: null
    })

    expect(result.nextGroupBranches).toEqual(branches)
    expect(result.nextGroups).toEqual([expect.objectContaining({ id: 'group-1' })])
  })

  it('moves branch groups back to ungrouped when deleting a named branch', () => {
    const branches = [createBranch('branch-2d', '2D'), createBranch('branch-3d', '3D')]
    const groups = [
      createGroup('group-1', ['item-1'], 'branch-2d'),
      createGroup('group-2', ['item-2'], 'branch-3d')
    ]

    const result = applyCanvasGroupBranchDeletion({
      groups,
      groupBranches: branches,
      branchId: 'branch-2d'
    })

    expect(result.nextGroupBranches).toEqual([expect.objectContaining({ id: 'branch-3d' })])
    expect(result.nextGroups).toEqual([
      expect.objectContaining({ id: 'group-1', branchId: null }),
      expect.objectContaining({ id: 'group-2', branchId: 'branch-3d' })
    ])
  })

  it('realigns moved branch groups into a single row beside the first group', () => {
    const groups = [
      createGroup('group-1', ['item-1'], 'branch-2d'),
      createGroup('group-3', ['item-3'], 'branch-2d'),
      createGroup('group-2', ['item-2'], 'branch-2d')
    ]
    const items = [
      createItem('item-1', 0, 20, 100, 100),
      createItem('item-3', 320, 260, 120, 80),
      createItem('item-2', 520, 360, 90, 90)
    ]

    const nextItems = realignCanvasGroupsIntoBranchRow({
      items,
      groups,
      groupIds: ['group-1', 'group-3', 'group-2'],
      gap: 40
    })

    expect(nextItems.find((item) => item.id === 'item-1')).toMatchObject({ x: 0, y: 20 })
    expect(nextItems.find((item) => item.id === 'item-3')).toMatchObject({ x: 140, y: 20 })
    expect(nextItems.find((item) => item.id === 'item-2')).toMatchObject({ x: 300, y: 20 })
  })
})
