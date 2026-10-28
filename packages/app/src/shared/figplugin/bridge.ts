import { z } from 'zod'
import { hostContextSchema, type HostContext } from './hostPlan'
import { hostContextImageSchema, type HostContextImage } from './hostContextImage'
import {
  figPluginPlanningAssetReferencesSchema,
  figPluginPlanningAssetCatalogSchema,
  type FigPluginPlanningAssetReference
} from './hostPlanningAssets'
import { ServiceError } from '../api/apiUtils/serviceValidation'
import { FIGPLUGIN_HOSTS, FigPluginIdSchema, FigPluginDesktopBridgeOriginSchema } from './manifest'

export const FIGPLUGIN_BRIDGE_PROTOCOL = 1 as const

const protocol = z.literal(FIGPLUGIN_BRIDGE_PROTOCOL)
const host = z.enum(FIGPLUGIN_HOSTS)
const hex32 = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const projectId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$(?![\s\S])/)
const profileId = z.string().min(1).max(512)
const prompt = z.string().trim().min(1).max(16_384)

export const figPluginBridgeHashSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
export type FigPluginBridgeHash = z.output<typeof figPluginBridgeHashSchema>
export const figPluginBridgeTokenSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
export type FigPluginBridgeToken = z.output<typeof figPluginBridgeTokenSchema>
export const figPluginBridgeRequestIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]{1,80}$(?![\s\S])/)
export type FigPluginBridgeRequestId = z.output<typeof figPluginBridgeRequestIdSchema>

// Do not normalize URLs: aliases, credentials, suffixes and noncanonical ports are invalid.
export const figPluginBridgeOriginSchema = FigPluginDesktopBridgeOriginSchema
export type FigPluginBridgeOrigin = z.output<typeof figPluginBridgeOriginSchema>

// References and integrity bindings only; never embed provider configuration or paths.
export const figPluginRuntimeBindingSchema = z
  .object({
    pluginId: FigPluginIdSchema,
    host,
    generation: safeInteger,
    artifactSha256: figPluginBridgeHashSchema,
    signerFingerprint: figPluginBridgeHashSchema,
    manifestSha256: figPluginBridgeHashSchema,
    bridgeOrigin: figPluginBridgeOriginSchema,
    projectId,
    profileId,
    profileRevision: figPluginBridgeHashSchema
  })
  .strict()
export type FigPluginRuntimeBinding = z.output<typeof figPluginRuntimeBindingSchema>

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength
const boundedJson = (maxBytes: number) =>
  z.unknown().refine((value) => {
    try {
      const json = JSON.stringify(value)
      return json !== undefined && utf8Bytes(json) <= maxBytes
    } catch {
      return false
    }
  }, 'Invalid or oversized bridge JSON')

const coordinate = z.number().finite().min(-10_000_000).max(10_000_000)
export const figPluginContextNodeSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    name: z.string().max(120),
    locked: z.boolean(),
    geometry: z
      .object({
        x: coordinate,
        y: coordinate,
        width: coordinate,
        height: coordinate,
        rotation: coordinate
      })
      .strict()
      .optional()
  })
  .strict()
export type FigPluginContextNode = z.output<typeof figPluginContextNodeSchema>

