import { z } from 'zod'
import { figPluginRuntimeBindingSchema } from './bridge'
import { FIGPLUGIN_HOSTS, canonicalFigPluginJson } from './manifest'
import type { FigPluginHost } from './manifest'
import {
  FIGPLUGIN_PLAN_MAX_BYTES,
  FIGPLUGIN_PLAN_MAX_STEPS,
  figPluginPlanSchema,
  snapshotFigPluginPlanData
} from './plan'

/**
 * This module is an inert contract only. It is not registered with a transport, does not dispatch a
 * host API, and does not create a runtime/profile/manifest capability. Schema validity is never a
 * grant, host identity, attestation, rollback proof, or write approval. In particular, metadata and
 * hashes are integrity references for a future main-owned binding; they do not authorize anything.
 */
export const FIGPLUGIN_NATIVE_COMMAND_DOMAIN = 'figplugin-native-rename' as const
export const FIGPLUGIN_NATIVE_COMMAND_VERSION = 1 as const
export const FIGPLUGIN_NATIVE_PRODUCTION_AVAILABLE = false as const
export const FIGPLUGIN_NATIVE_COMMAND = 'node.rename' as const

export const FIGPLUGIN_NATIVE_TOTAL_WIRE_BYTES = 64 * 1024
export const FIGPLUGIN_NATIVE_INTENT_BYTES = 8 * 1024
export const FIGPLUGIN_NATIVE_BINDING_BYTES = 4 * 1024
export const FIGPLUGIN_NATIVE_MAX_PROGRESS_EVENTS = 32
export const FIGPLUGIN_NATIVE_MAX_PROGRESS_CURSOR = 1_000_000_000

const nativeHostSchema = z.enum(FIGPLUGIN_HOSTS)
const protocolFields = {
  domain: z.literal(FIGPLUGIN_NATIVE_COMMAND_DOMAIN),
  version: z.literal(FIGPLUGIN_NATIVE_COMMAND_VERSION)
}
const hex32Schema = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const sha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
const safeIntegerSchema = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER)
const boundedTotalSchema = z.number().int().min(1).max(FIGPLUGIN_PLAN_MAX_STEPS)
const boundedIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(FIGPLUGIN_PLAN_MAX_STEPS - 1)
const boundedOrdinalSchema = z.number().int().min(1).max(FIGPLUGIN_PLAN_MAX_STEPS)
const effectSchema = z.enum(['none', 'applied', 'partial', 'rolled-back', 'unknown'])
const observationSchema = z.enum(['original', 'requested', 'other', 'unknown'])
const phaseSchema = z.enum([
  'capturing',
  'awaiting-write-consent',
  'approved',
  'claimed',
  'executing',
  'readback',
  'settled'
])
const lifecycleStatusSchema = z.enum([
  'queued',
  'capturing',
  'awaiting-write-consent',
  'approved',
  'claimed',
  'executing',
  'readback',
  'completed',
  'cancelled',
  'failed',
  'expired',
  'quarantined'
])
const terminalStatusSchema = z.enum(['completed', 'cancelled', 'failed', 'expired', 'quarantined'])
const unverifiedEvidenceSchema = z.literal('unverified-host-report')

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(canonicalFigPluginJson(value)).byteLength

const addIssue = (context: z.RefinementCtx, message: string, path: (string | number)[] = []) =>
  context.addIssue({ code: z.ZodIssueCode.custom, message, path })

/** Existing runtime binding is deliberately reused. The guard prevents its identifier/hash
 * normalizers from changing authority material before the shared contract returns it. */
