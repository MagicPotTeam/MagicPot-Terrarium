import type { Config } from '@shared/config/config'
import type { MagicAgentPlatformRunReq, MagicAgentPlatformRunResp } from '@shared/api/svcMagicAgentPlatform'
import type {
  ManagedTextFirstRunRuntimeClosure,
  ManagedTextFirstRunRuntimeClosureData,
  ManagedTextFirstRunRuntimeContext,
  ManagedTextFirstRunRuntimePlan,
  PreparedManagedTextFirstRunRuntime
} from '../assistantRuntime/managedTextFirstRunRuntime'

/** MAIN-only routing facade. Neither this facade nor its preview/plan authenticates
 * production owner, approval or durable admission. No wire service exposes it.
 * Material/digest describes the runtime input; agentId is pinned response identity,
 * not a policy grant. The production owner must bind its own immutable provenance. */
export type ManagedTextFirstRunPlatformFacade = Readonly<{
  prepare(request: MagicAgentPlatformRunReq, config: Config): PreparedManagedTextFirstRunRuntime
  start(plan: ManagedTextFirstRunRuntimePlan, context: ManagedTextFirstRunRuntimeContext): Readonly<{
    result: Promise<MagicAgentPlatformRunResp>
    closed: Promise<ManagedTextFirstRunRuntimeClosure>
  }>
  consumeClosure(closure: ManagedTextFirstRunRuntimeClosure, context: ManagedTextFirstRunRuntimeContext): ManagedTextFirstRunRuntimeClosureData
}>
