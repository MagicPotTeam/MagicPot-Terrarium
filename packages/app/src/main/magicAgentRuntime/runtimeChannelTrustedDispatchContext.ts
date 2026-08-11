import type { MagicAgentPlatformRunReq } from '@shared/api/svcMagicAgentPlatform'

export type RuntimeChannelTrustedDispatchContext = Readonly<{
  channelId: string
  memberId: string
  pendingMessageIds: readonly string[]
  agentInstanceId: string
}>

export const RUNTIME_CHANNEL_TRUSTED_DISPATCH_CONTEXT: unique symbol = Symbol(
  'magicpot.runtimeChannel.trustedDispatchContext'
)

type RuntimeChannelTrustedRunRequest = MagicAgentPlatformRunReq & {
  [RUNTIME_CHANNEL_TRUSTED_DISPATCH_CONTEXT]?: RuntimeChannelTrustedDispatchContext
}

const requireId = (value: unknown, field: string): string => {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new TypeError(`Runtime Channel trusted context requires ${field}.`)
  return normalized
}

export const attachRuntimeChannelTrustedDispatchContext = (
  request: MagicAgentPlatformRunReq,
  context: RuntimeChannelTrustedDispatchContext
): MagicAgentPlatformRunReq => {
  const pendingMessageIds = context.pendingMessageIds.map((id) =>
    requireId(id, 'pendingMessageIds')
  )
  if (!pendingMessageIds.length) {
    throw new TypeError('Runtime Channel trusted context requires pendingMessageIds.')
  }
  const validated = Object.freeze({
    channelId: requireId(context.channelId, 'channelId'),
    memberId: requireId(context.memberId, 'memberId'),
    pendingMessageIds: Object.freeze(pendingMessageIds),
    agentInstanceId: requireId(context.agentInstanceId, 'agentInstanceId')
  })
  Object.defineProperty(request, RUNTIME_CHANNEL_TRUSTED_DISPATCH_CONTEXT, {
    value: validated,
    enumerable: true,
    configurable: false,
    writable: false
  })
  return request
}

export const readRuntimeChannelTrustedDispatchContext = (
  request: MagicAgentPlatformRunReq
): RuntimeChannelTrustedDispatchContext | undefined =>
  (request as RuntimeChannelTrustedRunRequest)[RUNTIME_CHANNEL_TRUSTED_DISPATCH_CONTEXT]
