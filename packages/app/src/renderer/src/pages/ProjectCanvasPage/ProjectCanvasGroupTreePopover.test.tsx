import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material'
import { describe, expect, it, vi } from 'vitest'

import { theme } from '@renderer/theme'
import ProjectCanvasGroupTreePopover from './ProjectCanvasGroupTreePopover'

function createTranslate() {
  return (key: string, options?: Record<string, unknown>) => {
    switch (key) {
      case 'canvas.group_toolbar':
        return 'Groups'
      case 'canvas.group_empty':
        return 'No groups'
      case 'canvas.group_empty_hint':
        return 'Select elements first, then create a group.'
      case 'canvas.group_branch_create':
        return 'Branch'
      case 'canvas.group_branch_placeholder':
        return 'Branch name'
      case 'canvas.group_branch_ungrouped':
        return 'Ungrouped'
      case 'canvas.group_branch_delete':
        return 'Delete branch'
      case 'canvas.group_create_confirm':
        return 'Create'
      case 'canvas.group_branch_empty_hint':
        return 'Click a branch or group to focus it quickly.'
      case 'canvas.group_playback_start':
        return 'Play'
      case 'canvas.group_playback_pause':
        return 'Pause playback'
      case 'canvas.group_playback_resume':
        return 'Resume playback'
      case 'canvas.group_move_to_branch':
        return `Move to ${options?.name ?? ''}`.trim()
      case 'canvas.group_action_more':
        return 'More actions'
      case 'canvas.group_auto_arrange':
        return 'Arrange'
      case 'canvas.group_delete':
        return 'Delete group'
      case 'canvas.group_rename':
        return 'Rename'
      case 'canvas.group_item_count':
        return `${options?.valid ?? 0} / ${options?.total ?? 0} items`
      default:
        return key
    }
  }
}

