import { z } from 'zod'

import {
  FIGPLUGIN_BRIDGE_MANIFEST_VERSION,
  FIGPLUGIN_CAPABILITIES,
  FIGPLUGIN_DEFAULT_TIMEOUT_MS,
  FIGPLUGIN_HOSTS,
  FIGPLUGIN_MAX_CONFIG_BYTES,
  FIGPLUGIN_MAX_CONCURRENT_CALLS,
  FIGPLUGIN_MAX_DIALOGUE_CHARS,
  FIGPLUGIN_MAX_PAYLOAD_BYTES,
  FIGPLUGIN_MAX_TIMEOUT_MS,
  FIGPLUGIN_SCHEMA_VERSION,
  FigPluginIdSchema,
  FigPluginIsoDateSchema,
  FigPluginManifestSchema,
  canonicalFigPluginRequest,
  measureFigPluginConfigBytes,
  FigPluginSafeRelativePathSchema,
  FigPluginVersionSchema,
  type FigPluginCapability,
  type FigPluginHost,
  type FigPluginManifest
} from './manifest'
import {
  FIGPLUGIN_FAILURE_REASONS,
  FIGPLUGIN_LIFECYCLE_STATES,
  FigPluginIdempotencyKeySchema,
  FigPluginRequestIdSchema,
  figPluginPayloadMetadataSchema,
  isFigPluginPayloadByteAccountingValid,
  isFigPluginTransferMetadataEquivalent,
  type FigPluginFailureReason
} from './lifecycle'

export const FIGPLUGIN_CENTER_SCHEMA_VERSION = 1 as const

export const FIGPLUGIN_CENTER_OPERATION_KINDS = [
  'install',
  'inspect',
  'configure',
  'copy-path',
  'status',
  'call',
  'uninstall'
] as const
export type FigPluginCenterOperationKind = (typeof FIGPLUGIN_CENTER_OPERATION_KINDS)[number]

export const FIGPLUGIN_CENTER_CALL_CAPABILITIES = ['dialogue', 'background-removal'] as const
export type FigPluginCenterCallCapability = (typeof FIGPLUGIN_CENTER_CALL_CAPABILITIES)[number]

export const FIGPLUGIN_CENTER_TRANSFER_CAPABILITIES = ['asset-transfer', 'result-transfer'] as const
export type FigPluginCenterTransferCapability =
  (typeof FIGPLUGIN_CENTER_TRANSFER_CAPABILITIES)[number]

export const FIGPLUGIN_CENTER_CONSENT_PERMISSIONS = [
  'install',
  'configure',
  'uninstall',
  ...FIGPLUGIN_CENTER_CALL_CAPABILITIES,
  ...FIGPLUGIN_CENTER_TRANSFER_CAPABILITIES
] as const
export type FigPluginCenterConsentPermission = (typeof FIGPLUGIN_CENTER_CONSENT_PERMISSIONS)[number]

export const FIGPLUGIN_CENTER_FAILURE_REASONS = [
  ...FIGPLUGIN_FAILURE_REASONS,
  'consent-required',
  'manifest-mismatch',
  'display-only'
] as const
export type FigPluginCenterFailureReason = (typeof FIGPLUGIN_CENTER_FAILURE_REASONS)[number]

const FigPluginCenterTimeoutSchema = z
  .number()
  .int('timeout must be an integer')
  .min(100, 'timeout must be at least 100 milliseconds')
  .max(FIGPLUGIN_MAX_TIMEOUT_MS, 'timeout exceeds the FIGPLUGIN bound')
  .default(FIGPLUGIN_DEFAULT_TIMEOUT_MS)

export const FigPluginCenterCancellationSchema = z
  .object({
    requested: z.boolean().default(false),
    requestedAt: FigPluginIsoDateSchema.optional()
  })
  .strict()
  .superRefine((cancellation, context) => {
    if (cancellation.requested && cancellation.requestedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedAt'],
        message: 'requested cancellation must include requestedAt'
      })
    }
    if (!cancellation.requested && cancellation.requestedAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedAt'],
        message: 'requestedAt is only allowed for a requested cancellation'
      })
    }
  })
  .default({ requested: false })

export type FigPluginCenterCancellation = z.infer<typeof FigPluginCenterCancellationSchema>