const exactRuntimeBindingSchema = z.preprocess((value, context) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const exactStringKeys = [
      'pluginId',
      'host',
      'bridgeOrigin',
      'projectId',
      'profileId',
      'artifactSha256',
      'signerFingerprint',
      'manifestSha256',
      'profileRevision'
    ]
    for (const key of exactStringKeys) {
      const item = record[key]
      if (typeof item === 'string' && item !== item.trim()) {
        addIssue(context, 'runtime binding references must not be normalized', [key])
        return z.NEVER
      }
    }
    for (const key of [
      'artifactSha256',
      'signerFingerprint',
      'manifestSha256',
      'profileRevision'
    ]) {
      const item = record[key]
      if (typeof item === 'string' && item !== item.toLowerCase()) {
        addIssue(context, 'runtime binding hashes must use exact lowercase hex', [key])
        return z.NEVER
      }
    }
  }
  return value
}, figPluginRuntimeBindingSchema)

/** This is the existing plan format, not a second collector or revision protocol. Its
 * selectionRevision remains opaque observation material and is never native revision/CAS evidence. */
const nativePlanSchema = figPluginPlanSchema.superRefine((plan, context) => {
  try {
    if (utf8Bytes(plan) > FIGPLUGIN_PLAN_MAX_BYTES) {
      addIssue(context, 'plan exceeds its UTF-8 byte bound')
    }
  } catch {
    addIssue(context, 'plan is not canonical JSON data')
  }

  const targets = new Set<string>()
  for (const [index, step] of plan.steps.entries()) {
    if (targets.has(step.targetId))
      addIssue(context, 'duplicate target', ['steps', index, 'targetId'])
    targets.add(step.targetId)
  }
})

export type FigPluginNativePlan = z.output<typeof nativePlanSchema>

const proposalPurpose = z.literal('native-rename-proposal')
export const figPluginNativeProposalSchema = z
  .object({
    ...protocolFields,
    purpose: proposalPurpose,
    host: nativeHostSchema,
    plan: nativePlanSchema
  })
  .strict()
export type FigPluginNativeProposal = z.output<typeof figPluginNativeProposalSchema>

const figmaGuaranteeSchema = z
  .object({
    host: z.literal('figma'),
    policy: z.literal('proposed'),
    availability: z.literal('production-unavailable'),
    profile: z.literal('figma-synchronous-detectable'),
    revision: z.literal('none'),
    exclusion: z.literal(false),
    rollback: z.literal('none'),
    cancellation: z.literal('before-dispatch-only')
  })
  .strict()

const photoshopGuaranteeSchema = z
  .object({
    host: z.literal('photoshop'),
    policy: z.literal('proposed'),
    availability: z.literal('production-unavailable'),
    profile: z.literal('photoshop-modal-history'),
    revision: z.literal('none'),
    exclusion: z.literal('modal-scope'),
    rollback: z.literal('scoped-history'),
    cancellation: z.literal('modal-cooperative')
  })
  .strict()

/** Host policy is a discriminated declaration for later main-owned evidence, never host JSON
 * enablement. Figma is intentionally weak; Photoshop history is not JSON-proven rollback. */
export const figPluginNativeGuaranteeSchema = z.discriminatedUnion('host', [
  figmaGuaranteeSchema,
  photoshopGuaranteeSchema
])
export type FigPluginNativeGuarantee = z.output<typeof figPluginNativeGuaranteeSchema>

const intentPurpose = z.literal('native-command-intent')
export const figPluginNativeIntentSchema = z
  .object({
    ...protocolFields,
    purpose: intentPurpose,
    host: nativeHostSchema,
    actionId: hex32Schema,
    binding: exactRuntimeBindingSchema,
    authorityEpoch: hex32Schema,
    instanceEpoch: hex32Schema,
    guarantee: figPluginNativeGuaranteeSchema,
    plan: nativePlanSchema,
    expiresAt: safeIntegerSchema.optional()
  })
  .strict()
  .superRefine((intent, context) => {
    if (intent.guarantee.host !== intent.host) {
      addIssue(context, 'guarantee host does not match intent host', ['guarantee', 'host'])
    }
    if (intent.binding.host !== intent.host) {
      addIssue(context, 'runtime binding host does not match intent host', ['binding', 'host'])
    }
    try {
      const { binding, ...intentCore } = intent
      if (utf8Bytes(intentCore) > FIGPLUGIN_NATIVE_INTENT_BYTES) {
        addIssue(context, 'intent core exceeds its UTF-8 byte bound', ['plan'])
      }
      if (utf8Bytes(binding) > FIGPLUGIN_NATIVE_BINDING_BYTES) {
        addIssue(context, 'runtime binding exceeds its metadata byte bound', ['binding'])
      }
    } catch {
      addIssue(context, 'intent is not canonical JSON data')
    }
  })
