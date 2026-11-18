import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider, alpha, createTheme } from '@mui/material/styles'
import ChatQueueStrip, { type ChatQueueStripItem } from './ChatQueueStrip'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count !== undefined ? `${key}:${options.count}` : key
  })
}))

const theme = createTheme({
  palette: { mode: 'dark', warning: { main: '#cca700' }, primary: { main: '#0e639c' } }
})
const item = (id: number, extra: Partial<ChatQueueStripItem> = {}): ChatQueueStripItem => ({
  id,
  text: `message ${id}`,
  attachments: [],
  status: 'queued',
  canEdit: true,
  canRemove: true,
  blocksNewer: false,
  ...extra
})

const renderStrip = (props: Partial<React.ComponentProps<typeof ChatQueueStrip>> = {}) => {
  const handlers = {
    onToggleExpanded: vi.fn(),
    onEdit: vi.fn(),
    onEditChange: vi.fn(),
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onRemove: vi.fn()
  }
  const items = props.items ?? [item(1), item(2)]
  render(
    <ThemeProvider theme={theme}>
      <ChatQueueStrip
        items={items}
        visibleIds={new Set(items.map((entry) => entry.id))}
        expanded={false}
        editing={null}
        {...handlers}
        {...props}
      />
    </ThemeProvider>
  )
  return handlers
}