describe('ProjectCanvasGroupTreePopover', () => {
  it('shows a clickable create button after the branch name input', async () => {
    const anchorEl = document.createElement('button')
    document.body.appendChild(anchorEl)

    const handleCreateGroupBranch = vi.fn(() => ({
      id: 'branch-1',
      name: '2D',
      createdAt: '2026-04-22T00:00:00.000Z'
    }))

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasGroupTreePopover
          anchorEl={anchorEl}
          open
          onClose={vi.fn()}
          t={createTranslate()}
          groupSummaries={[]}
          groupBranches={[]}
          exactSelectedGroup={null}
          groupPlayback={null}
          canPlayGroupSummary={() => false}
          startGroupPlayback={vi.fn()}
          pauseGroupPlayback={vi.fn()}
          resumeGroupPlayback={vi.fn()}
          handleAutoArrangeGroup={vi.fn()}
          handleDeleteGroup={vi.fn()}
          handleFocusGroup={vi.fn()}
          handleCreateGroupBranch={handleCreateGroupBranch}
          handleDeleteGroupBranch={vi.fn()}
          handleFocusGroupBranch={vi.fn()}
          handleMoveGroupToBranch={vi.fn()}
          handleRenameGroup={vi.fn()}
          handleRenameGroupBranch={vi.fn()}
        />
      </ThemeProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Branch' }))
    fireEvent.change(await screen.findByPlaceholderText('Branch name'), {
      target: { value: '2D' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(handleCreateGroupBranch).toHaveBeenCalledTimes(1)
    expect(handleCreateGroupBranch).toHaveBeenCalledWith('2D')

    anchorEl.remove()
  })

  it('renames branches from the inline rename action with the caret at the end', async () => {
    const anchorEl = document.createElement('button')
    document.body.appendChild(anchorEl)
    const user = userEvent.setup()

    const handleRenameGroupBranch = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasGroupTreePopover
          anchorEl={anchorEl}
          open
          onClose={vi.fn()}
          t={createTranslate()}
          groupSummaries={[]}
          groupBranches={[
            {
              id: 'branch-1',
              name: '123',
              createdAt: '2026-04-22T00:00:00.000Z'
            }
          ]}
          exactSelectedGroup={null}
          groupPlayback={null}
          canPlayGroupSummary={() => false}
          startGroupPlayback={vi.fn()}
          pauseGroupPlayback={vi.fn()}
          resumeGroupPlayback={vi.fn()}
          handleAutoArrangeGroup={vi.fn()}
          handleDeleteGroup={vi.fn()}
          handleFocusGroup={vi.fn()}
          handleCreateGroupBranch={vi.fn(() => ({
            id: 'branch-2',
            name: '2D',
            createdAt: '2026-04-22T00:00:00.000Z'
          }))}
          handleDeleteGroupBranch={vi.fn()}
          handleFocusGroupBranch={vi.fn()}
          handleMoveGroupToBranch={vi.fn()}
          handleRenameGroup={vi.fn()}
          handleRenameGroupBranch={handleRenameGroupBranch}
        />
      </ThemeProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Rename 123' }))

    const branchNameInput = screen.getByDisplayValue('123') as HTMLInputElement
    expect(branchNameInput).toHaveFocus()
    expect(branchNameInput.selectionStart).toBe(branchNameInput.value.length)
    expect(branchNameInput.selectionEnd).toBe(branchNameInput.value.length)
    await user.clear(branchNameInput)
    await user.type(branchNameInput, '456')
    fireEvent.keyDown(branchNameInput, { key: 'Enter' })

    expect(handleRenameGroupBranch).toHaveBeenCalledWith('branch-1', '456')

    anchorEl.remove()
  })

  it('commits branch rename on blur', async () => {
    const anchorEl = document.createElement('button')
    document.body.appendChild(anchorEl)

    const handleRenameGroupBranch = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasGroupTreePopover
          anchorEl={anchorEl}
          open
          onClose={vi.fn()}
          t={createTranslate()}
          groupSummaries={[]}
          groupBranches={[
            {
              id: 'branch-1',
              name: '123',
              createdAt: '2026-04-22T00:00:00.000Z'
            }
          ]}
          exactSelectedGroup={null}
          groupPlayback={null}
          canPlayGroupSummary={() => false}
          startGroupPlayback={vi.fn()}
          pauseGroupPlayback={vi.fn()}
          resumeGroupPlayback={vi.fn()}
          handleAutoArrangeGroup={vi.fn()}
          handleDeleteGroup={vi.fn()}
          handleFocusGroup={vi.fn()}
          handleCreateGroupBranch={vi.fn(() => ({
            id: 'branch-2',
            name: '2D',
            createdAt: '2026-04-22T00:00:00.000Z'
          }))}
          handleDeleteGroupBranch={vi.fn()}
          handleFocusGroupBranch={vi.fn()}
          handleMoveGroupToBranch={vi.fn()}
          handleRenameGroup={vi.fn()}
          handleRenameGroupBranch={handleRenameGroupBranch}
        />
      </ThemeProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Rename 123' }))

    const branchNameInput = screen.getByDisplayValue('123')
    fireEvent.change(branchNameInput, { target: { value: '456' } })
    fireEvent.blur(branchNameInput)

    expect(handleRenameGroupBranch).toHaveBeenCalledWith('branch-1', '456')

    anchorEl.remove()
  })

  it('renames groups from the inline rename action with the caret at the end', async () => {
    const anchorEl = document.createElement('button')
    document.body.appendChild(anchorEl)
    const user = userEvent.setup()

    const handleRenameGroup = vi.fn()
    const group = {
      id: 'group-1',
      name: 'Group 1',
      itemIds: ['item-1'],
      createdAt: '2026-04-22T00:00:00.000Z',
      validItems: [],
      validCount: 1,
      totalCount: 1,
      branchId: null
    }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasGroupTreePopover
          anchorEl={anchorEl}
          open
          onClose={vi.fn()}
          t={createTranslate()}
          groupSummaries={[group]}
          groupBranches={[]}
          exactSelectedGroup={null}
          groupPlayback={null}
          canPlayGroupSummary={() => true}
          startGroupPlayback={vi.fn()}
          pauseGroupPlayback={vi.fn()}
          resumeGroupPlayback={vi.fn()}
          handleAutoArrangeGroup={vi.fn()}
          handleDeleteGroup={vi.fn()}
          handleFocusGroup={vi.fn()}
          handleCreateGroupBranch={vi.fn(() => ({
            id: 'branch-1',
            name: '2D',
            createdAt: '2026-04-22T00:00:00.000Z'
          }))}
          handleDeleteGroupBranch={vi.fn()}
          handleFocusGroupBranch={vi.fn()}
          handleMoveGroupToBranch={vi.fn()}
          handleRenameGroup={handleRenameGroup}
          handleRenameGroupBranch={vi.fn()}
        />
      </ThemeProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Rename Group 1' }))

    const groupNameInput = screen.getByDisplayValue('Group 1') as HTMLInputElement
    expect(groupNameInput).toHaveFocus()
    expect(groupNameInput.selectionStart).toBe(groupNameInput.value.length)
    expect(groupNameInput.selectionEnd).toBe(groupNameInput.value.length)
    await user.clear(groupNameInput)
    await user.type(groupNameInput, 'Group 9')
    fireEvent.keyDown(groupNameInput, { key: 'Enter' })

    expect(handleRenameGroup).toHaveBeenCalledWith('group-1', 'Group 9')

    anchorEl.remove()
  })

  it('commits group rename on blur', async () => {
    const anchorEl = document.createElement('button')
    document.body.appendChild(anchorEl)

    const handleRenameGroup = vi.fn()
    const group = {
      id: 'group-1',
      name: 'Group 1',
      itemIds: ['item-1'],
      createdAt: '2026-04-22T00:00:00.000Z',
      validItems: [],
      validCount: 1,
      totalCount: 1,
      branchId: null
    }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasGroupTreePopover
          anchorEl={anchorEl}
          open
          onClose={vi.fn()}
          t={createTranslate()}
          groupSummaries={[group]}
          groupBranches={[]}
          exactSelectedGroup={null}
          groupPlayback={null}
          canPlayGroupSummary={() => true}
          startGroupPlayback={vi.fn()}
          pauseGroupPlayback={vi.fn()}
          resumeGroupPlayback={vi.fn()}
          handleAutoArrangeGroup={vi.fn()}
          handleDeleteGroup={vi.fn()}
          handleFocusGroup={vi.fn()}
          handleCreateGroupBranch={vi.fn(() => ({
            id: 'branch-1',
            name: '2D',
            createdAt: '2026-04-22T00:00:00.000Z'
          }))}
          handleDeleteGroupBranch={vi.fn()}
          handleFocusGroupBranch={vi.fn()}
          handleMoveGroupToBranch={vi.fn()}
          handleRenameGroup={handleRenameGroup}
          handleRenameGroupBranch={vi.fn()}
        />
      </ThemeProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Rename Group 1' }))

    const groupNameInput = screen.getByDisplayValue('Group 1')
    fireEvent.change(groupNameInput, { target: { value: 'Group 9' } })
    fireEvent.blur(groupNameInput)

    expect(handleRenameGroup).toHaveBeenCalledWith('group-1', 'Group 9')

    anchorEl.remove()
  })

  it('keeps auto arrange outside and moves playback into more actions', async () => {
    const anchorEl = document.createElement('button')
    document.body.appendChild(anchorEl)

    const group = {
      id: 'group-1',
      name: 'Group 1',
      itemIds: ['item-1'],
      createdAt: '2026-04-22T00:00:00.000Z',
      validItems: [],
      validCount: 1,
      totalCount: 1,
      branchId: null
    }
    const handleAutoArrangeGroup = vi.fn()
    const startGroupPlayback = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasGroupTreePopover
          anchorEl={anchorEl}
          open
          onClose={vi.fn()}
          t={createTranslate()}
          groupSummaries={[group]}
          groupBranches={[]}
          exactSelectedGroup={null}
          groupPlayback={null}
          canPlayGroupSummary={() => true}
          startGroupPlayback={startGroupPlayback}
          pauseGroupPlayback={vi.fn()}
          resumeGroupPlayback={vi.fn()}
          handleAutoArrangeGroup={handleAutoArrangeGroup}
          handleDeleteGroup={vi.fn()}
          handleFocusGroup={vi.fn()}
          handleCreateGroupBranch={vi.fn(() => ({
            id: 'branch-1',
            name: '2D',
            createdAt: '2026-04-22T00:00:00.000Z'
          }))}
          handleDeleteGroupBranch={vi.fn()}
          handleFocusGroupBranch={vi.fn()}
          handleMoveGroupToBranch={vi.fn()}
          handleRenameGroup={vi.fn()}
          handleRenameGroupBranch={vi.fn()}
        />
      </ThemeProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Arrange' }))
    expect(handleAutoArrangeGroup).toHaveBeenCalledWith(group)

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))

    expect(screen.queryByRole('menuitem', { name: 'Arrange' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument()

    const playMenuItem = await screen.findByRole('menuitem', { name: 'Play' })
    expect(playMenuItem.querySelector('svg')).toBeNull()

    fireEvent.click(playMenuItem)
    expect(startGroupPlayback).toHaveBeenCalledWith(group)

    anchorEl.remove()
  })

  it('lets users delete the ungrouped branch section', async () => {
    const anchorEl = document.createElement('button')
    document.body.appendChild(anchorEl)

    const handleDeleteGroupBranch = vi.fn()
    const group = {
      id: 'group-1',
      name: 'Group 1',
      itemIds: ['item-1'],
      createdAt: '2026-04-22T00:00:00.000Z',
      validItems: [],
      validCount: 1,
      totalCount: 1,
      branchId: null
    }

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasGroupTreePopover
          anchorEl={anchorEl}
          open
          onClose={vi.fn()}
          t={createTranslate()}
          groupSummaries={[group]}
          groupBranches={[]}
          exactSelectedGroup={null}
          groupPlayback={null}
          canPlayGroupSummary={() => false}
          startGroupPlayback={vi.fn()}
          pauseGroupPlayback={vi.fn()}
          resumeGroupPlayback={vi.fn()}
          handleAutoArrangeGroup={vi.fn()}
          handleDeleteGroup={vi.fn()}
          handleFocusGroup={vi.fn()}
          handleCreateGroupBranch={vi.fn(() => ({
            id: 'branch-1',
            name: '2D',
            createdAt: '2026-04-22T00:00:00.000Z'
          }))}
          handleDeleteGroupBranch={handleDeleteGroupBranch}
          handleFocusGroupBranch={vi.fn()}
          handleMoveGroupToBranch={vi.fn()}
          handleRenameGroup={vi.fn()}
          handleRenameGroupBranch={vi.fn()}
        />
      </ThemeProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Delete branch' }))

    expect(handleDeleteGroupBranch).toHaveBeenCalledTimes(1)
    expect(handleDeleteGroupBranch).toHaveBeenCalledWith(null)

    anchorEl.remove()
  })
})