export type FigPluginNativeIntent = z.output<typeof figPluginNativeIntentSchema>

const transportIdentity = {
  ...protocolFields,
  actionId: hex32Schema,
  payloadSha256: sha256Schema,
  host: nativeHostSchema,
  command: z.literal(FIGPLUGIN_NATIVE_COMMAND),
  evidence: unverifiedEvidenceSchema.optional()
}

const hostEffectRefinement = (
  record: { host: FigPluginHost; effect: z.infer<typeof effectSchema> },
  context: z.RefinementCtx
) => {
  if (record.host === 'figma' && record.effect === 'rolled-back') {
    addIssue(context, 'Figma cannot report rolled-back effect')
  }
}

const claimPurpose = z.literal('native-command-claim')
export const figPluginNativeClaimSchema = z
  .object({
    ...transportIdentity,
    purpose: claimPurpose,
    total: boundedTotalSchema,
    claimedAt: safeIntegerSchema,
    expiresAt: safeIntegerSchema
  })
  .strict()
  .superRefine((claim, context) => {
    if (claim.expiresAt < claim.claimedAt) addIssue(context, 'claim expiry precedes claim time')
  })
export type FigPluginNativeClaim = z.output<typeof figPluginNativeClaimSchema>

const progressEventSchema = z
  .object({
    sequence: safeIntegerSchema.max(FIGPLUGIN_NATIVE_MAX_PROGRESS_CURSOR),
    ordinal: boundedOrdinalSchema,
    index: boundedIndexSchema,
    phase: phaseSchema,
    completed: safeIntegerSchema.max(FIGPLUGIN_PLAN_MAX_STEPS),
    total: boundedTotalSchema,
    effect: effectSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.index >= event.total) addIssue(context, 'progress index is outside total', ['index'])
    if (event.ordinal > event.total)
      addIssue(context, 'progress ordinal is outside total', ['ordinal'])
    if (event.completed > event.total)
      addIssue(context, 'progress completed count is outside total', ['completed'])
    if (
      ['capturing', 'awaiting-write-consent', 'approved', 'claimed'].includes(event.phase) &&
      (event.completed !== 0 || event.effect !== 'none')
    )
      addIssue(context, 'pre-dispatch progress cannot report completed steps or effects', ['phase'])
    if (event.effect === 'none' && event.completed !== 0)
      addIssue(context, 'none effect cannot report completed steps', ['effect'])
    if (event.effect === 'partial' && event.completed === event.total)
      addIssue(context, 'partial effect cannot report all steps completed', ['effect'])
    if (event.effect === 'applied' && event.completed !== event.total)
      addIssue(context, 'applied effect must report all steps completed', ['effect'])
  })
export type FigPluginNativeProgressEvent = z.output<typeof progressEventSchema>

const progressPurpose = z.literal('native-command-progress')
export const figPluginNativeProgressSchema = z
  .object({
    ...transportIdentity,
    purpose: progressPurpose,
    total: boundedTotalSchema,
    cursor: safeIntegerSchema.max(FIGPLUGIN_NATIVE_MAX_PROGRESS_CURSOR),
    events: z.array(progressEventSchema).max(FIGPLUGIN_NATIVE_MAX_PROGRESS_EVENTS)
  })
  .strict()
  .superRefine((progress, context) => {
    if (progress.events.length === 0 && progress.cursor !== 0) {
      addIssue(context, 'empty progress ring must have cursor zero', ['cursor'])
    }
    let previousSequence = 0
    for (const [index, event] of progress.events.entries()) {
      if (event.total !== progress.total)
        addIssue(context, 'event total does not match progress total', ['events', index, 'total'])
      if (event.sequence <= previousSequence)
        addIssue(context, 'progress sequences must increase', ['events', index, 'sequence'])
      if (event.sequence > progress.cursor)
        addIssue(context, 'event is ahead of progress cursor', ['events', index, 'sequence'])
      previousSequence = event.sequence
      hostEffectRefinement({ host: progress.host, effect: event.effect }, context)
    }
  })
