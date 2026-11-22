import type { AgentThreadInteractionScope } from './agentThreadInteraction'

export const AGENT_SIDE_LIMITS = {
  branchesPerScope: 12, branchesGlobal: 128, activePerScope: 1, activeGlobal: 4,
  snapshotMessages: 24, snapshotCharacters: 24000, messageCharacters: 16000,
  questionCharacters: 8000, transcriptBytes: 256 * 1024, transcriptMessages: 128,
  recordBytes: 384 * 1024, cipherBytes: 480 * 1024, storedCipherBytes: 64 * 1024 * 1024,
  turns: 16, stepsPerTurn: 8, readsPerTurn: 12, stepsPerBranch: 64, readsPerBranch: 96,
  modelOutputTokens: 2048, timeoutMs: 180000, receipts: 16
} as const
export type AgentSideStatus = 'running' | 'completed' | 'incomplete' | 'stopped' | 'interrupted' | 'failed' | 'budget_exhausted'
export type AgentSideMessage = { role: 'user' | 'assistant'; content: string; kind: 'question' | 'answer' | 'tool-call' | 'tool-result' | 'notice' }
export type AgentSideSummary = {
  id: string; revision: number; generation: number; status: AgentSideStatus
  title: string; createdAt: number; updatedAt: number; turns: number
  modelSteps: number; toolCalls: number; snapshotTruncated: boolean
  profileId: string; modelLabel: string; canContinue: boolean; busy: boolean
}
export type AgentSideOpen = { branch: AgentSideSummary; messages: AgentSideMessage[]; snapshotCharacters: number; untrustedData: true }
export type AgentSideReq = AgentThreadInteractionScope & { branchId: string }
export type AgentSideStartReq = AgentSideReq & {
  operationId: string; question: string; profileId: string
  snapshot: Array<{ role: 'user' | 'assistant'; content: string }>
}
export type AgentSideContinueReq = AgentSideReq & { operationId: string; expectedRevision: number; question: string }
export type AgentSideMutationReq = AgentSideReq & { expectedRevision: number }
