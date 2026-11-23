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
  /** Epoch ms; null when the prompt is open-ended (ask_user/show_card without timeout_s). */
  expiresAt: number | null
  prompt: AgentThreadInteractionPrompt
}

export const isAgentThreadInteractionExpired = (
  interaction: Pick<AgentThreadInteraction, 'expiresAt'>,
  now = Date.now()
): boolean => interaction.expiresAt !== null && now >= interaction.expiresAt

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
  /** show_app only; ask_user/show_card wait open-ended unless timeout_s is given. */
  defaultTimeoutSeconds: 300,
  maxTimeoutSeconds: 600,
  /** Largest timeout_s a timer can honour (setTimeout ceiling, 2^31-1 ms). */
  maxFeedbackTimeoutSeconds: 2_147_483
} as const