export type FigPluginNativeProgress = z.output<typeof figPluginNativeProgressSchema>

const statusPurpose = z.literal('native-command-status')
export const figPluginNativeStatusSchema = z
  .object({
    ...transportIdentity,
    purpose: statusPurpose,
    status: lifecycleStatusSchema,
    total: boundedTotalSchema,
    completed: safeIntegerSchema.max(FIGPLUGIN_PLAN_MAX_STEPS),
    effect: effectSchema,
    updatedAt: safeIntegerSchema
  })
  .strict()
  .superRefine((status, context) => {
    if (status.completed > status.total)
      addIssue(context, 'status completed count is outside total', ['completed'])
    hostEffectRefinement(status, context)
    if (
      ['queued', 'capturing', 'awaiting-write-consent', 'approved', 'claimed'].includes(
        status.status
      ) &&
      (status.completed !== 0 || status.effect !== 'none')
    )
      addIssue(context, 'pre-dispatch status cannot report completed steps or effects', ['status'])
    if (status.effect === 'none' && status.completed !== 0) {
      addIssue(context, 'none effect cannot report completed steps', ['effect'])
    }
    if (status.effect === 'partial' && status.completed === status.total) {
      addIssue(context, 'partial effect cannot report all steps completed', ['effect'])
    }
    if (status.effect === 'applied' && status.completed !== status.total) {
      addIssue(context, 'applied effect must report all steps completed', ['effect'])
    }
  })
export type FigPluginNativeStatus = z.output<typeof figPluginNativeStatusSchema>

const readbackSchema = z
  .object({ index: boundedIndexSchema, observation: observationSchema })
  .strict()
export type FigPluginNativeReadback = z.output<typeof readbackSchema>

const resultPurpose = z.literal('native-command-result')
export const figPluginNativeResultSchema = z
  .object({
    ...transportIdentity,
    purpose: resultPurpose,
    status: terminalStatusSchema,
    total: boundedTotalSchema,
    completed: safeIntegerSchema.max(FIGPLUGIN_PLAN_MAX_STEPS),
    effect: effectSchema,
    settledAt: safeIntegerSchema,
    readback: z.array(readbackSchema).max(FIGPLUGIN_PLAN_MAX_STEPS)
  })
  .strict()
  .superRefine((result, context) => {
    if (result.completed > result.total)
      addIssue(context, 'result completed count is outside total', ['completed'])
    if (result.readback.length !== result.total)
      addIssue(context, 'result must contain one readback record per step', ['readback'])
    const indices = new Set<number>()
    for (const [position, record] of result.readback.entries()) {
      if (record.index >= result.total)
        addIssue(context, 'readback index is outside total', ['readback', position, 'index'])
      if (indices.has(record.index))
        addIssue(context, 'duplicate readback index', ['readback', position, 'index'])
      indices.add(record.index)
    }
    if (indices.size === result.total) {
      for (let index = 0; index < result.total; index += 1) {
        if (!indices.has(index))
          addIssue(context, 'readback indices must cover every step', ['readback'])
      }
    }
    hostEffectRefinement(result, context)
    if (
      result.effect === 'rolled-back' &&
      result.readback.some((record) => record.observation !== 'original')
    )
      addIssue(context, 'rollback claim requires original observation for every step', ['readback'])
    if (result.effect === 'none' && result.completed !== 0) {
      addIssue(context, 'none effect cannot report completed steps', ['effect'])
    }
    if (result.effect === 'partial' && result.completed === result.total) {
      addIssue(context, 'partial effect cannot report all steps completed', ['effect'])
    }
    if (result.effect === 'applied') {
      if (result.completed !== result.total) {
        addIssue(context, 'applied effect must report all steps completed', ['effect'])
      }
      if (result.readback.some((record) => record.observation !== 'requested')) {
        addIssue(context, 'applied effect requires requested observation for every step', [
          'readback'
        ])
      }
    }
  })
