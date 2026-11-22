import React, { useCallback, useContext, useMemo } from 'react'
import { SnackbarProvider, useSnackbar } from 'notistack'
import { GlobalStyles, IconButton } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { AgentColumnToastContext } from './agentColumnToastContext'

export type MessageProviderProps = {
  anchorOrigin?: {
    vertical: 'top' | 'bottom'
    horizontal: 'left' | 'center' | 'right'
  }
  autoHideDuration?: number
  children: React.ReactNode
}

export const MessageProvider: React.FC<MessageProviderProps> = ({
  children,
  anchorOrigin = { vertical: 'top', horizontal: 'right' },
  autoHideDuration = 3000
}) => {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(GlobalStyles, {
      styles: {
        '.snackbar-top-right-offset': {
          top: '96px !important'
        }
      }
    }),
    React.createElement(
      SnackbarProvider,
      {
        anchorOrigin,
        autoHideDuration,
        classes: { containerAnchorOriginTopRight: 'snackbar-top-right-offset' },
        dense: true,
        preventDuplicate: true
      },
      children
    )
  )
}

type UseMessageReturn = {
  notifySuccess: (message: string, duration?: number | null) => import('notistack').SnackbarKey
  notifyError: (message: string, duration?: number | null) => import('notistack').SnackbarKey
  notifyInfo: (message: string, duration?: number | null) => import('notistack').SnackbarKey
  notifyWarning: (message: string, duration?: number | null) => import('notistack').SnackbarKey
  closeMessage: (key?: import('notistack').SnackbarKey) => void
}

const SUPPRESSED_SUCCESS_SNACKBAR_KEY = 'suppressed-success-snackbar'
const SUPPRESSED_TRANSIENT_ERROR_SNACKBAR_KEY = 'suppressed-transient-error-snackbar'

// Transient capacity errors are already surfaced by the chat loading status
// while the model retry loop is active. Do not show a second red toast for the
// same provider condition (including the exact OpenAI wording).
const isTransientCapacityError = (message: string): boolean =>
  /(?:our )?servers?\s+(?:are|is)\s+(?:currently\s+)?overloaded|server[_ -]overloaded|(?:selected )?model\s+is\s+(?:currently\s+)?at\s+capacity/i.test(
    message
  )

function calculateDuration(message: string): number {
  const baseTime = 3000
  const extraTime = Math.floor(message.length / 15) * 1000
  return Math.min(baseTime + extraTime, 10000)
}

function calculateErrorDuration(message: string): number {
  const baseTime = 5000
  const extraTime = Math.floor(message.length / 20) * 1000
  return Math.min(baseTime + extraTime, 8000)
}

export function useMessage(): UseMessageReturn {
  const { enqueueSnackbar, closeSnackbar } = useSnackbar()
  // Inside the Agent column its own toast stack shows the messages (while the column is shown).
  const columnToasts = useContext(AgentColumnToastContext)

  const createCloseButton = useCallback(
    (snackbarId: string | number) => {
      return React.createElement(
        IconButton,
        {
          size: 'small' as const,
          'aria-label': 'close',
          color: 'inherit' as const,
          onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation()
            closeSnackbar(snackbarId)
          },
          sx: { color: 'inherit' }
        },
        React.createElement(CloseIcon, { fontSize: 'small' })
      )
    },
    [closeSnackbar]
  )

  const notifySuccess = useCallback(() => {
    // Success snackbars are intentionally suppressed; they obscure canvas work.
    return SUPPRESSED_SUCCESS_SNACKBAR_KEY
  }, [])

  const notifyError = useCallback(
    (message: string, duration?: number | null) => {
      console.error('[Error]', message)
      if (isTransientCapacityError(message)) {
        return SUPPRESSED_TRANSIENT_ERROR_SNACKBAR_KEY
      }
      const columnKey = columnToasts?.push('error', message, duration)
      if (columnKey) return columnKey
      return enqueueSnackbar(message, {
        variant: 'error',
        autoHideDuration: duration === undefined ? calculateErrorDuration(message) : duration,
        persist: duration === null,
        preventDuplicate: true,
        action: createCloseButton
      })
    },
    [enqueueSnackbar, createCloseButton, columnToasts]
  )

  const notifyInfo = useCallback(
    (message: string, duration?: number | null) => {
      const columnKey = columnToasts?.push('info', message, duration)
      if (columnKey) return columnKey
      return enqueueSnackbar(message, {
        variant: 'info',
        autoHideDuration: duration === undefined ? calculateDuration(message) : duration,
        persist: duration === null,
        preventDuplicate: true,
        action: createCloseButton
      })
    },
    [enqueueSnackbar, createCloseButton, columnToasts]
  )

  const notifyWarning = useCallback(
    (message: string, duration?: number | null) => {
      const columnKey = columnToasts?.push('warning', message, duration)
      if (columnKey) return columnKey
      return enqueueSnackbar(message, {
        variant: 'warning',
        autoHideDuration: duration === undefined ? calculateDuration(message) : duration,
        persist: duration === null,
        preventDuplicate: true,
        action: createCloseButton
      })
    },
    [enqueueSnackbar, createCloseButton, columnToasts]
  )

  const closeMessage = useCallback(
    (key?: import('notistack').SnackbarKey) => {
      if (columnToasts && (key === undefined || typeof key === 'string')) columnToasts.dismiss(key)
      closeSnackbar(key)
    },
    [closeSnackbar, columnToasts]
  )

  return useMemo(
    () => ({ notifySuccess, notifyError, notifyInfo, notifyWarning, closeMessage }),
    [notifySuccess, notifyError, notifyInfo, notifyWarning, closeMessage]
  )
}
