type IdSet = { has(id: string): boolean }
type QueuedItem = { inFlight?: unknown }

/** A send to this session is in its preflight (a leased queue item included): Stop can stop it. */
export const sessionPreparing = (
  id: string,
  sending: IdSet,
  queues: ReadonlyMap<string, readonly QueuedItem[]>
): boolean => sending.has(id) || Boolean(queues.get(id)?.some(item => item.inFlight))

/**
 * The members the lead's stop covers: those that run, wait for an approval, or prepare a send
 * (only in the sending set, or a queued item in its preflight). Every stop-all goes through this,
 * so a member that is still preparing is never left to start its request after the stop.
 */
export const teamMembersToStop = (
  memberIds: readonly string[],
  state: Readonly<{ loading: IdSet; sending: IdSet; waiting: IdSet; queues: ReadonlyMap<string, readonly QueuedItem[]> }>
): string[] =>
  memberIds.filter(id => state.loading.has(id) || state.waiting.has(id) || sessionPreparing(id, state.sending, state.queues))

export type TeamMemberTerminate = (sessionId: string, options: { dropQueued: true; pauseUserSends: true }) => void

/** Stop-all for the members: a member stop (unsent user items stay paused, team deliveries are held). */
export const stopTeamMembers = (
  memberIds: readonly string[],
  state: Parameters<typeof teamMembersToStop>[1],
  terminate: TeamMemberTerminate
): string[] => {
  const stopped = teamMembersToStop(memberIds, state)
  for (const id of stopped) terminate(id, { dropQueued: true, pauseUserSends: true })
  return stopped
}

type AcceptedSend = Readonly<{
  composerSubmission?: boolean
  onComposerSubmissionAccepted?: unknown
  isQueuedComposerCurrent?: unknown
  userTaskDispatch?: boolean
}>

/**
 * Whether the acceptance of this send's user turn is the user's own explicit send to the session,
 * which releases what the user's stop held (team messages and paused queue items): a composer or
 * '@member' send, an edit-resend, or a task the user dispatched from team management. A drained
 * queue item releases in its own lease; a team-message delivery, and a task dispatched by the lead
 * or by automation (no userTaskDispatch), never release.
 */
export const sendReleasesStopHolds = (overrides: AcceptedSend | undefined): boolean =>
  !overrides?.isQueuedComposerCurrent &&
  (!overrides || Boolean(overrides.composerSubmission) || Boolean(overrides.onComposerSubmissionAccepted) || overrides.userTaskDispatch === true)