export const FigPluginCenterConsentSchema = z
  .object({
    granted: z.boolean(),
    permissions: z
      .array(z.enum(FIGPLUGIN_CENTER_CONSENT_PERMISSIONS))
      .max(FIGPLUGIN_CENTER_CONSENT_PERMISSIONS.length),
    grantedAt: FigPluginIsoDateSchema.optional(),
    source: z.enum(['user', 'policy', 'system']).default('user')
  })
  .strict()
  .superRefine((consent, context) => {
    const permissions = new Set<string>()
    for (const [index, permission] of consent.permissions.entries()) {
      if (permissions.has(permission)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permissions', index],
          message: `duplicate consent permission: ${permission}`
        })
      }
      permissions.add(permission)
    }

    if (consent.granted && consent.permissions.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions'],
        message: 'granted consent must name at least one permission'
      })
    }
    if (!consent.granted && consent.permissions.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions'],
        message: 'denied consent must not grant permissions'
      })
    }
    if (consent.granted && consent.grantedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grantedAt'],
        message: 'granted consent must include grantedAt'
      })
    }
  })

export type FigPluginCenterConsent = z.infer<typeof FigPluginCenterConsentSchema>

const FigPluginCenterRequestBaseFields = {
  schemaVersion: z.literal(FIGPLUGIN_CENTER_SCHEMA_VERSION),
  requestId: FigPluginRequestIdSchema,
  idempotencyKey: FigPluginIdempotencyKeySchema,
  requestedAt: FigPluginIsoDateSchema,
  timeoutMs: FigPluginCenterTimeoutSchema,
  cancellation: FigPluginCenterCancellationSchema
} as const

const requireConsent = (
  consent: FigPluginCenterConsent,
  requiredPermissions: readonly FigPluginCenterConsentPermission[],
  context: z.RefinementCtx
): void => {
  if (!consent.granted) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['consent', 'granted'],
      message: 'this operation requires explicit granted consent'
    })
    return
  }

  for (const permission of requiredPermissions) {
    if (!consent.permissions.includes(permission)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consent', 'permissions'],
        message: `consent must include ${permission} permission`
      })
    }
  }
}

const FigPluginCenterManifestIdentitySchema = z
  .object({
    schemaVersion: z.union([
      z.literal(FIGPLUGIN_SCHEMA_VERSION),
      z.literal(FIGPLUGIN_BRIDGE_MANIFEST_VERSION)
    ]),
    id: FigPluginIdSchema,
    version: FigPluginVersionSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    capabilities: z.array(z.enum(FIGPLUGIN_CAPABILITIES)).min(1).max(FIGPLUGIN_CAPABILITIES.length)
  })
  .strict()
  .superRefine((identity, context) => {
    const capabilities = new Set<string>()
    for (const [index, capability] of identity.capabilities.entries()) {
      if (capabilities.has(capability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', index],
          message: `duplicate capability: ${capability}`
        })
      }
      capabilities.add(capability)
    }
  })

export type FigPluginCenterManifestIdentity = z.infer<typeof FigPluginCenterManifestIdentitySchema>

const FigPluginCenterCallPayloadSchema = z
  .object({
    operation: z.enum(FIGPLUGIN_CENTER_CALL_CAPABILITIES),
    input: figPluginPayloadMetadataSchema,
    output: figPluginPayloadMetadataSchema.optional(),
    dialogueText: z.string().trim().min(1).max(FIGPLUGIN_MAX_DIALOGUE_CHARS).optional()
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.operation === 'dialogue' && payload.dialogueText === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dialogueText'],
        message: 'dialogue calls require dialogueText'
      })
    }
    if (payload.operation !== 'dialogue' && payload.dialogueText !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dialogueText'],
        message: 'dialogueText is only allowed for dialogue calls'
      })
    }
    if (payload.input.transfer && payload.input.transfer.kind !== 'asset') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['input', 'transfer', 'kind'],
        message: 'call input transfers must be asset transfers'
      })
    }
    if (payload.output?.transfer && payload.output.transfer.kind !== 'result') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['output', 'transfer', 'kind'],
        message: 'call output transfers must be result transfers'
      })
    }
  })

export type FigPluginCenterCallPayload = z.infer<typeof FigPluginCenterCallPayloadSchema>

