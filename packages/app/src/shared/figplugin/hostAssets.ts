import { z } from 'zod'
import { FigPluginIdSchema, FIGPLUGIN_HOSTS } from './manifest'

export const FIGPLUGIN_ASSET_MAX_BYTES = 8 * 1024 * 1024
export const FIGPLUGIN_ASSET_MAX_EDGE = 4096
export const FIGPLUGIN_ASSET_MAX_PIXELS = 16 * 1024 * 1024
export const FIGPLUGIN_ASSET_CHUNK_BYTES = 24 * 1024
export const FIGPLUGIN_ASSET_MAX_PER_SESSION = 4
export const FIGPLUGIN_ASSET_MAX_TOTAL = 16
export const FIGPLUGIN_ASSET_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const FIGPLUGIN_ASSET_TTL_MS = 120_000
export const FIGPLUGIN_ASSET_LIST_PATH = '/figplugin/v1/assets/list'
export const FIGPLUGIN_ASSET_READ_PATH = '/figplugin/v1/assets/read'

const id = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
const hash = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const projectId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$(?![\s\S])/)
const purpose = z.literal('local-preview')
export const figPluginAssetMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])
export type FigPluginAssetMime = z.output<typeof figPluginAssetMimeSchema>

// Main-owned selection and publication use this target, never a renderer-supplied pathname.
export const figPluginDesktopAssetTargetSchema = z
  .object({ sessionId: id, pluginId: FigPluginIdSchema, projectId })
  .strict()
export type FigPluginDesktopAssetTarget = z.output<typeof figPluginDesktopAssetTargetSchema>

export const figPluginSessionAssetSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('session-image-asset'),
    purpose,
    sessionId: id,
    pluginId: FigPluginIdSchema,
    projectId,
    host: z.enum(FIGPLUGIN_HOSTS),
    assetId: id,
    mimeType: figPluginAssetMimeSchema,
    sha256: hash,
    sizeBytes: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_BYTES),
    width: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_EDGE),
    height: z.number().int().min(1).max(FIGPLUGIN_ASSET_MAX_EDGE),
    chunkSize: z.literal(FIGPLUGIN_ASSET_CHUNK_BYTES),
    chunkCount: z
      .number()
      .int()
      .min(1)
      .max(Math.ceil(FIGPLUGIN_ASSET_MAX_BYTES / FIGPLUGIN_ASSET_CHUNK_BYTES)),
    createdAt: timestamp,
    expiresAt: timestamp
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.width * value.height > FIGPLUGIN_ASSET_MAX_PIXELS ||
      value.chunkCount !== Math.ceil(value.sizeBytes / value.chunkSize) ||
      value.expiresAt <= value.createdAt ||
      value.expiresAt - value.createdAt > FIGPLUGIN_ASSET_TTL_MS
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid session image limits' })
  })
export type FigPluginSessionAsset = z.output<typeof figPluginSessionAssetSchema>

export const figPluginAssetListRequestSchema = z
  .object({ protocol: z.literal(1), purpose })
  .strict()
export const figPluginAssetListSchema = z
  .object({
    protocol: z.literal(1),
    purpose,
    sessionId: id,
    assets: z.array(figPluginSessionAssetSchema).max(FIGPLUGIN_ASSET_MAX_PER_SESSION)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.assets.some((asset) => asset.sessionId !== value.sessionId) ||
      value.assets.some((asset) => {
        const first = value.assets[0]
        return (
          asset.pluginId !== first.pluginId ||
          asset.projectId !== first.projectId ||
          asset.host !== first.host
        )
      }) ||
      new Set(value.assets.map((asset) => asset.assetId)).size !== value.assets.length
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid session image catalog' })
  })
export type FigPluginAssetList = z.output<typeof figPluginAssetListSchema>

export const figPluginAssetReadRequestSchema = z
  .object({
    protocol: z.literal(1),
    purpose,
    assetId: id,
    sha256: hash,
    index: z
      .number()
      .int()
      .min(0)
      .max(Math.ceil(FIGPLUGIN_ASSET_MAX_BYTES / FIGPLUGIN_ASSET_CHUNK_BYTES) - 1)
  })
  .strict()
export type FigPluginAssetReadRequest = z.output<typeof figPluginAssetReadRequestSchema>

// The nested frame is the existing content-addressed-binary-chunk protocol, with a
// smaller fixed budget so HTTP and the independent Bridge child's 128 KiB frame both fit.
export const figPluginAssetChunkSchema = z
  .object({
    protocol: z.literal(1),
    purpose,
    sessionId: id,
    assetId: id,
    chunk: z
      .object({
        version: z.literal(1),
        kind: z.literal('content-addressed-binary-chunk'),
        sha256: hash,
        index: z
          .number()
          .int()
          .min(0)
          .max(Math.ceil(FIGPLUGIN_ASSET_MAX_BYTES / FIGPLUGIN_ASSET_CHUNK_BYTES) - 1),
        chunkCount: z
          .number()
          .int()
          .min(1)
          .max(Math.ceil(FIGPLUGIN_ASSET_MAX_BYTES / FIGPLUGIN_ASSET_CHUNK_BYTES)),
        bytesBase64: z
          .string()
          .min(4)
          .max(4 * Math.ceil(FIGPLUGIN_ASSET_CHUNK_BYTES / 3))
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/)
      })
      .strict()
  })
  .strict()
  .superRefine((value, ctx) => {
    const frame = value.chunk
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const text = frame.bytesBase64
    if (
      frame.index >= frame.chunkCount ||
      (text.endsWith('==') && (alphabet.indexOf(text[text.length - 3]) & 15) !== 0) ||
      (text.endsWith('=') &&
        !text.endsWith('==') &&
        (alphabet.indexOf(text[text.length - 2]) & 3) !== 0)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid session image chunk' })
  })
export type FigPluginAssetChunk = z.output<typeof figPluginAssetChunkSchema>

export const figPluginDesktopAssetRevokeSchema = figPluginDesktopAssetTargetSchema
  .extend({ assetId: id, sha256: hash })
  .strict()
export type FigPluginDesktopAssetRevoke = z.output<typeof figPluginDesktopAssetRevokeSchema>
