import { afterEach, describe, expect, it, vi } from 'vitest'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { EventCenter, type EventListener } from './eventCenter'

const listener = <T>(overrides: Partial<EventListener<T>> = {}): EventListener<T> => ({
  id: crypto.randomUUID(),
  onEvent: vi.fn(),
  onEnd: vi.fn(),
  ...overrides
})

describe('EventCenter listener lifecycle', () => {
  let center: EventCenter<number>

  afterEach(async () => {
    await center?.cleanAllListeners()
  })

  it('does not deliver the current event to a listener removed reentrantly', async () => {
    center = new EventCenter<number>()
    const removed = listener<number>()
    const remover = listener<number>({
      onEvent: vi.fn(() => center.removeListener(removed.id))
    })
    center.addListener(remover)
    center.addListener(removed)

    await center.emit(1)

    expect(remover.onEvent).toHaveBeenCalledWith(1)
    expect(removed.onEvent).not.toHaveBeenCalled()
    expect(removed.onEnd).toHaveBeenCalledOnce()
    expect(center.isEmpty()).toBe(false)
  })

  it('detaches listeners before calling onEnd so reentrant additions survive cleanup', async () => {
    center = new EventCenter<number>()
    const added = listener<number>()
    const ending = listener<number>({
      onEnd: vi.fn(() => center.addListener(added))
    })
    center.addListener(ending)

    await center.cleanAllListeners()

    expect(ending.onEnd).toHaveBeenCalledOnce()
    expect(center.isEmpty()).toBe(false)
    await center.emit(2)
    expect(added.onEvent).toHaveBeenCalledWith(2)
  })

  it('ends every listener when duplicate IDs are removed', () => {
    center = new EventCenter<number>()
    const first = listener<number>({ id: 'duplicate' })
    const second = listener<number>({ id: 'duplicate' })
    center.addListener(first)
    center.addListener(second)

    center.removeListener('duplicate')

    expect(first.onEnd).toHaveBeenCalledOnce()
    expect(second.onEnd).toHaveBeenCalledOnce()
    expect(center.isEmpty()).toBe(true)
  })

  it('removes a listener when its stream aborts, including an already-aborted stream', () => {
    center = new EventCenter<number>()
    const [sender, receiver] = newAbortHandler()
    const active = listener<number>({ abortReceiver: receiver })
    center.addListener(active)
    sender.abort()

    expect(active.onEnd).toHaveBeenCalledOnce()
    expect(center.isEmpty()).toBe(true)

    const [alreadyAbortedSender, alreadyAbortedReceiver] = newAbortHandler()
    alreadyAbortedSender.abort()
    const alreadyAborted = listener<number>({ abortReceiver: alreadyAbortedReceiver })
    center.addListener(alreadyAborted)
    expect(alreadyAborted.onEnd).toHaveBeenCalledOnce()
    expect(center.isEmpty()).toBe(true)
  })

  it('awaits asynchronous listeners and propagates their failures', async () => {
    center = new EventCenter<number>()
    const gate = Promise.withResolvers<void>()
    let completed = false
    center.addListener(
      listener<number>({
        onEvent: async () => {
          await gate.promise
          completed = true
        }
      })
    )

    const emitting = center.emit(1)
    await Promise.resolve()
    expect(completed).toBe(false)
    gate.resolve()
    await emitting
    expect(completed).toBe(true)

    center.addListener(
      listener<number>({
        onEvent: async () => {
          throw new Error('async listener failed')
        }
      })
    )
    await expect(center.emit(2)).rejects.toThrow('async listener failed')
  })
  it('skips a listener that was removed before its turn and still delivers later listeners', async () => {
    center = new EventCenter<number>()
    const skipped = listener<number>()
    const later = listener<number>()
    const first = listener<number>({
      onEvent: vi.fn(() => center.removeListener(skipped.id))
    })
    center.addListener(first)
    center.addListener(skipped)
    center.addListener(later)

    await center.emit(3)

    expect(skipped.onEvent).not.toHaveBeenCalled()
    expect(later.onEvent).toHaveBeenCalledWith(3)
  })
})
