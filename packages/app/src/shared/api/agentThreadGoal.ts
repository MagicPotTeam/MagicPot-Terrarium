import type { AgentThreadInteractionScope } from './agentThreadInteraction'

/** Data contract only. No stored goal restores an execution/approval capability. */
export const AGENT_GOAL_LIMITS = Object.freeze({
  goals: 8, retiredIds: 64, receipts: 64, owners: 128,
  title: 120, objective: 8000, listItems: 6, listItem: 512, summary: 2000, reason: 128,
  plainBytes: 128 * 1024, contentHeadroomBytes: 24 * 1024, cipherBytes: 196 * 1024,
  totalCipherBytes: 12 * 1024 * 1024, databaseBytes: 16 * 1024 * 1024,
  maxTurns: 100, maxToolCalls: 1000, maxWalltimeSeconds: 86400
})
export type AgentGoalStatus = 'draft' | 'active' | 'waiting' | 'blocked' | 'paused' | 'cancelled' | 'completed' | 'failed'
export type AgentGoalControlStatus = Exclude<AgentGoalStatus, 'completed' | 'failed'>
export type AgentGoalSpec = {
  objective: string; successCriteria: string[]; constraints: string[]
  autonomy: 'manual'; completionPolicy: 'user_confirm'
  budgets: { maxTurns: number; maxToolCalls: number; maxWalltimeSeconds: number }
}
export type AgentGoalReport = { summary: string; evidence: string[]; reportedAt: number }
export type AgentGoalProposal = { outcome: 'completed' | 'failed'; summary: string; evidence: string[]; proposedAt: number }
export type AgentGoal = {
  id: string; generation: number; title: string; spec: AgentGoalSpec; status: AgentGoalStatus
  createdAt: number; updatedAt: number; reason: string
  progress?: AgentGoalReport; proposal?: AgentGoalProposal
}
export type AgentGoalCommand =
  | { action: 'create'; goalId: string; title: string; spec: AgentGoalSpec }
  | ({ expectedGeneration: number } & (
    | { action: 'update'; goalId: string; title: string; spec: AgentGoalSpec }
    | { action: 'control'; goalId: string; status: AgentGoalControlStatus; reason: string }
    | { action: 'report'; goalId: string; summary: string; evidence: string[] }
    | { action: 'propose'; goalId: string; outcome: 'completed' | 'failed'; summary: string; evidence: string[] }
    | { action: 'confirm'; goalId: string; outcome: 'completed' | 'failed' }
    | { action: 'reject-proposal'; goalId: string }
    | { action: 'delete'; goalId: string }
  ))
export type AgentGoalMutation = AgentGoalCommand & { expectedRevision: number; operationId: string }
export type AgentModelGoalMutation = Extract<AgentGoalMutation, { action: 'report' | 'propose' }>
/** Must be captured by a future main-owned request admission, never from model arguments. */
export type AgentGoalBinding = Readonly<{ goalId: string; generation: number }>
export type AgentGoalCollection = {
  version: 1; revision: number; goals: AgentGoal[]; retiredIds: string[]
  receipts: Array<{ operationHash: string; digest: string }>
}
export type AgentGoalView = { revision: number; goals: AgentGoal[]; untrustedData: true; grantsPermission: false }
export type AgentGoalScope = AgentThreadInteractionScope & { documentToken: string }
export type AgentGoalScopeReq = AgentThreadInteractionScope & { active: boolean; lifecycleRevision: number }
export type AgentGoalMutationReq = AgentGoalScope & AgentGoalMutation
export type AgentGoalShareReq = AgentGoalScope & {
  goalId: string; expectedGeneration: number; expectedRevision: number; profileId: string
  /** Optional user-selected limit on injected provider fetch calls, NOT goal turns or money. */
  maxProviderDispatches?: number
}
export type AgentGoalShare = {
  token: string; goalId: string; generation: number; profileId: string; expiresAt: number
  mode: 'progress-only'; budgetsEnforced: false; grantsPermission: false
  /** Prepared consent only. Enforcement begins only after main claims/adopts this request. */
  dispatchCap?: { maxProviderDispatches: number; unit: 'provider-fetch-delegate'; enforced: false; unaryOnly: true }
}
export type AgentGoalDispatchView = {
  revision: number; orphaned: boolean; mutationBlocked: boolean; scopeBlocked: boolean; capacityReached: boolean
  mode: 'data-only'; budgetsEnforced: false; grantsPermission: false
  /** Absent only in older inspection responses; never an execution selector. */
  payloadVersion?: 1 | 2
  v1ExecutionUnsupported?: true
  limits: { runs: number; attemptsPerRun: number; retainedReceipts: number }
  runs: Array<{
    id: string; goalId: string; generation: number; status: 'active' | 'finished' | 'unknown'
    startedAt: number; updatedAt: number; deadlineAt: number
    maxProviderDispatches: number; chargedProviderDispatches: number
    /** Absent means model/tool usage was not measured, NOT zero. Stored v2
     * counters are accounting DATA, not evidence that an invocation occurred. */
    unitAccounting?: {
      maxModelSteps: number; chargedModelSteps: number; maxToolInvocations: number; chargedToolInvocations: number
      units: Array<{ id: string; unit: 'modelStep' | 'toolInvocation' | 'providerDispatch'; parentId?: string; reservedAt: number; settledAt?: number; state: 'pending' | 'not-started' | 'not-dispatched' | 'completed' | 'failed' | 'response-complete' | 'unknown' }>
    }
    attempts: Array<{ id: string; reservedAt: number; settledAt?: number; state: 'pending' | 'not-dispatched' | 'response-complete' | 'unknown'; status?: number; responseBytes?: number }>
  }>
}
export type AgentGoalMutationResult =
  | (AgentGoalView & { status: 'applied'; operationId: string })
  // Only this retry was rejected before commit. An evicted prior receipt means
  // the original operation may already have committed; never infer never-applied.
  | { status: 'retry-not-applied'; priorOutcome: 'unknown'; operationId: string; reason: 'revision-conflict'; currentRevision: number }
