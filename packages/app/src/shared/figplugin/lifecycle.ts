import { z } from 'zod'

import {
  FIGPLUGIN_CAPABILITIES,
  FIGPLUGIN_DEFAULT_TIMEOUT_MS,
  FIGPLUGIN_HOSTS,
  FIGPLUGIN_MAX_CONFIG_BYTES,
  FIGPLUGIN_MAX_DIALOGUE_CHARS,
  FIGPLUGIN_MAX_PAYLOAD_BYTES,
  FIGPLUGIN_MAX_TIMEOUT_MS,
  FigPluginBoundedPayloadSizeSchema,
  canonicalFigPluginRequest,
  measureFigPluginConfigBytes,
  FigPluginIdSchema,
  FigPluginManifestSchema,
  FigPluginMimeTypeSchema,
  FigPluginSafeFileNameSchema,
  FigPluginSafeRelativePathSchema,
  FigPluginSha256Schema,
  isSafeRelativePath,
  type FigPluginCapability,
  type FigPluginHost,
  type FigPluginManifest
} from './manifest'

export const FIGPLUGIN_LIFECYCLE_STATES = [
  'discovered',
  'installing',
  'installed',
  'configuring',
  'configured',
  'ready',
  'calling',
  'cancelling',
  'disabled',
  'failed',
  'uninstalled'
] as const
export type FigPluginLifecycleState = (typeof FIGPLUGIN_LIFECYCLE_STATES)[number]

export const FIGPLUGIN_REQUEST_KINDS = ['install', 'configure', 'status', 'call', 'cancel'] as const
export type FigPluginRequestKind = (typeof FIGPLUGIN_REQUEST_KINDS)[number]

export const FIGPLUGIN_FAILURE_REASONS = [
  'invalid-request',
  'invalid-manifest',
  'unsupported-version',
  'unsupported-host',
  'unsupported-capability',
  'permission-denied',
  'not-installed',
  'not-configured',
  'not-ready',
  'busy',
  'duplicate-request',
  'idempotency-conflict',
  'payload-too-large',
  'invalid-path',
  'invalid-signature',
  'timeout',
  'cancelled',
  'host-error',
  'transfer-error',
  'internal-error'
] as const
export type FigPluginFailureReason = (typeof FIGPLUGIN_FAILURE_REASONS)[number]

export const FIGPLUGIN_TRANSFER_KINDS = ['asset', 'result'] as const
export type FigPluginTransferKind = (typeof FIGPLUGIN_TRANSFER_KINDS)[number]

export const FIGPLUGIN_CALL_OPERATIONS = ['dialogue', 'background-removal'] as const
export type FigPluginCallOperation = (typeof FIGPLUGIN_CALL_OPERATIONS)[number]

const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/
const REQUEST_ID_SCHEMA = FigPluginIdSchema.refine((value) => ID_PATTERN.test(value), {
  message: 'request id is malformed'
})
const IDEMPOTENCY_KEY_SCHEMA = z
  .string()
  .trim()
  .min(8, 'idempotency key must be at least 8 characters')
  .max(128, 'idempotency key is too long')
  .regex(ID_PATTERN, 'idempotency key is malformed')
const TIMESTAMP_SCHEMA = z
  .string()
  .trim()
  .refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
      return false
    }
    if (!Number.isFinite(Date.parse(value))) return false

    const normalizedValue = value.includes('.') ? value : value.replace('Z', '.000Z')
    return new Date(value).toISOString() === normalizedValue
  }, 'timestamp must be an ISO-8601 UTC date')

export const FigPluginRequestIdSchema = REQUEST_ID_SCHEMA
export const FigPluginIdempotencyKeySchema = IDEMPOTENCY_KEY_SCHEMA

const FigPluginTransferMetadataSchema = z
  .object({
    transferId: REQUEST_ID_SCHEMA,
    kind: z.enum(FIGPLUGIN_TRANSFER_KINDS),
    fileName: FigPluginSafeFileNameSchema,
    relativePath: FigPluginSafeRelativePathSchema,
    mimeType: FigPluginMimeTypeSchema,
    sizeBytes: FigPluginBoundedPayloadSizeSchema,
    sha256: FigPluginSha256Schema,
    source: z.enum(['figma', 'photoshop', 'magicpot', 'plugin'])
  })
  .strict()

export type FigPluginTransferMetadata = z.infer<typeof FigPluginTransferMetadataSchema>

const FIGPLUGIN_TRANSFER_METADATA_KEYS = [
  'transferId',
  'sizeBytes',
  'sha256',
  'fileName',
  'relativePath',
  'mimeType',
  'kind',
  'source'
] as const

