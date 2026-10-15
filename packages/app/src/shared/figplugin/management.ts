import { z } from 'zod'
import { ServiceError, ServiceValidationError } from '../api/apiUtils/serviceValidation'
import {
  FIGPLUGIN_CAPABILITIES,
  FIGPLUGIN_HOSTS,
  FigPluginDesktopBridgeOriginSchema,
  FigPluginIdSchema,
  FigPluginVersionSchema
} from './manifest'

// No source paths, file contents, signer key material or provider credentials in listings.
// Profile IDs are references only. Main owns native dialogs and installation paths.
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const receipt = z.string().regex(/^[a-f0-9]{48}$/)
const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const host = z.enum(FIGPLUGIN_HOSTS)
const settings = z
  .object({
    analysisProfileId: z.string().trim().min(1).max(512).optional(),
    backgroundRemovalProfileId: z.string().trim().min(1).max(512).optional()
  })
  .strict()

export const figPluginManagedSummarySchema = z
  .object({
    pluginId: FigPluginIdSchema,
    name: z.string().min(1).max(128),
    version: FigPluginVersionSchema,
    host,
    generation,
    capabilities: z.array(z.enum(FIGPLUGIN_CAPABILITIES)).min(1).max(4),
    manifestSha256: hash,
    materialization: z.enum(['metadata-only', 'verified-package', 'cleanup-pending']),
    signerFingerprint: hash.optional(),
    artifactSha256: hash.optional(),
    bridgeOrigin: FigPluginDesktopBridgeOriginSchema.optional(),
    fileCount: z.number().int().min(0).max(64),
    contentBytes: z
      .number()
      .int()
      .min(0)
      .max(8 * 1024 * 1024),
    configured: z.boolean(),
    ready: z.literal(false),
    state: z.enum(['disabled', 'uninstalled']),
    cleanupPending: z.boolean(),
    settings
  })
  .strict()
  .superRefine((item, context) => {
    const tombstone = item.materialization === 'cleanup-pending'
    if (
      tombstone !== (item.state === 'uninstalled') ||
      (tombstone && (!item.cleanupPending || item.configured || Object.keys(item.settings).length))
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid cleanup state' })
    }
    if (
      item.materialization === 'verified-package' &&
      (!item.signerFingerprint ||
        !item.artifactSha256 ||
        item.fileCount < 1 ||
        item.contentBytes < 1)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Missing verified package identity'
      })
    }
  })
export type FigPluginManagedSummary = z.infer<typeof figPluginManagedSummarySchema>

export const figPluginManagedListSchema = z
  .object({
    items: z.array(figPluginManagedSummarySchema).max(256),
    truncated: z.boolean(),
    skippedRecords: z.number().int().min(0).max(512)
  })
  .strict()
export type FigPluginManagedList = z.infer<typeof figPluginManagedListSchema>

export const figPluginPackagePreviewSchema = z
  .object({
    receiptId: receipt,
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    pluginId: FigPluginIdSchema,
    name: z.string().min(1).max(128),
    version: FigPluginVersionSchema,
    host,
    expectedGeneration: generation,
    capabilities: z.array(z.enum(FIGPLUGIN_CAPABILITIES)).min(1).max(4),
    signerFingerprint: hash,
    artifactSha256: hash,
    bridgeOrigin: FigPluginDesktopBridgeOriginSchema.optional(),
    fileCount: z.number().int().min(1).max(64),
    contentBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
    signatureVerified: z.literal(true),
    publisherTrusted: z.literal(false),
    executesInDesktop: z.literal(false)
  })
  .strict()
export type FigPluginPackagePreview = z.infer<typeof figPluginPackagePreviewSchema>

export const figPluginManagementEmptyRequestSchema = z.object({}).strict()
export const figPluginPackageInstallRequestSchema = z
  .object({
    receiptId: receipt,
    expectedGeneration: generation,
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
  })
  .strict()
export type FigPluginPackageInstallRequest = z.infer<typeof figPluginPackageInstallRequestSchema>

export const figPluginManagedTargetSchema = z
  .object({
    pluginId: FigPluginIdSchema,
    expectedGeneration: generation
  })
  .strict()
export type FigPluginManagedTarget = z.infer<typeof figPluginManagedTargetSchema>

export const figPluginManagedConfigureRequestSchema = figPluginManagedTargetSchema
  .extend({ settings })
  .strict()
export type FigPluginManagedConfigureRequest = z.infer<
  typeof figPluginManagedConfigureRequestSchema
>
export const figPluginManagedRemoveRequestSchema = figPluginManagedTargetSchema
  .extend({
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
  })
  .strict()
export type FigPluginManagedRemoveRequest = z.infer<typeof figPluginManagedRemoveRequestSchema>

export const figPluginManagedMutationSchema = z
  .object({
    completed: z.boolean(),
    generation,
    cleanupPending: z.boolean()
  })
  .strict()
export type FigPluginManagedMutation = z.infer<typeof figPluginManagedMutationSchema>
export const figPluginManagedPathResultSchema = z.object({ completed: z.boolean() }).strict()

export const FIGPLUGIN_MANAGEMENT_ERRORS = Object.freeze({
  PERMISSION_DENIED: 'Plugin management requires the trusted desktop window.',
  INVALID_PACKAGE: 'The plugin package is invalid.',
  INVALID_SIGNATURE: 'The plugin package signature is invalid.',
  INVALID_SIGNER: 'The selected signer key is invalid.',
  INTEGRITY_FAILED: 'The plugin package integrity check failed.',
  STALE_PREVIEW:
    'The package preview expired or belongs to another window. Select the package again.',
  CONFIGURATION_CHANGED: 'The installed plugin changed. Refresh before continuing.',
  BUSY: 'Plugin management is busy or its bounded capacity has been reached.',
  CANCELLED: 'Plugin management was cancelled.',
  TIMEOUT: 'Plugin management timed out before commit.',
  IO_ERROR: 'The plugin files or store are unavailable.',
  NOT_INSTALLED: 'No verified plugin package is installed.',
  IDEMPOTENCY_CONFLICT: 'The operation identifier has already been used with different content.'
})
export type FigPluginManagementErrorCode = keyof typeof FIGPLUGIN_MANAGEMENT_ERRORS
export class FigPluginManagementError extends ServiceError {
  constructor(code: FigPluginManagementErrorCode) {
    super(FIGPLUGIN_MANAGEMENT_ERRORS[code], { code })
  }
}
export function parseFigPluginManagementValue<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown
): z.output<Schema> {
  try {
    return schema.parse(value)
  } catch {
    throw new ServiceValidationError('FIGPLUGIN management value')
  }
}
