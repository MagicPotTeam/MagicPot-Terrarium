import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnackbarKey } from 'notistack'
import React from 'react'
import { useMessage } from './useMessage'

const enqueueSnackbarMock = vi.fn<(_: string, __: Record<string, unknown>) => SnackbarKey>()
const closeSnackbarMock = vi.fn()

vi.mock('notistack', () => ({
  SnackbarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSnackbar: () => ({
    enqueueSnackbar: enqueueSnackbarMock,
    closeSnackbar: closeSnackbarMock
  })
}))

function TestComponent() {
  const { notifyError } = useMessage()

  return (
    <button type="button" onClick={() => notifyError('Photoshop is not running')}>
      trigger
    </button>
  )
}

function TestSuccessComponent() {
  const { notifySuccess } = useMessage()

  return (
    <button type="button" onClick={() => notifySuccess('Saved')}>
      trigger success
    </button>
  )
}

describe('useMessage', () => {
  beforeEach(() => {
    enqueueSnackbarMock.mockReset()
    closeSnackbarMock.mockReset()
    vi.restoreAllMocks()
  })

  it('shows an error snackbar for notifyError', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<TestComponent />)
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }))

    expect(consoleErrorSpy).toHaveBeenCalledWith('[Error]', 'Photoshop is not running')
    expect(enqueueSnackbarMock).toHaveBeenCalledTimes(1)
    expect(enqueueSnackbarMock).toHaveBeenCalledWith(
      'Photoshop is not running',
      expect.objectContaining({
        variant: 'error',
        autoHideDuration: 6000,
        persist: false,
        preventDuplicate: true
      })
    )
  })

  it('suppresses success snackbars', () => {
    render(<TestSuccessComponent />)
    fireEvent.click(screen.getByRole('button', { name: 'trigger success' }))

    expect(enqueueSnackbarMock).not.toHaveBeenCalled()
  })
})
