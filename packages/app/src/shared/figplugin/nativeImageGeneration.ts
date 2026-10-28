import { z } from 'zod'
import { FIGPLUGIN_HOSTS, FigPluginIdSchema } from './manifest'
import type { FigPluginBridgeErrorCode } from './bridge'

export const FIGPLUGIN_NATIVE_IMAGE_GENERATION_MAX_MS = 120_000
export const FIGPLUGIN_NATIVE_IMAGE_GENERATION_PREPARE_PATH =
  '/figplugin/v1/image-generation/prepare'
export const FIGPLUGIN_NATIVE_IMAGE_GENERATION_STATUS_PATH = '/figplugin/v1/image-generation/status'
export const FIGPLUGIN_NATIVE_IMAGE_GENERATION_CANCEL_PATH = '/figplugin/v1/image-generation/cancel'

const protocol = z.literal(1)
const id = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const hash = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const prompt = z.string().trim().min(1).max(8192)
const errors = [
  'UNAUTHORIZED',
  'BUSY',
  'INVALID_REQUEST',
  'EXPIRED',
  'CONFIGURATION_CHANGED',
  'DENIED',
  'CANCELLED',
  'TIMEOUT',
  'UPSTREAM_FAILED'
] as const satisfies readonly FigPluginBridgeErrorCode[]

const boundedJson = (maxBytes: number) =>
  z.unknown().refine((value) => {
    try {
      const json = JSON.stringify(value)
      return json !== undefined && new TextEncoder().encode(json).byteLength <= maxBytes
    } catch {
      return false
    }
  }, 'Invalid or oversized image generation JSON')

const validLifetime = (
  value: { createdAt: number; expiresAt: number },
  context: z.RefinementCtx
): void => {
  if (
    value.expiresAt <= value.createdAt ||
    value.expiresAt - value.createdAt > FIGPLUGIN_NATIVE_IMAGE_GENERATION_MAX_MS
  )
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid image generation proposal lifetime'
    })
}

// Bound raw JSON before trimming; a native proposal conveys no provider or host-write authority.
export const figPluginImageGenerationProposalPrepareRequestSchema = boundedJson(64 * 1024).pipe(
  z
    .object({
      protocol,
      requestId: id,
      sequence: z.number().int().min(1).max(1_000_000_000),
      prompt
    })
    .strict()
)
export type FigPluginImageGenerationProposalPrepareRequest = z.output<
  typeof figPluginImageGenerationProposalPrepareRequestSchema
>

export const figPluginImageGenerationProposalPrepareResponseSchema = z
  .object({
    protocol,
    requestId: id,
    proposalId: id,
    status: z.literal('awaiting-approval'),
    createdAt: timestamp,
    expiresAt: timestamp
  })
  .strict()
  .superRefine(validLifetime)
export type FigPluginImageGenerationProposalPrepareResponse = z.output<
  typeof figPluginImageGenerationProposalPrepareResponseSchema
>

export const figPluginImageGenerationProposalStatusRequestSchema = boundedJson(4096).pipe(
  z.object({ protocol, requestId: id, proposalId: id }).strict()
)
export type FigPluginImageGenerationProposalStatusRequest = z.output<
  typeof figPluginImageGenerationProposalStatusRequestSchema
>

export const figPluginImageGenerationProposalCancelRequestSchema =
  figPluginImageGenerationProposalStatusRequestSchema
export type FigPluginImageGenerationProposalCancelRequest = z.output<
  typeof figPluginImageGenerationProposalCancelRequestSchema
>

// This deliberately cannot contain the prompt, output, managed reference or coordinator job ID.
export const figPluginImageGenerationProposalStatusSchema = z
  .object({
    protocol,
    requestId: id,
    proposalId: id,
    phase: z.enum([
      'awaiting-approval',
      'preparing',
      'generating',
      'materializing',
      'awaiting-acceptance',
      'accepted',
      'declined',
      'cancelled',
      'failed'
    ]),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    error: z.enum(errors).optional()
  })
  .strict()
  .superRefine((value, context) => {
    validLifetime(value, context)
    if (value.updatedAt < value.createdAt)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid proposal update time' })
  })
export type FigPluginImageGenerationProposalStatus = z.output<
  typeof figPluginImageGenerationProposalStatusSchema
>

// Trusted Desktop data only: the generation key is distinct from the native request identity.
export const figPluginNativeImageGenerationDesktopProposalSchema = z
  .object({
    proposalId: id,
    requestId: id,
    generationRequestId: id,
    sessionId: id,
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    projectId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9_-]+$(?![\s\S])/),
    prompt,
    payloadSha256: hash,
    createdAt: timestamp,
    expiresAt: timestamp
  })
  .strict()
  .superRefine((value, context) => {
    validLifetime(value, context)
    if (value.generationRequestId === value.requestId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Native and generation request identities must differ'
      })
  })
export type FigPluginNativeImageGenerationDesktopProposal = z.output<
  typeof figPluginNativeImageGenerationDesktopProposalSchema
>

export const figPluginNativeImageGenerationDesktopStateSchema = z
  .object({ proposals: z.array(figPluginNativeImageGenerationDesktopProposalSchema).max(32) })
  .strict()
export type FigPluginNativeImageGenerationDesktopState = z.output<
  typeof figPluginNativeImageGenerationDesktopStateSchema
>

export const figPluginNativeImageGenerationDesktopKeySchema = z
  .object({ proposalId: id, payloadSha256: hash })
  .strict()
export type FigPluginNativeImageGenerationDesktopKey = z.output<
  typeof figPluginNativeImageGenerationDesktopKeySchema
>

export const figPluginDesktopImageGenerationProposalSchema =
  figPluginNativeImageGenerationDesktopProposalSchema
export type FigPluginDesktopImageGenerationProposal = FigPluginNativeImageGenerationDesktopProposal
export const figPluginNativeImageGenerationProposalSchema =
  figPluginNativeImageGenerationDesktopProposalSchema
export type FigPluginNativeImageGenerationProposal = FigPluginNativeImageGenerationDesktopProposal
