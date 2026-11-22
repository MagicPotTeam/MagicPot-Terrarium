import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useStableCallbackProps, useStableEventHandler } from './useStableEventHandler'

describe('useStableEventHandler', () => {
  it('keeps one identity and calls the handler of the latest render', () => {
    const first = vi.fn(() => 'first')
    const second = vi.fn(() => 'second')
    const { result, rerender } = renderHook(({ handler }) => useStableEventHandler(handler), {
      initialProps: { handler: first as (value: number) => string }
    })
    const stable = result.current

    rerender({ handler: second })
    expect(result.current).toBe(stable)
    expect(stable(3)).toBe('second')
    expect(second).toHaveBeenCalledWith(3)
    expect(first).not.toHaveBeenCalled()
  })

  it('returns undefined while the handler is missing', () => {
    const { result } = renderHook(() => useStableEventHandler(undefined))
    expect(result.current()).toBeUndefined()
  })
})

describe('useStableCallbackProps', () => {
  it('keeps the bag when only callback identities change and forwards to the latest callback', () => {
    const items = [1, 2]
    const firstSelect = vi.fn()
    const secondSelect = vi.fn()
    type Props = { items: number[]; onSelect: () => void; handleClose: () => string }
    const { result, rerender } = renderHook((props: Props) => useStableCallbackProps(props), {
      initialProps: { items, onSelect: firstSelect, handleClose: () => 'a' }
    })
    const bag = result.current

    rerender({ items, onSelect: secondSelect, handleClose: () => 'b' })
    expect(result.current).toBe(bag)
    bag.onSelect()
    expect(secondSelect).toHaveBeenCalledTimes(1)
    expect(firstSelect).not.toHaveBeenCalled()
    expect(bag.handleClose()).toBe('b')
  })

  it('returns a new bag when a rendered value changes and keeps the forwarders', () => {
    const onSelect = vi.fn()
    const { result, rerender } = renderHook((props) => useStableCallbackProps(props), {
      initialProps: { open: false, onSelect }
    })
    const bag = result.current

    rerender({ open: true, onSelect })
    expect(result.current).not.toBe(bag)
    expect(result.current.open).toBe(true)
    expect(result.current.onSelect).toBe(bag.onSelect)
  })

  it('passes a callback that is not a function through, so its presence still re-renders', () => {
    const onExport: () => void = vi.fn()
    const { result, rerender } = renderHook(
      (props: { onExport?: () => void }) => useStableCallbackProps(props),
      { initialProps: { onExport } as { onExport?: () => void } }
    )
    const bag = result.current
    expect(typeof bag.onExport).toBe('function')

    rerender({ onExport: undefined })
    expect(result.current).not.toBe(bag)
    expect(result.current.onExport).toBeUndefined()

    rerender({ onExport })
    expect(result.current.onExport).toBe(bag.onExport)
  })

  it('compares functions under other keys by identity, so render-time functions still update', () => {
    const { result, rerender } = renderHook((props) => useStableCallbackProps(props), {
      initialProps: { t: (key: string) => `en:${key}` }
    })
    const bag = result.current

    const nextT = (key: string) => `zh:${key}`
    rerender({ t: nextT })
    expect(result.current).not.toBe(bag)
    expect(result.current.t).toBe(nextT)
  })

  it('accepts extra callback keys', () => {
    type Props = { buildPayload: () => number; onSelect: () => number }
    const { result, rerender } = renderHook(
      (props: Props) => useStableCallbackProps(props, (key) => key === 'buildPayload'),
      { initialProps: { buildPayload: () => 1, onSelect: () => 1 } }
    )
    const bag = result.current

    rerender({ buildPayload: () => 2, onSelect: bag.onSelect })
    expect(result.current).toBe(bag)
    expect(bag.buildPayload()).toBe(2)
  })
})
