import crypto from 'node:crypto'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import type { LLMCli, LLMChatParams, LLMChatResult } from '@shared/llm'

export const CODEX_REQUEST_GOVERNOR_ERROR_CODES = {
  DUPLICATE: 'CODEX_REQUEST_DUPLICATE'
} as const

export type CodexRequestGovernorErrorCode =
  (typeof CODEX_REQUEST_GOVERNOR_ERROR_CODES)[keyof typeof CODEX_REQUEST_GOVERNOR_ERROR_CODES]

export class CodexRequestGovernorError extends ServiceError {
  readonly code: CodexRequestGovernorErrorCode

  constructor(code: CodexRequestGovernorErrorCode) {
    super('This identical Codex request was submitted too many times in a short period.', { code })
    this.name = 'CodexRequestGovernorError'
    this.code = code
  }
}

export interface CodexRequestGovernorConfig {
  duplicateWindowMs: number
  duplicateMaxAccepted: number
}

const DEFAULT_CONFIG: CodexRequestGovernorConfig = {
  duplicateWindowMs: 30_000,
  duplicateMaxAccepted: 3
}

const PROCESS_HMAC_KEY = crypto.randomBytes(32)
const UNKNOWN_OAUTH_IDENTITY = 'oauth:unknown'
const UNKNOWN_CLIPROXY_IDENTITY = 'cliproxy:unknown'

type DuplicateState = {
  acceptedAt: number[]
}

const positiveInteger = (value: number, fallback: number): number =>
  Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback

const normalizeConfig = (
  overrides: Partial<CodexRequestGovernorConfig> = {}
): CodexRequestGovernorConfig => ({
  duplicateWindowMs: positiveInteger(
    overrides.duplicateWindowMs ?? DEFAULT_CONFIG.duplicateWindowMs,
    DEFAULT_CONFIG.duplicateWindowMs
  ),
  duplicateMaxAccepted: positiveInteger(
    overrides.duplicateMaxAccepted ?? DEFAULT_CONFIG.duplicateMaxAccepted,
    DEFAULT_CONFIG.duplicateMaxAccepted
  )
})

const hmacDigest = (domain: string, value: string): string =>
  crypto
    .createHmac('sha256', PROCESS_HMAC_KEY)
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')

const stableSerialize = (value: unknown, ancestors = new WeakSet<object>()): string => {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
    case 'bigint':
      return JSON.stringify(`${value.toString()}n`)
    case 'undefined':
      return '"[undefined]"'
    case 'function':
      return '"[function]"'
    case 'symbol':
      return '"[symbol]"'
  }

  if (ancestors.has(value)) return '"[circular]"'
  ancestors.add(value)

  let serialized: string
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => stableSerialize(item, ancestors)).join(',')}]`
  } else if (value instanceof Date) {
    serialized = JSON.stringify(value.toISOString())
  } else {
    const record = value as Record<string, unknown>
    serialized = `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], ancestors)}`)
      .join(',')}}`
  }

  ancestors.delete(value)
  return serialized
}

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
}

/** Returns an opaque identity; the account id is never retained by the governor. */
export const createCodexOAuthGovernorIdentity = (accountId?: string): string => {
  const normalized = accountId?.trim()
  return normalized ? `oauth:${hmacDigest('oauth-account', normalized)}` : UNKNOWN_OAUTH_IDENTITY
}

/** Returns an opaque identity; the API key is never retained by the governor. */
export const createCLIProxyGovernorIdentity = (apiKey?: string): string => {
  const normalized = apiKey?.trim()
  return normalized
    ? `cliproxy:${hmacDigest('cliproxy-key', normalized)}`
    : UNKNOWN_CLIPROXY_IDENTITY
}

/** Removes credentials, query values, and fragments before the endpoint enters a fingerprint. */
export const normalizeCodexGovernorEndpoint = (endpoint: string): string => {
  const candidate = endpoint.trim()
  try {
    const parsed = new URL(candidate)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    const pathname = parsed.pathname.replace(/\/+$/g, '')
    return `${parsed.protocol}//${parsed.host}${pathname}`
  } catch {
    return `invalid:${hmacDigest('invalid-endpoint', candidate)}`
  }
}