export const isFigPluginTransferMetadataEquivalent = (
  left: FigPluginTransferMetadata,
  right: FigPluginTransferMetadata
): boolean => FIGPLUGIN_TRANSFER_METADATA_KEYS.every((key) => left[key] === right[key])

export const isFigPluginPayloadByteAccountingValid = (
  inputSizeBytes: number,
  outputSizeBytes: number,
  metadataSizeBytes: number
): boolean => inputSizeBytes + outputSizeBytes <= metadataSizeBytes

const FigPluginPayloadMetadataSchema = z
  .object({
    contentType: z.enum(['json', 'text', 'binary', 'asset-reference']),
    sizeBytes: z.number().int().min(0).max(FIGPLUGIN_MAX_PAYLOAD_BYTES),
    sha256: FigPluginSha256Schema.optional(),
    mimeType: FigPluginMimeTypeSchema.optional(),
    transfer: FigPluginTransferMetadataSchema.optional()
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.contentType === 'asset-reference' && metadata.transfer === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transfer'],
        message: 'asset-reference payloads require transfer metadata'
      })
    }
    if (metadata.contentType !== 'asset-reference' && metadata.transfer !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transfer'],
        message: 'transfer metadata is only allowed for asset-reference payloads'
      })
    }
    if (metadata.contentType === 'binary' && metadata.mimeType === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'binary payloads require a MIME type'
      })
    }
  })

export type FigPluginPayloadMetadata = z.infer<typeof FigPluginPayloadMetadataSchema>
export const figPluginPayloadMetadataSchema = FigPluginPayloadMetadataSchema

const FigPluginCallPayloadSchema = z
  .object({
    operation: z.enum(FIGPLUGIN_CALL_OPERATIONS),
    input: FigPluginPayloadMetadataSchema,
    output: FigPluginPayloadMetadataSchema.optional(),
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
  })

export type FigPluginCallPayload = z.infer<typeof FigPluginCallPayloadSchema>

