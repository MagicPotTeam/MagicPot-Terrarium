import { compareAndUpdateSessionInDB, hasSessionDeleteTombstone, sameTeamLifecycle, type ChatSession } from './chatStorage'
import { setTeamTaskStatus, type TeamTask } from './agentTeamTasks'

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

/** Fixture-oriented executor: callers provide their normal dispatch admission checks. */
export async function dispatchTeamTask(
  store: TeamTaskDispatchStore,
  taskId: string,
  execute: () => Promise<void>
): Promise<void> {
  await store.updateTasks(current => {
    const task = current.find(item => item.id === taskId)
    if (!task || task.status !== 'pending') throw new Error('Task is not pending')
    return setTeamTaskStatus(current, taskId, 'running')
  })
  await execute()
}