const FigPluginCenterCallRequestSchema = z
  .object({
    ...FigPluginCenterRequestBaseFields,
    kind: z.literal('call'),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    capability: z.enum(FIGPLUGIN_CENTER_CALL_CAPABILITIES),
    consent: FigPluginCenterConsentSchema,
    payload: FigPluginCenterCallPayloadSchema,
    payloadMetadata: figPluginPayloadMetadataSchema,
    installedManifest: FigPluginManifestSchema.optional()
  })
  .strict()
  .superRefine((request, context) => {
    const requiredPermissions: FigPluginCenterConsentPermission[] = [request.capability]
    if (request.payload.input.transfer) requiredPermissions.push('asset-transfer')
    if (request.payload.output?.transfer) requiredPermissions.push('result-transfer')
    requireConsent(request.consent, requiredPermissions, context)

    if (request.capability !== request.payload.operation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability'],
        message: 'capability must match payload.operation'
      })
    }
    if (request.payloadMetadata.contentType !== request.payload.input.contentType) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payloadMetadata', 'contentType'],
        message: 'payloadMetadata.contentType must match payload.input.contentType'
      })
    }
    const outputSizeBytes = request.payload.output?.sizeBytes ?? 0
    if (
      !isFigPluginPayloadByteAccountingValid(
        request.payload.input.sizeBytes,
        outputSizeBytes,
        request.payloadMetadata.sizeBytes
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payloadMetadata', 'sizeBytes'],
        message: 'payloadMetadata.sizeBytes must cover input and output payloads'
      })
    }

    const inputTransfer = request.payload.input.transfer
    const mirroredTransfer = request.payloadMetadata.transfer
    if (inputTransfer === undefined || mirroredTransfer === undefined) {
      if (inputTransfer !== mirroredTransfer) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payloadMetadata', 'transfer'],
          message: 'payloadMetadata.transfer must mirror the input transfer'
        })
      }
    } else if (!isFigPluginTransferMetadataEquivalent(inputTransfer, mirroredTransfer)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payloadMetadata', 'transfer'],
        message: 'payloadMetadata.transfer must exactly mirror the input transfer metadata'
      })
    }
    if (inputTransfer && inputTransfer.sizeBytes !== request.payload.input.sizeBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'input', 'transfer', 'sizeBytes'],
        message: 'input transfer sizeBytes must match payload.input.sizeBytes'
      })
    }
    if (
      request.payload.output?.transfer &&
      request.payload.output.transfer.sizeBytes !== request.payload.output.sizeBytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'output', 'transfer', 'sizeBytes'],
        message: 'output transfer sizeBytes must match payload.output.sizeBytes'
      })
    }

    const manifest = request.installedManifest
    if (manifest === undefined) return

    if (request.pluginId !== manifest.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pluginId'],
        message: 'pluginId must match installedManifest.id'
      })
    }
    if (request.host !== manifest.host) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['host'],
        message: 'host must match installedManifest.host'
      })
    }
    if (!manifest.capabilities.includes(request.capability)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capability'],
        message: 'capability must be declared by installedManifest'
      })
    }
    if (request.payload.input.transfer) {
      if (!manifest.capabilities.includes('asset-transfer')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', 'input', 'transfer'],
          message: 'asset transfer must be declared by installedManifest'
        })
      }
      if (manifest.permissions.assetTransfer !== 'read') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', 'input', 'transfer'],
          message: 'installedManifest does not grant asset-transfer permission'
        })
      }
    }
    if (request.payload.output?.transfer) {
      if (!manifest.capabilities.includes('result-transfer')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', 'output', 'transfer'],
          message: 'result transfer must be declared by installedManifest'
        })
      }
      if (manifest.permissions.resultTransfer !== 'write') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload', 'output', 'transfer'],
          message: 'installedManifest does not grant result-transfer permission'
        })
      }
    }

    const maxPayloadBytes = Math.min(manifest.limits.maxPayloadBytes, FIGPLUGIN_MAX_PAYLOAD_BYTES)
    const maxResultBytes = Math.min(manifest.limits.maxResultBytes, maxPayloadBytes)
    if (request.payloadMetadata.sizeBytes > maxPayloadBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payloadMetadata', 'sizeBytes'],
        message: 'payload exceeds installedManifest.maxPayloadBytes'
      })
    }
    if (request.payload.input.sizeBytes > maxPayloadBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'input', 'sizeBytes'],
        message: 'input exceeds installedManifest.maxPayloadBytes'
      })
    }
    if (request.payload.output && request.payload.output.sizeBytes > maxResultBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'output', 'sizeBytes'],
        message: 'output exceeds installedManifest.maxResultBytes'
      })
    }
    if (request.timeoutMs > Math.min(manifest.limits.maxCallTimeoutMs, FIGPLUGIN_MAX_TIMEOUT_MS)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeoutMs'],
        message: 'timeout exceeds installedManifest.maxCallTimeoutMs'
      })
    }
  })

