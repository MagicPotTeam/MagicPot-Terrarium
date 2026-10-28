import {
  HOST_COMMANDS,
  HOST_PLAN_VERSION,
  hostContextSchema,
  hostPlanSchema,
  type HostCommand,
  type HostContext,
  type HostPlan
} from './hostPlan'

/**
 * The context protocol and plan schema are intentionally independent.  A host can keep an
 * older context protocol while the bridge evolves the plan vocabulary (or vice versa), but a
 * pair is executable only when both sides are explicitly understood here.
 */
export const FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION = 1 as const
export const FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION = HOST_PLAN_VERSION
export const FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION = 1 as const

export const hostCompatibilityErrorCodes = [
  'INVALID_CONTEXT',
  'INVALID_PLAN',
  'UNSUPPORTED_CONTEXT_PROTOCOL',
  'UNSUPPORTED_PLAN_SCHEMA',
  'ADAPTER_HOST_MISMATCH',
  'ADAPTER_VERSION_UNSUPPORTED',
  'CAPABILITY_MISSING'
] as const
export type HostCompatibilityErrorCode = (typeof hostCompatibilityErrorCodes)[number]

export type HostCompatibilityFailure = {
  ok: false
  code: HostCompatibilityErrorCode
  missing?: readonly HostCommand[]
  adapterVersion?: string
  supportedMajor?: number
}

export type HostCompatibilitySuccess = {
  ok: true
  contextProtocol: typeof FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION
  planSchema: typeof FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION
  adapter: { state: 'planning-only' } | { state: 'current' | 'opaque'; version: string }
  commands: readonly HostCommand[]
}

export type HostCompatibilityResult = HostCompatibilitySuccess | HostCompatibilityFailure

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const knownAdapterPrefix = (host: HostContext['host']): string =>
  host === 'figma' ? 'figma-native-' : 'photoshop-uxp-native-'

/**
 * Negotiate the independent protocol/schema and host adapter capabilities before execution.
 * Unknown adapter identifiers are retained as opaque legacy versions for backwards compatibility;
 * known native identifiers are checked strictly so a Photoshop adapter cannot be used by Figma,
 * and a future major cannot be silently treated as compatible.
 */
export const negotiateHostPlanCompatibility = (
  rawContext: unknown,
  rawPlan: unknown
): HostCompatibilityResult => {
  const contextRecord = isRecord(rawContext) ? rawContext : undefined
  if (!contextRecord) return { ok: false, code: 'INVALID_CONTEXT' }
  if (contextRecord.version !== FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION)
    return { ok: false, code: 'UNSUPPORTED_CONTEXT_PROTOCOL' }
  const contextResult = hostContextSchema.safeParse(rawContext)
  if (!contextResult.success) return { ok: false, code: 'INVALID_CONTEXT' }
  const context = contextResult.data

  const planRecord = isRecord(rawPlan) ? rawPlan : undefined
  if (!planRecord) return { ok: false, code: 'INVALID_PLAN' }
  if (planRecord.schemaVersion !== FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION)
    return { ok: false, code: 'UNSUPPORTED_PLAN_SCHEMA' }
  const planResult = hostPlanSchema.safeParse(rawPlan)
  if (!planResult.success) return { ok: false, code: 'INVALID_PLAN' }
  const plan = planResult.data

  if (plan.captureId !== context.captureId) return { ok: false, code: 'INVALID_PLAN' }
  if (!context.execution) {
    return {
      ok: true,
      contextProtocol: FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION,
      planSchema: FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION,
      adapter: { state: 'planning-only' },
      commands: Object.freeze([])
    }
  }

  const adapterVersion = context.execution.adapterVersion
  const prefix = knownAdapterPrefix(context.host)
  const otherHostPrefix = context.host === 'figma' ? 'photoshop-uxp-native-' : 'figma-native-'
  if (adapterVersion.startsWith(otherHostPrefix))
    return { ok: false, code: 'ADAPTER_HOST_MISMATCH', adapterVersion }
  let adapterState: 'current' | 'opaque' = 'opaque'
  if (adapterVersion.startsWith(prefix)) {
    const majorText = adapterVersion.slice(prefix.length)
    if (!/^[1-9][0-9]*$/.test(majorText))
      return {
        ok: false,
        code: 'ADAPTER_VERSION_UNSUPPORTED',
        adapterVersion,
        supportedMajor: FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION
      }
    const major = Number(majorText)
    if (!Number.isSafeInteger(major) || major !== FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION)
      return {
        ok: false,
        code: 'ADAPTER_VERSION_UNSUPPORTED',
        adapterVersion,
        supportedMajor: FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION
      }
    adapterState = 'current'
  }

  const missing = [...new Set(plan.steps.map((step) => step.command))].filter(
    (command) => !context.execution!.supports.includes(command)
  )
  if (missing.length)
    return { ok: false, code: 'CAPABILITY_MISSING', missing: Object.freeze(missing) }

  return {
    ok: true,
    contextProtocol: FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION,
    planSchema: FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION,
    adapter: { state: adapterState, version: adapterVersion },
    commands: Object.freeze([...context.execution.supports])
  }
}

/** Throw a stable, machine-readable error when negotiation fails. */
export const assertHostPlanCompatibility = (
  rawContext: unknown,
  rawPlan: unknown
): HostCompatibilitySuccess => {
  const result = negotiateHostPlanCompatibility(rawContext, rawPlan)
  if (!result.ok) throw new Error(result.code)
  return result
}

/** Runtime guard for callers that only need to validate a capability list. */
export const isKnownHostCommand = (value: unknown): value is HostCommand =>
  typeof value === 'string' && (HOST_COMMANDS as readonly string[]).includes(value)
