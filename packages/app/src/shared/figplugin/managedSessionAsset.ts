import { z } from 'zod'
import { isNormalizedMediaRelativePath } from '../mediaReference'
import {
  FIGPLUGIN_ASSET_MAX_BYTES,
  figPluginAssetMimeSchema,
  figPluginDesktopAssetTargetSchema
} from './hostAssets'

const originalFileName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value === value.trim() &&
      value !== '.' &&
      value !== '..' &&
      !/[\p{Cc}\p{Cf}<>:"|?*/\\]/u.test(value) &&
      !/[. ]$/u.test(value) &&
      !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value),
    'Invalid managed image filename'
  )

// This is source identity, not proof of task/project ownership or a publication grant.
export const figPluginManagedAssetReferenceSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('managed'),
    relativePath: z.string().min(1).max(1024).refine(isNormalizedMediaRelativePath),
    sha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_BYTES),
    mimeType: figPluginAssetMimeSchema,
    originalFileName
  })
  .strict()
export type FigPluginManagedAssetReference = z.output<typeof figPluginManagedAssetReferenceSchema>

export const figPluginDesktopManagedAssetRequestSchema = figPluginDesktopAssetTargetSchema
  .extend({
    source: z
      .object({
        kind: z.literal('managed-media'),
        reference: figPluginManagedAssetReferenceSchema
      })
      .strict()
  })
  .strict()
export type FigPluginDesktopManagedAssetRequest = z.output<
  typeof figPluginDesktopManagedAssetRequestSchema
>
