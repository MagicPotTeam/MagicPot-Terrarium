import { z } from 'zod'

export const FIGPLUGIN_SCHEMA_VERSION = 1 as const
export const FIGPLUGIN_BRIDGE_MANIFEST_VERSION = 2 as const
export const FIGPLUGIN_MANIFEST_KIND = 'figplugin' as const

export const FIGPLUGIN_HOSTS = ['figma', 'photoshop'] as const
export type FigPluginHost = (typeof FIGPLUGIN_HOSTS)[number]

export const FIGPLUGIN_CAPABILITIES = [
  'dialogue',
  'background-removal',
  'asset-transfer',
  'result-transfer'
] as const
export type FigPluginCapability = (typeof FIGPLUGIN_CAPABILITIES)[number]

export const FIGPLUGIN_PERMISSION_MODES = ['none', 'prompt'] as const
export type FigPluginPermissionMode = (typeof FIGPLUGIN_PERMISSION_MODES)[number]

export const FIGPLUGIN_ASSET_TRANSFER_PERMISSION_VALUES = ['none', 'read'] as const
export type FigPluginAssetTransferPermission =
  (typeof FIGPLUGIN_ASSET_TRANSFER_PERMISSION_VALUES)[number]

export const FIGPLUGIN_RESULT_TRANSFER_PERMISSION_VALUES = ['none', 'write'] as const
export type FigPluginResultTransferPermission =
  (typeof FIGPLUGIN_RESULT_TRANSFER_PERMISSION_VALUES)[number]

export const FIGPLUGIN_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
export const FIGPLUGIN_MAX_CONFIG_BYTES = 64 * 1024
export const FIGPLUGIN_MAX_MANIFEST_ASSETS = 64
export const FIGPLUGIN_MAX_TIMEOUT_MS = 120_000
export const FIGPLUGIN_DEFAULT_TIMEOUT_MS = 30_000
export const FIGPLUGIN_MAX_CONCURRENT_CALLS = 8
export const FIGPLUGIN_MAX_DIALOGUE_CHARS = 16_384

export type FigPluginJsonValue =
  | null
  | boolean
  | number
  | string
  | FigPluginJsonValue[]
  | { readonly [key: string]: FigPluginJsonValue }

/** Serializes JSON-compatible data with sorted object keys and no external effects. */
export const canonicalFigPluginJson = (value: unknown): string => {
  const ancestors = new Set<object>()

  const serialize = (current: unknown): string => {
    if (current === null) return 'null'
    if (typeof current === 'string' || typeof current === 'boolean') {
      const serialized = JSON.stringify(current)
      if (serialized === undefined) throw new TypeError('value is not JSON serializable')
      return serialized
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('value must contain finite numbers')
      const serialized = JSON.stringify(current)
      if (serialized === undefined) throw new TypeError('value is not JSON serializable')
      return serialized
    }
    if (typeof current !== 'object') throw new TypeError('value must be JSON serializable')

    if (ancestors.has(current)) throw new TypeError('value must not contain cycles')
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const arrayValue = current as unknown[]
        const serializedItems: string[] = []
        for (let index = 0; index < arrayValue.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index))
          if (descriptor && !('value' in descriptor)) {
            throw new TypeError('value must not contain accessor properties')
          }
          serializedItems.push(descriptor ? serialize(descriptor.value) : 'null')
        }
        return `[${serializedItems.join(',')}]`
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('value must contain plain objects')
      }
      const objectValue = current as Record<string, unknown>
      return `{${Object.keys(objectValue)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(objectValue, key)
          if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('value must not contain accessor properties')
          }
          return `${JSON.stringify(key)}:${serialize(descriptor.value)}`
        })
        .join(',')}}`
    } finally {
      ancestors.delete(current)
    }
  }

  return serialize(value)
}