const FigPluginCancellationSchema = z
  .object({
    requested: z.boolean().default(false),
    requestedAt: TIMESTAMP_SCHEMA.optional()
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

const FigPluginRequestBaseFields = {
  requestId: REQUEST_ID_SCHEMA,
  idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
  requestedAt: TIMESTAMP_SCHEMA,
  timeoutMs: z
    .number()
    .int()
    .min(100, 'timeout must be at least 100 milliseconds')
    .max(FIGPLUGIN_MAX_TIMEOUT_MS, 'timeout exceeds the FIGPLUGIN bound')
    .default(FIGPLUGIN_DEFAULT_TIMEOUT_MS),
  cancellation: FigPluginCancellationSchema
} as const

const FigPluginInstallRequestSchema = z
  .object({
    kind: z.literal('install'),
    ...FigPluginRequestBaseFields,
    manifest: FigPluginManifestSchema
  })
  .strict()

const FigPluginConfigureRequestSchema = z
  .object({
    kind: z.literal('configure'),
    ...FigPluginRequestBaseFields,
    pluginId: FigPluginIdSchema,
    config: z.record(z.string(), z.unknown()),
    configBytes: z.number().int().min(0).max(FIGPLUGIN_MAX_CONFIG_BYTES)
  })
  .strict()
  .superRefine((request, context) => {
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

const FigPluginStatusRequestSchema = z
  .object({
    kind: z.literal('status'),
    ...FigPluginRequestBaseFields,
    pluginId: FigPluginIdSchema
  })
  .strict()

const FigPluginCallRequestSchema = z
  .object({
    kind: z.literal('call'),
    ...FigPluginRequestBaseFields,
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    capability: z.enum(['dialogue', 'background-removal']),
    payload: FigPluginCallPayloadSchema,
    payloadMetadata: FigPluginPayloadMetadataSchema
  })
  .strict()
  .superRefine((request, context) => {
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
  })

const FigPluginCancelRequestSchema = z
  .object({
    kind: z.literal('cancel'),
    ...FigPluginRequestBaseFields,
    targetRequestId: REQUEST_ID_SCHEMA,
    pluginId: FigPluginIdSchema,
    cancellation: z
      .object({
        requested: z.literal(true),
        requestedAt: TIMESTAMP_SCHEMA
      })
      .strict()
  })
  .strict()

export const FigPluginLifecycleRequestSchema = z.union([
  FigPluginInstallRequestSchema,
  FigPluginConfigureRequestSchema,
  FigPluginStatusRequestSchema,
  FigPluginCallRequestSchema,
  FigPluginCancelRequestSchema
])

export type FigPluginInstallRequest = z.infer<typeof FigPluginInstallRequestSchema>
export type FigPluginConfigureRequest = z.infer<typeof FigPluginConfigureRequestSchema>
export type FigPluginStatusRequest = z.infer<typeof FigPluginStatusRequestSchema>
export type FigPluginCallRequest = z.infer<typeof FigPluginCallRequestSchema>
export type FigPluginCancelRequest = z.infer<typeof FigPluginCancelRequestSchema>
export type FigPluginLifecycleRequest = z.infer<typeof FigPluginLifecycleRequestSchema>

const FigPluginFailureSchema = z
  .object({
    reason: z.enum(FIGPLUGIN_FAILURE_REASONS),
    message: z.string().trim().min(1).max(512),
    retryable: z.boolean(),
    requestId: REQUEST_ID_SCHEMA,
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export type FigPluginFailure = z.infer<typeof FigPluginFailureSchema>

const FigPluginLifecycleResponseSchema = z
  .object({
    ok: z.boolean(),
    requestId: REQUEST_ID_SCHEMA,
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
    pluginId: FigPluginIdSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    state: z.enum(FIGPLUGIN_LIFECYCLE_STATES),
    completedAt: TIMESTAMP_SCHEMA,
    failure: FigPluginFailureSchema.optional(),
    manifest: FigPluginManifestSchema.optional(),
    status: z
      .object({
        installed: z.boolean(),
        configured: z.boolean(),
        ready: z.boolean(),
        activeCalls: z.number().int().min(0).max(8)
      })
      .strict()
      .optional(),
    payloadMetadata: FigPluginPayloadMetadataSchema.optional()
  })
  .strict()
  .superRefine((response, context) => {
    if (response.ok && response.failure !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'successful responses must not include failure'
      })
    }
    if (!response.ok && response.failure === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'failed responses require failure'
      })
    }
    if (response.state === 'failed' && response.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ok'],
        message: 'failed state requires ok=false'
      })
    }
    if (!response.ok && response.state !== 'failed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'failed responses must use failed state'
      })
    }
    if (response.status) {
      if (response.status.configured && !response.status.installed) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status', 'configured'],
          message: 'configured status requires installed status'
        })
      }
      if (response.status.ready && (!response.status.installed || !response.status.configured)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status', 'ready'],
          message: 'ready status requires installed and configured status'
        })
      }
      if (
        !response.status.installed &&
        (response.status.configured || response.status.ready || response.status.activeCalls !== 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status', 'installed'],
          message: 'uninstalled status cannot be configured, ready, or active'
        })
      }
      if (
        response.state === 'uninstalled' &&
        (response.status.installed ||
          response.status.configured ||
          response.status.ready ||
          response.status.activeCalls !== 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'uninstalled state cannot be configured, ready, or active'
        })
      }
      if (
        (response.state === 'ready' || response.state === 'calling') &&
        (!response.status.installed || !response.status.configured || !response.status.ready)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: `${response.state} state requires installed, configured, and ready status`
        })
      }
    } else if (response.state === 'ready' || response.state === 'calling') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: `${response.state} state requires status`
      })
    }

    if (response.failure && response.failure.requestId !== response.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure', 'requestId'],
        message: 'failure.requestId must match requestId'
      })
    }
    if (response.manifest) {
      if (response.manifest.id !== response.pluginId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifest', 'id'],
          message: 'manifest.id must match pluginId'
        })
      }
      if (response.manifest.host !== response.host) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifest', 'host'],
          message: 'manifest.host must match host'
        })
      }
    }
  })

export type FigPluginLifecycleResponse = z.infer<typeof FigPluginLifecycleResponseSchema>

export const figPluginLifecycleRequestSchema = FigPluginLifecycleRequestSchema
export const figPluginLifecycleResponseSchema = FigPluginLifecycleResponseSchema

export const parseFigPluginLifecycleRequest = (value: unknown): FigPluginLifecycleRequest =>
  FigPluginLifecycleRequestSchema.parse(value)

export const parseFigPluginLifecycleResponse = (value: unknown): FigPluginLifecycleResponse =>
  FigPluginLifecycleResponseSchema.parse(value)

export const safeParseFigPluginLifecycleRequest = (value: unknown) =>
  FigPluginLifecycleRequestSchema.safeParse(value)

export const safeParseFigPluginLifecycleResponse = (value: unknown) =>
  FigPluginLifecycleResponseSchema.safeParse(value)

export const isFigPluginLifecycleRequest = (value: unknown): value is FigPluginLifecycleRequest =>
  FigPluginLifecycleRequestSchema.safeParse(value).success

