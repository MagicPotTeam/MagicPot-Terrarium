import { createContext } from 'react'

export type AgentColumnToastSeverity = 'info' | 'success' | 'warning' | 'error'

export type AgentColumnToastSink = {
  /**
   * Shows a message in the Agent column's toast stack. `duration` in ms; null keeps it until it
   * is dismissed; undefined uses the default. Returns the toast's key, or null when the column
   * cannot show it (it is not visible), so the caller falls back to the app-wide snackbar.
   */
  push: (
    severity: AgentColumnToastSeverity,
    message: string,
    duration?: number | null
  ) => string | null
  dismiss: (key?: string) => void
}

/**
 * Set by the Agent column for everything rendered inside it: useMessage() then raises its
 * messages as the column's toasts instead of the app-wide snackbar.
 */
export const AgentColumnToastContext = createContext<AgentColumnToastSink | null>(null)
