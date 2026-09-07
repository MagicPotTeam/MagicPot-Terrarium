import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BottomPanel from './BottomPanel'
import { LOG_FLUSH_INTERVAL_MS } from '@renderer/utils/logBuffer'

let activeTab = 'terminal'
let visible = true
const watchAppLogs = vi.fn()
const clearOutput = vi.fn()
let output: string[] = []

vi.mock('../store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      layout: {
        bottomPanelVisible: visible,
        bottomPanelActiveTab: activeTab,
        bottomPanelMaximized: false
      }
    })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcLog: { watchAppLogs } }) }))
vi.mock('@renderer/store/hooks/comfyProcess', () => ({
  useComfyProcess: () => ({
    state: { output, pid: 0, isRunning: false, isManaged: false },
    setPid: vi.fn(),
    setIsRunning: vi.fn(),
    setIsManaged: vi.fn(),
    addOutput: vi.fn(),
    clearOutput
  })
}))

describe('BottomPanel bounded log surfaces', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    activeTab = 'terminal'
    visible = true
    watchAppLogs.mockReset().mockReturnValue(new Promise(() => undefined))
    clearOutput.mockClear()
    output = []
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('buffers and sanitizes terminal logs, clears pending output and aborts its subscription', () => {
    const view = render(<BottomPanel />)
    const response = watchAppLogs.mock.calls[0][1]
    response.onData({
      message: `ERROR data:image/png;base64,${'A'.repeat(1_000_000)}; failed`,
      level: 'error',
      timestamp: '2025-01-01'
    })
    expect(screen.getByRole('log').textContent).not.toContain('failed')
    act(() => vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS))
    expect(screen.getByRole('log').textContent).toContain('failed')
    expect(screen.getByRole('log').textContent).not.toContain('A'.repeat(256))
    response.onData({ message: 'pending', level: 'info', timestamp: '2025-01-01' })
    fireEvent.click(screen.getByRole('button', { name: 'terminal.clear' }))
    act(() => vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS))
    expect(screen.getByRole('log').textContent).toBe('No logs yet.')
    view.unmount()
    expect(response.abortReceiver.isAborted()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('filters wrapped and control-separated Base64 in the terminal single-normalization path', () => {
    const view = render(<BottomPanel />)
    const response = watchAppLogs.mock.calls[0][1]
    const wrapped = Array<string>(4)
      .fill('Ab9+/'.repeat(15) + 'A')
      .join('\r\n')
    response.onData({
      message: `image: data:image/png;base64,${wrapped}\r\nTQ==\nERROR: still readable`,
      level: 'error',
      timestamp: 0
    })
    response.onData({
      message: `${'A'.repeat(128)}${String.fromCharCode(0)}${'B'.repeat(128)}; failed`,
      level: 'error',
      timestamp: 0
    })
    act(() => vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS))
    const text = screen.getByRole('log', { name: 'terminal.terminal_log' }).textContent
    expect(text).toContain('[base64 redacted]')
    expect(text).toContain('ERROR: still readable')
    expect(text).toContain('failed')
    expect(text).not.toContain('Ab9+/')
    expect(text).not.toContain('TQ==')
    expect(text).not.toContain('A'.repeat(128))
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('virtualizes and bounds pre-fix Comfy state that survives HMR', () => {
    activeTab = 'comfyui'
    output = Array.from({ length: 20_000 }, (_, index) => `line-${index}`)
    output.push(`ERROR> ${'Ab+/'.repeat(250_000)}; final failure`)
    const view = render(<BottomPanel />)
    expect(view.container.querySelectorAll('[data-log-row]').length).toBeLessThan(30)
    const viewport = screen.getByRole('log', { name: 'ComfyUI logs' })
    expect(viewport.textContent).toContain('final failure')
    expect(viewport.textContent).not.toContain('Ab+/'.repeat(64))
    expect(viewport.textContent).not.toContain('line-0')
    expect(watchAppLogs).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'terminal.clear' }))
    expect(clearOutput).toHaveBeenCalledOnce()
  })

  it.each(['terminal', 'comfyui'])('does not mount the hidden %s log surface', (tab) => {
    activeTab = tab
    visible = false
    output = ['not rendered while hidden']
    const view = render(<BottomPanel />)
    expect(view.container.querySelector('[role="log"]')).toBeNull()
    expect(view.container.querySelector('[data-log-row]')).toBeNull()
    expect(watchAppLogs).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts terminal logging and pending refreshes on hide or tab switch', () => {
    const view = render(<BottomPanel />)
    const first = watchAppLogs.mock.calls[0][1]
    first.onData({ message: 'pending before hide', level: 'info', timestamp: 0 })
    visible = false
    view.rerender(<BottomPanel />)
    expect(first.abortReceiver.isAborted()).toBe(true)
    expect(view.container.querySelector('[role="log"]')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)

    visible = true
    view.rerender(<BottomPanel />)
    expect(watchAppLogs).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('log').textContent).not.toContain('pending before hide')
    const second = watchAppLogs.mock.calls[1][1]
    activeTab = 'comfyui'
    view.rerender(<BottomPanel />)
    expect(second.abortReceiver.isAborted()).toBe(true)
    expect(screen.getByRole('log', { name: 'ComfyUI logs' })).toBeTruthy()
    // JSDOM has no ResizeObserver: only the mounted viewport's resize fallback remains.
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
