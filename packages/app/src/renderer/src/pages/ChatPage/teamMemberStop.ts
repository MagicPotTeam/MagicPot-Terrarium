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

/**
 * The lead's composer stop (stop-all): stops the members that work (stopTeamMembers) and also holds
 * the members that are idle at the click but still have team messages waiting for them (their run
 * ended just before the click), so the next pump delivers nothing to them either. Both stay held
 * until the user's own next send to them.
 */
export const stopTeamMembersAndHoldQueued = (
  memberIds: readonly string[],
  state: Parameters<typeof teamMembersToStop>[1],
  terminate: TeamMemberTerminate,
  hasQueuedTeamMessages: (memberId: string) => boolean,
  hold: (memberId: string) => void
): { stopped: string[]; held: string[] } => {
  const stopped = stopTeamMembers(memberIds, state, terminate)
  const held = memberIds.filter(id => !stopped.includes(id) && hasQueuedTeamMessages(id))
  for (const id of held) hold(id)
  return { stopped, held }
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

type TeamSessionRecord = Readonly<{
  id: string
  teamLeadId?: string
  archived?: boolean
  teamEnded?: boolean
  teamGeneration?: number
  teamMemberGeneration?: number
}>

/**
 * Drops the stop holds ('scope\0member') of this scope whose member is no longer in a live team:
 * the team ended, the member was removed (archived or deleted) or belongs to an older generation.
 * Holds of other scopes and of current members stay. Returns the member ids it dropped.
 */
export const pruneTeamMemberHolds = (
  held: Set<string>,
  scope: string,
  sessions: readonly TeamSessionRecord[],
  isDeleted: (id: string) => boolean = () => false
): string[] => {
  const prefix = `${scope}\u0000`
  const byId = new Map(sessions.map(session => [session.id, session]))
  const dropped: string[] = []
  for (const key of held) {
    if (!key.startsWith(prefix)) continue
    const id = key.slice(prefix.length)
    const member = byId.get(id)
    const lead = member?.teamLeadId ? byId.get(member.teamLeadId) : undefined
    const live = !!member && !!lead && !member.archived && !lead.archived && !lead.teamEnded && !lead.teamLeadId &&
      (member.teamMemberGeneration ?? 0) === (lead.teamGeneration ?? 0) && !isDeleted(id) && !isDeleted(lead.id)
    if (live) continue
    held.delete(key)
    dropped.push(id)
  }
  return dropped
}
