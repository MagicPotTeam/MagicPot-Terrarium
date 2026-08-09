import { normalizeMediaReference, type MediaReference } from '../../shared/mediaReference'
import {
  DEFAULT_MANAGED_MEDIA_MAX_BYTES,
  importManagedMedia,
  ManagedMediaImportError,
  type ImportedManagedMedia,
  type ManagedMediaStoreDependencies
} from './managedMediaStore'

export const LEGACY_MEDIA_MIGRATION_CHECKPOINT_VERSION = 1 as const

const IMAGE_DATA_URL_PREFIX = /^data:image\//i
const IMAGE_DATA_URL_HEADER = /^data:image\/[a-z0-9!#$&^_.+-]+;base64$/i
const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export type LegacyMediaMigrationCheckpoint = {
  version: typeof LEGACY_MEDIA_MIGRATION_CHECKPOINT_VERSION
  rollbackToken: unknown
}

export type LegacyMediaMigrationResult =
  | { status: 'unchanged'; value: unknown }
  | { status: 'already-migrated'; value: MediaReference }
  | {
      status: 'migrated'
      value: MediaReference
      checkpoint: LegacyMediaMigrationCheckpoint
      imported: ImportedManagedMedia
    }

export type LazyLegacyMediaMigrationInput = {
  value: unknown
  chatMediaRoot: string
  authorizedRoot: string
  maxBytes?: number
  signal?: AbortSignal
  /** Caller-owned persistence token/reference retained for rollback; the migration does not copy the value. */
  rollbackToken?: unknown
  provenance?: Record<string, unknown>
}

export type LegacyMediaMigrationErrorCode =
  | 'LEGACY_MEDIA_MALFORMED'
  | 'LEGACY_MEDIA_UNSUPPORTED'
  | 'LEGACY_MEDIA_TOO_LARGE'

export class LegacyMediaMigrationError extends Error {
  constructor(
    public readonly code: LegacyMediaMigrationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'LegacyMediaMigrationError'
  }
}

function decodedBase64Size(payload: string): number {
  if (!payload.length || payload.length % 4 !== 0 || !STRICT_BASE64.test(payload)) return -1
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  const unpaddedLength = payload.length - padding
  if (unpaddedLength % 4 === 1) return -1
  return (payload.length / 4) * 3 - padding
}

const DEFAULT_ROLLBACK_TOKEN = Symbol('legacy-media-migration-rollback')

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/**
 * Lazily migrates one legacy image data URL. It never writes chat persistence: callers decide
 * whether and when to persist `value`; the caller retains the original persistence value and
 * supplies a rollback token/reference in the checkpoint.
 */
export async function migrateLegacyBase64MediaOnDemand(
  input: LazyLegacyMediaMigrationInput,
  dependencies: Omit<ManagedMediaStoreDependencies, 'authorizedRoot'> = {}
): Promise<LegacyMediaMigrationResult> {
  throwIfAborted(input.signal)
  const reference = normalizeMediaReference(input.value)
  if (reference) return { status: 'already-migrated', value: reference }
  if (typeof input.value !== 'string' || !IMAGE_DATA_URL_PREFIX.test(input.value)) {
    return { status: 'unchanged', value: input.value }
  }

  throwIfAborted(input.signal)
  const commaIndex = input.value.indexOf(',')
  if (commaIndex < 0) {
    throw new LegacyMediaMigrationError(
      'LEGACY_MEDIA_MALFORMED',
      'Legacy image data URL must contain strict Base64 data'
    )
  }
  const header = input.value.slice(0, commaIndex)
  const payload = input.value.slice(commaIndex + 1)
  if (!IMAGE_DATA_URL_HEADER.test(header)) {
    throw new LegacyMediaMigrationError(
      'LEGACY_MEDIA_MALFORMED',
      'Legacy image data URL must contain a strict image Base64 header'
    )
  }

  const mimeType = header.slice('data:'.length, header.length - ';base64'.length).toLowerCase()
  const extension = EXTENSIONS[mimeType]
  if (!extension) {
    throw new LegacyMediaMigrationError(
      'LEGACY_MEDIA_UNSUPPORTED',
      `Unsupported legacy image MIME type: ${mimeType}`
    )
  }

  const maxBytes = input.maxBytes ?? DEFAULT_MANAGED_MEDIA_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new LegacyMediaMigrationError('LEGACY_MEDIA_MALFORMED', 'Invalid migration size limit')
  }
  const sizeBytes = decodedBase64Size(payload)
  if (sizeBytes <= 0) {
    throw new LegacyMediaMigrationError(
      'LEGACY_MEDIA_MALFORMED',
      'Legacy image data is empty or invalid'
    )
  }
  if (sizeBytes > maxBytes) {
    throw new LegacyMediaMigrationError(
      'LEGACY_MEDIA_TOO_LARGE',
      `Legacy image exceeds the ${maxBytes} byte limit`
    )
  }

  throwIfAborted(input.signal)
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.byteLength !== sizeBytes) {
    throw new LegacyMediaMigrationError('LEGACY_MEDIA_MALFORMED', 'Legacy image Base64 is invalid')
  }

  try {
    throwIfAborted(input.signal)
    const imported = await importManagedMedia(
      input.chatMediaRoot,
      {
        bytes,
        mimeType,
        originalFileName: `legacy-image.${extension}`,
        provenance: { ...(input.provenance ?? {}), source: 'legacy-base64-media-migration' },
        maxBytes,
        signal: input.signal
      },
      { ...dependencies, authorizedRoot: input.authorizedRoot }
    )
    return {
      status: 'migrated',
      value: imported.reference,
      checkpoint: {
        version: LEGACY_MEDIA_MIGRATION_CHECKPOINT_VERSION,
        rollbackToken:
          input.rollbackToken === undefined ? DEFAULT_ROLLBACK_TOKEN : input.rollbackToken
      },
      imported
    }
  } catch (error) {
    if (error instanceof ManagedMediaImportError && error.code === 'MANAGED_MEDIA_TOO_LARGE') {
      throw new LegacyMediaMigrationError('LEGACY_MEDIA_TOO_LARGE', error.message, { cause: error })
    }
    throw error
  }
}
