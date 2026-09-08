import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppLogPage from './AppLogPage'
import { LOG_FLUSH_INTERVAL_MS } from '@renderer/utils/logBuffer'

const watchAppLogs = vi.fn()
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcLog: { watchAppLogs } }) }))
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
const flush = () => act(() => vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS))

describe('AppLogPage stream lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    watchAppLogs.mockReturnValue(new Promise(() => undefined))
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('passes an abort receiver and aborts on unmount', () => {
    const view = render(<AppLogPage />)
    expect(watchAppLogs).toHaveBeenCalledOnce()
    const response = watchAppLogs.mock.calls[0][1] as StreamResponse
    expect(response.abortReceiver.isAborted()).toBe(false)
    view.unmount()
    expect(response.abortReceiver.isAborted()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores events delivered after unmount', () => {
    const view = render(<AppLogPage />)
    const response = watchAppLogs.mock.calls[0][1] as StreamResponse
    view.unmount()
    expect(() => response.onData(log('late event'))).not.toThrow()
    flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps StrictMode generations isolated', () => {
    render(
      <StrictMode>
        <AppLogPage />
      </StrictMode>
    )
    const responses = watchAppLogs.mock.calls.map((call) => call[1] as StreamResponse)
    expect(responses).toHaveLength(2)
    expect(responses[0].abortReceiver.isAborted()).toBe(true)
    expect(responses[1].abortReceiver.isAborted()).toBe(false)
    act(() => {
      responses[0].onData(log('stale event'))
      responses[1].onData(log('active event'))
    })
    expect(screen.queryByText(/active event/)).toBeNull()
    flush()
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
    view.unmount()
    await act(async () => reject(new Error('cancelled')))
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('bounds bursts, redacts image data, retains error text and virtualizes both app log surfaces', () => {
    const view = render(<AppLogPage />)
    const response = watchAppLogs.mock.calls[0][1] as StreamResponse
    act(() => {
      for (let index = 0; index < 20_000; index += 1) response.onData(log(`line-${index}`))
      response.onData({
        ...log(`decode data:image/png;base64,${'A'.repeat(1_000_000)}; failed`),
        level: 'error'
      })
    })
    flush()
    expect(view.container.querySelectorAll('[data-log-row]').length).toBeLessThan(30)
    const viewport = screen.getByRole('log')
    expect(viewport.textContent).toContain('failed')
    expect(viewport.textContent).toContain('[ERROR]')
    expect(viewport.textContent).not.toContain('A'.repeat(256))
    expect(viewport.textContent).not.toContain('line-0')
    response.onData(log('queued before clear'))
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    flush()
    expect(viewport.textContent).toBe('Log listener is ready...')
    response.onData(log('after clear'))
    flush()
    expect(viewport.textContent).toContain('after clear')
    expect(viewport.textContent).not.toContain('queued before clear')
  })
})
