import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { TeamMessageDispatcher } from '../teamMessageDispatcher'

/** Get the real page's dispatcher after it has subscribed its fixture members. The normal
 * polling tick calls pump; we only observe that call and never trigger a poll or delivery. */
export async function subscribedTeamDispatcher(
  Dispatcher: typeof TeamMessageDispatcher,
  members: readonly string[]
): Promise<TeamMessageDispatcher> {
  const pump = vi.spyOn(Dispatcher.prototype, 'pump')
  try {
    return await waitFor(
      () => {
        const dispatcher = pump.mock.contexts.find(
          (d): d is TeamMessageDispatcher =>
            d instanceof Dispatcher && members.every((id) => d.isSubscribed(id))
        )
        if (!dispatcher) throw new Error('Waiting for fixture team subscriptions')
        return dispatcher
      },
      { timeout: 5000 }
    )
  } finally {
    pump.mockRestore()
  }
}