type FingerprintAttachment = NonNullable<LLMChatParams['messages'][number]['attachments']>[number]

const sha256Digest = (value: string | Uint8Array): string =>
  crypto.createHash('sha256').update(value).digest('hex')

const normalizedAttachmentUrlDigest = (value: string): string => {
  const normalized = value.trim()
  const dataUrl = /^data:([^,]*),(.*)$/is.exec(normalized)
  if (!dataUrl) return sha256Digest(normalized)

  const metadata = dataUrl[1].trim().toLowerCase()
  const payload = dataUrl[2]
  try {
    const bytes = /(?:^|;)base64(?:;|$)/i.test(metadata)
      ? Buffer.from(payload.replace(/\s+/g, ''), 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
    return sha256Digest(bytes)
  } catch {
    return sha256Digest(normalized)
  }
}

const attachmentFingerprint = (attachment: FingerprintAttachment) => ({
  type: attachment.type,
  identity:
    attachment.media?.mediaId ||
    attachment.media?.sha256 ||
    attachment.media?.relativePath ||
    `url-sha256:${normalizedAttachmentUrlDigest(attachment.url)}`,
  fileName: attachment.fileName || '',
  mimeType: attachment.mimeType || '',
  sizeBytes: attachment.sizeBytes,
  width: attachment.sourceWidth || attachment.media?.width,
  height: attachment.sourceHeight || attachment.media?.height
})

const fingerprintMessages = (messages: LLMChatParams['messages']) =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
    hiddenContext: message.hiddenContext,
    attachments: message.attachments?.map(attachmentFingerprint)
  }))

/** Only fields that affect an upstream chat are included; callbacks and AbortSignals are excluded. */
export const createCodexChatFingerprintPayload = (
  params: LLMChatParams,
  modelName?: string
): Record<string, unknown> => {
  const reasoningEffort = params.reasoningEffort?.trim().toLowerCase()
  return {
    model: modelName?.trim() || '',
    messages: fingerprintMessages(params.messages),
    ...(params.tools?.length ? { tools: params.tools, toolTurns: params.toolTurns || [] } : {}),
    imageHistoryPolicy: params.imageHistoryPolicy || 'latest-user-turn',
    systemPrompt: params.systemPrompt?.trim() || 'You are a helpful assistant.',
    reasoningEffort: reasoningEffort === 'ultra' ? 'max' : reasoningEffort || '',
    imageGenerationOptions: params.imageGenerationOptions,
    ...(params.readOnlyImageReview ? { readOnlyImageReview: true } : {}),
    ...(params.disableProviderTools ? { disableProviderTools: true } : {}),
    ...(params.disableAutomaticImageGeneration ? { disableAutomaticImageGeneration: true } : {}),
    videoGenerationOptions: params.videoGenerationOptions
  }
}

class CodexRequestGovernor {
  private config = DEFAULT_CONFIG
  private readonly duplicates = new Map<string, DuplicateState>()
  private duplicateCleanupTimer?: ReturnType<typeof setTimeout>

  run<T>(
    options: { identity: string; endpoint: string; fingerprint: unknown },
    task: () => Promise<T>
  ): Promise<T> {
    const identity = options.identity || UNKNOWN_OAUTH_IDENTITY
    const endpoint = normalizeCodexGovernorEndpoint(options.endpoint)
    const fingerprint = hmacDigest(
      'request-fingerprint',
      stableSerialize({ endpoint, identity, request: options.fingerprint })
    )
    const now = Date.now()
    this.pruneDuplicateState(now)

    const recentAccepted = (this.duplicates.get(fingerprint)?.acceptedAt || []).filter(
      (acceptedAt) => now - acceptedAt < this.config.duplicateWindowMs
    )
    if (recentAccepted.length >= this.config.duplicateMaxAccepted) {
      return Promise.reject(
        new CodexRequestGovernorError(CODEX_REQUEST_GOVERNOR_ERROR_CODES.DUPLICATE)
      )
    }

    this.duplicates.set(fingerprint, { acceptedAt: [...recentAccepted, now] })
    this.scheduleDuplicateCleanup()
    return task()
  }

