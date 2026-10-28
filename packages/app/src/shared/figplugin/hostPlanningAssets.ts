import { z } from 'zod'
import {
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_MAX_EDGE,
  FIGPLUGIN_ASSET_MAX_PER_SESSION,
  FIGPLUGIN_ASSET_MAX_PIXELS,
  figPluginAssetMimeSchema,
  figPluginDesktopAssetTargetSchema,
  figPluginSessionAssetSchema,
  type FigPluginSessionAsset
} from './hostAssets'
import { validateSessionAssetCatalog, type SessionAssetIdentity } from './hostAssetClient'
import { FIGPLUGIN_HOSTS } from './manifest'

const assetId = z.string().regex(/^[a-f0-9]{32}$(?![\s\S])/)
const hash = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/)

export const figPluginPlanningAssetReferenceSchema = z.object({ assetId, sha256: hash }).strict()
export type FigPluginPlanningAssetReference = z.output<typeof figPluginPlanningAssetReferenceSchema>
export const figPluginPlanningAssetReferencesSchema = z
  .array(figPluginPlanningAssetReferenceSchema)
  .min(1)
  .max(FIGPLUGIN_ASSET_MAX_PER_SESSION)
  .refine(
    (references) => new Set(references.map((ref) => ref.assetId)).size === references.length,
    {
      message: 'Duplicate planning asset reference'
    }
  )

// This is a separate, explicitly reviewed model-input projection. A local-preview
// lease alone never authorizes sending these fields, image pixels or host writes.
export const figPluginPlanningAssetMetadataSchema = z
  .object({
    ...figPluginPlanningAssetReferenceSchema.shape,
    mimeType: figPluginAssetMimeSchema,
    sizeBytes: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_BYTES),
    width: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_EDGE),
    height: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_EDGE),
    expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
  .refine((asset) => asset.width * asset.height <= FIGPLUGIN_ASSET_MAX_PIXELS, {
    message: 'Invalid planning asset dimensions'
  })
export type FigPluginPlanningAssetMetadata = z.output<typeof figPluginPlanningAssetMetadataSchema>

export const figPluginPlanningAssetCatalogSchema = figPluginDesktopAssetTargetSchema
  .extend({
    version: z.literal(1),
    kind: z.literal('planning-asset-catalog'),
    purpose: z.literal('model-planning-metadata'),
    host: z.enum(FIGPLUGIN_HOSTS),
    assets: z
      .array(figPluginPlanningAssetMetadataSchema)
      .min(1)
      .max(FIGPLUGIN_ASSET_MAX_PER_SESSION)
  })
  .strict()
  .refine(
    (catalog) =>
      new Set(catalog.assets.map((asset) => asset.assetId)).size === catalog.assets.length,
    {
      message: 'Duplicate planning catalog asset'
    }
  )
export type FigPluginPlanningAssetCatalog = z.output<typeof figPluginPlanningAssetCatalogSchema>

export function planningAssetMetadata(
  input: FigPluginSessionAsset
): FigPluginPlanningAssetMetadata {
  const { assetId, sha256, mimeType, sizeBytes, width, height, expiresAt } =
    figPluginSessionAssetSchema.parse(input)
  return { assetId, sha256, mimeType, sizeBytes, width, height, expiresAt }
}

export const validatePlanningAssetReferences = (
  input: unknown
): FigPluginPlanningAssetReference[] => figPluginPlanningAssetReferencesSchema.parse(input)

/** Host-side final selection check; the Bridge independently resolves its own catalog. */
export function selectPlanningAssetReferences(
  input: unknown,
  references: unknown,
  identity: SessionAssetIdentity,
  now = Date.now()
): FigPluginPlanningAssetReference[] {
  const catalog = validateSessionAssetCatalog(input, identity, now)
  const selected = validatePlanningAssetReferences(references)
  for (const reference of selected) {
    const asset = catalog.assets.find((asset) => asset.assetId === reference.assetId)
    if (!asset || asset.sha256 !== reference.sha256) throw new Error('PLANNING_ASSET_UNBOUND')
  }
  return selected
}
