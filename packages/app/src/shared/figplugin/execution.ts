import { z } from 'zod'
import { FigPluginIdSchema, FIGPLUGIN_HOSTS } from './manifest'
import {
  hostPlanReadbackSchema,
  hostPlanSchema,
  type HostPlan,
  type HostPlanReadback
} from './hostPlan'

export const FIGPLUGIN_EXECUTION_PROTOCOL = 1 as const
export const FIGPLUGIN_EXECUTION_MAX_EVENTS = 32
export const FIGPLUGIN_EXECUTION_TTL_MS = 120_000
export const FIGPLUGIN_VISUAL_BASELINE_TTL_MS = 24 * 60 * 60 * 1000
export const FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS = 3

const protocol = z.literal(FIGPLUGIN_EXECUTION_PROTOCOL)
const host = z.enum(FIGPLUGIN_HOSTS)
const hex32 = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const sha256 = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).max(160)
const command = z.enum([
  'node.rename',
  'node.opacity',
  'node.visibility',
  'text.content',
  'layout.flow'
])
const effect = z.enum(['none', 'applied', 'rolled-back', 'partial', 'unknown'])
const terminalStatus = z.enum(['completed', 'cancelled', 'denied', 'failed', 'expired'])
export const figPluginExecutionStateSchema = z.enum([
  'awaiting-approval',
  'approved',
  'claimed',
  'executing',
  'readback',
  'completed',
  'cancelled',
  'denied',
  'failed',
  'expired'
])
export type FigPluginExecutionState = z.output<typeof figPluginExecutionStateSchema>

const differenceSchema = z
  .object({
    targetId: identifier,
    command,
    before: z.unknown(),
    after: z.unknown()
  })
  .strict()

export const figPluginVisualEvidencePointSchema = z
  .object({
    sha256,
    width: z.number().int().min(1).max(512),
    height: z.number().int().min(1).max(512)
  })
  .strict()

const visualPointsDiffer = (
  left: { sha256: string; width: number; height: number },
  right: { sha256: string; width: number; height: number }
): boolean =>
  left.sha256 !== right.sha256 || left.width !== right.width || left.height !== right.height

export const figPluginVisualEvidenceSchema = z
  .object({
    targetId: identifier,
    before: figPluginVisualEvidencePointSchema,
    after: figPluginVisualEvidencePointSchema,
    changed: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedChanged = visualPointsDiffer(value.before, value.after)
    if (value.changed !== expectedChanged)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Visual evidence change mismatch' })
  })
export type FigPluginVisualEvidence = z.output<typeof figPluginVisualEvidenceSchema>

const uniqueTargetArray = <Schema extends z.ZodTypeAny>(schema: Schema, message: string) =>
  z
    .array(schema)
    .min(1)
    .max(20)
    .superRefine((value, ctx) => {
      const targets = new Set<string>()
      for (const [index, item] of value.entries()) {
        const targetId = (item as { targetId?: unknown }).targetId
        if (typeof targetId !== 'string') continue
        if (targets.has(targetId))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message,
            path: [index, 'targetId']
          })
        targets.add(targetId)
      }
    })

const visualEvidenceArraySchema = uniqueTargetArray(
  figPluginVisualEvidenceSchema,
  'Duplicate visual evidence target'
)

export const figPluginVisualBaselineTargetSchema = z
  .object({
    targetId: identifier,
    accepted: figPluginVisualEvidencePointSchema
  })
  .strict()

export const figPluginVisualBaselineSchema = z
  .object({
    protocol,
    baselineId: hex32,
    sourceExecutionId: hex32,
    pluginId: FigPluginIdSchema,
    host,
    projectId: identifier,
    documentId: identifier,
    scopeId: identifier,
    captureId: hex32,
    planSha256: sha256,
    contextSha256: sha256,
    visualEvidenceSha256: sha256,
    adapterVersion: z.string().min(1).max(64),
    targets: uniqueTargetArray(
      figPluginVisualBaselineTargetSchema,
      'Duplicate visual baseline target'
    ),
    acceptedAt: safeInteger,
    expiresAt: safeInteger,
    correctionRoundsUsed: z.number().int().min(0).max(FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS),
    maxCorrectionRounds: z.literal(FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expiresAt <= value.acceptedAt)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid visual baseline expiry' })
    if (value.correctionRoundsUsed > value.maxCorrectionRounds)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual correction round limit exceeded'
      })
  })
export type FigPluginVisualBaseline = z.output<typeof figPluginVisualBaselineSchema>

export const figPluginVisualBaselineComparisonTargetSchema = z
  .object({
    targetId: identifier,
    baseline: figPluginVisualEvidencePointSchema,
    current: figPluginVisualEvidencePointSchema,
    changed: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.changed !== visualPointsDiffer(value.baseline, value.current))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual baseline comparison change mismatch'
      })
  })