const FigPluginCenterInstallRequestSchema = z
  .object({
    ...FigPluginCenterRequestBaseFields,
    kind: z.literal('install'),
    manifest: FigPluginManifestSchema,
    consent: FigPluginCenterConsentSchema
  })
  .strict()
  .superRefine((request, context) => {
    requireConsent(request.consent, ['install'], context)
  })

const FigPluginCenterInspectRequestSchema = z
  .object({
    ...FigPluginCenterRequestBaseFields,
    kind: z.literal('inspect'),
    manifest: FigPluginManifestSchema
  })
  .strict()

const FigPluginCenterConfigureRequestSchema = z
  .object({
    ...FigPluginCenterRequestBaseFields,
    kind: z.literal('configure'),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    consent: FigPluginCenterConsentSchema,
    config: z.record(z.string(), z.unknown()),
    configBytes: z.number().int().min(0).max(FIGPLUGIN_MAX_CONFIG_BYTES)
  })
  .strict()
  .superRefine((request, context) => {
    requireConsent(request.consent, ['configure'], context)

    let measuredBytes: number
    try {
      measuredBytes = measureFigPluginConfigBytes(request.config)
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config'],
        message: error instanceof Error ? error.message : 'config is not JSON serializable'
      })
      return
    }

    if (request.configBytes !== measuredBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['configBytes'],
        message: `configBytes must equal canonical JSON UTF-8 size (${measuredBytes})`
      })
    }
  })

const FigPluginCenterCopyPathRequestSchema = z
  .object({
    ...FigPluginCenterRequestBaseFields,
    kind: z.literal('copy-path'),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    path: FigPluginSafeRelativePathSchema,
    displayOnly: z.literal(true)
  })
  .strict()

const FigPluginCenterStatusRequestSchema = z
  .object({
    ...FigPluginCenterRequestBaseFields,
    kind: z.literal('status'),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS)
  })
  .strict()

const FigPluginCenterUninstallRequestSchema = z
  .object({
    ...FigPluginCenterRequestBaseFields,
    kind: z.literal('uninstall'),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    consent: FigPluginCenterConsentSchema
  })
  .strict()
  .superRefine((request, context) => {
    requireConsent(request.consent, ['uninstall'], context)
  })

export const FigPluginCenterOperationSchema = z.union([
  FigPluginCenterInstallRequestSchema,
  FigPluginCenterInspectRequestSchema,
  FigPluginCenterConfigureRequestSchema,
  FigPluginCenterCopyPathRequestSchema,
  FigPluginCenterStatusRequestSchema,
  FigPluginCenterCallRequestSchema,
  FigPluginCenterUninstallRequestSchema
])

export type FigPluginCenterInstallOperation = z.infer<typeof FigPluginCenterInstallRequestSchema>
export type FigPluginCenterInspectOperation = z.infer<typeof FigPluginCenterInspectRequestSchema>
export type FigPluginCenterConfigureOperation = z.infer<
  typeof FigPluginCenterConfigureRequestSchema
>
export type FigPluginCenterCopyPathOperation = z.infer<typeof FigPluginCenterCopyPathRequestSchema>
export type FigPluginCenterStatusOperation = z.infer<typeof FigPluginCenterStatusRequestSchema>
export type FigPluginCenterCallOperation = z.infer<typeof FigPluginCenterCallRequestSchema>
export type FigPluginCenterUninstallOperation = z.infer<
  typeof FigPluginCenterUninstallRequestSchema
>
export type FigPluginCenterOperation = z.infer<typeof FigPluginCenterOperationSchema>
export type FigPluginCenterOperationInput = z.input<typeof FigPluginCenterOperationSchema>

const FigPluginCenterStatusFailureSummarySchema = z
  .object({
    reason: z.enum(FIGPLUGIN_CENTER_FAILURE_REASONS),
    retryable: z.boolean()
  })
  .strict()

export type FigPluginCenterStatusFailureSummary = z.infer<
  typeof FigPluginCenterStatusFailureSummarySchema
>

