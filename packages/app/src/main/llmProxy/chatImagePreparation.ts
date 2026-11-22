import { resolveCanvasThumbnailSidecarBinary } from '../api/canvasThumbnailSidecarAdapter'
import { inspectStillRaster } from '../utils/stillRaster'
import type { OpenAIResponsesInputMessage } from '../../shared/llm/openaiResponses'
import { ChatImagePreparer } from './chatImagePreparer'
import {
  runChatImageWorker,
  type ChatImageWorkerInput,
  type ChatImageWorkerResult
} from './chatImageWorker'
import { prepareResponsesImageProjection } from './responsesImageProjectionCandidate'

const PREPARED_BATCH_BYTES = 18 * 1024 * 1024
const TARGET_BYTES = 512_000
const MAX_EDGE = 2000

/** MAIN-owned dependencies only. Neither executable paths nor these functions
 * are accepted from IPC, profiles, or the projected messages. */
export type ChatImagePreparationOptions = {
  resolveWorker?: () => Promise<string | undefined>
  runWorker?: (input: ChatImageWorkerInput) => Promise<ChatImageWorkerResult>
}

export type ChatImagePreparation = {
  prepareResponsesInput(
    input: readonly OpenAIResponsesInputMessage[],
    signal?: AbortSignal
  ): Promise<OpenAIResponsesInputMessage[]>
  clear(): void
}

function aborted(): Error {
  return Object.assign(new Error('Image preparation aborted'), { name: 'AbortError' })
}

function unavailable(): Error {
  return Object.assign(new Error('图片处理组件不可用，请重新构建或更新应用。'), {
    code: 'CHAT_IMAGE_WORKER_UNAVAILABLE'
  })
}

function publicFailure(error: unknown, signal?: AbortSignal): Error {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (
    signal?.aborted ||
    (error instanceof Error && error.name === 'AbortError') ||
    code === 'CHAT_IMAGE_WORKER_ABORTED'
  ) {
    return aborted()
  }
  if (code === 'CHAT_IMAGE_WORKER_UNAVAILABLE') return unavailable()
  if (code === 'CHAT_IMAGE_WORKER_PROTOCOL_UNSUPPORTED') {
    return Object.assign(new Error('图片处理组件不支持当前聊天图片协议，请更新或重新构建应用。'), {
      code: 'CHAT_IMAGE_WORKER_PROTOCOL_UNSUPPORTED'
    })
  }
  return Object.assign(new Error('图片准备失败，请减少图片数量或大小后重试。'), {
    code: 'CHAT_IMAGE_PREPARATION_FAILED'
  })
}

/** Request-scoped preparation of a private provider projection. It does not
 * read media paths, fetch remote images, or alter source/tool attachments.
 * The fixed binary budget is not a complete JSON budget; the client must still
 * enforce its final body limit. Call clear() when this request is finished. */
export function createChatImagePreparation(
  options: ChatImagePreparationOptions = {}
): ChatImagePreparation {
  const resolveWorker =
    options.resolveWorker ??
    (async () => {
      const result = await resolveCanvasThumbnailSidecarBinary()
      return result.ok ? result.binaryPath : undefined
    })
  const runWorker = options.runWorker ?? runChatImageWorker
  let binaryPromise: Promise<string> | undefined

  const getBinary = async (): Promise<string> => {
    if (!binaryPromise) {
      binaryPromise = Promise.resolve()
        .then(resolveWorker)
        .then((binaryPath) => {
          if (!binaryPath) throw unavailable()
          return binaryPath
        })
        .catch(() => {
          throw unavailable()
        })
    }
    const attempt = binaryPromise
    try {
      return await attempt
    } catch (error) {
      if (binaryPromise === attempt) binaryPromise = undefined
      throw error
    }
  }

  const preparer = new ChatImagePreparer({
    async encode(bytes, settings) {
      if (settings.signal.aborted) throw aborted()
      const image = inspectStillRaster(bytes, {
        maxBytes: 20 * 1024 * 1024,
        maxEdge: 16384,
        maxPixels: settings.maxPixels
      })
      if (
        (image.mimeType === 'image/png' || image.mimeType === 'image/jpeg') &&
        image.orientation === 1 &&
        image.width <= settings.maxEdge &&
        image.height <= settings.maxEdge &&
        bytes.byteLength <= settings.targetBytes
      ) {
        return bytes
      }
      const binaryPath = await getBinary()
      if (settings.signal.aborted) throw aborted()
      const result = await runWorker({
        binaryPath,
        source: bytes,
        targetBytes: settings.targetBytes,
        maxEdge: settings.maxEdge,
        signal: settings.signal
      })
      return result.bytes
    }
  })

  return {
    async prepareResponsesInput(input, signal) {
      try {
        return await prepareResponsesImageProjection(
          input,
          (sources, batchSignal) =>
            preparer.prepareBatch(
              sources,
              PREPARED_BATCH_BYTES,
              { targetBytes: TARGET_BYTES, maxSide: MAX_EDGE },
              batchSignal
            ),
          signal
        )
      } catch (error) {
        throw publicFailure(error, signal)
      }
    },
    clear() {
      binaryPromise = undefined
      preparer.clear()
    }
  }
}