export type FigPluginNativeResult = z.output<typeof figPluginNativeResultSchema>

/** Independent user-consent material. It deliberately has no dialogue call, bridge approval,
 * pairing, host, binding, or grant field. Validity of this object alone grants nothing; main owns
 * any future single final-hash binding and must not mint it from this input. */
export const figPluginNativeWriteConsentSchema = z
  .object({
    ...protocolFields,
    purpose: z.literal('native-write-consent'),
    actionId: hex32Schema,
    payloadSha256: sha256Schema
  })
  .strict()
export type FigPluginNativeWriteConsent = z.output<typeof figPluginNativeWriteConsentSchema>

const auditPurpose = z.literal('native-command-audit')
export const figPluginNativeAuditSchema = z
  .object({
    ...protocolFields,
    purpose: auditPurpose,
    actionId: hex32Schema,
    payloadSha256: sha256Schema,
    host: nativeHostSchema,
    index: boundedIndexSchema,
    phase: phaseSchema,
    effect: effectSchema,
    at: safeIntegerSchema
  })
  .strict()
  .superRefine((audit, context) => {
    hostEffectRefinement(audit, context)
    if (
      ['capturing', 'awaiting-write-consent', 'approved', 'claimed'].includes(audit.phase) &&
      audit.effect !== 'none'
    )
      addIssue(context, 'pre-dispatch audit cannot report document effects', ['phase'])
  })
export type FigPluginNativeAudit = z.output<typeof figPluginNativeAuditSchema>

export type FigPluginNativeCommandErrorCode = 'INVALID_DATA' | 'TOO_LARGE' | 'INVALID_COMMAND'
export type FigPluginNativeCommandParseResult<Schema extends z.ZodTypeAny> =
  { ok: true; data: z.output<Schema> } | { ok: false; code: FigPluginNativeCommandErrorCode }

/**
 * Safe ingress is intentionally two-stage: snapshot decoded plain data and enforce the total wire
 * bound before Zod. The snapshot reads data descriptors, never getters or toJSON hooks, and returns
 * detached JSON data. It is not a Proxy sandbox: shared code cannot safely inspect arbitrary
 * in-process Proxies. Main must pass util.types.isProxy as rejectObject before reflection. Ordinary
 * schema.safeParse is likewise not a getter-safe ingress and must not replace this helper.
 *
 * No digest is computed here. Main may later hash one final canonical payload when it owns the
 * binding; this shared module imports no node:crypto and never mints a grant from input metadata.
 */
export const parseFigPluginNativeCommandValue = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
  rejectObject?: (item: object) => boolean
): FigPluginNativeCommandParseResult<Schema> => {
  const detached = snapshotFigPluginPlanData(value, FIGPLUGIN_NATIVE_TOTAL_WIRE_BYTES, rejectObject)
  if (!detached.ok) return { ok: false, code: detached.code }
  try {
    const parsed = schema.safeParse(detached.data)
    if (!parsed.success) return { ok: false, code: 'INVALID_COMMAND' }
    return { ok: true, data: parsed.data }
  } catch {
    // Never expose Zod paths, raw exception text, unknown keys, or host-provided data.
    return { ok: false, code: 'INVALID_COMMAND' }
  }
}

// Public aliases keep the contract discoverable without registering a second protocol or executor.
export const figPluginNativeRenamePlanSchema = nativePlanSchema
export const figPluginNativeRuntimeBindingSchema = exactRuntimeBindingSchema
export const figPluginNativeReadbackSchema = readbackSchema