export const FigPluginCenterRedactedStatusSchema = z
  .object({
    redacted: z.literal(true),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    state: z.enum(FIGPLUGIN_LIFECYCLE_STATES),
    installed: z.boolean(),
    configured: z.boolean(),
    ready: z.boolean(),
    activeCalls: z.number().int().min(0).max(FIGPLUGIN_MAX_CONCURRENT_CALLS),
    manifestIdentity: FigPluginCenterManifestIdentitySchema.optional(),
    lastFailure: FigPluginCenterStatusFailureSummarySchema.optional()
  })
  .strict()
  .superRefine((status, context) => {
    if (!status.installed && (status.configured || status.ready || status.activeCalls !== 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['installed'],
        message: 'uninstalled status cannot be configured, ready, or active'
      })
    }
    if (status.configured && !status.installed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['configured'],
        message: 'configured status requires installed status'
      })
    }
    if (status.ready && (!status.installed || !status.configured)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ready'],
        message: 'ready status requires installed and configured status'
      })
    }
    if (
      (status.state === 'ready' || status.state === 'calling') &&
      (!status.installed || !status.configured || !status.ready)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: `${status.state} status requires installed, configured, and ready status`
      })
    }
    if (
      status.state === 'uninstalled' &&
      (status.installed || status.configured || status.ready || status.activeCalls !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'uninstalled status cannot be installed, configured, ready, or active'
      })
    }
    if (status.state === 'failed' && status.lastFailure === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastFailure'],
        message: 'failed status requires lastFailure'
      })
    }
    if (status.installed && status.manifestIdentity === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifestIdentity'],
        message: 'installed status requires a redacted manifest identity'
      })
    }
    if (status.manifestIdentity) {
      if (status.manifestIdentity.id !== status.pluginId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifestIdentity', 'id'],
          message: 'manifestIdentity.id must match pluginId'
        })
      }
      if (status.manifestIdentity.host !== status.host) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifestIdentity', 'host'],
          message: 'manifestIdentity.host must match host'
        })
      }
    }
  })

export type FigPluginCenterRedactedStatus = z.infer<typeof FigPluginCenterRedactedStatusSchema>

export const FigPluginCenterFailureSchema = z
  .object({
    type: z.literal('figplugin-center-failure'),
    reason: z.enum(FIGPLUGIN_CENTER_FAILURE_REASONS),
    message: z.string().trim().min(1).max(512),
    retryable: z.boolean(),
    requestId: FigPluginRequestIdSchema,
    idempotencyKey: FigPluginIdempotencyKeySchema
  })
  .strict()

export type FigPluginCenterFailure = z.infer<typeof FigPluginCenterFailureSchema>

const FigPluginCenterResponseBaseFields = {
  schemaVersion: z.literal(FIGPLUGIN_CENTER_SCHEMA_VERSION),
  requestId: FigPluginRequestIdSchema,
  idempotencyKey: FigPluginIdempotencyKeySchema,
  completedAt: FigPluginIsoDateSchema
} as const

const FigPluginCenterInstallResponseSchema = z
  .object({
    ...FigPluginCenterResponseBaseFields,
    kind: z.literal('install'),
    ok: z.literal(true),
    pluginId: FigPluginIdSchema,
    manifestIdentity: FigPluginCenterManifestIdentitySchema,
    status: FigPluginCenterRedactedStatusSchema
  })
  .strict()
  .superRefine((response, context) => {
    if (response.pluginId !== response.manifestIdentity.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifestIdentity', 'id'],
        message: 'manifestIdentity.id must match pluginId'
      })
    }
    if (response.status.pluginId !== response.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'pluginId'],
        message: 'status.pluginId must match pluginId'
      })
    }
  })

const FigPluginCenterInspectResponseSchema = z
  .object({
    ...FigPluginCenterResponseBaseFields,
    kind: z.literal('inspect'),
    ok: z.literal(true),
    pluginId: FigPluginIdSchema,
    manifest: FigPluginManifestSchema
  })
  .strict()
  .superRefine((response, context) => {
    if (response.pluginId !== response.manifest.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifest', 'id'],
        message: 'manifest.id must match pluginId'
      })
    }
  })

const FigPluginCenterConfigureResponseSchema = z
  .object({
    ...FigPluginCenterResponseBaseFields,
    kind: z.literal('configure'),
    ok: z.literal(true),
    pluginId: FigPluginIdSchema,
    status: FigPluginCenterRedactedStatusSchema
  })
  .strict()
  .superRefine((response, context) => {
    if (response.status.pluginId !== response.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'pluginId'],
        message: 'status.pluginId must match pluginId'
      })
    }
  })