export const figPluginVisualBaselineComparisonSchema = z
  .object({
    protocol,
    baselineId: hex32,
    executionId: hex32,
    baselineEvidenceSha256: sha256,
    visualEvidenceSha256: sha256,
    comparedAt: safeInteger,
    targets: uniqueTargetArray(
      figPluginVisualBaselineComparisonTargetSchema,
      'Duplicate visual comparison target'
    ),
    changedCount: z.number().int().min(0).max(20),
    exactMatch: z.boolean()
  })
  .strict()
  .superRefine((value, ctx) => {
    const changedCount = value.targets.filter((target) => target.changed).length
    if (value.changedCount !== changedCount)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual comparison changed count mismatch'
      })
    if (value.exactMatch !== (changedCount === 0))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual comparison exact match mismatch'
      })
  })
export type FigPluginVisualBaselineComparison = z.output<
  typeof figPluginVisualBaselineComparisonSchema
>

export const figPluginExecutionPreviewSchema = z
  .object({
    protocol,
    executionId: hex32,
    callId: hex32,
    pluginId: FigPluginIdSchema,
    host,
    projectId: identifier,
    documentId: identifier,
    scopeId: identifier,
    captureId: hex32,
    plan: hostPlanSchema,
    planSha256: sha256,
    contextSha256: sha256,
    adapterVersion: z.string().min(1).max(64),
    rollback: z.enum(['verified-in-place', 'native-history', 'none']),
    visualAudit: z.enum(['hash-only', 'unavailable']),
    risk: z.enum(['low', 'medium', 'high']),
    differences: z.array(differenceSchema).min(1).max(20),
    state: figPluginExecutionStateSchema,
    requiresWriteApproval: z.literal(true),
    createdAt: safeInteger,
    expiresAt: safeInteger
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expiresAt <= value.createdAt)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid execution expiry' })
    if (value.differences.length !== value.plan.steps.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete execution preview' })
    try {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Execution preview is too large' })
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Execution preview is not JSON' })
    }
  })
export type FigPluginExecutionPreview = z.output<typeof figPluginExecutionPreviewSchema>

export const figPluginExecutionIntentSchema = z
  .object({
    protocol,
    purpose: z.literal('execute-host-plan'),
    executionId: hex32,
    callId: hex32,
    pluginId: FigPluginIdSchema,
    host,
    documentId: identifier,
    scopeId: identifier,
    captureId: hex32,
    plan: hostPlanSchema,
    planSha256: sha256,
    expiresAt: safeInteger,
    adapterVersion: z.string().min(1).max(64),
    actionId: hex32
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.plan.captureId !== value.captureId)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Intent capture mismatch' })
    try {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32 * 1024)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Execution intent is too large' })
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Execution intent is not JSON' })
    }
  })
export type FigPluginExecutionIntent = z.output<typeof figPluginExecutionIntentSchema>

export const figPluginExecutionClaimRequestSchema = z.object({ protocol, callId: hex32 }).strict()
export type FigPluginExecutionClaimRequest = z.output<typeof figPluginExecutionClaimRequestSchema>

const publicStatusFields = {
  protocol,
  executionId: hex32,
  callId: hex32,
  state: figPluginExecutionStateSchema,
  completed: z.number().int().min(0).max(20),
  total: z.number().int().min(1).max(20),
  effect,
  updatedAt: safeInteger,
  visualEvidence: visualEvidenceArraySchema.optional(),
  visualEvidenceSha256: sha256.optional(),
  visualBaselineComparison: figPluginVisualBaselineComparisonSchema.optional()
}
export const figPluginExecutionStatusSchema = z
  .object({
    ...publicStatusFields,
    errorCode: z
      .enum([
        'DENIED',
        'EXPIRED',
        'CANCELLED',
        'TIMEOUT',
        'HOST_UNAVAILABLE',
        'INVALID_PLAN',
        'STALE_CONTEXT',
        'EXECUTION_FAILED',
        'ROLLED_BACK',
        'QUARANTINED'
      ])
      .optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.completed > value.total)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid completed count' })
    if ((value.visualEvidence === undefined) !== (value.visualEvidenceSha256 === undefined))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Incomplete visual evidence status'
      })
    if (value.visualEvidence && (value.state !== 'completed' || value.effect !== 'applied'))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual evidence is not applied success'
      })
    if (value.visualBaselineComparison) {
      if (!value.visualEvidence || !value.visualEvidenceSha256)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Visual comparison has no evidence'
        })
      if (value.visualBaselineComparison.executionId !== value.executionId)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Visual comparison execution mismatch'
        })
      if (value.visualBaselineComparison.visualEvidenceSha256 !== value.visualEvidenceSha256)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Visual comparison evidence mismatch'
        })
      const evidenceByTarget = new Map(
        (value.visualEvidence ?? []).map((item) => [item.targetId, item.after] as const)
      )
      if (
        evidenceByTarget.size !== value.visualBaselineComparison.targets.length ||
        value.visualBaselineComparison.targets.some((target) => {
          const current = evidenceByTarget.get(target.targetId)
          return !current || visualPointsDiffer(current, target.current)
        })
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Visual comparison target mismatch'
        })
    }
  })
