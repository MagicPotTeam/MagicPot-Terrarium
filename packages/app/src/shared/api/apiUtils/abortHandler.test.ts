import { describe, expect, it, vi } from 'vitest'
import { newAbortHandler } from './abortHandler'

describe('newAbortHandler', () => {
  it('notifies registered abort handlers and flips the aborted state', () => {
    const [sender, receiver] = newAbortHandler()
    const first = vi.fn()
    const second = vi.fn()

    receiver.onAbort(first)
    receiver.onAbort(second)

    expect(receiver.isAborted()).toBe(false)

    sender.abort()

    expect(receiver.isAborted()).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('runs late subscribers at least once after abort', () => {
    const [sender, receiver] = newAbortHandler()
    const late = vi.fn()

    sender.abort()
    receiver.onAbort(late)

    expect(receiver.isAborted()).toBe(true)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('does not retain or re-run handlers when abort is called repeatedly', () => {
    const [sender, receiver] = newAbortHandler()
    const handler = vi.fn()

    receiver.onAbort(handler)
    sender.abort()
    sender.abort()
    receiver.onAbort(handler)

    expect(handler).toHaveBeenCalledTimes(2)
  })
})
