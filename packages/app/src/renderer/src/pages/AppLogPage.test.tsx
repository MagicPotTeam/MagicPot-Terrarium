import React, { StrictMode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AppLogPage from './AppLogPage'

const watchAppLogs = vi.fn()

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcLog: { watchAppLogs } })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback })
}))

type LogData = { message: string; level: string; timestamp: string }
type StreamResponse = {
  onData: (data: LogData) => void
  abortReceiver: { isAborted: () => boolean }
}

const log = (message: string): LogData => ({
  message,
  level: 'info',
  timestamp: '2025-01-01T00:00:00.000Z'
})

describe('AppLogPage stream lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    watchAppLogs.mockReturnValue(new Promise(() => undefined))
  })

  it('passes an abort receiver and aborts on unmount', async () => {
    const view = render(<AppLogPage />)
    await waitFor(() => expect(watchAppLogs).toHaveBeenCalledOnce())
    const response = watchAppLogs.mock.calls[0][1] as StreamResponse

    expect(response.abortReceiver.isAborted()).toBe(false)
    view.unmount()
    expect(response.abortReceiver.isAborted()).toBe(true)
  })

  it('ignores events delivered after unmount', async () => {
    let response!: StreamResponse
    watchAppLogs.mockImplementation((_request, nextResponse) => {
      response = nextResponse
      return new Promise(() => undefined)
    })
    const view = render(<AppLogPage />)
    await waitFor(() => expect(watchAppLogs).toHaveBeenCalledOnce())

    view.unmount()
    expect(() => response.onData(log('late event'))).not.toThrow()
  })

  it('keeps StrictMode generations isolated', async () => {
    const responses: StreamResponse[] = []
    watchAppLogs.mockImplementation((_request, response) => {
      responses.push(response)
      return new Promise(() => undefined)
    })

    render(
      <StrictMode>
        <AppLogPage />
      </StrictMode>
    )
    await waitFor(() => expect(responses).toHaveLength(2))
    expect(responses[0].abortReceiver.isAborted()).toBe(true)
    expect(responses[1].abortReceiver.isAborted()).toBe(false)

    act(() => {
      responses[0].onData(log('stale event'))
      responses[1].onData(log('active event'))
    })
    expect(screen.queryByText(/stale event/)).toBeNull()
    expect(screen.getByText(/active event/)).toBeTruthy()
  })

  it('does not report cancellation rejection as an error', async () => {
    let reject!: (error: unknown) => void
    watchAppLogs.mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
    )
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(<AppLogPage />)
    await waitFor(() => expect(watchAppLogs).toHaveBeenCalledOnce())

    view.unmount()
    await act(async () => reject(new Error('cancelled')))
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