export type FigPluginExecutionStatus = z.output<typeof figPluginExecutionStatusSchema>

export const figPluginExecutionClaimResponseSchema = z.discriminatedUnion('status', [
  z
    .object({ protocol, status: z.literal('pending'), state: figPluginExecutionStateSchema })
    .strict(),
  z
    .object({ protocol, status: z.literal('ready'), intent: figPluginExecutionIntentSchema })
    .strict(),
  z
    .object({
      protocol,
      status: z.literal('terminal'),
      state: terminalStatus,
      errorCode: z.string().min(1).max(64).optional()
    })
    .strict()
])
export type FigPluginExecutionClaimResponse = z.output<typeof figPluginExecutionClaimResponseSchema>

export const figPluginExecutionProgressRequestSchema = z
  .object({
    protocol,
    executionId: hex32,
    actionId: hex32,
    sequence: z.number().int().min(1).max(1_000_000),
    phase: z.enum(['claimed', 'executing', 'readback']),
    index: z.number().int().min(0).max(19).optional(),
    completed: z.number().int().min(0).max(20),
    total: z.number().int().min(1).max(20),
    effect,
    at: safeInteger
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.completed > value.total)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid completed count' })
    if (value.phase !== 'claimed' && value.index === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Progress index is required' })
    if (value.effect === 'none' && value.completed !== 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'No-effect progress has changes' })
    if (value.effect === 'applied' && value.completed !== value.total)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Applied progress is incomplete' })
  })
export type FigPluginExecutionProgressRequest = z.output<
  typeof figPluginExecutionProgressRequestSchema
>

export const figPluginExecutionResultRequestSchema = z
  .object({
    protocol,
    executionId: hex32,
    actionId: hex32,
    status: z.enum(['completed', 'cancelled', 'failed']),
    effect,
    completed: z.number().int().min(0).max(20),
    total: z.number().int().min(1).max(20),
    readback: hostPlanReadbackSchema,
    errorCode: z
      .enum([
        'CANCELLED',
        'TIMEOUT',
        'HOST_UNAVAILABLE',
        'INVALID_PLAN',
        'STALE_CONTEXT',
        'EXECUTION_FAILED',
        'ROLLED_BACK',
        'QUARANTINED'
      ])
      .optional(),
    visualEvidence: visualEvidenceArraySchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.completed > value.total)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid completed count' })
    if (value.status === 'completed' && value.effect !== 'applied' && value.effect !== 'partial')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed result has no effect' })
    if (value.effect === 'applied' && value.completed !== value.total)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Applied result is incomplete' })
    if (value.effect === 'rolled-back' && value.status !== 'failed' && value.status !== 'cancelled')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Rollback must be a failure' })
    if (value.visualEvidence && (value.status !== 'completed' || value.effect !== 'applied'))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Visual evidence requires an applied completed result'
      })
    try {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Execution result is too large' })
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Execution result is not JSON' })
    }
  })
export type FigPluginExecutionResultRequest = z.output<typeof figPluginExecutionResultRequestSchema>

export const figPluginExecutionResultResponseSchema = z
  .object({
    protocol,
    executionId: hex32,
    status: figPluginExecutionStatusSchema
  })
  .strict()
export type FigPluginExecutionResultResponse = z.output<
  typeof figPluginExecutionResultResponseSchema
>

export const figPluginExecutionStatusRequestSchema = z.object({ protocol, callId: hex32 }).strict()
export type FigPluginExecutionStatusRequest = z.output<typeof figPluginExecutionStatusRequestSchema>

export const figPluginDesktopExecutionApprovalSchema = z
  .object({ executionId: hex32, planSha256: sha256 })
  .strict()
export type FigPluginDesktopExecutionApproval = z.output<
  typeof figPluginDesktopExecutionApprovalSchema
>
export const figPluginDesktopExecutionSchema = z.object({ executionId: hex32 }).strict()
export type FigPluginDesktopExecution = z.output<typeof figPluginDesktopExecutionSchema>

export const figPluginDesktopVisualBaselineAcceptanceSchema = z
  .object({ executionId: hex32, visualEvidenceSha256: sha256 })
  .strict()
export type FigPluginDesktopVisualBaselineAcceptance = z.output<
  typeof figPluginDesktopVisualBaselineAcceptanceSchema
>

export const figPluginExecutionDesktopStateSchema = z
  .object({
    previews: z.array(figPluginExecutionPreviewSchema).max(16),
    statuses: z.array(figPluginExecutionStatusSchema).max(16),
    baselines: z.array(figPluginVisualBaselineSchema).max(16)
  })
  .strict()
export type FigPluginExecutionDesktopState = z.output<typeof figPluginExecutionDesktopStateSchema>

export type FigPluginExecutionRecord = {
  plan: HostPlan
  readback: HostPlanReadback
}