/**
 * Canonical comparison material, not a digest. Never log or persist this raw string:
 * it can include configuration or dialogue. Main-process receipts hash it first.
 * Only transport retry metadata is omitted; nested config/manifest keys are business data.
 */
export const canonicalFigPluginRequest = (value: object): string => {
  // Validate plain JSON before copying; no getters/toJSON hooks are invoked.
  const request = JSON.parse(canonicalFigPluginJson(value)) as Record<string, unknown>
  delete request.requestId
  delete request.requestedAt
  for (const [key, timestamp] of [
    ['consent', 'grantedAt'],
    ['cancellation', 'requestedAt']
  ] as const) {
    const metadata = request[key]
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      delete (metadata as Record<string, unknown>)[timestamp]
    }
  }
  return canonicalFigPluginJson(request)
}

/** Measures canonical JSON UTF-8 bytes and rejects values above the contract bound. */
export const measureFigPluginConfigBytes = (config: unknown): number => {
  const bytes = new TextEncoder().encode(canonicalFigPluginJson(config)).byteLength
  if (bytes > FIGPLUGIN_MAX_CONFIG_BYTES) {
    throw new RangeError('configuration exceeds the FIGPLUGIN bound')
  }
  return bytes
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256_PATTERN = /^[A-Fa-f0-9]{64}$/
const MIME_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$/
const SIGNATURE_HEX_PATTERN = /^[A-Fa-f0-9]{128}$/
// 64 bytes leave two significant bits in the final base64url character.
// Reject nonzero pad bits; shape validity is still not cryptographic verification.
const SIGNATURE_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw](?:==)?$/
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const FORBIDDEN_PATH_SEGMENTS = new Set(['.', '..', '__proto__', 'prototype', 'constructor'])
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
  'conin$',
  'conout$'
])

const isValidIsoTimestamp = (value: string): boolean => {
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return false

  const normalizedValue = value.includes('.') ? value : value.replace('Z', '.000Z')
  return new Date(value).toISOString() === normalizedValue
}

export const FigPluginIdSchema = z
  .string()
  .trim()
  .min(1, 'identifier must not be empty')
  .max(128, 'identifier is too long')
  .regex(IDENTIFIER_PATTERN, 'identifier contains unsafe characters')

export const FigPluginVersionSchema = z
  .string()
  .max(128, 'version is too long')
  // A pipeline, rather than chained max+regex, prevents costly regex work on untrusted long strings.
  .pipe(z.string().trim().regex(SEMVER_PATTERN, 'version must be a strict semantic version'))

export const FigPluginSafeRelativePathSchema = z
  .string()
  .trim()
  .min(1, 'relative path must not be empty')
  .max(512, 'relative path is too long')
  .refine((value) => isSafeRelativePath(value), {
    message: 'path must be a safe relative path without traversal or absolute prefixes'
  })

export const FigPluginSafeFileNameSchema = z
  .string()
  .trim()
  .min(1, 'file name must not be empty')
  .max(128, 'file name is too long')
  .refine((value) => isSafeFileName(value), {
    message: 'file name must be a single safe file name'
  })

export const FigPluginSha256Schema = z
  .string()
  .trim()
  .regex(SHA256_PATTERN, 'sha256 must be exactly 64 hexadecimal characters')
  .transform((value) => value.toLowerCase())

export const FigPluginMimeTypeSchema = z
  .string()
  .trim()
  .max(192, 'MIME type is too long')
  .regex(MIME_TYPE_PATTERN, 'MIME type must be a valid type/subtype')
  .transform((value) => value.toLowerCase())

export const FigPluginSignatureValueSchema = z
  .string()
  .trim()
  .refine(
    (value) => SIGNATURE_HEX_PATTERN.test(value) || SIGNATURE_BASE64URL_PATTERN.test(value),
    'signature must be a 64-byte hexadecimal or base64url value'
  )

export const FigPluginIsoDateSchema = z
  .string()
  .trim()
  .refine(isValidIsoTimestamp, 'timestamp must be an ISO-8601 UTC date')

