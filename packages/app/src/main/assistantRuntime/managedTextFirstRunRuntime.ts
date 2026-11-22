import { isProxy } from 'node:util/types'
import { sinkUnsupportedProviderRejection } from '../../shared/llm/providerRawWork'
import type { ManagedTextFirstRunMaterial, PreparedManagedTextFirstRun } from '../llmProxy/managedTextFirstRun'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { managedOwnValues } from '../magicAgentPlatform2/agents/managedRuntimeSnapshot'
import type { AssistantArtifactRef, AssistantInboundMessage, AssistantRoute, AssistantRunEvent, AssistantRuntimeResult, AssistantWorkspaceState } from './types'

/** MAIN-only dependencies supplied by the actual owner. These callback identities
 * are not authenticated by this type or by a plan; production policy remains the
 * caller's responsibility. Completion is deliberately independent of abort. */
export type ManagedTextFirstRunRuntimeContext = Readonly<{
  controller: AbortController
  cooperativeExecution: CooperativeExecutionController
  runId: string
  assertDispatchCurrent: () => void
  assertCompletionCurrent: () => void
}>
declare const runtimePlanBrand: unique symbol
declare const runtimeClosureBrand: unique symbol
export type ManagedTextFirstRunRuntimePlan = Readonly<{ [runtimePlanBrand]: true }>
export type ManagedTextFirstRunRuntimeClosure = Readonly<{ [runtimeClosureBrand]: true }>
export type ManagedTextFirstRunRuntimeMaterial = Readonly<{
  protocol: 'assistant-final-input/v1'
  route: AssistantRoute
  model: ManagedTextFirstRunMaterial
  storage: Readonly<{
    route: AssistantRoute
    workspace: Readonly<AssistantWorkspaceState>
    history: 'new-private-session'
    reusableContext: 'none'
    eventDelivery: 'awaited-store-only'
  }>
  digest: string
}>
export type PreparedManagedTextFirstRunRuntime = Readonly<{
  plan: ManagedTextFirstRunRuntimePlan
  material: ManagedTextFirstRunRuntimeMaterial
}>
export type ManagedTextFirstRunRuntimeOutcome = 'completed' | 'cancelled' | 'failed'
export type ManagedTextFirstRunRuntimeResult = AssistantRuntimeResult & {
  runId: string
  status: ManagedTextFirstRunRuntimeOutcome
  events: AssistantRunEvent[]
  artifacts: AssistantArtifactRef[]
  executionMode: 'isolated'
  executionHistorySize: 1
}
export type ManagedTextFirstRunRuntimeExecution = Readonly<{
  result: Promise<ManagedTextFirstRunRuntimeResult>
  closed: Promise<ManagedTextFirstRunRuntimeClosure>
}>
export type ManagedTextFirstRunRuntimeClosureData = Readonly<{
  protocol: 'assistant-bounded-closure/v1'
  runId: string
  finalInputDigest: string
  outcome: ManagedTextFirstRunRuntimeOutcome
}>
export type ManagedTextFirstRunRuntimePreparedRecord = {
  plan: ManagedTextFirstRunRuntimePlan
  model: PreparedManagedTextFirstRun
  request: AssistantInboundMessage
  material: ManagedTextFirstRunRuntimeMaterial
  used: boolean
}

/** Callbacks must be synchronous guards, never detached async permission checks. */
export function assertManagedTextFirstRunGuard(guard: () => void): void {
  const returned: unknown = guard()
  if (returned !== undefined) {
    sinkUnsupportedProviderRejection(returned)
    throw Error('Managed first-run authority checks must return synchronously without a result.')
  }
}

export function captureManagedTextFirstRunRuntimeContext(input: ManagedTextFirstRunRuntimeContext): ManagedTextFirstRunRuntimeContext {
  const values = managedOwnValues(input)
  if (Object.keys(values).some(key => !['controller', 'cooperativeExecution', 'runId', 'assertDispatchCurrent', 'assertCompletionCurrent'].includes(key)) ||
      isProxy(values.controller) || !(values.controller instanceof AbortController) ||
      isProxy(values.cooperativeExecution) || !(values.cooperativeExecution instanceof CooperativeExecutionController) ||
      typeof values.runId !== 'string' || !values.runId || values.runId.length > 200 || values.runId.trim() !== values.runId || Array.from(values.runId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      typeof values.assertDispatchCurrent !== 'function' || typeof values.assertCompletionCurrent !== 'function')
    throw Error('Managed first-run requires the exact original controller, root and private execution context.')
  return Object.freeze(values) as ManagedTextFirstRunRuntimeContext
}

/** Caller cancellation is not raw-work completion. Observe the owned producer
 * independently and remove only this caller's abort listener upon settlement. */
export function managedTextFirstRunCaller<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    void work.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}
