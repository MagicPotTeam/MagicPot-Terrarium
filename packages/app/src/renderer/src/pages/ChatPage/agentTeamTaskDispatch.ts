import { compareAndUpdateSessionInDB, hasSessionDeleteTombstone, sameTeamLifecycle, type ChatSession } from './chatStorage'
import { revertTeamTaskRun, setTeamTaskStatus, type TeamTask, type TeamTaskOutcome } from './agentTeamTasks'

/**
 * The store must serialize updates for the team and commit the returned graph before
 * resolving. It must reject on conflict or failure; a read followed by a separate
 * write does not satisfy this contract.
 */
export interface TeamTaskDispatchStore {
  updateTasks(update: (current: readonly TeamTask[]) => TeamTask[]): Promise<void>
}

/**
 * Persist a task claim against an exact lead snapshot. End still uses the normal
 * renderer and MAIN admission checks; this claim is not an atomic End fence.
 */
export async function claimTeamTaskInDB(input: {
  scope: string
  leadId: string
  expectedLead: ChatSession
  taskId: string
}): Promise<ChatSession> {
  const { scope, leadId, taskId } = input
  const expectedLead = structuredClone(input.expectedLead)
  const validFence = (value: number | undefined) => value === undefined || (Number.isSafeInteger(value) && value >= 0)
  const validLead = (lead: ChatSession) => lead.id === leadId && !lead.teamLeadId && !lead.teamMemberName && !lead.archived && !lead.teamEnded &&
    (lead.storageScope === undefined || lead.storageScope === scope) &&
    validFence(lead.teamGeneration) && validFence(lead.teamMemberGeneration) && validFence(lead.teamLifecycleRevision)
  if (!scope || !leadId || !taskId || !validLead(expectedLead) || hasSessionDeleteTombstone(leadId, scope)) {
    throw new Error('Invalid team claim')
  }
  const committed = await compareAndUpdateSessionInDB(leadId, scope, {
    expectedSession: expectedLead,
    shouldUpdate: current => validLead(current) && sameTeamLifecycle(current, expectedLead) && !hasSessionDeleteTombstone(leadId, scope),
    update: current => {
      const tasks = current.teamTasks ?? []
      const task = tasks.find(item => item.id === taskId)
      if (!task || task.status !== 'pending') throw new Error('Task is not pending')
      return { ...current, teamTasks: setTeamTaskStatus(tasks, taskId, 'running') }
    }
  })
  if (!committed) throw new Error('Team claim conflict')
  return committed
}

/**
 * Undo a claim whose run never started: only while the stored lead is still exactly the claimed
 * snapshot, the stored task goes back to its pre-claim record, so the stored lead equals the
 * snapshot the claim started from again (and the renderer's save baseline for it stays valid).
 * Any other write since the claim wins: nothing is changed and null is returned, and the task stays
 * running until the user resets it. Storage failures reject.
 */
export async function releaseTeamTaskClaimInDB(input: {
  scope: string
  leadId: string
  claimedLead: ChatSession
  taskBeforeClaim: TeamTask
}): Promise<ChatSession | null> {
  const { scope, leadId } = input
  const claimedLead = structuredClone(input.claimedLead)
  const restored = structuredClone(input.taskBeforeClaim)
  if (!scope || !leadId || claimedLead.id !== leadId || restored.status !== 'pending' ||
    claimedLead.teamTasks?.find(item => item.id === restored.id)?.status !== 'running') throw new Error('Invalid team claim release')
  return compareAndUpdateSessionInDB(leadId, scope, {
    expectedSession: claimedLead,
    shouldUpdate: current => current.id === leadId && !current.teamEnded && !current.archived &&
      sameTeamLifecycle(current, claimedLead) && !hasSessionDeleteTombstone(leadId, scope),
    update: current => {
      const tasks = current.teamTasks ?? []
      const task = tasks.find(item => item.id === restored.id)
      if (!task || task.status !== 'running' || task.ownerId !== restored.ownerId) throw new Error('Task is not running')
      return { ...current, teamTasks: tasks.map(item => item.id === restored.id ? restored : item) }
    }
  })
}

/**
 * Fixture-oriented executor: callers provide their normal dispatch admission checks. A failed run
 * returns the task to pending with its outcome; it is never retried here.
 */
export async function dispatchTeamTask(
  store: TeamTaskDispatchStore,
  taskId: string,
  execute: () => Promise<void>,
  outcomeOf: (error: unknown) => TeamTaskOutcome = () => 'failed'
): Promise<void> {
  let ownerId = ''
  await store.updateTasks(current => {
    const task = current.find(item => item.id === taskId)
    if (!task || task.status !== 'pending') throw new Error('Task is not pending')
    ownerId = task.ownerId
    return setTeamTaskStatus(current, taskId, 'running')
  })
  try {
    await execute()
  } catch (error) {
    // A failed revert leaves the task running (the user can reset it); the run's error still wins.
    await store.updateTasks(current => revertTeamTaskRun(current, taskId, ownerId, outcomeOf(error)) ?? [...current]).catch(() => undefined)
    throw error
  }
}