// Labels are explicitly previewed text, not sanitized or interpreted instructions.
// Measure the incoming JSON before parsing/transforming any of its fields.
export const figPluginContextSchema = boundedJson(48 * 1024).pipe(
  z
    .object({
      nodes: z
        .array(figPluginContextNodeSchema)
        .max(100)
        .refine((nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length, {
          message: 'Duplicate context node identifiers'
        }),
      selectionRevision: z.string().min(1).max(128),
      documentLabel: z.string().max(120).optional()
    })
    .strict()
)
export type FigPluginContext = z.output<typeof figPluginContextSchema>

// Pairing/session secrets belong only to their transport envelopes, never previews or logs.
export const figPluginPairRequestSchema = z
  .object({
    protocol,
    ticketId: hex32,
    pairingSecret: figPluginBridgeTokenSchema,
    pluginId: FigPluginIdSchema,
    host,
    artifactSha256: figPluginBridgeHashSchema,
    clientNonce: hex32
  })
  .strict()
export type FigPluginPairRequest = z.output<typeof figPluginPairRequestSchema>

export const figPluginPairResponseSchema = z
  .object({
    protocol,
    sessionId: hex32,
    sessionToken: figPluginBridgeTokenSchema,
    expiresAt: safeInteger,
    idleTimeoutMs: z.literal(120_000)
  })
  .strict()
export type FigPluginPairResponse = z.output<typeof figPluginPairResponseSchema>

// Planning extends data carried by the read-only model request, never its permissions.
const planningFields = {
  featureId: z.literal('plan-preview').optional(),
  hostContext: hostContextSchema.optional(),
  contextImage: hostContextImageSchema.optional(),
  assetReferences: figPluginPlanningAssetReferencesSchema.optional()
}
const validatePlanningFields = (
  value: {
    featureId?: 'plan-preview'
    hostContext?: HostContext
    contextImage?: HostContextImage
    assetReferences?: FigPluginPlanningAssetReference[]
    context: FigPluginContext
  },
  ctx: z.RefinementCtx
): void => {
  const host = value.hostContext
  if (value.assetReferences && (value.featureId !== 'plan-preview' || !host))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Assets require host planning' })
  if (
    value.contextImage &&
    (value.featureId !== 'plan-preview' ||
      !host ||
      value.contextImage.captureId !== host.captureId ||
      !host.selectedIds?.includes(value.contextImage.targetId))
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Context image requires its exact selected host planning target'
    })
  if ((value.featureId === 'plan-preview') !== Boolean(host)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Planning requires an exact context' })
    return
  }
  if (!host) return
  if (
    host.captureId !== value.context.selectionRevision ||
    host.nodes.length !== value.context.nodes.length ||
    host.nodes.some((node, index) => {
      const brief = value.context.nodes[index]
      return (
        !brief ||
        node.id !== brief.id ||
        node.type !== brief.type ||
        brief.locked !== (node.locked || node.ancestors.some((ancestor) => ancestor.locked))
      )
    })
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Planning context does not match its summary'
    })
}

// Replay/order enforcement is session-owned; the shared contract has no retry or lifecycle state.
export const figPluginBridgePrepareRequestSchema = boundedJson(64 * 1024).pipe(
  z
    .object({
      protocol,
      requestId: figPluginBridgeRequestIdSchema,
      sequence: z.number().int().min(1).max(1_000_000_000),
      prompt,
      context: figPluginContextSchema,
      ...planningFields
    })
    .strict()
    .superRefine(validatePlanningFields)
)
export type FigPluginBridgePrepareRequest = z.output<typeof figPluginBridgePrepareRequestSchema>

export const figPluginBridgePrepareResponseSchema = z
  .object({
    protocol,
    callId: hex32,
    status: z.literal('awaiting-approval'),
    expiresAt: safeInteger
  })
  .strict()
export type FigPluginBridgePrepareResponse = z.output<typeof figPluginBridgePrepareResponseSchema>

export const figPluginBridgeStatusRequestSchema = z.object({ protocol, callId: hex32 }).strict()
export type FigPluginBridgeStatusRequest = z.output<typeof figPluginBridgeStatusRequestSchema>

export const figPluginBridgeCancelRequestSchema = figPluginBridgeStatusRequestSchema
export type FigPluginBridgeCancelRequest = z.output<typeof figPluginBridgeCancelRequestSchema>

export const figPluginBridgeSessionCloseRequestSchema = z
  .object({ protocol, callId: hex32.optional() })
  .strict()
export type FigPluginBridgeSessionCloseRequest = z.output<
  typeof figPluginBridgeSessionCloseRequestSchema
>

const callErrorCode = z.enum([
  'DENIED',
  'EXPIRED',
  'CONFIGURATION_CHANGED',
  'CANCELLED',
  'TIMEOUT',
  'UPSTREAM_FAILED'
])
const callIdentity = { protocol, callId: hex32 }
export const figPluginBridgeStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({ ...callIdentity, status: z.literal('awaiting-approval') }).strict(),
  z.object({ ...callIdentity, status: z.literal('running') }).strict(),
  z
    .object({
      ...callIdentity,
      status: z.literal('completed'),
      content: z
        .string()
        .min(1)
        .max(32 * 1024)
        .refine((value) => utf8Bytes(value) <= 32 * 1024, 'Bridge content is too large'),
      reportedTotalTokens: safeInteger.optional()
    })
    .strict(),
  z
    .object({
      ...callIdentity,
      status: z.literal('cancelled'),
      errorCode: callErrorCode.optional()
    })
    .strict(),
  z
    .object({
      ...callIdentity,
      status: z.literal('failed'),
      errorCode: callErrorCode.optional()
    })
    .strict()
])
export type FigPluginBridgeStatusResponse = z.output<typeof figPluginBridgeStatusResponseSchema>

