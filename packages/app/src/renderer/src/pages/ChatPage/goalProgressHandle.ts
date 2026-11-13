import type { AgentGoalShare } from '@shared/api/agentThreadGoal'
/** Local, transient UI handle; never usable by external autoSend/edit/queue paths. */
export type AgentGoalProgressHandle = {
  take(expectedScope: string, profileId: string | undefined, eligible: boolean): AgentGoalShare | undefined
}