export const isFigPluginLifecycleResponse = (value: unknown): value is FigPluginLifecycleResponse =>
  FigPluginLifecycleResponseSchema.safeParse(value).success

export const getFigPluginRequestIdentity = (
  request: Pick<FigPluginLifecycleRequest, 'requestId' | 'idempotencyKey'>
): { requestId: string; idempotencyKey: string } => ({
  requestId: request.requestId,
  idempotencyKey: request.idempotencyKey
})

type FigPluginIdempotencyComparableRequest =
  | FigPluginLifecycleRequest
  | (Pick<FigPluginLifecycleRequest, 'kind' | 'idempotencyKey'> & {
      pluginId?: string
      manifest?: Pick<FigPluginManifest, 'id'>
    })

const getFigPluginComparablePluginId = (
  request: FigPluginIdempotencyComparableRequest
): string | undefined => (request.kind === 'install' ? request.manifest?.id : request.pluginId)

export const getFigPluginIdempotencyFingerprint = (
  request: FigPluginIdempotencyComparableRequest
): string => canonicalFigPluginRequest(request)

export const isSameFigPluginIdempotentRequest = (
  left: FigPluginIdempotencyComparableRequest,
  right: FigPluginIdempotencyComparableRequest
): boolean => {
  const leftPluginId = getFigPluginComparablePluginId(left)
  const rightPluginId = getFigPluginComparablePluginId(right)
  if (
    leftPluginId === undefined ||
    rightPluginId === undefined ||
    leftPluginId !== rightPluginId ||
    left.kind !== right.kind ||
    left.idempotencyKey !== right.idempotencyKey
  ) {
    return false
  }

  try {
    return getFigPluginIdempotencyFingerprint(left) === getFigPluginIdempotencyFingerprint(right)
  } catch {
    return false
  }
}

export const isFigPluginCallWithinPayloadLimit = (
  request: Pick<FigPluginCallRequest, 'payloadMetadata'> &
    Partial<Pick<FigPluginCallRequest, 'payload'>>,
  manifest: Pick<FigPluginManifest, 'limits'>
): boolean => {
  const maxPayloadBytes = Math.min(manifest.limits.maxPayloadBytes, FIGPLUGIN_MAX_PAYLOAD_BYTES)
  const maxResultBytes = Math.min(manifest.limits.maxResultBytes, maxPayloadBytes)

  if (request.payloadMetadata.sizeBytes > maxPayloadBytes) return false
  if (request.payload && request.payload.input.sizeBytes > maxPayloadBytes) return false
  if (request.payload?.output && request.payload.output.sizeBytes > maxResultBytes) return false
  if (
    request.payload &&
    !isFigPluginPayloadByteAccountingValid(
      request.payload.input.sizeBytes,
      request.payload.output?.sizeBytes ?? 0,
      request.payloadMetadata.sizeBytes
    )
  ) {
    return false
  }
  return true
}

export const isFigPluginRequestWithinTimeout = (
  request: Pick<FigPluginLifecycleRequest, 'timeoutMs'>,
  manifest: Pick<FigPluginManifest, 'limits'>
): boolean =>
  request.timeoutMs <= Math.min(manifest.limits.maxCallTimeoutMs, FIGPLUGIN_MAX_TIMEOUT_MS)

export const isFigPluginConfigWithinLimit = (
  request: Pick<FigPluginConfigureRequest, 'config' | 'configBytes'>,
  manifest: Pick<FigPluginManifest, 'limits'>
): boolean => {
  try {
    const measuredBytes = measureFigPluginConfigBytes(request.config)
    return (
      request.configBytes === measuredBytes &&
      measuredBytes <= Math.min(manifest.limits.maxConfigBytes, FIGPLUGIN_MAX_CONFIG_BYTES)
    )
  } catch {
    return false
  }
}

export const isFigPluginRequestCancellation = (request: FigPluginLifecycleRequest): boolean =>
  request.cancellation.requested

export const getFigPluginRequestHost = (
  request: FigPluginLifecycleRequest
): FigPluginHost | undefined => {
  if (request.kind === 'call') return request.host
  if (request.kind === 'install') return request.manifest.host
  return undefined
}

export const getFigPluginRequestCapabilities = (
  request: FigPluginLifecycleRequest
): readonly FigPluginCapability[] => {
  if (request.kind === 'install') return request.manifest.capabilities
  if (request.kind === 'call') return [request.capability]
  return []
}

export const isSafeFigPluginRequestPath = (value: string): boolean => isSafeRelativePath(value)