export const FigPluginBoundedPayloadSizeSchema = z
  .number()
  .int('payload size must be an integer')
  .min(1, 'payload size must be greater than zero')
  .max(FIGPLUGIN_MAX_PAYLOAD_BYTES, 'payload exceeds the FIGPLUGIN bound')

const FigPluginAssetDeclarationSchema = z
  .object({
    id: FigPluginIdSchema,
    path: FigPluginSafeRelativePathSchema,
    mimeType: FigPluginMimeTypeSchema.optional(),
    sizeBytes: FigPluginBoundedPayloadSizeSchema.optional(),
    sha256: FigPluginSha256Schema.optional()
  })
  .strict()

export type FigPluginAssetDeclaration = z.infer<typeof FigPluginAssetDeclarationSchema>

// Both loopback spellings must be explicitly selected and signed. They are NOT equivalent
// approval identities; never normalize, auto-rewrite, retry against aliases, or permit suffixes.
export const FigPluginDesktopBridgeOriginSchema = z
  .string()
  .max(22)
  .regex(/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{3,4}$(?![\s\S])/)
  .refine((value) => {
    const port = Number(value.slice(value.lastIndexOf(':') + 1))
    return port >= 1024 && port <= 65_535
  }, 'Invalid bridge origin')

const FigPluginDesktopBridgeSchema = z
  .object({
    protocol: z.literal(1),
    origin: FigPluginDesktopBridgeOriginSchema
  })
  .strict()

const FigPluginPermissionsSchema = z
  .object({
    dialogue: z.enum(FIGPLUGIN_PERMISSION_MODES).default('none'),
    backgroundRemoval: z.enum(FIGPLUGIN_PERMISSION_MODES).default('none'),
    assetTransfer: z.enum(FIGPLUGIN_ASSET_TRANSFER_PERMISSION_VALUES).default('none'),
    resultTransfer: z.enum(FIGPLUGIN_RESULT_TRANSFER_PERMISSION_VALUES).default('none'),
    filesystem: z.literal('none').default('none'),
    network: z.enum(['none', 'desktop-bridge']).default('none')
  })
  .strict()

export type FigPluginPermissions = z.infer<typeof FigPluginPermissionsSchema>

const FigPluginLimitsSchema = z
  .object({
    maxPayloadBytes: z
      .number()
      .int()
      .min(1)
      .max(FIGPLUGIN_MAX_PAYLOAD_BYTES)
      .default(FIGPLUGIN_MAX_PAYLOAD_BYTES),
    maxResultBytes: z
      .number()
      .int()
      .min(1)
      .max(FIGPLUGIN_MAX_PAYLOAD_BYTES)
      .default(FIGPLUGIN_MAX_PAYLOAD_BYTES),
    maxConfigBytes: z
      .number()
      .int()
      .min(1)
      .max(FIGPLUGIN_MAX_CONFIG_BYTES)
      .default(16 * 1024),
    maxCallTimeoutMs: z.number().int().min(100).max(FIGPLUGIN_MAX_TIMEOUT_MS).default(60_000),
    maxConcurrentCalls: z.number().int().min(1).max(FIGPLUGIN_MAX_CONCURRENT_CALLS).default(1)
  })
  .strict()

export type FigPluginLimits = z.infer<typeof FigPluginLimitsSchema>

const FigPluginProvenanceSchema = z
  .object({
    publisherId: FigPluginIdSchema,
    publisherName: z.string().trim().min(1).max(128),
    source: z.enum(['official', 'verified-publisher', 'user-provided']),
    artifactSha256: FigPluginSha256Schema,
    sourceUrl: z
      .string()
      .trim()
      .url()
      .refine((value) => value.startsWith('https://'), 'sourceUrl must use https')
      .optional(),
    issuedAt: FigPluginIsoDateSchema
  })
  .strict()

