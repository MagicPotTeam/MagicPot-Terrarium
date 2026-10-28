import { z } from 'zod'
import {
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_MAX_EDGE,
  FIGPLUGIN_ASSET_MAX_PIXELS,
  figPluginAssetMimeSchema
} from './hostAssets'
import type { HostPlan } from './hostPlan'
import { canonicalFigPluginJson } from './manifest'

const id = z.string().regex(/^[a-f0-9]{32}$(?![\s\S])/)
const hash = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/)
const dimension = z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_EDGE)
const coordinate = z.number().int().min(-10_000_000).max(10_000_000)
export const hostImageBoundsSchema = z
  .object({ left: coordinate, top: coordinate, right: coordinate, bottom: coordinate })
  .strict()
  .refine((value) => value.right > value.left && value.bottom > value.top, {
    message: 'Invalid image bounds'
  })
const figmaEvidenceSchema = z
  .object({
    kind: z.literal('figma-image-fill'),
    sourceSha256: hash,
    nativeImageHash: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0),
    fillsSha256: hash
  })
  .strict()
const photoshopEvidenceSchema = z
  .object({
    kind: z.literal('photoshop-pixels'),
    sourceSha256: hash,
    pixelSha256: hash,
    width: dimension,
    height: dimension,
    bounds: hostImageBoundsSchema
  })
  .strict()
export const hostImageEvidenceSchema = z.discriminatedUnion('kind', [
  figmaEvidenceSchema,
  photoshopEvidenceSchema
])
export type HostImageEvidence = z.output<typeof hostImageEvidenceSchema>

const recoveryAssetSchema = z
  .object({
    assetId: id,
    sha256: hash,
    mimeType: figPluginAssetMimeSchema,
    sizeBytes: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_BYTES),
    width: dimension,
    height: dimension
  })
  .strict()
  .refine((value) => value.width * value.height <= FIGPLUGIN_ASSET_MAX_PIXELS)
const targetFields = { targetId: z.string().min(1).max(128), assetId: id, sha256: hash }
const recoveryTargetSchema = z.discriminatedUnion('command', [
  z
    .object({
      ...targetFields,
      command: z.literal('image.fill'),
      scaleMode: z.enum(['FILL', 'FIT']),
      acceptedEvidence: figmaEvidenceSchema
    })
    .strict(),
  z
    .object({
      ...targetFields,
      command: z.literal('image.pixels'),
      pixelEncoding: z.literal('rgba8-srgb-zero-alpha-v1'),
      acceptedEvidence: photoshopEvidenceSchema
    })
    .strict()
])
const sortedUnique = (values: string[]): boolean =>
  new Set(values).size === values.length &&
  values.every((value, index) => [...values].sort()[index] === value)

/** Accepted post-task state only. Historical asset IDs are content keys, never live grants. */
export const figPluginRecoveryImagesSchema = z
  .object({
    version: z.literal(1),
    sourcePlanSha256: hash,
    assets: z.array(recoveryAssetSchema).min(1).max(4),
    targets: z.array(recoveryTargetSchema).min(1).max(20),
    manifestSha256: hash
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !sortedUnique(value.assets.map((asset) => asset.assetId)) ||
      !sortedUnique(value.targets.map((target) => `${target.targetId}\u0000${target.command}`)) ||
      value.assets.some(
        (asset) => !value.targets.some((target) => target.assetId === asset.assetId)
      ) ||
      value.targets.some((target) => {
        const asset = value.assets.find((asset) => asset.assetId === target.assetId)
        const evidence = target.acceptedEvidence
        return (
          !asset ||
          asset.sha256 !== target.sha256 ||
          evidence.sourceSha256 !== target.sha256 ||
          (evidence.kind === 'photoshop-pixels' &&
            (evidence.width !== asset.width ||
              evidence.height !== asset.height ||
              evidence.width !== evidence.bounds.right - evidence.bounds.left ||
              evidence.height !== evidence.bounds.bottom - evidence.bounds.top))
        )
      })
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid recovery image manifest' })
  })
export type FigPluginRecoveryImages = z.output<typeof figPluginRecoveryImagesSchema>

export const figPluginRecoveryExecutionImagesSchema = z
  .object({
    manifest: figPluginRecoveryImagesSchema,
    assetBindings: z
      .array(z.object({ sourceAssetId: id, assetId: id }).strict())
      .min(1)
      .max(4)
  })
  .strict()
  .superRefine((value, ctx) => {
    const sourceIds = value.manifest.assets.map((asset) => asset.assetId)
    if (
      !sortedUnique(value.assetBindings.map((binding) => binding.sourceAssetId)) ||
      new Set(value.assetBindings.map((binding) => binding.assetId)).size !==
        value.assetBindings.length ||
      value.assetBindings.length !== sourceIds.length ||
      value.assetBindings.some(
        (binding) =>
          !sourceIds.includes(binding.sourceAssetId) || sourceIds.includes(binding.assetId)
      )
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid recovery asset remapping' })
  })
export type FigPluginRecoveryExecutionImages = z.output<
  typeof figPluginRecoveryExecutionImagesSchema
>

export function recoveryImagesManifestContent(input: FigPluginRecoveryImages): string {
  const { manifestSha256: _manifestSha256, ...content } = figPluginRecoveryImagesSchema.parse(input)
  return canonicalFigPluginJson(content)
}

export function validateRecoveryExecutionImages(input: unknown): FigPluginRecoveryExecutionImages {
  const value = figPluginRecoveryExecutionImagesSchema.parse(input)
  const freeze = (object: object): void => {
    for (const child of Object.values(object)) if (child && typeof child === 'object') freeze(child)
    Object.freeze(object)
  }
  freeze(value)
  return value
}

export function recoveryImageTarget(
  images: FigPluginRecoveryExecutionImages | undefined,
  targetId: string,
  command: string
): FigPluginRecoveryImages['targets'][number] | undefined {
  if (!images) return undefined
  const target = images.manifest.targets.find(
    (target) => target.targetId === targetId && target.command === command
  )
  if (!target) throw new Error('IMAGE_RECOVERY_UNBOUND')
  return target
}

/** A separate trusted recovery descriptor is required; model plans cannot request placement. */
export function validateRecoveryImagePlanBinding(
  plan: HostPlan,
  input?: FigPluginRecoveryExecutionImages
): void {
  if (!input) return
  const images = validateRecoveryExecutionImages(input)
  const steps = plan.steps.filter(
    (step) => step.command === 'image.fill' || step.command === 'image.pixels'
  )
  if (
    steps.length !== images.manifest.targets.length ||
    steps.some((step) => {
      const target = recoveryImageTarget(images, step.targetId, step.command)
      const binding = images.assetBindings.find(
        (binding) => binding.sourceAssetId === target?.assetId
      )
      return (
        !target ||
        binding?.assetId !== step.assetId ||
        target.sha256 !== step.sha256 ||
        (step.command === 'image.fill' &&
          (target.command !== 'image.fill' || target.scaleMode !== step.scaleMode))
      )
    })
  )
    throw new Error('IMAGE_RECOVERY_UNBOUND')
}
