import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentColumnToastSink } from '@renderer/hooks/agentColumnToastContext'
import AgentColumnToastItem, { type Toast } from './AgentColumnToastItem'

/** Upstream's numbers: 4 s by default, a given duration capped at 60 s, at most 5 toasts. */
const AGENT_COLUMN_TOAST_DEFAULT_MS = 4000
const MAX_DURATION_MS = 60000
const MAX_TOASTS = 5

/**
 * The Agent column's toasts: a stack at the top of the column, 8px in from its edges. Each
 * toast reads "<severity word>：<message>" with a × button and a 3px stripe in the severity
 * colour; it goes after 4 s (hovering or focusing pauses it), and at most five are shown.
 * Returns the sink that useMessage() reaches through AgentColumnToastContext and the stack.
 */
export function useAgentColumnToasts(rootRef: React.RefObject<HTMLElement | null>) {
  const { t } = useTranslation()
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const nextKeyRef = useRef(0)

  const dismiss = useCallback((key?: string) => {
    setToasts((previous) =>
      key === undefined ? [] : previous.filter((toast) => toast.key !== key)
    )
  }, [])

  const sink = useMemo<AgentColumnToastSink>(
    () => ({
      push: (severity, message, duration) => {
        const root = rootRef.current
        // A column that is not shown cannot show its toasts: the app-wide snackbar does.
        if (!root?.isConnected) return null
        if (typeof root.checkVisibility === 'function' && !root.checkVisibility()) return null
        // A modal dialog over the app (session history, previews) would cover the column's
        // stack: the snackbar shows above it.
        const dialogs = Array.from(document.querySelectorAll('.MuiDialog-root'))
        if (dialogs.some((dialog) => !root.contains(dialog))) return null
        const duplicate = toastsRef.current.find(
          (toast) => toast.severity === severity && toast.message === message
        )
        if (duplicate) return duplicate.key
        nextKeyRef.current += 1
        const toast: Toast = {
          key: `agent-column-toast-${nextKeyRef.current}`,
          severity,
          message,
          duration:
            duration === null
              ? null
              : Math.min(
                  duration === undefined || duration <= 0
                    ? AGENT_COLUMN_TOAST_DEFAULT_MS
                    : duration,
                  MAX_DURATION_MS
                )
        }
        const next = [...toastsRef.current, toast].slice(-MAX_TOASTS)
        toastsRef.current = next
        setToasts(next)
        return toast.key
      },
      dismiss
    }),
    [dismiss, rootRef]
  )

  const stack = (
    <Box
      component="section"
      aria-label={t('agent_workspace.toast.region')}
      data-testid="agent-column-toasts"
      sx={{
        position: 'absolute',
        top: 8,
        left: 8,
        right: 8,
        zIndex: 20,
        display: 'grid',
        gap: '8px',
        maxHeight: '50%',
        overflowY: 'auto',
        pointerEvents: 'none'
      }}
    >
      {toasts.map((toast) => (
        <AgentColumnToastItem key={toast.key} toast={toast} onDismiss={dismiss} />
      ))}
    </Box>
  )

  return { sink, stack }
}
