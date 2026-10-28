import { z } from 'zod'
import { validateImportManagedMediaResp } from '../api/svcManagedMedia'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  figPluginBridgeHashSchema,
  type FigPluginBridgeErrorCode
} from './bridge'
import {
  FIGPLUGIN_ASSET_MAX_EDGE,
  FIGPLUGIN_ASSET_MAX_PIXELS,
  figPluginDesktopAssetTargetSchema
} from './hostAssets'
import { figPluginManagedAssetReferenceSchema } from './managedSessionAsset'

export const FIGPLUGIN_IMAGE_GENERATION_MAX_MS = 120_000
export const FIGPLUGIN_IMAGE_GENERATION_OPTIONS = Object.freeze({
  enabled: true,
  action: 'generate',
  outputFormat: 'png',
  size: '1024x1024',
  quality: 'auto',
  background: 'auto'
} as const)

// Listing metadata filters choices only; main must separately verify the consented revision.
export function supportsFigPluginImageGenerationProfile(profile: unknown): boolean {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false
  const candidate = profile as Record<string, unknown>
  return (
    candidate.provider === 'openai' &&
    candidate.model_use === 'image' &&
    (candidate.api_mode === 'images' || candidate.api_mode === 'responses') &&
    candidate.is_ocr_model !== true &&
    (candidate.call_type === undefined || candidate.call_type === 'api')
  )
}

const id = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const error = z.enum(
  Object.keys(FIGPLUGIN_BRIDGE_ERRORS) as [FigPluginBridgeErrorCode, ...FigPluginBridgeErrorCode[]]
)

export const figPluginImageGenerationKeySchema = figPluginDesktopAssetTargetSchema
  .extend({ requestId: id })
  .strict()
export type FigPluginImageGenerationKey = z.output<typeof figPluginImageGenerationKeySchema>

export const figPluginImageGenerationRequestSchema = figPluginImageGenerationKeySchema
  .extend({ prompt: z.string().trim().min(1).max(8192) })
  .strict()
export type FigPluginImageGenerationRequest = z.output<typeof figPluginImageGenerationRequestSchema>

// A generated managed image is not a session publication, model-input grant or host-write grant.
export const figPluginImageGenerationOutputSchema = figPluginImageGenerationKeySchema
  .extend({
    jobId: id,
    resultId: id,
    profileId: z.string().min(1).max(512),
    profileRevision: figPluginBridgeHashSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    reference: figPluginManagedAssetReferenceSchema,
    localMediaUrl: z.string().min(1).max(4096),
    width: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_EDGE),
    height: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_EDGE)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expiresAt <= value.createdAt ||
      value.expiresAt - value.createdAt > FIGPLUGIN_IMAGE_GENERATION_MAX_MS ||
      value.width * value.height > FIGPLUGIN_ASSET_MAX_PIXELS
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid generated image limits' })
    }
    try {
      validateImportManagedMediaResp({
        reference: value.reference,
        localMediaUrl: value.localMediaUrl
      })
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid generated image reference'
      })
    }
  })
export type FigPluginImageGenerationOutput = z.output<typeof figPluginImageGenerationOutputSchema>

export const figPluginImageGenerationStateSchema = figPluginImageGenerationKeySchema
  .extend({
    jobId: id,
    phase: z.enum([
      'preparing',
      'awaiting-approval',
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
    error: error.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.updatedAt < value.createdAt ||
      value.expiresAt <= value.createdAt ||
      value.expiresAt - value.createdAt > FIGPLUGIN_IMAGE_GENERATION_MAX_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid image generation lifetime'
      })
    }
  })
export type FigPluginImageGenerationState = z.output<typeof figPluginImageGenerationStateSchema>

export const figPluginImageGenerationAcceptSchema = figPluginImageGenerationKeySchema
  .extend({ jobId: id, resultId: id, sha256: figPluginBridgeHashSchema })
  .strict()
export type FigPluginImageGenerationAccept = z.output<typeof figPluginImageGenerationAcceptSchema>