  resetForTests(overrides: Partial<CodexRequestGovernorConfig> = {}): void {
    this.duplicates.clear()
    if (this.duplicateCleanupTimer) clearTimeout(this.duplicateCleanupTimer)
    this.duplicateCleanupTimer = undefined
    this.config = normalizeConfig(overrides)
  }

  private pruneDuplicateState(now: number): void {
    for (const [fingerprint, state] of this.duplicates) {
      const acceptedAt = state.acceptedAt.filter(
        (timestamp) => now - timestamp < this.config.duplicateWindowMs
      )
      if (acceptedAt.length === 0) this.duplicates.delete(fingerprint)
      else if (acceptedAt.length !== state.acceptedAt.length) state.acceptedAt = acceptedAt
    }
  }

  private scheduleDuplicateCleanup(): void {
    if (this.duplicateCleanupTimer || this.duplicates.size === 0) return

    const earliestAcceptedAt = Math.min(
      ...[...this.duplicates.values()].flatMap((state) => state.acceptedAt)
    )
    const delay = Math.max(1, earliestAcceptedAt + this.config.duplicateWindowMs - Date.now())
    this.duplicateCleanupTimer = setTimeout(() => {
      this.duplicateCleanupTimer = undefined
      this.pruneDuplicateState(Date.now())
      this.scheduleDuplicateCleanup()
    }, delay)
    unrefTimer(this.duplicateCleanupTimer)
  }
}

const GOVERNOR_SINGLETON = Symbol.for('magicpot.codexRequestGovernor')
type GovernorGlobal = typeof globalThis & {
  [GOVERNOR_SINGLETON]?: CodexRequestGovernor
}
const governorGlobal = globalThis as GovernorGlobal
const governor = (governorGlobal[GOVERNOR_SINGLETON] ??= new CodexRequestGovernor())

export const runWithCodexRequestGovernor = <T>(
  options: { identity: string; endpoint: string; fingerprint: unknown },
  task: () => Promise<T>
): Promise<T> => governor.run(options, task)

/** Review is a single, selected-model text response, never a tool/discovery turn. */
export function assertCodexReviewParams(params: LLMChatParams, modelName?: string): void {
  if (params.readOnlyImageReview !== true) return
  params.signal?.throwIfAborted()
  if (!modelName?.trim()) throw new Error('Select a model before starting image review.')
  if (params.tools?.length || params.toolTurns?.length || params.disableProviderTools !== true ||
      params.disableAutomaticImageGeneration !== true || params.retryCapacity || params.imageRequest ||
      params.videoGenerationOptions || (params.imageGenerationOptions &&
        (params.imageGenerationOptions.enabled !== false || Object.keys(params.imageGenerationOptions).some(key => key !== 'enabled')))) {
    throw new Error('Image review requires a tool-free request without generation or retries.')
  }
}

export const createGuardedCodexCli = (
  delegate: LLMCli,
  options: { identity: string; endpoint: string; modelName?: string }
): LLMCli => ({
  get supportsNativeTools() {
    return delegate.supportsNativeTools
  },
  get toolFreeImageReviewEndpoint() {
    return options.modelName?.trim() ? delegate.toolFreeImageReviewEndpoint : undefined
  },
  get supportsToolFreeImageReview() {
    return delegate.supportsToolFreeImageReview
  },
  get supportsIsolatedReadOnlyTurns() {
    return delegate.supportsIsolatedReadOnlyTurns
  },
  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    assertCodexReviewParams(params, options.modelName)
    return runWithCodexRequestGovernor(
      {
        identity: options.identity,
        endpoint: options.endpoint,
        fingerprint: createCodexChatFingerprintPayload(params, options.modelName)
      },
      () => delegate.chat(params)
    )
  }
})

/** Test-only state reset and configuration injection. */
export const __resetCodexRequestGovernorForTests = (
  overrides: Partial<CodexRequestGovernorConfig> = {}
): void => governor.resetForTests(overrides)