const FigPluginCenterCopyPathResponseSchema = z
  .object({
    ...FigPluginCenterResponseBaseFields,
    kind: z.literal('copy-path'),
    ok: z.literal(true),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    path: FigPluginSafeRelativePathSchema,
    displayOnly: z.literal(true)
  })
  .strict()

const FigPluginCenterStatusResponseSchema = z
  .object({
    ...FigPluginCenterResponseBaseFields,
    kind: z.literal('status'),
    ok: z.literal(true),
    pluginId: FigPluginIdSchema,
    status: FigPluginCenterRedactedStatusSchema
  })
  .strict()
  .superRefine((response, context) => {
    if (response.status.pluginId !== response.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'pluginId'],
        message: 'status.pluginId must match pluginId'
      })
    }
  })

const FigPluginCenterCallResponseSchema = z
  .object({
    ...FigPluginCenterResponseBaseFields,
    kind: z.literal('call'),
    ok: z.literal(true),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    capability: z.enum(FIGPLUGIN_CENTER_CALL_CAPABILITIES),
    status: FigPluginCenterRedactedStatusSchema,
    payloadMetadata: figPluginPayloadMetadataSchema.optional()
  })
  .strict()
  .superRefine((response, context) => {
    if (response.status.pluginId !== response.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'pluginId'],
        message: 'status.pluginId must match pluginId'
      })
    }
    if (response.status.host !== response.host) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'host'],
        message: 'status.host must match host'
      })
    }
  })

const FigPluginCenterUninstallResponseSchema = z
  .object({
    ...FigPluginCenterResponseBaseFields,
    kind: z.literal('uninstall'),
    ok: z.literal(true),
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    status: FigPluginCenterRedactedStatusSchema,
    alreadyUninstalled: z.boolean(),
    idempotent: z.literal(true)
  })
  .strict()
  .superRefine((response, context) => {
    if (response.status.pluginId !== response.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'pluginId'],
        message: 'status.pluginId must match pluginId'
      })
    }
    if (response.status.host !== response.host) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'host'],
        message: 'status.host must match host'
      })
    }
    if (response.status.state !== 'uninstalled' || response.status.installed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'uninstall responses must report an uninstalled status'
      })
    }
  })

const FigPluginCenterFailureResponseSchema = z
  .object({
    ...FigPluginCenterResponseBaseFields,
    kind: z.enum(FIGPLUGIN_CENTER_OPERATION_KINDS),
    ok: z.literal(false),
    failure: FigPluginCenterFailureSchema
  })
  .strict()
  .superRefine((response, context) => {
    if (response.failure.requestId !== response.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure', 'requestId'],
        message: 'failure.requestId must match requestId'
      })
    }
    if (response.failure.idempotencyKey !== response.idempotencyKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure', 'idempotencyKey'],
        message: 'failure.idempotencyKey must match idempotencyKey'
      })
    }
  })

export const FigPluginCenterResponseSchema = z.union([
  FigPluginCenterFailureResponseSchema,
  FigPluginCenterInstallResponseSchema,
  FigPluginCenterInspectResponseSchema,
  FigPluginCenterConfigureResponseSchema,
  FigPluginCenterCopyPathResponseSchema,
  FigPluginCenterStatusResponseSchema,
  FigPluginCenterCallResponseSchema,
  FigPluginCenterUninstallResponseSchema
])

export type FigPluginCenterInstallResponse = z.infer<typeof FigPluginCenterInstallResponseSchema>
export type FigPluginCenterInspectResponse = z.infer<typeof FigPluginCenterInspectResponseSchema>
export type FigPluginCenterConfigureResponse = z.infer<
  typeof FigPluginCenterConfigureResponseSchema
>
export type FigPluginCenterCopyPathResponse = z.infer<typeof FigPluginCenterCopyPathResponseSchema>
export type FigPluginCenterStatusResponse = z.infer<typeof FigPluginCenterStatusResponseSchema>
export type FigPluginCenterCallResponse = z.infer<typeof FigPluginCenterCallResponseSchema>
export type FigPluginCenterUninstallResponse = z.infer<
  typeof FigPluginCenterUninstallResponseSchema
>
export type FigPluginCenterFailureResponse = z.infer<typeof FigPluginCenterFailureResponseSchema>
export type FigPluginCenterResponse = z.infer<typeof FigPluginCenterResponseSchema>

