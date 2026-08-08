import type { PolicyJsonValue } from './policy'
import type { RuntimeTopologyAttribution } from './agentInstance'

export type RuntimeChannelMode = 'point-to-point' | 'queue' | 'broadcast'
export type RuntimeChannelMemberRole = 'producer' | 'consumer' | 'member'
export type RuntimeChannelGraphWakeRequest = Readonly<{
  graphId: string
  route: Readonly<{ channel: string; scopeType: string; scopeId: string }>
  input: PolicyJsonValue
}>

export type RuntimeChannelMember = Readonly<{
  memberId: string
  agentInstanceId?: string
  graphTargetId?: string
  graphWakeRequest?: RuntimeChannelGraphWakeRequest
  role: RuntimeChannelMemberRole
  joinedAt: number
}>
export type RuntimeChannelState = Readonly<{
  id: string
  name: string
  mode: RuntimeChannelMode
  /** Maximum number of unacknowledged messages; broadcast deliveries do not multiply capacity. */
  capacity: number
  members: readonly RuntimeChannelMember[]
  runtimeTopologyAttribution?: RuntimeTopologyAttribution
}>
export type RuntimeChannelMessageDelivery = Readonly<{
  consumerMemberId: string
  acknowledgedAt?: number
}>
export type RuntimeChannelQueueClaim = Readonly<{
  consumerMemberId: string
  token: string
  expiresAt: number
}>
export type RuntimeChannelWireState = Readonly<{
  id: string
  sourceChannelId: string
  targetChannelId: string
  targetPublisherMemberId: string
  enabled: boolean
  createdAt: number
  maxHops: number
  runtimeTopologyAttribution?: RuntimeTopologyAttribution
}>

export type RuntimeChannelForwardingState = Readonly<{
  id: string
  wireId: string
  sourceMessageId: string
  targetMessageId: string
  status: 'pending' | 'succeeded' | 'failed'
  attemptCount: number
  nextAttemptAt: number
  lastFailure?: string
  completedAt?: number
}>

export type RuntimeChannelMessageState = Readonly<{
  id: string
  channelId: string
  publisherMemberId: string
  payload: PolicyJsonValue
  priority: number
  publishedAt: number
  expiresAt?: number
  deliveries?: readonly RuntimeChannelMessageDelivery[]
  queueClaim?: RuntimeChannelQueueClaim
  acknowledgedAt?: number
  acknowledgedBy?: string
  wirePath?: readonly string[]
}>
