/**
 * How often a pane with a team asks MAIN for new team message intents. MAIN keeps an unclaimed
 * intent in its durable store (agentTeamMessageQueue.ts). A visible pane polls every 500 ms and
 * delivers at once; a hidden pane only claims intents into queued records (delivery waits until
 * the pane is shown), so a poll every 3 s is enough.
 */
export const TEAM_MESSAGE_VISIBLE_POLL_MS = 500
export const TEAM_MESSAGE_HIDDEN_POLL_MS = 3000

export type TeamMessagePoller = Readonly<{
  /** Polls now and restarts the timer at the current pace (use when the pane is shown again). */
  wake(): void
  stop(): void
}>

/** Calls `poll` now and then again after each interval, at the pace of the pane's visibility. */
export function startTeamMessagePolling(isVisible: () => boolean, poll: () => void): TeamMessagePoller {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const run = (): void => {
    if (stopped) return
    clearTimeout(timer)
    try { poll() } catch { /* A failed poll never stops the next one. */ }
    if (stopped) return
    timer = setTimeout(run, isVisible() ? TEAM_MESSAGE_VISIBLE_POLL_MS : TEAM_MESSAGE_HIDDEN_POLL_MS)
  }
  run()
  return {
    wake: run,
    stop: () => {
      stopped = true
      clearTimeout(timer)
    }
  }
}
