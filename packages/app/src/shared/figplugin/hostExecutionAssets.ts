import { z } from 'zod'
import {
  FIGPLUGIN_ASSET_MAX_PER_SESSION,
  FIGPLUGIN_ASSET_MAX_PIXELS,
  FIGPLUGIN_ASSET_TTL_MS,
  figPluginAssetChunkSchema,
  figPluginAssetReadRequestSchema,
  figPluginSessionAssetSchema
} from './hostAssets'
import { validateSessionAsset, type SessionAssetIdentity } from './hostAssetClient'
import {
  figPluginPlanningAssetMetadataSchema,
  type FigPluginPlanningAssetMetadata
} from './hostPlanningAssets'
import type { HostPlan } from './hostPlan'
import {
  validateRecoveryExecutionImages,
  validateRecoveryImagePlanBinding
} from './hostImageRecovery'

export const FIGPLUGIN_EXECUTION_ASSET_READ_PATH = '/figplugin/v1/plan/assets/read'
const id = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const hash = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
const purpose = z.literal('host-plan-execution')

// Shape reuse is not an authorization conversion. This schema accepts only the
// execution purpose; the Bridge still owns claim/action/approval authorization.
export const figPluginExecutionAssetSchema = z
  .object({
    ...figPluginSessionAssetSchema.innerType().shape,
    kind: z.literal('execution-image-asset'),
    purpose
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (
      asset.width * asset.height > FIGPLUGIN_ASSET_MAX_PIXELS ||
      asset.chunkCount !== Math.ceil(asset.sizeBytes / asset.chunkSize) ||
      asset.expiresAt <= asset.createdAt ||
      asset.expiresAt - asset.createdAt > FIGPLUGIN_ASSET_TTL_MS
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid execution image limits' })
  })
export type FigPluginExecutionAsset = z.output<typeof figPluginExecutionAssetSchema>

export const figPluginExecutionAssetsSchema = z
  .array(figPluginExecutionAssetSchema)
  .min(1)
  .max(FIGPLUGIN_ASSET_MAX_PER_SESSION)
  .refine((assets) => new Set(assets.map((asset) => asset.assetId)).size === assets.length, {
    message: 'Duplicate execution asset'
  })

/** Explicit caller-bound projection only; this helper never grants execution permission. */
export function executionAssetFromSessionAsset(
  input: unknown,
  caller: SessionAssetIdentity,
  now = Date.now()
): FigPluginExecutionAsset {
  const source = validateSessionAsset(input, caller, now)
  return figPluginExecutionAssetSchema.parse({
    ...source,
    kind: 'execution-image-asset',
    purpose: 'host-plan-execution'
  })
}

export function executionAssetMetadata(input: unknown): FigPluginPlanningAssetMetadata {
  const { assetId, sha256, mimeType, sizeBytes, width, height, expiresAt } =
    figPluginExecutionAssetSchema.parse(input)
  return figPluginPlanningAssetMetadataSchema.parse({
    assetId,
    sha256,
    mimeType,
    sizeBytes,
    width,
    height,
    expiresAt
  })
}

const executionBinding = {
  callId: id,
  executionId: id,
  actionId: id,
  planSha256: hash
}
export const figPluginExecutionAssetReadRequestSchema = z
  .object({
    ...figPluginAssetReadRequestSchema.shape,
    purpose,
    ...executionBinding
  })
  .strict()
export type FigPluginExecutionAssetReadRequest = z.output<
  typeof figPluginExecutionAssetReadRequestSchema
>

export const figPluginExecutionAssetChunkSchema = z
  .object({
    protocol: z.literal(1),
    purpose,
    ...executionBinding,
    sessionId: id,
    assetId: id,
    chunk: figPluginAssetChunkSchema.innerType().shape.chunk
  })
  .strict()
  .superRefine((value, ctx) => {
    const frame = value.chunk
    const text = frame.bytesBase64
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    if (
      frame.index >= frame.chunkCount ||
      (text.endsWith('==') && (alphabet.indexOf(text[text.length - 3]) & 15) !== 0) ||
      (text.endsWith('=') &&
        !text.endsWith('==') &&
        (alphabet.indexOf(text[text.length - 2]) & 3) !== 0)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid execution image chunk' })
  })
export type FigPluginExecutionAssetChunk = z.output<typeof figPluginExecutionAssetChunkSchema>

/** Structural binding only; native readback is the sole source of observed write evidence. */
export function refineExecutionAssets(
  value: {
    plan: HostPlan
    host: string
    pluginId: string
    projectId?: string
    createdAt?: number
    expiresAt: number
    risk?: string
    executionAssets?: FigPluginExecutionAsset[]
    recovery?: unknown
    visualCorrection?: unknown
  },
  ctx: z.RefinementCtx
): void {
  const imageSteps = value.plan.steps.filter(
    (step) => step.command === 'image.fill' || step.command === 'image.pixels'
  )
  if (!imageSteps.length) {
    if (value.executionAssets !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Non-image plan has execution assets' })
    if ((value.recovery as { images?: unknown } | undefined)?.images !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Non-image plan has image recovery' })
    return
  }
  if (value.visualCorrection !== undefined)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Image visual correction is unsupported' })
  if (value.recovery !== undefined) {
    try {
      const images = validateRecoveryExecutionImages(
        (value.recovery as { images?: unknown }).images
      )
      validateRecoveryImagePlanBinding(value.plan, images)
      for (const source of images.manifest.assets) {
        const assetId = images.assetBindings.find(
          (binding) => binding.sourceAssetId === source.assetId
        )!.assetId
        const asset = value.executionAssets?.find((asset) => asset.assetId === assetId)
        if (
          !asset ||
          asset.sha256 !== source.sha256 ||
          asset.mimeType !== source.mimeType ||
          asset.sizeBytes !== source.sizeBytes ||
          asset.width !== source.width ||
          asset.height !== source.height
        )
          throw new Error('Recovery asset mismatch')
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid image recovery binding' })
    }
  }
  if (value.risk !== undefined && value.risk !== 'high')
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Image execution requires high risk' })
  const assets = value.executionAssets
  if (!assets) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Image execution assets are required' })
    return
  }
  const expected = new Set(imageSteps.map((step) => `${step.assetId}:${step.sha256}`))
  if (
    assets.length !== expected.size ||
    assets.some((asset) => !expected.has(`${asset.assetId}:${asset.sha256}`)) ||
    imageSteps.some(
      (step) => step.command !== (value.host === 'figma' ? 'image.fill' : 'image.pixels')
    ) ||
    assets.some(
      (asset) =>
        asset.host !== value.host ||
        asset.pluginId !== value.pluginId ||
        (value.projectId !== undefined && asset.projectId !== value.projectId) ||
        asset.sessionId !== assets[0].sessionId ||
        asset.projectId !== assets[0].projectId ||
        asset.expiresAt < value.expiresAt ||
        asset.createdAt >= value.expiresAt ||
        (value.createdAt !== undefined && asset.createdAt > value.createdAt)
    )
  )
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Execution asset binding mismatch' })
}
