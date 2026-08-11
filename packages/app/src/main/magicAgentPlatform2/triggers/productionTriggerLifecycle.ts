import { subscribeDriveStates } from '../drives/driveStateEvents'
import type { PolicyJsonRecord, PolicyRequest } from '../../../shared/magicAgentPlatform2/policy'
import type {
  MagicAgentPlatformRunReq,
  MagicAgentPlatformGraphRunReq
} from '@shared/api/svcMagicAgentPlatform'
import type { AgentRouteLike } from '@shared/agent'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { AssistantTerminalPolicyRuntime } from '../productionRuntime'
import { subscribeWorkflowCompletions } from './workflowCompletionEvents'
import { subscribeTrustedChannelMessages } from './channelMessageEvents'
import { ProductionTriggerRuntime } from './productionTriggerRuntime'
import type { PersistentTriggerState } from './persistentTriggerStore'
import { attachTriggerTrustedDispatchContext } from '../../magicAgentRuntime/triggerTrustedDispatchContext'

export const TRIGGER_ROUTE = 'magicpot-trigger://runtime' as const
const SERVICE_ROUTE = (scopeId: string): AgentRouteLike => ({
  channel: 'magic-agent-trigger',
  scopeType: 'agent',
  scopeId,
  threadId: 'trigger-runtime'
})
const TRIGGER_INVOCATION: ServiceInvocationContext = {
  methodName: 'magic-agent.trigger.run',
  senderUrl: TRIGGER_ROUTE,
  isMainFrame: true
}

type LifecycleService = Readonly<{
  runAgent: (
    request: MagicAgentPlatformRunReq,
    invocation?: ServiceInvocationContext
  ) => unknown | Promise<unknown>
  runGraph: (
    request: MagicAgentPlatformGraphRunReq,
    invocation?: ServiceInvocationContext
  ) => unknown | Promise<unknown>
}>

export type ProductionTriggerLifecycleOptions = Readonly<{
  policyRuntime: AssistantTerminalPolicyRuntime
  service: LifecycleService
  routeResolver?: (trigger: PersistentTriggerState) => PolicyJsonRecord
  now?: () => number
  pollInterval?: number
  grantProvider?: (
    request: PolicyRequest
  ) =>
    | Promise<{ grantId: string; expectedGrantUseCount?: number } | undefined>
    | { grantId: string; expectedGrantUseCount?: number }
    | undefined
}>

let active: ProductionTriggerLifecycle | undefined

export class ProductionTriggerLifecycle {
  readonly runtime: ProductionTriggerRuntime<unknown>
  readonly eventStore: AssistantTerminalPolicyRuntime['eventStore']
  private started = false
  private unsubscribeChannelMessages: (() => void) | undefined
  private unsubscribeWorkflowCompletions: (() => void) | undefined
  private unsubscribeDriveStates: (() => void) | undefined

  constructor(options: ProductionTriggerLifecycleOptions) {
    this.eventStore = options.policyRuntime.eventStore
    this.runtime = new ProductionTriggerRuntime<unknown>({
      eventStore: this.eventStore,
      authorization: options.policyRuntime.authorization,
      service: {
        runAgent: (input) => {
          const request: MagicAgentPlatformRunReq = {
            agentId: input.agentId,
            text: input.prompt,
            route: SERVICE_ROUTE(input.agentId),
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
          }
          if (input.trustedContext)
            attachTriggerTrustedDispatchContext(request, input.trustedContext)
          return options.service.runAgent(request, TRIGGER_INVOCATION)
        },
        runGraph: (input) =>
          options.service.runGraph(
            {
              graphId: input.graphId,
              input: JSON.stringify(input.input),
              route: SERVICE_ROUTE(input.graphId),
              metadata: { triggerSessionId: input.sessionId }
            },
            TRIGGER_INVOCATION
          )
      },
      grantProvider: options.grantProvider ?? (() => undefined),
      routeResolver: options.routeResolver ?? (() => ({ kind: 'custom', value: TRIGGER_ROUTE })),
      now: options.now,
      pollInterval: options.pollInterval
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribeChannelMessages = subscribeTrustedChannelMessages((event) => {
      this.runtime.channelMessageSource.enqueue(event)
    })
    this.unsubscribeWorkflowCompletions = subscribeWorkflowCompletions((event) => {
      this.runtime.workflowCompletionSource.enqueue(event)
    })
    this.unsubscribeDriveStates = subscribeDriveStates((event) => {
      this.runtime.driveStateSource.enqueue(event)
    })
    this.runtime.start()
  }

  async close(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.unsubscribeChannelMessages?.()
    this.unsubscribeChannelMessages = undefined
    this.unsubscribeWorkflowCompletions?.()
    this.unsubscribeWorkflowCompletions = undefined
    this.unsubscribeDriveStates?.()
    this.unsubscribeDriveStates = undefined
    await this.runtime.stop()
  }
}

export const getProductionTriggerLifecycle = (): ProductionTriggerLifecycle | undefined => active

export const startProductionTriggerLifecycle = (
  options: ProductionTriggerLifecycleOptions
): ProductionTriggerLifecycle => {
  if (!active) {
    active = new ProductionTriggerLifecycle(options)
    active.start()
  }
  return active
}

export const closeProductionTriggerLifecycle = async (): Promise<void> => {
  if (!active) return
  const current = active
  active = undefined
  await current.close()
}
