import { ProviderRequestControl } from './openaiRequestControl'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES } from './providerJsonBudget'

/**
 * Provider-only conversion candidate. The ceiling bounds one encoded image, not
 * the total request, source URL ownership, decoding, or the eventual JSON size.
 * Existing image-edit/reference readers must not use this helper.
 */
export async function convertBoundedChatImageToBase64(
  imageUrl: string,
  control: ProviderRequestControl,
  maxEncodedChars = DEFAULT_PROVIDER_JSON_MAX_BYTES
): Promise<string> {
  if (!Number.isSafeInteger(maxEncodedChars) || maxEncodedChars < 1 || maxEncodedChars > DEFAULT_PROVIDER_JSON_MAX_BYTES) {
    throw new Error('Invalid per-image size limit.')
  }
  control.check()
  if (imageUrl.startsWith('data:')) {
    const maxHeaderChars = 4096
    const searchEnd = Math.min(imageUrl.length, maxHeaderChars + 6)
    let comma = 5
    while (comma < searchEnd && imageUrl.charCodeAt(comma) !== 44) comma++
    if (comma === searchEnd && searchEnd < imageUrl.length) throw new Error('Image exceeds the per-image size limit.')
    if (comma < searchEnd) {
      const payloadStart = comma + 1
      const probeEnd = Math.min(imageUrl.length, payloadStart + maxEncodedChars + 1)
      // indexOf scans the bounded view in native code instead of monopolizing
      // the event loop with a per-character JavaScript loop.
      const probe = imageUrl.slice(payloadStart, probeEnd)
      const next = probe.indexOf(',')
      const length = next < 0 ? probe.length : next
      if (length > maxEncodedChars) throw new Error('Image exceeds the per-image size limit.')
      if (length) return imageUrl.slice(payloadStart, payloadStart + length)
    }
  }
  const response = await control.fetch(imageUrl, { signal: control.signal })
  // Do not read unbounded server error bodies, and preserve the prior reader's
  // requirement for an explicit image/* Content-Type and a nonempty stream.
  if (!response.ok) throw new Error('Image download failed.')
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (!contentType?.startsWith('image/')) throw new Error('Image download did not return an image.')
  if (!response.body) throw new Error('Image download did not provide a readable body.')

  // A complete base64 quantum is 4 characters per at most 3 input bytes.
  // chunks() tests the next chunk against the allowance before yielding it and
  // owns cancellation, deadline and reader release; no Content-Length trust.
  const maxInputBytes = Math.floor(maxEncodedChars / 4) * 3
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of control.chunks(response, maxInputBytes)) {
    if (!chunk.byteLength) continue
    chunks.push(chunk)
    total += chunk.byteLength
  }
  if (!total) throw new Error('Image download returned an empty body.')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  control.check()
  return Buffer.from(bytes.buffer).toString('base64')
}
