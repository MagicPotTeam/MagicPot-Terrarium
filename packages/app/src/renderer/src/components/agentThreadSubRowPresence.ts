import { createContext } from 'react'

/**
 * Provided by AgentWorkspace around a pane's chat page: every mounted AgentThreadSubRow reports
 * itself (+1 on mount, -1 on unmount), so the thread row above knows that it heads a group.
 */
export const AgentThreadSubRowPresenceContext = createContext<((delta: 1 | -1) => void) | null>(
  null
)
