import React, { useCallback, useMemo } from 'react'
import { SnackbarProvider, useSnackbar } from 'notistack'
import { GlobalStyles, IconButton } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'

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
      return enqueueSnackbar(message, {
        variant: 'error',
        autoHideDuration: duration === undefined ? calculateErrorDuration(message) : duration,
        persist: duration === null,
        preventDuplicate: true,
        action: createCloseButton
      })
    },
    [enqueueSnackbar, createCloseButton]
  )

  const notifyInfo = useCallback(
    (message: string, duration?: number | null) => {
      return enqueueSnackbar(message, {
        variant: 'info',
        autoHideDuration: duration === undefined ? calculateDuration(message) : duration,
        persist: duration === null,
        preventDuplicate: true,
        action: createCloseButton
      })
    },
    [enqueueSnackbar, createCloseButton]
  )

  const notifyWarning = useCallback(
    (message: string, duration?: number | null) => {
      return enqueueSnackbar(message, {
        variant: 'warning',
        autoHideDuration: duration === undefined ? calculateDuration(message) : duration,
        persist: duration === null,
        preventDuplicate: true,
        action: createCloseButton
      })
    },
    [enqueueSnackbar, createCloseButton]
  )

  const closeMessage = useCallback(
    (key?: import('notistack').SnackbarKey) => {
      closeSnackbar(key)
    },
    [closeSnackbar]
  )

  return useMemo(
    () => ({ notifySuccess, notifyError, notifyInfo, notifyWarning, closeMessage }),
    [notifySuccess, notifyError, notifyInfo, notifyWarning, closeMessage]
  )
}
