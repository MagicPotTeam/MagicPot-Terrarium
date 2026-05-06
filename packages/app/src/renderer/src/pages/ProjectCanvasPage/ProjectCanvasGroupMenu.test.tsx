import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { describe, expect, it, vi } from 'vitest'

import { theme } from '@renderer/theme'
import ProjectCanvasGroupMenu from './ProjectCanvasGroupMenu'
import type { CanvasGroupSummary } from './groupMenuUtils'
import type { CanvasImageItem } from './types'

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
    zIndex: 1,
    locked: false
  }
}

function createGroupSummary(): CanvasGroupSummary {
  return {
    id: 'group-1',
    name: '组合 Alpha',
    itemIds: ['image-1', 'image-2'],
    createdAt: '2026-04-20T00:00:00.000Z',
    validItems: [createImageItem('image-1'), createImageItem('image-2')],
    validCount: 2,
    totalCount: 2
  }
}

function t(key: string, options?: Record<string, unknown>): string {
  switch (key) {
    case 'canvas.group_create_button':
      return '组合'
    case 'canvas.group_create_empty':
      return '请先选中要组合的元素'
    case 'canvas.group_name_hint':
      return `留空时将自动命名为“${options?.defaultName as string}”`
    case 'canvas.group_empty':
      return '暂无组合'
    case 'canvas.group_empty_hint':
      return '先选中元素，再点击画布中的“组合”按钮创建'
    case 'canvas.group_name_placeholder':
      return '输入组合名（可选）'
    case 'canvas.group_create_cancel':
      return '退出'
    case 'canvas.group_item_count':
      return `${options?.valid as number} / ${options?.total as number} 个元素`
    case 'canvas.group_auto_arrange':
      return '整理'
    case 'canvas.group_delete':
      return '删除组合'
    default:
      return key
  }
}

function renderMenu(overrides: Partial<React.ComponentProps<typeof ProjectCanvasGroupMenu>> = {}) {
  const anchorEl = document.createElement('button')
  document.body.appendChild(anchorEl)

  const props: React.ComponentProps<typeof ProjectCanvasGroupMenu> = {
    anchorEl,
    canPlayGroupSummary: vi.fn(() => true),
    exactSelectedGroupId: null,
    groupRenameDraft: '',
    groupRenameId: null,
    groupRenameInputRef: { current: null },
    groupSummaries: [createGroupSummary()],
    isChineseUi: true,
    selectedIdsSize: 2,
    handleAutoArrangeGroup: vi.fn(),
    handleCancelGroupRename: vi.fn(),
    handleCloseGroupMenu: vi.fn(),
    handleCommitGroupRename: vi.fn(),
    handleCreateGroup: vi.fn(),
    handleDeleteGroup: vi.fn(),
    handleFocusGroup: vi.fn(),
    handleStartGroupRename: vi.fn(),
    setGroupRenameDraft: vi.fn(),
    startGroupPlayback: vi.fn(),
    t,
    ...overrides
  }

  return {
    ...render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasGroupMenu {...props} />
      </ThemeProvider>
    ),
    props
  }
}

describe('ProjectCanvasGroupMenu', () => {
  it('renders the group menu and focuses a group when its row is clicked', async () => {
    const { props } = renderMenu()

    await screen.findByRole('menu')
    fireEvent.click(screen.getByText('组合 Alpha'))

    expect(props.handleFocusGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'group-1',
        name: '组合 Alpha'
      })
    )
  })

  it('starts playback from the action button without also focusing the group', async () => {
    const { props } = renderMenu()

    await screen.findByRole('menu')
    fireEvent.click(screen.getByLabelText('播放 组合 Alpha'))

    expect(props.startGroupPlayback).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'group-1'
      })
    )
    expect(props.handleFocusGroup).not.toHaveBeenCalled()
  })
})