export const figPluginCenterOperationSchema = FigPluginCenterOperationSchema
export const figPluginCenterResponseSchema = FigPluginCenterResponseSchema
export const figPluginCenterConsentSchema = FigPluginCenterConsentSchema
export const figPluginCenterRedactedStatusSchema = FigPluginCenterRedactedStatusSchema
export const figPluginCenterFailureSchema = FigPluginCenterFailureSchema

export const parseFigPluginCenterOperation = (value: unknown): FigPluginCenterOperation =>
  FigPluginCenterOperationSchema.parse(value)

export const safeParseFigPluginCenterOperation = (value: unknown) =>
  FigPluginCenterOperationSchema.safeParse(value)

export const parseFigPluginCenterResponse = (value: unknown): FigPluginCenterResponse =>
  FigPluginCenterResponseSchema.parse(value)

export const safeParseFigPluginCenterResponse = (value: unknown) =>
  FigPluginCenterResponseSchema.safeParse(value)

export const isFigPluginCenterOperation = (value: unknown): value is FigPluginCenterOperation =>
  FigPluginCenterOperationSchema.safeParse(value).success

export const isFigPluginCenterResponse = (value: unknown): value is FigPluginCenterResponse =>
  FigPluginCenterResponseSchema.safeParse(value).success

export type FigPluginCenterValidationIssue = {
  path: (string | number)[]
  message: string
  code?: string
}

export type FigPluginCenterValidationResult<T> =
  | { ok: true; value: T; issues: FigPluginCenterValidationIssue[] }
  | { ok: false; issues: FigPluginCenterValidationIssue[] }

export const validateFigPluginCenterOperation = (
  value: unknown
): FigPluginCenterValidationResult<FigPluginCenterOperation> => {
  const result = FigPluginCenterOperationSchema.safeParse(value)
  if (result.success) return { ok: true, value: result.data, issues: [] }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code
    }))
  }
}

export const validateFigPluginCenterResponse = (
  value: unknown
): FigPluginCenterValidationResult<FigPluginCenterResponse> => {
  const result = FigPluginCenterResponseSchema.safeParse(value)
  if (result.success) return { ok: true, value: result.data, issues: [] }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code
    }))
  }
}

export const getFigPluginCenterOperationPluginId = (
  operation: FigPluginCenterOperation
): string | undefined => {
  if (operation.kind === 'install' || operation.kind === 'inspect') return operation.manifest.id
  return operation.pluginId
}

export const getFigPluginCenterOperationHost = (
  operation: FigPluginCenterOperation
): FigPluginHost | undefined => {
  if (operation.kind === 'install' || operation.kind === 'inspect') return operation.manifest.host
  return operation.host
}

export const getFigPluginCenterOperationCapabilities = (
  operation: FigPluginCenterOperation
): readonly FigPluginCapability[] => {
  if (operation.kind === 'install' || operation.kind === 'inspect')
    return operation.manifest.capabilities
  if (operation.kind === 'call') return [operation.capability]
  return []
}

export const getFigPluginCenterRequiredConsentPermissions = (
  operation: FigPluginCenterOperation
): readonly FigPluginCenterConsentPermission[] => {
  if (operation.kind === 'install') return ['install']
  if (operation.kind === 'configure') return ['configure']
  if (operation.kind === 'uninstall') return ['uninstall']
  if (operation.kind !== 'call') return []

  const permissions: FigPluginCenterConsentPermission[] = [operation.capability]
  if (operation.payload.input.transfer) permissions.push('asset-transfer')
  if (operation.payload.output?.transfer) permissions.push('result-transfer')
  return permissions
}

export const isFigPluginCenterPathCopyDisplayOnly = (
  operation: FigPluginCenterOperation
): operation is FigPluginCenterCopyPathOperation =>
  operation.kind === 'copy-path' && operation.displayOnly === true

export const isFigPluginCenterUninstallIdempotent = (
  operation: FigPluginCenterOperation
): operation is FigPluginCenterUninstallOperation => operation.kind === 'uninstall'

type FigPluginCenterIdempotencyComparableOperation =
  | FigPluginCenterOperation
  | (Pick<FigPluginCenterOperation, 'kind' | 'idempotencyKey'> & {
      pluginId?: string
      manifest?: Pick<FigPluginManifest, 'id'>
    })

