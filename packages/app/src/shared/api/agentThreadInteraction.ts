import type { AgentThreadChoiceCardPrompt } from './agentThreadCardDisplay'
import type { AgentAppDocument, AgentAppValues } from './agentThreadApp'
import type { AgentRouteLike } from '@shared/agent'

/** Conversation feedback only. Never an execution permit or a mutation approval. */
export type AgentThreadInteractionScope = {
  route: AgentRouteLike
  conversationId: string
}

export type AgentThreadInteractionPrompt =
  | { kind: 'show_app'; document: AgentAppDocument }
  | { kind: 'ask_user'; question: string; placeholder?: string; multiline?: boolean }
  | AgentThreadChoiceCardPrompt

export type AgentThreadInteraction = {
  id: string
  expiresAt: number
  prompt: AgentThreadInteractionPrompt
}

export type AgentThreadInteractionAnswer =
  | { status: 'answered'; text: string }
  | { status: 'answered'; actionId: string }
  | { status: 'answered'; values: AgentAppValues }
  | { status: 'dismissed' }

export type AgentThreadInteractionResult = AgentThreadInteractionAnswer | { status: 'timeout' }
export type ResolveAgentThreadInteractionReq = AgentThreadInteractionScope & {
  interactionId: string
  answer: AgentThreadInteractionAnswer
}

export const AGENT_THREAD_INTERACTION_LIMITS = {
  question: 2000,
  title: 200,
  body: 4000,
  answer: 4000,
  actionLabel: 200,
  defaultTimeoutSeconds: 300,
  maxTimeoutSeconds: 600
} as const
