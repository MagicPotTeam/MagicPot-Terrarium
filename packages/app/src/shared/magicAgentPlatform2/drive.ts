import type { PolicyJsonValue } from './policy'

export type MagicAgentDriveStatus =
  | 'draft'
  | 'active'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type MagicAgentDriveLink = Readonly<{
  kind:
    | 'parent'
    | 'child'
    | 'blocks'
    | 'blocked-by'
    | 'related'
    | 'task-group'
    | 'session'
    | 'run'
    | 'artifact'
  targetId: string
}>

export type MagicAgentDriveDeliveryTarget = Readonly<{
  kind: 'agent'
  agentId: string
  text: string
  profileId?: string
  sessionId?: string
  allowedToolNames?: readonly string[]
}>

export type MagicAgentDriveState = Readonly<{
  id: string
  title: string
  objective: string
  status: MagicAgentDriveStatus
  priority: number
  ownerId?: string
  assigneeId?: string
  deliveryTarget?: MagicAgentDriveDeliveryTarget
  parentDriveId?: string
  links: readonly MagicAgentDriveLink[]
  metadata?: Readonly<Record<string, PolicyJsonValue>>
  progress?: Readonly<{
    summary: string
    reportedAt: number
    sequence: number
    evidence: readonly Readonly<{
      kind: 'session' | 'run' | 'artifact' | 'url' | 'text'
      ref: string
      digest?: string
    }>[]
  }>
  delivery?: Readonly<{
    attemptCount: number
    nextAttemptAt: number
    lease?: Readonly<{
      ownerId: string
      token: string
      expiresAt: number
    }>
    acknowledgedAt?: number
    deadLetteredAt?: number
    lastFailure?: Readonly<{
      failedAt: number
      reason: string
    }>
  }>
  terminalReason?: string
}>
