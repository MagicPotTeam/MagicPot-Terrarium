/** Post-serialization wire-size bound. This does not bound peak memory while building JSON. */
export const DEFAULT_PROVIDER_JSON_MAX_BYTES = 28 * 1024 * 1024

const trustedBudgetErrors = new WeakSet<object>()

/** Identity only: neither metadata, prototype nor a public constructor grants trust. */
export function isTrustedProviderJsonBudgetError(value: unknown): value is ProviderJsonBudgetError {
  return (typeof value === 'object' && value !== null || typeof value === 'function') && trustedBudgetErrors.has(value as object)
}

export class ProviderJsonBudgetError extends Error {
  readonly code = 'PROVIDER_JSON_BUDGET_EXCEEDED'
  readonly retryBlocked = true
  constructor() {
    super('Provider request exceeds the size limit. Remove some attachments or send fewer images per message.')
    this.name = 'ProviderJsonBudgetError'
  }
}

/** Shared rejection factory; trust indicates only that a budget helper rejected,
 * never that an arbitrary current request or its configured limit was verified. */
export function rejectProviderJsonBudgetExceeded(): never {
  const error = new ProviderJsonBudgetError()
  trustedBudgetErrors.add(error)
  throw error
}

/** Count UTF-8 without allocating an encoded copy; unpaired surrogates use U+FFFD. */
export function providerJsonUtf8Bytes(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit <= 0x7f) bytes++
    else if (unit <= 0x7ff) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

/** Never replaces provider-specific validation; callers must apply both limits. */
export function serializeProviderJsonWithBudget(value: unknown, maxBytes = DEFAULT_PROVIDER_JSON_MAX_BYTES): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > DEFAULT_PROVIDER_JSON_MAX_BYTES) {
    throw new Error('Invalid provider JSON size limit.')
  }
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { throw new Error('Unable to serialize provider JSON request.') }
  if (typeof serialized !== 'string') throw new Error('Unable to serialize provider JSON request.')
  if (providerJsonUtf8Bytes(serialized) > maxBytes) rejectProviderJsonBudgetExceeded()
  return serialized
}
