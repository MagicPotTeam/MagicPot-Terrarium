import type { OpenAIResponsesInputMessage } from './openaiResponses'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES, rejectProviderJsonBudgetExceeded } from './providerJsonBudget'

/**
 * Cheap conservative rejection for a freshly projected Responses input.
 * Each string's UTF-16 length is no greater than its JSON UTF-8 representation.
 * This is not a complete body-size check; the caller must still serialize and
 * enforce the full budget. Do not reuse with an input that may be filtered or
 * replaced before serialization. Hosted image-generation follows a distinct
 * existing size policy and must not be passed here.
 */
export function assertResponsesImageUrlByteLowerBound(
  input: readonly OpenAIResponsesInputMessage[],
  maxBytes = DEFAULT_PROVIDER_JSON_MAX_BYTES
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > DEFAULT_PROVIDER_JSON_MAX_BYTES) {
    throw new Error('Invalid provider JSON size limit.')
  }
  let remaining = maxBytes
  for (const message of input) {
    for (const part of message.content) {
      if (part.type !== 'input_image') continue
      if (part.image_url.length > remaining) rejectProviderJsonBudgetExceeded()
      remaining -= part.image_url.length
    }
  }
}
