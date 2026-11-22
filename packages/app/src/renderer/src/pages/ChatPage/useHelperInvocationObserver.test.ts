import { createElement, StrictMode, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useHelperInvocationObserver } from './useHelperInvocationObserver'

const event = (status = 'running') => ({ type: 'tool-status', toolStatus: { runId: 'event', toolCallId: 'call', toolName: 'explore', status, args: 'SECRET_ARGS', error: 'SECRET_ERROR' }, toolHistory: [{ content: 'SECRET_OUTPUT' }] })
afterEach(() => vi.useRealTimers())

describe('useHelperInvocationObserver', () => {
  it('maps real event shape without retaining sensitive fields or providing stop', () => {
    const { result } = renderHook(() => useHelperInvocationObserver('scope'))
    let handle: ReturnType<typeof result.current.begin>
    act(() => { handle = result.current.begin('session', 1); expect(handle?.observe(event())).toBe(true) })
    expect(result.current.list('session')[0].status).toBe('running')
    act(() => { expect(handle?.observe(event('completed'))).toBe(true) })
    expect(result.current.list('session')[0].status).toBe('returned')
    expect(JSON.stringify(result.current.list('session'))).not.toContain('SECRET')
    expect(Object.keys(handle!).sort()).toEqual(['end', 'observe'])
    act(() => { expect(handle?.observe(event())).toBe(false); handle?.end(); handle?.end() })
  })
  it('invalidates old runs and scope ABA handles, isolates sessions and rejects other tools', () => {
    const { result, rerender } = renderHook(({ scope }) => useHelperInvocationObserver(scope), { initialProps: { scope: 'a' } })
    let old: ReturnType<typeof result.current.begin>, next: ReturnType<typeof result.current.begin>
    act(() => { old = result.current.begin('same', 1); old?.observe(event()); next = result.current.begin('same', 2) })
    act(() => { expect(old?.observe(event('completed'))).toBe(false); old?.end(); expect(next?.observe(event())).toBe(true) })
    expect(result.current.list('other')).toEqual([])
    act(() => { expect(next?.observe({ ...event(), toolStatus: { ...event().toolStatus, toolName: 'read' } })).toBe(false) })
    rerender({ scope: 'b' }); rerender({ scope: 'a' })
    act(() => { expect(next?.observe(event())).toBe(false); next?.end() })
    expect(result.current.list('same')).toEqual([])
  })
  it('rejects a retained old list closure across scope ABA', () => {
    const { result, rerender } = renderHook(({ scope }) => useHelperInvocationObserver(scope), { initialProps: { scope: 'a' } })
    act(() => { result.current.begin('same', 1)?.observe(event()) })
    const oldList = result.current.list
    expect(oldList('same')).toHaveLength(1)
    rerender({ scope: 'b' }); rerender({ scope: 'a' })
    expect(oldList('same')).toEqual([])
    expect(result.current.list('same')).toEqual([])
  })
  it('cleans up StrictMode generations and invalidates handles on unmount', () => {
    vi.useFakeTimers()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children)
    const { result, unmount } = renderHook(() => useHelperInvocationObserver('scope'), { wrapper })
    let handle: ReturnType<typeof result.current.begin>
    act(() => { handle = result.current.begin('session', 1); handle?.observe(event()) })
    const oldList = result.current.list
    expect(oldList('session')).toHaveLength(1)
    unmount()
    expect(oldList('session')).toEqual([])
    expect(handle?.observe(event('completed'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('superseding a parent marks its running call unknown and preserves newer run', () => {
    const { result } = renderHook(() => useHelperInvocationObserver('scope'))
    let old: ReturnType<typeof result.current.begin>, next: ReturnType<typeof result.current.begin>
    act(() => { old = result.current.begin('session', 1); old?.observe(event()) })
    act(() => { next = result.current.begin('session', 2) })
    expect(result.current.list('session').map(row => [row.parentRunId, row.status])).toEqual([[1, 'unknown']])
    act(() => { expect(old?.observe(event('completed'))).toBe(false); old?.end(); expect(next?.observe(event())).toBe(true) })
    expect(result.current.list('session').map(row => [row.parentRunId, row.status])).toEqual([[1, 'unknown'], [2, 'running']])
  })
  it('expires observation with a local timer and rejects late completions', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useHelperInvocationObserver('scope'))
    let handle: ReturnType<typeof result.current.begin>
    act(() => { handle = result.current.begin('session', 1); handle?.observe(event()) })
    act(() => { vi.advanceTimersByTime(15 * 60 * 1000) })
    expect(result.current.list('session')[0].status).toBe('unknown')
    act(() => { expect(handle?.observe(event('completed'))).toBe(false) })
  })
  it('uses bounded session capacity and fails closed on invalid inputs', () => {
    const { result } = renderHook(() => useHelperInvocationObserver('scope'))
    act(() => {
      const h = result.current.begin('session', 1)!
      for (let i = 0; i < 32; i++) expect(h.observe({ ...event(), toolStatus: { ...event().toolStatus, toolCallId: String(i) } })).toBe(true)
      expect(h.observe({ ...event(), toolStatus: { ...event().toolStatus, toolCallId: 'overflow' } })).toBe(false)
      expect(h.observe(null)).toBe(false)
      expect(result.current.begin('session', 1)).toBeUndefined()
    })
  })
})
