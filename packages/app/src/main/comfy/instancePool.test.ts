import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => ':memory:') }
}))

import { getComfyInstanceReservationCount, tryReserveComfyInstanceCapacity } from './instancePool'

const state = { id: 'gpu-a', maxConcurrency: 1 } as const

describe('shared ComfyUI instance capacity reservations', () => {
  let release: (() => void) | null = null

  afterEach(() => {
    release?.()
    release = null
  })

  it('allows only one reservation across all callers and releases idempotently', () => {
    release = tryReserveComfyInstanceCapacity(state, 0, 0)
    expect(release).toEqual(expect.any(Function))
    expect(getComfyInstanceReservationCount(state.id)).toBe(1)
    expect(tryReserveComfyInstanceCapacity(state, 0, 0)).toBeNull()

    release?.()
    release?.()
    release = null
    expect(getComfyInstanceReservationCount(state.id)).toBe(0)
    expect(tryReserveComfyInstanceCapacity(state, 1, 0)).toBeNull()
    expect(tryReserveComfyInstanceCapacity(state, 0, 1)).toBeNull()
  })
})