export type FigPluginProvenance = z.infer<typeof FigPluginProvenanceSchema>

const FigPluginSignatureSchema = z
  .object({
    algorithm: z.literal('ed25519'),
    keyId: FigPluginIdSchema,
    value: FigPluginSignatureValueSchema,
    signedAt: FigPluginIsoDateSchema
  })
  .strict()

export type FigPluginSignature = z.infer<typeof FigPluginSignatureSchema>

export const FigPluginManifestSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(FIGPLUGIN_SCHEMA_VERSION),
      z.literal(FIGPLUGIN_BRIDGE_MANIFEST_VERSION)
    ]),
    id: FigPluginIdSchema,
    name: z.string().trim().min(1).max(128),
    version: FigPluginVersionSchema,
    host: z.enum(FIGPLUGIN_HOSTS),
    entryPath: FigPluginSafeRelativePathSchema.optional(),
    capabilities: z.array(z.enum(FIGPLUGIN_CAPABILITIES)).min(1).max(FIGPLUGIN_CAPABILITIES.length),
    permissions: FigPluginPermissionsSchema,
    limits: FigPluginLimitsSchema,
    provenance: FigPluginProvenanceSchema,
    signature: FigPluginSignatureSchema,
    assets: z.array(FigPluginAssetDeclarationSchema).max(FIGPLUGIN_MAX_MANIFEST_ASSETS).default([]),
    bridge: FigPluginDesktopBridgeSchema.optional()
  })
  .strict()
  .superRefine((manifest, context) => {
    const capabilities = new Set<string>()
    for (const [index, capability] of manifest.capabilities.entries()) {
      if (capabilities.has(capability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', index],
          message: `duplicate capability: ${capability}`
        })
      }
      capabilities.add(capability)
    }

    // A v1 network denial must never be upgraded by adding a bridge declaration.
    if (manifest.schemaVersion === FIGPLUGIN_SCHEMA_VERSION) {
      if (manifest.permissions.network !== 'none') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permissions', 'network'],
          message: 'v1 manifests require network permission none'
        })
      }
      if ('bridge' in manifest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bridge'],
          message: 'v1 manifests must not declare a desktop bridge'
        })
      }
    } else {
      if (manifest.permissions.network !== 'desktop-bridge') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permissions', 'network'],
          message: 'v2 manifests require explicit desktop-bridge network permission'
        })
      }
      if (manifest.bridge === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bridge'],
          message: 'v2 manifests require a desktop bridge declaration'
        })
      }
      if (manifest.entryPath === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entryPath'],
          message: 'v2 manifests require a native artifact entryPath'
        })
      }
      for (const capability of ['dialogue', 'asset-transfer'] as const) {
        if (!capabilities.has(capability)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['capabilities'],
            message: `v2 manifests require ${capability}`
          })
        }
      }
    }

    const capabilityPermissionPairs: Array<
      [
        FigPluginCapability,
        keyof Pick<
          FigPluginPermissions,
          'dialogue' | 'backgroundRemoval' | 'assetTransfer' | 'resultTransfer'
        >,
        string
      ]
    > = [
      ['dialogue', 'dialogue', 'prompt'],
      ['background-removal', 'backgroundRemoval', 'prompt'],
      ['asset-transfer', 'assetTransfer', 'read'],
      ['result-transfer', 'resultTransfer', 'write']
    ]

    for (const [capability, permissionKey, requestedValue] of capabilityPermissionPairs) {
      const permission = manifest.permissions[permissionKey]
      if (capabilities.has(capability) && permission !== requestedValue) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permissions', permissionKey],
          message: `${permissionKey} permission must be ${requestedValue} when ${capability} is declared`
        })
      }
      if (!capabilities.has(capability) && permission !== 'none') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permissions', permissionKey],
          message: `${permissionKey} permission is over-privileged without ${capability}`
        })
      }
    }

    const assetIds = new Set<string>()
    const assetPaths = new Set<string>()
    for (const [index, asset] of manifest.assets.entries()) {
      if (assetIds.has(asset.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets', index, 'id'],
          message: `duplicate asset id: ${asset.id}`
        })
      }
      const canonicalPath = canonicalizeFigPluginPath(asset.path)
      if (canonicalPath !== undefined && assetPaths.has(canonicalPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets', index, 'path'],
          message: `duplicate asset path: ${asset.path}`
        })
      }
      assetIds.add(asset.id)
      if (canonicalPath !== undefined) assetPaths.add(canonicalPath)
    }

    if (manifest.limits.maxResultBytes > manifest.limits.maxPayloadBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limits', 'maxResultBytes'],
        message: 'maxResultBytes must not exceed maxPayloadBytes'
      })
    }
  })