describe('ChatQueueStrip', () => {
  it("is upstream's queue strip: a count line, then flat tinted rows with text, status word and two text buttons", () => {
    const handlers = renderStrip({
      items: [
        item(1, { attachments: [{ type: 'image', fileName: 'hero.png' }, { type: 'file' }] }),
        item(2, { text: '', attachments: [{ type: 'image' }], status: 'held' })
      ]
    })
    const panel = screen.getByRole('region', { name: 'chat.queue_region' })
    expect(panel).toHaveStyle({ maxHeight: '35vh', padding: '8px', borderTop: '1px solid #cca700' })
    expect(within(panel).getByRole('status')).toHaveTextContent('chat.queue_count:2')
    const rows = screen.getAllByTestId('chat-queue-item')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveStyle({ padding: '6.4px', backgroundColor: alpha('#cca700', 0.16) })
    expect(getComputedStyle(rows[0]).borderRadius).toMatch(/^(|0|0px)$/)
    expect(within(rows[0]).getByTestId('chat-queue-text')).toHaveTextContent('message 1')
    // One label per attachment, as upstream words it: the file name, or its kind.
    expect(
      within(rows[0])
        .getAllByTestId('chat-queue-attachment')
        .map((label) => label.textContent)
    ).toEqual(['hero.png', 'chat.queue_attachment_file'])
    expect(within(rows[1]).getByTestId('chat-queue-attachment')).toHaveTextContent(
      'chat.queue_attachment_image'
    )
    expect(within(rows[0]).getByTestId('chat-queue-status')).toHaveTextContent(
      'chat.queue_status_queued'
    )
    // A message of attachments only says so; a held item says it is held.
    expect(within(rows[1]).getByTestId('chat-queue-text')).toHaveTextContent(
      'chat.queue_attachments'
    )
    expect(within(rows[1]).getByTestId('chat-queue-status')).toHaveTextContent(
      'chat.queue_status_held'
    )
    // Text buttons, no icons, no explanatory paragraph.
    const edit = within(rows[0]).getByRole('button', { name: 'chat.queue_edit' })
    const remove = within(rows[0]).getByRole('button', { name: 'chat.queue_remove' })
    expect(edit).toHaveTextContent('chat.queue_edit_button')
    expect(remove).toHaveTextContent('chat.queue_remove_button')
    expect(edit).toHaveStyle({ backgroundColor: '#0e639c' })
    expect(panel.querySelector('svg')).toBeNull()
    expect(panel.querySelector('p')).toBeNull()
    fireEvent.click(edit)
    expect(handlers.onEdit).toHaveBeenCalledWith(1)
    fireEvent.click(remove)
    expect(handlers.onRemove).toHaveBeenCalledWith(1)
  })

  it('shows the status words and keeps an item that is being prepared from being edited or removed', () => {
    renderStrip({
      items: [
        item(1, { status: 'preparing', canEdit: false, canRemove: false }),
        item(2, { status: 'paused' })
      ]
    })
    const [preparing, paused] = screen.getAllByTestId('chat-queue-item')
    expect(within(preparing).getByTestId('chat-queue-status')).toHaveTextContent(
      'chat.queue_status_preparing'
    )
    // Upstream keeps both buttons and disables them.
    expect(within(preparing).getByRole('button', { name: 'chat.queue_edit' })).toBeDisabled()
    expect(within(preparing).getByRole('button', { name: 'chat.queue_remove' })).toBeDisabled()
    expect(within(paused).getByTestId('chat-queue-status')).toHaveTextContent(
      'chat.queue_status_paused'
    )
  })

  it('says in one line that the newer messages wait behind a paused head', () => {
    renderStrip({ items: [item(1, { status: 'paused', blocksNewer: true }), item(2)] })
    const [head, newer] = screen.getAllByTestId('chat-queue-item')
    const notice = within(head).getByTestId('chat-queue-resume-notice')
    expect(notice).toHaveTextContent('chat.queue_resume_notice')
    expect(notice).toHaveStyle({
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
      overflow: 'hidden'
    })
    expect(notice).toHaveAttribute('title', 'chat.queue_resume_notice')
    expect(
      within(head).getByRole('button', { name: 'chat.queue_edit' })
    ).toHaveAccessibleDescription('chat.queue_resume_notice')
    expect(within(newer).queryByTestId('chat-queue-resume-notice')).toBeNull()
  })

  it('shows the visible rows while collapsed and offers the rest', () => {
    const items = [1, 2, 3, 4, 5].map((id) => item(id))
    const handlers = renderStrip({ items, visibleIds: new Set([3, 4, 5]) })
    expect(screen.getAllByTestId('chat-queue-text').map((row) => row.textContent)).toEqual([
      'message 3',
      'message 4',
      'message 5'
    ])
    expect(screen.getByRole('status')).toHaveTextContent('chat.queue_count:5')
    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_show_more:2' }))
    expect(handlers.onToggleExpanded).toHaveBeenCalledOnce()
  })

  it('keeps the row being edited in view while collapsed', () => {
    const items = [1, 2, 3, 4, 5].map((id) => item(id))
    renderStrip({ items, visibleIds: new Set([3, 4, 5]), editing: { id: 1, text: 'draft' } })
    const rows = screen.getAllByTestId('chat-queue-item')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveAttribute('data-editing', 'true')
    expect(screen.getByRole('textbox', { name: 'chat.queue_edit_field' })).toHaveValue('draft')
    expect(screen.getByRole('button', { name: 'chat.queue_show_more:1' })).toBeInTheDocument()
  })

  it('offers nothing to show while the row being edited is the only one outside the collapsed rows', () => {
    const items = [1, 2, 3, 4].map((id) => item(id))
    renderStrip({ items, visibleIds: new Set([2, 3, 4]), editing: { id: 1, text: 'draft' } })
    expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(4)
    expect(screen.queryByRole('button', { name: /chat\.queue_show_more/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'chat.queue_collapse' })).toBeNull()
  })

  it('collapses again once expanded', () => {
    const items = [1, 2, 3, 4].map((id) => item(id))
    renderStrip({ items, visibleIds: new Set([2, 3, 4]), expanded: true })
    expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'chat.queue_collapse' })).toBeInTheDocument()
  })

  it('edits in the row: Ctrl/Cmd+Enter saves, Escape discards, Save needs text or an attachment', () => {
    const handlers = renderStrip({
      items: [item(1, { attachments: [{ type: 'image', fileName: 'hero.png' }] }), item(2)],
      editing: { id: 1, text: 'draft' }
    })
    const row = screen.getAllByTestId('chat-queue-item')[0]
    expect(row).toHaveAttribute('data-editing', 'true')
    const editor = within(row).getByRole('textbox', { name: 'chat.queue_edit_field' })
    expect(editor).toHaveValue('draft')
    expect(editor).toHaveFocus()
    // The editor is upstream's: the text field, Save and Discard; the attachment labels are not in it.
    expect(within(row).queryByTestId('chat-queue-attachment')).toBeNull()
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'chat.queue_save',
      'chat.queue_discard'
    ])
    fireEvent.change(editor, { target: { value: 'draft 2' } })
    expect(handlers.onEditChange).toHaveBeenCalledWith('draft 2')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(handlers.onSave).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
    expect(handlers.onSave).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(handlers.onDiscard).toHaveBeenCalledOnce()
    fireEvent.click(within(row).getByRole('button', { name: 'chat.queue_save' }))
    fireEvent.click(within(row).getByRole('button', { name: 'chat.queue_discard' }))
    expect(handlers.onSave).toHaveBeenCalledTimes(3)
    expect(handlers.onDiscard).toHaveBeenCalledTimes(2)
    // The other row keeps its own buttons.
    expect(
      within(screen.getAllByTestId('chat-queue-item')[1]).getByRole('button', {
        name: 'chat.queue_edit'
      })
    ).toBeInTheDocument()
  })

  it('does not save an empty edit of a text-only message', () => {
    const handlers = renderStrip({ items: [item(1)], editing: { id: 1, text: '   ' } })
    expect(screen.getByRole('button', { name: 'chat.queue_save' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'chat.queue_edit_field' }), {
      key: 'Enter',
      ctrlKey: true
    })
    expect(handlers.onSave).not.toHaveBeenCalled()
  })

  it('shows why a save was refused in one line of the row, and keeps the editor open', () => {
    renderStrip({ items: [item(1)], editing: { id: 1, text: '/status', error: 'not a message' } })
    const row = screen.getByTestId('chat-queue-item')
    const error = within(row).getByTestId('chat-queue-edit-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveTextContent('not a message')
    expect(error).toHaveStyle({ whiteSpace: 'nowrap' })
    expect(within(row).getByRole('textbox', { name: 'chat.queue_edit_field' })).toHaveValue('/status')
  })
})
