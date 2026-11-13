import { useEffect, useId, useRef, useState } from 'react'
import { Box, Button, TextField, Typography } from '@mui/material'
import type { AgentRouteLike } from '@shared/agent'

/** In-page reminder only: no persistence, IPC, model call, or background wake. */
export default function AgentThreadLocalReminder({
  route,
  conversationId,
  active,
  allowCreate = true
}: {
  route?: AgentRouteLike
  conversationId?: string
  active: boolean
  allowCreate?: boolean
}) {
  const key =
    active &&
    route?.channel === 'canvas' &&
    route.scopeType === 'thread' &&
    route.scopeId &&
    route.threadId &&
    conversationId
      ? JSON.stringify([route.scopeId, route.threadId, conversationId])
      : ''
  if (!key || !route || !conversationId) return null
  return (
    <ReminderScope
      key={key}
      threadId={route.threadId!}
      conversationId={conversationId}
      allowCreate={allowCreate}
    />
  )
}

function ReminderScope({
  threadId,
  conversationId,
  allowCreate
}: {
  threadId: string
  conversationId: string
  allowCreate: boolean
}) {
  const toggleId = useId()
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [minutes, setMinutes] = useState('')
  const [reminder, setReminder] = useState<{ note: string; dueAt: number } | null>(null)
  const [due, setDue] = useState(false)
  const delay = Number(minutes)
  const valid =
    note.trim().length > 0 &&
    note.length <= 200 &&
    Number.isInteger(delay) &&
    delay >= 1 &&
    delay <= 1440
  useEffect(() => {
    if (!reminder) return
    const timer = setTimeout(() => setDue(true), Math.max(0, reminder.dueAt - Date.now()))
    return () => clearTimeout(timer)
  }, [reminder])
  const clearReminder = () => {
    setReminder(null)
    setDue(false)
    toggleRef.current?.focus()
  }
  return (
    <Box
      sx={{
        px: 1,
        flexShrink: 0,
        maxHeight: '30%',
        minWidth: 0,
        overflowY: 'auto',
        overflowWrap: 'anywhere'
      }}
    >
      <Button
        id={toggleId}
        ref={toggleRef}
        size="small"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        Local reminder
      </Button>
      {open && (
        <Box
          id={panelId}
          role="region"
          aria-labelledby={toggleId}
          sx={{ display: 'grid', gap: 1, width: '100%', boxSizing: 'border-box' }}
        >
          <Typography>
            Only while this conversation stays open and active. In-page only; no system notification
            or background wake. Switching panes or conversations, reloading, or closing the app
            cancels it. Delivery may be delayed. No model runs and this reminder has no provider
            fees.
          </Typography>
          <Typography>
            Target: thread {threadId}, conversation {conversationId}
          </Typography>
          <TextField
            disabled={Boolean(reminder) || !allowCreate}
            label="Reminder note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            inputProps={{ maxLength: 200 }}
            size="small"
          />
          <TextField
            disabled={Boolean(reminder) || !allowCreate}
            label="Minutes from now"
            type="number"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            inputProps={{ min: 1, max: 1440, step: 1 }}
            size="small"
          />
          <Typography>
            One reminder at a time. Cancel or dismiss it before creating another.
          </Typography>
          {!allowCreate && (
            <Typography>
              New reminders are unavailable while chat storage reports an error. Existing reminders
              remain in this page.
            </Typography>
          )}
          <Button
            disabled={!valid || Boolean(reminder) || !allowCreate}
            onClick={() => {
              if (allowCreate && !reminder && valid) {
                setReminder({ note: note.trim(), dueAt: Date.now() + delay * 60_000 })
                setDue(false)
              }
            }}
          >
            Confirm local reminder
          </Button>
          {reminder && (
            <Box>
              <Box role={due ? 'alert' : undefined}>
                {due ? (
                  <Typography>Reminder: {reminder.note}</Typography>
                ) : (
                  <Typography role="status">
                    Reminder scheduled: {reminder.note} ·{' '}
                    <time dateTime={new Date(reminder.dueAt).toISOString()}>
                      {new Date(reminder.dueAt).toLocaleString()}
                    </time>
                  </Typography>
                )}
              </Box>
              <Button onClick={clearReminder}>
                {due ? 'Dismiss and continue manually' : 'Cancel reminder'}
              </Button>
            </Box>
          )}
        </Box>
      )}
      {!open && reminder && due && (
        <Box role="alert">
          <Typography>Reminder: {reminder.note}</Typography>
          <Button onClick={clearReminder}>Dismiss and continue manually</Button>
        </Box>
      )}
    </Box>
  )
}
