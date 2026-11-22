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

type ReadinessState = { attempt: object | null; ready: object | null; retired: boolean; depth: number }
const readiness = new WeakMap<ProductionAgentInstanceLifecycle, ReadinessState>()
const readinessOf = (owner: ProductionAgentInstanceLifecycle): ReadinessState => {
  let state = readiness.get(owner)
  if (!state) {
    state = { attempt: null, ready: null, retired: false, depth: 0 }
    readiness.set(owner, state)
  }
  return state
}

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
    /** MAIN-only disabled-by-default composition; no IPC/SDK/UI forwarding. */
    managedFirstRun?: Omit<import('./managedFirstRunLifecycle').ManagedFirstRunDependencies, 'events'>
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
      this.configStore,
      options.managedFirstRun ? { ...options.managedFirstRun, events: options.eventStore } : undefined
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
    const state = readinessOf(this), attempt = {}
    // Invalidate before either recovery can synchronously re-enter. Nested/superseded
    // attempts cannot publish, even when their shared concrete owner is unchanged.
    state.attempt = attempt; state.ready = null; state.depth++
    let recovered = false
    try {
      this.service.recoverInterrupted()
      for (const operation of this.teamLifecycleOperations.listRunning())
        this.teamLifecycleOperations.recoverInterrupted({ id: operation.id, recoveredAt: Date.now() })
      recovered = true
    } finally {
      state.depth--
      if (recovered && state.depth === 0 && state.attempt === attempt && !state.retired && !this.service.isClosing())
        state.ready = attempt
    }
  }

  close(): Promise<void> {
    const state = readinessOf(this)
    state.retired = true; state.attempt = null; state.ready = null
    return this.service.close()
  }
}

let active: ProductionAgentInstanceLifecycle | undefined
let closing: Promise<void> | undefined

export const getProductionAgentInstanceLifecycle = ():
  | ProductionAgentInstanceLifecycle
  | undefined => active

export type ProductionAgentInstanceLifecycleReadinessCapture = Readonly<{
  lifecycle: ProductionAgentInstanceLifecycle
  isCurrent(): boolean
}>

/** MAIN-only already-ready reference. No initialization, DB-open/data-freshness proof or read grant. */
export const captureProductionAgentInstanceLifecycleReadiness = ():
  ProductionAgentInstanceLifecycleReadinessCapture | null => {
  const lifecycle = active
  if (!lifecycle || closing) return null
  const state = readiness.get(lifecycle), attempt = state?.ready
  if (!state || !attempt) return null
  const isCurrent = () => active === lifecycle && !closing && !state.retired && state.depth === 0 &&
    state.ready === attempt && state.attempt === attempt && !lifecycle.service.isClosing()
  return isCurrent() ? Object.freeze({ lifecycle, isCurrent }) : null
}

export const startProductionAgentInstanceLifecycle = (
  options: ConstructorParameters<typeof ProductionAgentInstanceLifecycle>[0]
): ProductionAgentInstanceLifecycle => {
  if (active) return active
  active = new ProductionAgentInstanceLifecycle(options)
  active.start()
  return active
}

export const closeProductionAgentInstanceLifecycle = (): Promise<void> => {
  if (closing) return closing
  const current = active
  if (!current) return Promise.resolve()
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const task = new Promise<void>((done, failed) => { resolve = done; reject = failed })
  void task.catch(() => undefined)
  // Keep this singleton reachable and publish the join before abort listeners
  // call start/close again. A publication/drain failure keeps reconstruction
  // blocked; an explicit recovery design is required, not an automatic retry.
  closing = task
  const succeeded = (): void => {
    if (active === current && closing === task) {
      active = undefined
      closing = undefined
    }
    resolve()
  }
  try { void current.close().then(succeeded, reject) }
  catch (error) { reject(error) }
  return task
}
