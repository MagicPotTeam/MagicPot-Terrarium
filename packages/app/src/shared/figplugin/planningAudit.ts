import { z } from 'zod'
import {
  FIGPLUGIN_AUDIT_TTL_MS,
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  FIGPLUGIN_AUDIT_MAX_LINE_BYTES
} from './executionAudit'

export {
  FIGPLUGIN_AUDIT_TTL_MS,
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  FIGPLUGIN_AUDIT_MAX_LINE_BYTES
} from './executionAudit'

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const hex32 = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const hex64 = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
const errorCodes = {
  cancelled: ['CANCELLED'],
  denied: ['DENIED'],
  expired: ['EXPIRED'],
  failed: ['TIMEOUT', 'UPSTREAM_FAILED', 'CONFIGURATION_CHANGED']
} as const

export const figPluginPlanningModelMetadataSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$(?![\s\S])/)
      .optional(),
    modelName: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value), 'Invalid model label')
      .optional()
  })
  .strict()
export type FigPluginPlanningModelMetadata = z.output<typeof figPluginPlanningModelMetadataSchema>

/** Strict metadata projection only; never store prompt, context, image bytes or raw errors. */
export const figPluginPlanningAuditEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('planning'),
    at: safeInteger,
    callId: hex32,
    correlationId: hex32,
    sequence: z.number().int().min(1).max(8),
    requestId: z.string().min(1).max(80),
    pluginId: z.string().min(1).max(128),
    host: z.enum(['figma', 'photoshop']),
    projectId: z.string().min(1).max(160),
    profileId: z.string().min(1).max(512),
    profileRevision: hex64,
    featureId: z.enum(['read-only-analysis', 'plan-preview']),
    state: z.enum([
      'awaiting-approval',
      'running',
      'provider-dispatched',
      'completed',
      'cancelled',
      'denied',
      'failed',
      'expired'
    ]),
    durationMs: safeInteger,
    inputBytes: z.number().int().min(0).max(65536),
    estimatedInputTokens: z.number().int().min(0).max(100000),
    nodeCount: z.number().int().min(0).max(100),
    imageCount: z.union([z.literal(0), z.literal(1)]),
    imageBytes: z.number().int().min(0).max(24576),
    assetCount: z.number().int().min(1).max(4).optional(),
    assetCatalogSha256: hex64.optional(),
    ...figPluginPlanningModelMetadataSchema.shape,
    resultBytes: z.number().int().min(0).max(32768).optional(),
    reportedTotalTokens: safeInteger.optional(),
    errorCode: z
      .enum([
        'CANCELLED',
        'DENIED',
        'EXPIRED',
        'TIMEOUT',
        'UPSTREAM_FAILED',
        'CONFIGURATION_CHANGED'
      ])
      .optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.assetCount === undefined) !== (value.assetCatalogSha256 === undefined) ||
      (value.assetCount !== undefined && value.featureId !== 'plan-preview')
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid asset catalog audit summary' })
    if ((value.imageCount === 0) !== (value.imageBytes === 0))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid image audit summary' })
    if (value.state === 'completed') {
      if (value.resultBytes === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Completed planning requires result size'
        })
    } else if (value.resultBytes !== undefined || value.reportedTotalTokens !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only completed planning has result usage'
      })
    }
    const allowed = Object.hasOwn(errorCodes, value.state)
      ? (errorCodes[value.state as keyof typeof errorCodes] as readonly string[])
      : undefined
    if (
      allowed
        ? value.errorCode === undefined || !allowed.includes(value.errorCode)
        : value.errorCode !== undefined
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid planning terminal error' })
    if (
      new TextEncoder().encode(`${JSON.stringify(value)}\n`).byteLength >
      FIGPLUGIN_AUDIT_MAX_LINE_BYTES
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Planning audit exceeds its byte budget'
      })
  })
export type FigPluginPlanningAuditEvent = z.output<typeof figPluginPlanningAuditEventSchema>

export const figPluginPlanningHistoryRequestSchema = z
  .object({
    callId: hex32.optional(),
    correlationId: hex32.optional(),
    pluginId: z.string().min(1).max(128).optional(),
    projectId: z.string().min(1).max(160).optional(),
    limit: z.number().int().min(1).max(FIGPLUGIN_AUDIT_MAX_RECORDS).optional()
  })
  .strict()
export type FigPluginPlanningHistoryRequest = z.output<typeof figPluginPlanningHistoryRequestSchema>

export const figPluginPlanningHistorySchema = z
  .object({
    records: z.array(figPluginPlanningAuditEventSchema).max(FIGPLUGIN_AUDIT_MAX_RECORDS),
    truncated: z.boolean(),
    recordedAt: safeInteger,
    retentionMs: z.literal(FIGPLUGIN_AUDIT_TTL_MS),
    maxRecords: z.literal(FIGPLUGIN_AUDIT_MAX_RECORDS),
    maxBytes: z.literal(FIGPLUGIN_AUDIT_MAX_BYTES),
    writeFailed: z.boolean()
  })
  .strict()
export type FigPluginPlanningHistory = z.output<typeof figPluginPlanningHistorySchema>
