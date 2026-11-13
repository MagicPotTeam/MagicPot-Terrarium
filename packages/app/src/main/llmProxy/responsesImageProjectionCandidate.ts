import { inspectOpenAIResponsesImageDataUrl, type OpenAIResponsesInputMessage } from '../../shared/llm/openaiResponses'

/** Transform a private Responses projection. This is not an IPC boundary:
 * callers supply trusted, already selected plain projection data and a trusted
 * preparer. It grants no media/URL access and cannot prevent an earlier renderer
 * from materializing originals. HTTP URLs and budgeted GIFs remain untouched. */
const MAX_OCCURRENCES = 50
const MAX_INPUT = 20 * 1024 * 1024
const MAX_BATCH_INPUT = 32 * 1024 * 1024
const MAX_OUTPUT = 512_000
const MAX_BATCH_OUTPUT = MAX_OCCURRENCES * MAX_OUTPUT
const HTTP_URL = /^https?:\/\/\S+$/i

type EncodedImage = { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' }
export type ResponsesProjectionBatch = (sources: readonly Uint8Array[], signal?: AbortSignal) => Promise<readonly EncodedImage[]>
const aborted = () => Object.assign(new Error('Image preparation aborted'), { name: 'AbortError' })
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw aborted() }

export async function prepareResponsesImageProjection(
  input: readonly OpenAIResponsesInputMessage[], prepare: ResponsesProjectionBatch, signal?: AbortSignal
): Promise<OpenAIResponsesInputMessage[]> {
  checkAbort(signal)
  // Snapshot the complete typed projection synchronously before invoking any
  // async work; no opaque objects/URLs are introduced from request.messages.
  const copy = input.map(message => ({ role: message.role, content: message.content.map(part => ({ ...part })) }))
  const inline: Array<{ part: Extract<OpenAIResponsesInputMessage['content'][number], { type: 'input_image' }>; payload: string }> = []
  let imageCount = 0
  let sourceBytes = 0
  for (const message of copy) {
    for (const part of message.content) {
      if (part.type !== 'input_image') continue
      if (++imageCount > MAX_OCCURRENCES) throw new Error('Image occurrence budget exceeded')
      if (HTTP_URL.test(part.image_url)) continue
      const info = part.image_url === part.image_url.trim() ? inspectOpenAIResponsesImageDataUrl(part.image_url) : null
      if (!info) throw new Error('Unsupported inline image')
      sourceBytes += info.decodedBytes
      if (info.decodedBytes > MAX_INPUT || sourceBytes > MAX_BATCH_INPUT) throw new Error('Image source budget exceeded')
      // Preserve animation rather than converting a GIF to a single still frame.
      // It still consumes the same per-image and aggregate source-byte budgets.
      if (info.mimeType === 'image/gif') continue
      inline.push({ part, payload: part.image_url.slice(part.image_url.indexOf(',') + 1) })
    }
  }
  checkAbort(signal)
  if (!inline.length) return copy
  const sources = inline.map(({ payload }) => Buffer.from(payload, 'base64'))
  const results = await prepare(sources, signal)
  checkAbort(signal)
  if (!Array.isArray(results) || results.length !== inline.length) throw new Error('Invalid image preparation results')
  let resultBytes = 0
  // Validate the whole batch before changing even this private copy.
  for (const result of results) {
    if (!result || !(result.bytes instanceof Uint8Array) || !result.bytes.byteLength || result.bytes.byteLength > MAX_OUTPUT ||
        (result.mimeType !== 'image/png' && result.mimeType !== 'image/jpeg')) throw new Error('Invalid prepared image')
    resultBytes += result.bytes.byteLength
    if (resultBytes > MAX_BATCH_OUTPUT) throw new Error('Prepared image budget exceeded')
  }
  for (let index = 0; index < inline.length; index++) {
    const result = results[index]
    inline[index].part.image_url = `data:${result.mimeType};base64,${Buffer.from(result.bytes).toString('base64')}`
  }
  return copy
}
