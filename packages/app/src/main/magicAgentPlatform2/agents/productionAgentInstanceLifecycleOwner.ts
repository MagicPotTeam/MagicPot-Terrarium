import type { MagicAgentPlatformSvcImpl } from '../../api/svcMagicAgentPlatformImpl'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import type { MagicAgentEventStore } from '../persistence/eventStore'
import { AgentTeamCommandService } from './agentTeamCommandService'
import { PersistentAgentTeamStore } from './persistentAgentTeamStore'
import { PersistentAgentTeamLifecycleOperationStore } from './persistentAgentTeamLifecycleOperationStore'
import { PersistentAgentConfigStore } from './persistentAgentConfigStore'
import { AgentInstanceCommandService } from './agentInstanceCommandService'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import { ProductionAgentInstanceLifecycleService } from './productionAgentInstanceLifecycle'

export const AGENT_INSTANCE_ROUTE = 'magicpot-agent-instance://runtime' as const
export const AGENT_INSTANCE_INVOCATION = {
  methodName: 'magic-agent.instance.run',
  senderUrl: AGENT_INSTANCE_ROUTE,
  isMainFrame: true
} as const

export class ProductionAgentInstanceLifecycle {
  readonly store: PersistentAgentInstanceStore
  readonly service: ProductionAgentInstanceLifecycleService
  readonly teamStore: PersistentAgentTeamStore
  readonly teamLifecycleOperations: PersistentAgentTeamLifecycleOperationStore
  readonly teams: AgentTeamCommandService
  readonly configStore: PersistentAgentConfigStore
  readonly commands: AgentInstanceCommandService

  constructor(options: {
    eventStore: MagicAgentEventStore
    authorization: MagicAgentPolicyAuthorizationService
    platformService: Pick<MagicAgentPlatformSvcImpl, 'runAgent'>
    runAgent?: ConstructorParameters<typeof ProductionAgentInstanceLifecycleService>[2]
    now?: () => number
  }) {
    this.store = new PersistentAgentInstanceStore(options.eventStore)
    this.configStore = new PersistentAgentConfigStore(options.eventStore)
    this.teamStore = new PersistentAgentTeamStore(options.eventStore)
    this.teamLifecycleOperations = new PersistentAgentTeamLifecycleOperationStore(
      options.eventStore
    )
    this.service = new ProductionAgentInstanceLifecycleService(
      this.store,
      options.authorization,
      options.runAgent ??
        ((request, runOptions) =>
          options.platformService.runAgent(request, AGENT_INSTANCE_INVOCATION, runOptions)),
      options.now,
      this.configStore
    )
    this.commands = new AgentInstanceCommandService(this.store, this.service, this.configStore)
    this.teams = new AgentTeamCommandService(
      this.teamStore,
      this.store,
      options.authorization,
      options.now,
      this.commands,
      this.teamLifecycleOperations
    )
  }

  start(): void {
    this.service.recoverInterrupted()
    for (const operation of this.teamLifecycleOperations.listRunning())
      this.teamLifecycleOperations.recoverInterrupted({ id: operation.id, recoveredAt: Date.now() })
  }

  async close(): Promise<void> {
    await this.service.close()
  }
}

let active: ProductionAgentInstanceLifecycle | undefined

export const getProductionAgentInstanceLifecycle = ():
  | ProductionAgentInstanceLifecycle
  | undefined => active

export const startProductionAgentInstanceLifecycle = (
  options: ConstructorParameters<typeof ProductionAgentInstanceLifecycle>[0]
): ProductionAgentInstanceLifecycle => {
  if (active) return active
  active = new ProductionAgentInstanceLifecycle(options)
  active.start()
  return active
}

export const closeProductionAgentInstanceLifecycle = async (): Promise<void> => {
  const current = active
  active = undefined
  await current?.close()
}