export const getFigPluginCenterIdempotencyIdentity = (
  operation: FigPluginCenterIdempotencyComparableOperation
): {
  kind: FigPluginCenterOperationKind
  pluginId: string | undefined
  idempotencyKey: string
} => ({
  kind: operation.kind,
  pluginId:
    operation.kind === 'install' || operation.kind === 'inspect'
      ? operation.manifest?.id
      : operation.pluginId,
  idempotencyKey: operation.idempotencyKey
})

export const getFigPluginCenterIdempotencyFingerprint = (
  operation: FigPluginCenterIdempotencyComparableOperation
): string => canonicalFigPluginRequest(operation)

export const isSameFigPluginCenterIdempotentOperation = (
  left: FigPluginCenterIdempotencyComparableOperation,
  right: FigPluginCenterIdempotencyComparableOperation
): boolean => {
  const leftIdentity = getFigPluginCenterIdempotencyIdentity(left)
  const rightIdentity = getFigPluginCenterIdempotencyIdentity(right)
  if (
    leftIdentity.kind !== rightIdentity.kind ||
    leftIdentity.pluginId === undefined ||
    leftIdentity.pluginId !== rightIdentity.pluginId ||
    leftIdentity.idempotencyKey !== rightIdentity.idempotencyKey
  ) {
    return false
  }

  try {
    return (
      getFigPluginCenterIdempotencyFingerprint(left) ===
      getFigPluginCenterIdempotencyFingerprint(right)
    )
  } catch {
    return false
  }
}

export const isFigPluginCenterCallWithinPayloadLimit = (
  operation: Pick<FigPluginCenterCallOperation, 'payload' | 'payloadMetadata'>,
  manifest?: Pick<FigPluginManifest, 'limits'>
): boolean => {
  const maxPayloadBytes = Math.min(
    manifest?.limits.maxPayloadBytes ?? FIGPLUGIN_MAX_PAYLOAD_BYTES,
    FIGPLUGIN_MAX_PAYLOAD_BYTES
  )
  const maxResultBytes = Math.min(
    manifest?.limits.maxResultBytes ?? maxPayloadBytes,
    maxPayloadBytes
  )
  const outputSizeBytes = operation.payload.output?.sizeBytes ?? 0

  return (
    operation.payloadMetadata.sizeBytes <= maxPayloadBytes &&
    operation.payload.input.sizeBytes <= maxPayloadBytes &&
    outputSizeBytes <= maxResultBytes &&
    isFigPluginPayloadByteAccountingValid(
      operation.payload.input.sizeBytes,
      outputSizeBytes,
      operation.payloadMetadata.sizeBytes
    )
  )
}

export const isFigPluginCenterRequestWithinTimeout = (
  operation: Pick<FigPluginCenterOperation, 'timeoutMs'>,
  manifest?: Pick<FigPluginManifest, 'limits'>
): boolean =>
  operation.timeoutMs <=
  Math.min(manifest?.limits.maxCallTimeoutMs ?? FIGPLUGIN_MAX_TIMEOUT_MS, FIGPLUGIN_MAX_TIMEOUT_MS)

export const isFigPluginCenterConfigWithinLimit = (
  operation: Pick<FigPluginCenterConfigureOperation, 'config' | 'configBytes'>,
  manifest?: Pick<FigPluginManifest, 'limits'>
): boolean => {
  try {
    const measuredBytes = measureFigPluginConfigBytes(operation.config)
    return (
      operation.configBytes === measuredBytes &&
      measuredBytes <=
        Math.min(
          manifest?.limits.maxConfigBytes ?? FIGPLUGIN_MAX_CONFIG_BYTES,
          FIGPLUGIN_MAX_CONFIG_BYTES
        )
    )
  } catch {
    return false
  }
}

export const isFigPluginCenterRequestCancellation = (
  operation: Pick<FigPluginCenterOperation, 'cancellation'>
): boolean => operation.cancellation.requested

export const isFigPluginCenterCapability = (
  value: unknown
): value is FigPluginCenterCallCapability | FigPluginCenterTransferCapability =>
  typeof value === 'string' &&
  ((FIGPLUGIN_CENTER_CALL_CAPABILITIES as readonly string[]).includes(value) ||
    (FIGPLUGIN_CENTER_TRANSFER_CAPABILITIES as readonly string[]).includes(value))

export const isFigPluginCenterFailureReason = (
  value: unknown
): value is FigPluginCenterFailureReason | FigPluginFailureReason =>
  typeof value === 'string' &&
  (FIGPLUGIN_CENTER_FAILURE_REASONS as readonly string[]).includes(value)
