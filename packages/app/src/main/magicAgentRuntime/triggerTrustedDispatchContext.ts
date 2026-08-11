import type { MagicAgentPlatformRunReq } from '@shared/api/svcMagicAgentPlatform'

export type TriggerTrustedDispatchContext = Readonly<{
  triggerId: string
  occurrenceId?: string
  requestId: string
  occurrenceAt: number
  triggerType: string
  triggerTitle: string
  targetAgentId: string
  targetSessionId?: string
  source?: string
  attempt?: number
}>

export const TRIGGER_TRUSTED_DISPATCH_CONTEXT: unique symbol = Symbol(
  'magicpot.trigger.trustedDispatchContext'
)

type TriggerTrustedRunRequest = MagicAgentPlatformRunReq & {
  [TRIGGER_TRUSTED_DISPATCH_CONTEXT]?: TriggerTrustedDispatchContext
}

const requireString = (value: unknown, field: string): string => {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new TypeError(`Trigger trusted context requires ${field}.`)
  return normalized
}

const optionalString = (value: unknown, field: string): string | undefined =>
  value === undefined ? undefined : requireString(value, field)

export const attachTriggerTrustedDispatchContext = (
  request: MagicAgentPlatformRunReq,
  context: TriggerTrustedDispatchContext
): MagicAgentPlatformRunReq => {
  if (!Number.isSafeInteger(context.occurrenceAt) || context.occurrenceAt < 0) {
    throw new TypeError('Trigger trusted context requires a non-negative integer occurrenceAt.')
  }
  if (
    context.attempt !== undefined &&
    (!Number.isSafeInteger(context.attempt) || context.attempt < 0)
  ) {
    throw new TypeError('Trigger trusted context attempt must be a non-negative integer.')
  }
  const validated = Object.freeze({
    triggerId: requireString(context.triggerId, 'triggerId'),
    ...(context.occurrenceId === undefined
      ? {}
      : { occurrenceId: optionalString(context.occurrenceId, 'occurrenceId') }),
    requestId: requireString(context.requestId, 'requestId'),
    occurrenceAt: context.occurrenceAt,
    triggerType: requireString(context.triggerType, 'triggerType'),
    triggerTitle: requireString(context.triggerTitle, 'triggerTitle'),
    targetAgentId: requireString(context.targetAgentId, 'targetAgentId'),
    ...(context.targetSessionId === undefined
      ? {}
      : { targetSessionId: optionalString(context.targetSessionId, 'targetSessionId') }),
    ...(context.source === undefined ? {} : { source: optionalString(context.source, 'source') }),
    ...(context.attempt === undefined ? {} : { attempt: context.attempt })
  })
  Object.defineProperty(request, TRIGGER_TRUSTED_DISPATCH_CONTEXT, {
    value: validated,
    enumerable: true,
    configurable: false,
    writable: false
  })
  return request
}

export const readTriggerTrustedDispatchContext = (
  request: MagicAgentPlatformRunReq
): TriggerTrustedDispatchContext | undefined =>
  (request as TriggerTrustedRunRequest)[TRIGGER_TRUSTED_DISPATCH_CONTEXT]
