import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VirtualLogViewport, { LOG_OVERSCAN, LOG_ROW_HEIGHT } from './VirtualLogViewport'

const rows = Array.from({ length: 1000 }, (_, index) => `line-${index}`)
let resize: () => void
let height = 200
const disconnect = vi.fn()

describe('VirtualLogViewport', () => {
  beforeEach(() => {
    height = 200
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe = vi.fn()
        disconnect = disconnect
      }
    )
    disconnect.mockClear()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('mounts only visible rows plus overscan, without wrapping, and follows the tail', () => {
    const view = render(<VirtualLogViewport lines={rows} label="Test logs" />)
    const viewport = screen.getByRole('log')
    expect(view.container.querySelectorAll('[data-log-row]').length).toBeLessThanOrEqual(
      11 + LOG_OVERSCAN * 2
    )
    expect(viewport.style.whiteSpace).toBe('pre')
    expect(viewport.style.overflow).toBe('auto')
    expect(screen.queryByText('line-0')).toBeNull()
    expect(screen.getByText('line-999')).toBeTruthy()
    expect(viewport.scrollTop).toBe(1000 * LOG_ROW_HEIGHT - height)
    view.rerender(<VirtualLogViewport lines={[...rows, 'new tail']} label="Test logs" />)
    expect(viewport.scrollTop).toBe(1001 * LOG_ROW_HEIGHT - height)
    expect(screen.getByText('new tail')).toBeTruthy()
  })

  it('keeps scrollback stable during appends and count/character evictions, even for duplicate text', () => {
    const lines = Array<string>(1000).fill('repeated message')
    const view = render(<VirtualLogViewport lines={lines} label="Test logs" />)
    const viewport = screen.getByRole('log')
    fireEvent.scroll(viewport, { target: { scrollTop: 4050 } })
    view.rerender(
      <VirtualLogViewport lines={[...lines.slice(10), 'new']} firstIndex={10} label="Test logs" />
    )
    expect(viewport.scrollTop).toBe(3850)
    expect(view.container.querySelector('[data-log-row="202"]')).toBeTruthy()
    view.rerender(
      <VirtualLogViewport
        lines={[...lines.slice(10), 'new', 'newer']}
        firstIndex={10}
        label="Test logs"
      />
    )
    expect(viewport.scrollTop).toBe(3850)
    expect(screen.queryByText('newer')).toBeNull()
  })

  it('measures resize, preserves reading position and cleans up the observer', () => {
    const view = render(<VirtualLogViewport lines={rows} label="Test logs" />)
    const viewport = screen.getByRole('log')
    height = 400
    act(() => resize())
    expect(viewport.scrollTop).toBe(19600)
    fireEvent.scroll(viewport, { target: { scrollTop: 4000 } })
    height = 600
    act(() => resize())
    expect(viewport.scrollTop).toBe(4000)
    expect(view.container.querySelectorAll('[data-log-row]').length).toBeLessThanOrEqual(
      31 + LOG_OVERSCAN * 2
    )
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('keeps following when the browser clamps scroll before the resize observer runs', () => {
    const view = render(<VirtualLogViewport lines={rows} label="Test logs" />)
    const viewport = screen.getByRole('log')
    height = 400
    // Browser layout can deliver the clamp scroll before ResizeObserver updates React height.
    fireEvent.scroll(viewport, { target: { scrollTop: 19600 } })
    act(() => resize())
    view.rerender(<VirtualLogViewport lines={[...rows, 'new tail']} label="Test logs" />)
    expect(viewport.scrollTop).toBe(19620)
    expect(screen.getByText('new tail')).toBeTruthy()
  })

  it('resets empty/cleared output and resumes following, and supports an explicit tail request', () => {
    const view = render(<VirtualLogViewport lines={rows} label="Test logs" />)
    const viewport = screen.getByRole('log')
    fireEvent.scroll(viewport, { target: { scrollTop: 4000, scrollLeft: 100 } })
    view.rerender(
      <VirtualLogViewport lines={[]} generation={1} label="Test logs" emptyText="Empty" />
    )
    expect(viewport.scrollTop).toBe(0)
    expect(viewport.scrollLeft).toBe(0)
    expect(screen.getByText('Empty')).toBeTruthy()
    view.rerender(<VirtualLogViewport lines={rows} generation={1} label="Test logs" />)
    expect(viewport.scrollTop).toBe(19800)
    fireEvent.scroll(viewport, { target: { scrollTop: 4000 } })
    view.rerender(
      <VirtualLogViewport lines={rows} generation={1} tailRequest={1} label="Test logs" />
    )
    expect(viewport.scrollTop).toBe(19800)
  })

  it('handles missing ResizeObserver with a cleaned-up low-frequency fallback', () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', undefined)
    const remove = vi.spyOn(window, 'removeEventListener')
    const view = render(<VirtualLogViewport lines={rows} label="Test logs" />)
    height = 400
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByRole('log').scrollTop).toBe(19600)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
  })
})