export type FigPluginManifest = z.infer<typeof FigPluginManifestSchema>
export type FigPluginManifestInput = z.input<typeof FigPluginManifestSchema>

export type FigPluginValidationIssue = {
  path: (string | number)[]
  message: string
  code?: string
}

export type FigPluginValidationResult<T> =
  | { ok: true; value: T; issues: FigPluginValidationIssue[] }
  | { ok: false; issues: FigPluginValidationIssue[] }

export const figPluginManifestSchema = FigPluginManifestSchema

export const parseFigPluginManifest = (value: unknown): FigPluginManifest =>
  FigPluginManifestSchema.parse(value)

export const safeParseFigPluginManifest = (value: unknown) =>
  FigPluginManifestSchema.safeParse(value)

export const validateFigPluginManifest = (
  value: unknown
): FigPluginValidationResult<FigPluginManifest> => {
  const result = FigPluginManifestSchema.safeParse(value)
  if (result.success) {
    return { ok: true, value: result.data, issues: [] }
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code
    }))
  }
}

export const isFigPluginManifest = (value: unknown): value is FigPluginManifest =>
  FigPluginManifestSchema.safeParse(value).success

export const isFigPluginHost = (value: unknown): value is FigPluginHost =>
  typeof value === 'string' && (FIGPLUGIN_HOSTS as readonly string[]).includes(value)

export const isFigPluginCapability = (value: unknown): value is FigPluginCapability =>
  typeof value === 'string' && (FIGPLUGIN_CAPABILITIES as readonly string[]).includes(value)

const canonicalizePathSegment = (segment: string): string =>
  segment.toLowerCase().replace(/[. ]+$/g, '')

const isWindowsReservedDeviceName = (segment: string): boolean => {
  const canonicalSegment = canonicalizePathSegment(segment)
  const baseName = canonicalSegment.split('.')[0]
  return WINDOWS_RESERVED_DEVICE_NAMES.has(baseName)
}

const isSafePathSegment = (segment: string): boolean => {
  if (
    segment.length === 0 ||
    segment.length > 128 ||
    !SAFE_PATH_SEGMENT_PATTERN.test(segment) ||
    /[. ]$/.test(segment)
  ) {
    return false
  }

  const canonicalSegment = canonicalizePathSegment(segment)
  return (
    canonicalSegment.length > 0 &&
    !FORBIDDEN_PATH_SEGMENTS.has(canonicalSegment) &&
    !isWindowsReservedDeviceName(segment)
  )
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    return false
  }
  if (value.includes('\\') || value.includes('%') || value.includes('\u0000')) return false

  return value.split('/').every(isSafePathSegment)
}

/** Returns the case-insensitive Windows-safe canonical form of a relative path. */
export function canonicalizeFigPluginPath(value: string): string | undefined {
  if (!isSafeRelativePath(value)) return undefined
  return value.split('/').map(canonicalizePathSegment).join('/')
}

export function isSafeFileName(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('%') &&
    !value.includes('\u0000') &&
    isSafePathSegment(value)
  )
}
