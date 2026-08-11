import type { MagicAgentDriveState } from '../../../shared/magicAgentPlatform2/drive'
import type {
  MagicAgentPlatformRunReq,
  MagicAgentPlatformRunResp
} from '../../../shared/api/svcMagicAgentPlatform'
import type { ServiceInvocationContext } from '../../../shared/api/apiUtils/serviceInvocation'
import { attachDriveTrustedDispatchContext } from '../../magicAgentRuntime/driveTrustedDispatchContext'
import type { StoredResource } from '../persistence/eventStore'

export const DRIVE_ROUTE = 'magicpot-drive://runtime' as const
export const DRIVE_INVOCATION = {
  methodName: 'magic-agent.drive.deliver',
  senderUrl: DRIVE_ROUTE,
  isMainFrame: true
} as const

export const createProductionDriveDelivery =
  (service: {
    runAgent: (
      request: MagicAgentPlatformRunReq,
      invocation?: ServiceInvocationContext
    ) => Promise<MagicAgentPlatformRunResp>
  }) =>
  async (drive: StoredResource<MagicAgentDriveState>): Promise<void> => {
    const target = drive.state.deliveryTarget
    if (!target) throw new Error('Drive delivery target is missing.')
    await service.runAgent(
      attachDriveTrustedDispatchContext(
        {
          route: { channel: DRIVE_ROUTE, scopeType: 'channel', scopeId: drive.id },
          agentId: target.agentId,
          text: target.text,
          ...(target.profileId === undefined ? {} : { profileId: target.profileId }),
          ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
          ...(target.allowedToolNames === undefined
            ? {}
            : { allowedToolNames: [...target.allowedToolNames] }),
          metadata: { driveId: drive.id, driveRevision: drive.revision }
        },
        {
          driveId: drive.id,
          driveRevision: drive.revision,
          status: drive.state.status,
          ...(drive.state.assigneeId === undefined ? {} : { assigneeId: drive.state.assigneeId }),
          ...(drive.state.ownerId === undefined ? {} : { ownerId: drive.state.ownerId }),
          targetAgentId: target.agentId,
          ...(target.sessionId === undefined ? {} : { targetSessionId: target.sessionId })
        }
      ),
      DRIVE_INVOCATION
    )
  }
import { DriveCommandService } from './driveCommandService'
import {
  ProductionDriveRuntime,
  type ProductionDriveRuntimeOptions
} from './productionDriveRuntime'

export type ProductionDriveLifecycleOptions = ProductionDriveRuntimeOptions

export class ProductionDriveLifecycle {
  readonly runtime: ProductionDriveRuntime
  readonly commands: DriveCommandService

  constructor(options: ProductionDriveLifecycleOptions) {
    this.runtime = new ProductionDriveRuntime(options)
    this.commands = new DriveCommandService(this.runtime)
  }

  start(): void {
    this.runtime.start()
  }
  async close(): Promise<void> {
    await this.runtime.stop()
  }
}

let active: ProductionDriveLifecycle | undefined

export const getProductionDriveLifecycle = (): ProductionDriveLifecycle | undefined => active

export const startProductionDriveLifecycle = (
  options: ProductionDriveLifecycleOptions
): ProductionDriveLifecycle => {
  if (active) return active
  active = new ProductionDriveLifecycle(options)
  active.start()
  return active
}

export const closeProductionDriveLifecycle = async (): Promise<void> => {
  const current = active
  active = undefined
  await current?.close()
}

export type ProductionDriveDelivery = (drive: StoredResource<MagicAgentDriveState>) => Promise<void>
