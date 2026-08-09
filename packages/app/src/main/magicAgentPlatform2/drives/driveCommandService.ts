import type {
  MagicAgentDriveLink,
  MagicAgentDriveState,
  MagicAgentDriveStatus
} from '../../../shared/magicAgentPlatform2/drive'
import type { StoredResource } from '../persistence/eventStore'
import { publishDriveState } from './driveStateEvents'
import type { ProductionDriveRuntime } from './productionDriveRuntime'

export type DriveCommandServiceRuntime = Pick<ProductionDriveRuntime, 'store'>

export class DriveCommandError extends Error {
  constructor(
    readonly code: 'not-found' | 'revision-conflict' | 'invalid-state' | 'invalid-command',
    message: string
  ) {
    super(message)
    this.name = 'DriveCommandError'
  }
}

const normalize = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error)
  const code = /not found/i.test(message)
    ? 'not-found'
    : /revision conflict|idempotency conflict|already exists/i.test(message)
      ? 'revision-conflict'
      : /invalid drive transition|terminal drive/i.test(message)
        ? 'invalid-state'
        : 'invalid-command'
  throw new DriveCommandError(code, message)
}

export class DriveCommandService {
  constructor(private readonly runtime: DriveCommandServiceRuntime) {}

  listDrives(): readonly StoredResource<MagicAgentDriveState>[] {
    return this.runtime.store.list()
  }

  getDrive(driveId: string): StoredResource<MagicAgentDriveState> | undefined {
    if (!driveId.trim()) throw new DriveCommandError('invalid-command', 'driveId is required.')
    return this.runtime.store.get(driveId)
  }

  create(input: { drive: MagicAgentDriveState; createdAt: number; idempotencyKey: string }) {
    try {
      const existing = this.runtime.store.get(input.drive.id)
      const resource = this.runtime.store.create(input)
      if (!existing && resource.revision === 0)
        publishDriveState({
          eventId: `drive-state:${resource.id}:${resource.revision}:${input.createdAt}`,
          driveId: resource.id,
          status: resource.state.status,
          revision: resource.revision,
          changedAt: input.createdAt
        })
      return resource
    } catch (error) {
      return normalize(error)
    }
  }

  transition(input: {
    driveId: string
    expectedRevision: number
    status: MagicAgentDriveStatus
    transitionedAt: number
    idempotencyKey: string
    reason?: string
  }) {
    try {
      const existingRevision = this.runtime.store.get(input.driveId)?.revision
      const previousStatus = this.runtime.store.get(input.driveId)?.state.status
      const resource = this.runtime.store.transition(input)
      if (
        existingRevision === input.expectedRevision &&
        resource.revision === input.expectedRevision + 1
      )
        publishDriveState({
          eventId: `drive-state:${resource.id}:${resource.revision}:${input.transitionedAt}`,
          driveId: resource.id,
          ...(previousStatus === undefined ? {} : { previousStatus }),
          status: resource.state.status,
          revision: resource.revision,
          changedAt: input.transitionedAt
        })
      return resource
    } catch (error) {
      return normalize(error)
    }
  }

  transfer(input: {
    driveId: string
    expectedRevision: number
    ownerId?: string
    assigneeId?: string
    transferredAt: number
    idempotencyKey: string
  }) {
    try {
      return this.runtime.store.transfer(input)
    } catch (error) {
      return normalize(error)
    }
  }

  reportProgress(input: {
    driveId: string
    expectedRevision: number
    summary: string
    evidence: NonNullable<MagicAgentDriveState['progress']>['evidence']
    reportedAt: number
    idempotencyKey: string
  }) {
    try {
      return this.runtime.store.reportProgress(input)
    } catch (error) {
      return normalize(error)
    }
  }

  retryDelivery(input: {
    driveId: string
    expectedRevision: number
    retryAt: number
    idempotencyKey: string
  }) {
    try {
      return this.runtime.store.retryDelivery(input)
    } catch (error) {
      return normalize(error)
    }
  }

  setLinks(input: {
    driveId: string
    expectedRevision: number
    links: readonly MagicAgentDriveLink[]
    updatedAt: number
    idempotencyKey: string
  }) {
    try {
      return this.runtime.store.setLinks(input)
    } catch (error) {
      return normalize(error)
    }
  }
}
