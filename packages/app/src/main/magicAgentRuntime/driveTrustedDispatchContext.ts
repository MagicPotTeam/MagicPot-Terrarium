import type { MagicAgentPlatformRunReq } from '@shared/api/svcMagicAgentPlatform'
import type { MagicAgentDriveStatus } from '../../shared/magicAgentPlatform2/drive'

export type DriveTrustedDispatchContext = Readonly<{
  driveId: string
  driveRevision: number
  status: MagicAgentDriveStatus
  assigneeId?: string
  ownerId?: string
  targetAgentId: string
  targetSessionId?: string
}>

export const DRIVE_TRUSTED_DISPATCH_CONTEXT: unique symbol = Symbol(
  'magicpot.drive.trustedDispatchContext'
)

type DriveTrustedRunRequest = MagicAgentPlatformRunReq & {
  [DRIVE_TRUSTED_DISPATCH_CONTEXT]?: DriveTrustedDispatchContext
}

const requireId = (value: unknown, field: string): string => {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new TypeError(`Drive trusted context requires ${field}.`)
  return normalized
}

const optionalId = (value: unknown, field: string): string | undefined =>
  value === undefined ? undefined : requireId(value, field)

export const attachDriveTrustedDispatchContext = (
  request: MagicAgentPlatformRunReq,
  context: DriveTrustedDispatchContext
): MagicAgentPlatformRunReq => {
  if (!Number.isSafeInteger(context.driveRevision) || context.driveRevision < 0) {
    throw new TypeError('Drive trusted context requires a non-negative integer driveRevision.')
  }
  const validated = Object.freeze({
    driveId: requireId(context.driveId, 'driveId'),
    driveRevision: context.driveRevision,
    status: requireId(context.status, 'status') as MagicAgentDriveStatus,
    ...(context.assigneeId === undefined
      ? {}
      : { assigneeId: optionalId(context.assigneeId, 'assigneeId') }),
    ...(context.ownerId === undefined ? {} : { ownerId: optionalId(context.ownerId, 'ownerId') }),
    targetAgentId: requireId(context.targetAgentId, 'targetAgentId'),
    ...(context.targetSessionId === undefined
      ? {}
      : { targetSessionId: optionalId(context.targetSessionId, 'targetSessionId') })
  })
  Object.defineProperty(request, DRIVE_TRUSTED_DISPATCH_CONTEXT, {
    value: validated,
    enumerable: true,
    configurable: false,
    writable: false
  })
  return request
}

export const readDriveTrustedDispatchContext = (
  request: MagicAgentPlatformRunReq
): DriveTrustedDispatchContext | undefined =>
  (request as DriveTrustedRunRequest)[DRIVE_TRUSTED_DISPATCH_CONTEXT]
