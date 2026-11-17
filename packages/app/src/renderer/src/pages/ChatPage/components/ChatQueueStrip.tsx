import React from 'react'
import { Box } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import { getAgentColumnTokens, type AgentColumnTokens } from '../../../components/agentColumnTokens'

/** Where a queued message stands: waiting, being prepared, paused, or held back (reload or Stop). */
export type ChatQueueStripStatus = 'queued' | 'preparing' | 'paused' | 'held'

export type ChatQueueStripItem = {
  id: number
  /** The message text; empty for a message of attachments only. */
  text: string
  attachmentCount: number
  status: ChatQueueStripStatus
  canEdit: boolean
  canRemove: boolean
  /** A paused item that the newer messages wait behind: the row says so in one line. */
  blocksNewer: boolean
}

/** Upstream's queue buttons: filled, square, about 24px tall. */
const buttonSx = (tokens: AgentColumnTokens, contrast: string) =>
  ({
    flexShrink: 0,
    boxSizing: 'border-box',
    m: 0,
    padding: '3.2px 6.4px',
    border: '1px solid transparent',
    borderRadius: 0,
    bgcolor: tokens.accent,
    color: contrast,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: tokens.fontSize.base,
    lineHeight: '16px',
    '&:hover:not(:disabled)': { filter: 'brightness(1.1)' },
    '&:focus-visible': { outline: `2px solid ${tokens.accent}`, outlineOffset: '1px' },
    '&:disabled': { opacity: 0.5, cursor: 'default' }
  }) as const

/**
 * The Agent column's queued messages, directly above the composer (upstream's QueuedMessages):
 * a live line with the count, then one row per message — the text, its attachments, the status
 * word, 编辑 and 取消 — the last three first, "再显示 N 条" for the rest. 编辑 turns the row into an
 * editor (保存 / 放弃编辑; Ctrl/Cmd+Enter saves, Escape discards).
 */