export const figPluginBridgePreviewSchema = z
  .object({
    callId: hex32,
    pluginId: FigPluginIdSchema,
    host,
    projectId,
    profileId,
    profileRevision: figPluginBridgeHashSchema,
    context: figPluginContextSchema,
    prompt,
    expiresAt: safeInteger,
    payloadSha256: figPluginBridgeHashSchema,
    estimatedInputTokens: safeInteger,
    ...planningFields,
    assetCatalog: figPluginPlanningAssetCatalogSchema.optional()
  })
  .strict()
  .superRefine(validatePlanningFields)
  .superRefine((value, ctx) => {
    const catalog = value.assetCatalog
    if (
      Boolean(catalog) !== Boolean(value.assetReferences) ||
      (catalog &&
        (value.featureId !== 'plan-preview' ||
          catalog.host !== value.host ||
          catalog.host !== value.hostContext?.host ||
          catalog.pluginId !== value.pluginId ||
          catalog.projectId !== value.projectId ||
          value.expiresAt > Math.min(...catalog.assets.map((asset) => asset.expiresAt)) ||
          catalog.assets.length !== value.assetReferences!.length ||
          catalog.assets.some((asset, index) => {
            const reference = value.assetReferences![index]
            return asset.assetId !== reference.assetId || asset.sha256 !== reference.sha256
          })))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Planning asset snapshot mismatch' })
  })
export type FigPluginBridgePreview = z.output<typeof figPluginBridgePreviewSchema>

export const figPluginDesktopPairRequestSchema = z
  .object({
    pluginId: FigPluginIdSchema,
    expectedGeneration: safeInteger,
    projectId
  })
  .strict()
export type FigPluginDesktopPairRequest = z.output<typeof figPluginDesktopPairRequestSchema>
export const figPluginDesktopPairTicketSchema = z
  .object({
    ticketId: hex32,
    pairingSecret: figPluginBridgeTokenSchema,
    expiresAt: safeInteger,
    bridgeOrigin: figPluginBridgeOriginSchema,
    pluginId: FigPluginIdSchema,
    host,
    artifactSha256: figPluginBridgeHashSchema
  })
  .strict()
export type FigPluginDesktopPairTicket = z.output<typeof figPluginDesktopPairTicketSchema>
export const figPluginDesktopApprovalSchema = z
  .object({ callId: hex32, payloadSha256: figPluginBridgeHashSchema })
  .strict()
export type FigPluginDesktopApproval = z.output<typeof figPluginDesktopApprovalSchema>
export const figPluginDesktopCallSchema = z.object({ callId: hex32 }).strict()
export const figPluginBridgeSessionSummarySchema = z
  .object({
    sessionId: hex32,
    pluginId: FigPluginIdSchema,
    host,
    projectId,
    expiresAt: safeInteger,
    activeCalls: z.number().int().min(0).max(1)
  })
  .strict()
export const figPluginBridgeDesktopStateSchema = z
  .object({
    sessions: z.array(figPluginBridgeSessionSummarySchema).max(16),
    previews: z.array(figPluginBridgePreviewSchema).max(32)
  })
  .strict()
export type FigPluginBridgeDesktopState = z.output<typeof figPluginBridgeDesktopStateSchema>

export const FIGPLUGIN_BRIDGE_ERRORS = Object.freeze({
  UNAUTHORIZED: 'The plugin bridge session is not authorized.',
  BUSY: 'The plugin bridge is busy or its bounded capacity has been reached.',
  INVALID_REQUEST: 'The plugin bridge request is invalid.',
  EXPIRED: 'The plugin bridge request or session has expired.',
  CONFIGURATION_CHANGED: 'The plugin bridge configuration has changed.',
  DENIED: 'The plugin bridge request was denied.',
  CANCELLED: 'The plugin bridge request was cancelled.',
  TIMEOUT: 'The plugin bridge request timed out.',
  UPSTREAM_FAILED: 'The plugin bridge upstream request failed.'
})
export type FigPluginBridgeErrorCode = keyof typeof FIGPLUGIN_BRIDGE_ERRORS

export class FigPluginBridgeError extends ServiceError {
  declare readonly code: FigPluginBridgeErrorCode

  constructor(code: FigPluginBridgeErrorCode) {
    const safeCode =
      typeof code === 'string' &&
      Object.prototype.hasOwnProperty.call(FIGPLUGIN_BRIDGE_ERRORS, code)
        ? code
        : 'INVALID_REQUEST'
    super(FIGPLUGIN_BRIDGE_ERRORS[safeCode], { code: safeCode })
  }
}

export function parseFigPluginBridgeValue<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown
): z.output<Schema> {
  try {
    return schema.parse(value)
  } catch {
    // Raw validation issues, exception causes and property names may contain credentials.
    throw new FigPluginBridgeError('INVALID_REQUEST')
  }
}
