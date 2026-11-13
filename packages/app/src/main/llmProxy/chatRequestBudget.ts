export const DEFAULT_CHAT_REQUEST_BODY_LIMIT = 28 * 1024 * 1024

/** Body bytes only; does not include HTTP framing or headers. Never logs request content. */
export class ChatRequestBudgetError extends Error {
  constructor(readonly code: 'INVALID_LIMIT' | 'UNSUPPORTED_BODY' | 'BODY_TOO_LARGE') {
    super(code === 'BODY_TOO_LARGE' ? 'Chat request body exceeds the byte limit.' : code === 'INVALID_LIMIT' ? 'Invalid chat request body limit.' : 'Unsupported chat request body.')
    this.name = 'ChatRequestBudgetError'
  }
}

/** Call after final provider JSON serialization, before transport. This helper does not parse JSON. */
export function assertChatRequestBodyBudget(body: unknown, limit = DEFAULT_CHAT_REQUEST_BODY_LIMIT): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > DEFAULT_CHAT_REQUEST_BODY_LIMIT) throw new ChatRequestBudgetError('INVALID_LIMIT')
  let length: number
  if (typeof body === 'string') length = Buffer.byteLength(body, 'utf8')
  else if (body instanceof Uint8Array) length = body.byteLength
  else if (body instanceof ArrayBuffer) length = body.byteLength
  else throw new ChatRequestBudgetError('UNSUPPORTED_BODY')
  if (length > limit) throw new ChatRequestBudgetError('BODY_TOO_LARGE')
  return length
}