export const ChatQueueStrip: React.FC<{
  items: readonly ChatQueueStripItem[]
  /** Rows shown while the strip is collapsed (the rest wait behind "再显示 N 条"). */
  visibleIds: ReadonlySet<number>
  expanded: boolean
  onToggleExpanded: () => void
  /** The row being edited, and why its last save was refused (one line in the row). */
  editing: { id: number; text: string; error?: string } | null
  onEdit: (id: number) => void
  onEditChange: (text: string) => void
  onSave: () => void
  onDiscard: () => void
  onRemove: (id: number) => void
}> = ({
  items,
  visibleIds,
  expanded,
  onToggleExpanded,
  editing,
  onEdit,
  onEditChange,
  onSave,
  onDiscard,
  onRemove
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const contrast = theme.palette.getContrastText(tokens.accent)
  const resumeNoticeId = React.useId()
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null)
  const editingId = editing?.id
  React.useEffect(() => {
    if (editingId === undefined) return
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    editor.setSelectionRange(editor.value.length, editor.value.length)
  }, [editingId])
  // The row being edited stays in view when the strip is collapsed: its editor holds the item back.
  const shown = expanded
    ? items
    : items.filter((item) => visibleIds.has(item.id) || item.id === editingId)
  const hidden = items.length - shown.length
  // Something is left out while collapsed: the strip offers to show it (or to collapse again).
  const collapsible = items.some((item) => !visibleIds.has(item.id))
  const statusLabel: Record<ChatQueueStripStatus, string> = {
    queued: t('chat.queue_status_queued'),
    preparing: t('chat.queue_status_preparing'),
    paused: t('chat.queue_status_paused'),
    held: t('chat.queue_status_held')
  }
  const resumeNotice = t('chat.queue_resume_notice')
  return (
    <Box
      component="section"
      data-testid="chat-queue-panel"
      role="region"
      aria-label={t('chat.queue_region')}
      sx={{
        flexShrink: 0,
        minWidth: 0,
        maxHeight: '35vh',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '8px',
        borderTop: `1px solid ${tokens.attention}`,
        color: tokens.text,
        fontSize: tokens.fontSize.base,
        lineHeight: '18px'
      }}
    >
      <Box role="status" aria-live="polite" data-testid="chat-queue-count">
        {t('chat.queue_count', { count: items.length })}
      </Box>
      {shown.map((item) => {
        const isEditing = editing?.id === item.id
        const attachmentLabel =
          item.attachmentCount > 0
            ? t('chat.queue_attachment_count', { count: item.attachmentCount })
            : null
        return (
          <Box
            key={item.id}
            data-testid="chat-queue-item"
            data-status={item.status}
            data-editing={isEditing ? 'true' : undefined}
            sx={{
              mt: '4.8px',
              minWidth: 0,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '6.4px',
              padding: '6.4px',
              bgcolor: alpha(tokens.attention, theme.palette.mode === 'dark' ? 0.16 : 0.12)
            }}
          >
            {isEditing ? (
              <>
                <Box
                  component="textarea"
                  ref={editorRef}
                  data-testid="chat-queue-editor"
                  aria-label={t('chat.queue_edit_field')}
                  value={editing.text}
                  onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                    onEditChange(event.target.value)
                  }
                  onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      onDiscard()
                    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault()
                      if (editing.text.trim() || item.attachmentCount > 0) onSave()
                    }
                  }}
                  sx={{
                    flex: '1 1 100%',
                    boxSizing: 'border-box',
                    width: '100%',
                    minWidth: 0,
                    minHeight: '3rem',
                    m: 0,
                    padding: '4px 6px',
                    border: `1px solid ${tokens.border}`,
                    borderRadius: 0,
                    bgcolor: theme.palette.background.default,
                    color: tokens.text,
                    font: 'inherit',
                    fontSize: tokens.fontSize.base,
                    lineHeight: '18px',
                    resize: 'vertical',
                    outline: 'none',
                    '&:focus': { borderColor: tokens.accent }
                  }}
                />
                {editing.error ? (
                  <Box
                    component="span"
                    role="alert"
                    data-testid="chat-queue-edit-error"
                    title={editing.error}
                    sx={{
                      flexBasis: '100%',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: tokens.danger
                    }}
                  >
                    {editing.error}
                  </Box>
                ) : null}
                {attachmentLabel ? (
                  <Box component="span" sx={{ fontSize: '0.85em', color: tokens.muted }}>
                    {attachmentLabel}
                  </Box>
                ) : null}
                <Box
                  component="button"
                  type="button"
                  disabled={!editing.text.trim() && item.attachmentCount === 0}
                  onClick={onSave}
                  sx={buttonSx(tokens, contrast)}
                >
                  {t('chat.queue_save')}
                </Box>
                <Box
                  component="button"
                  type="button"
                  onClick={onDiscard}
                  sx={buttonSx(tokens, contrast)}
                >
                  {t('chat.queue_discard')}
                </Box>
              </>
            ) : (
              <>
                <Box
                  component="span"
                  data-testid="chat-queue-text"
                  sx={{
                    flex: '1 1 8rem',
                    minWidth: 0,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    color: item.text ? tokens.text : tokens.muted
                  }}
                >
                  {item.text || t('chat.queue_attachments')}
                </Box>
                {attachmentLabel ? (
                  <Box
                    component="span"
                    data-testid="chat-queue-attachments"
                    sx={{ flexShrink: 0, fontSize: '0.85em', color: tokens.muted }}
                  >
                    {attachmentLabel}
                  </Box>
                ) : null}
                <Box
                  component="span"
                  data-testid="chat-queue-status"
                  sx={{ flexShrink: 0, color: tokens.muted }}
                >
                  {statusLabel[item.status]}
                </Box>
                {item.canEdit ? (
                  <Box
                    component="button"
                    type="button"
                    aria-label={t('chat.queue_edit')}
                    aria-describedby={item.blocksNewer ? resumeNoticeId : undefined}
                    onClick={() => onEdit(item.id)}
                    sx={buttonSx(tokens, contrast)}
                  >
                    {t('chat.queue_edit_button')}
                  </Box>
                ) : null}
                <Box
                  component="button"
                  type="button"
                  aria-label={t('chat.queue_remove')}
                  aria-describedby={item.blocksNewer ? resumeNoticeId : undefined}
                  disabled={!item.canRemove}
                  onClick={() => onRemove(item.id)}
                  sx={buttonSx(tokens, contrast)}
                >
                  {t('chat.queue_remove_button')}
                </Box>
                {item.blocksNewer ? (
                  <Box
                    component="span"
                    id={resumeNoticeId}
                    data-testid="chat-queue-resume-notice"
                    title={resumeNotice}
                    sx={{
                      flexBasis: '100%',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: tokens.fontSize.small,
                      color: tokens.muted
                    }}
                  >
                    {resumeNotice}
                  </Box>
                ) : null}
              </>
            )}
          </Box>
        )
      })}
      {collapsible ? (
        <Box
          component="button"
          type="button"
          onClick={onToggleExpanded}
          sx={{ ...buttonSx(tokens, contrast), mt: '4.8px' }}
        >
          {expanded ? t('chat.queue_collapse') : t('chat.queue_show_more', { count: hidden })}
        </Box>
      ) : null}
    </Box>
  )
}

export default ChatQueueStrip
