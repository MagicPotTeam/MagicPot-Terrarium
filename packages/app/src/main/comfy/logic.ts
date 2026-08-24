import { sleep } from '@shared/utils/utilFuncs'
import { ComfyHistory, ComfyHistoryResp, FileItem } from '@shared/comfy/types'

/**
 * 这里包含一些 ComfyUI 相关的逻辑封装
 * 可以依赖到 ComfyUI API ，但不直接发起请求，而是通过 ComfyHttpCli 封装
 */

const HISTORY_POLL_MS = 500 // 500ms
const HISTORY_TIMEOUT: number | null = null // 默认不超时，直到 ComfyUI 返回结果或任务被取消

// Wrapper for ComfyHttpCli
// 定义这个类型的目的是用我们内部的 Queue 逻辑接管 ComfyHttpCli 的请求
export type ComfyCliWrapper = {
  history: (promptId: string, signal?: AbortSignal) => Promise<ComfyHistoryResp>
  view: (meta: FileItem, signal?: AbortSignal) => Promise<Uint8Array>
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? Object.assign(new Error('Operation was aborted.'), { name: 'AbortError' })

const raceAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return await promise
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (result) => {
        cleanup()
        resolve(result)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

const delay = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) {
    await sleep(milliseconds)
    return
  }
  await raceAbort(
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds)
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
    }),
    signal
  )
}

// 等待 ComfyUI 生成 prompt_id 的执行
// 长执行，注意阻塞
export async function waitPromptId(
  httpCli: ComfyCliWrapper,
  promptId: string,
  timeout: number | null = HISTORY_TIMEOUT,
  poll: number = HISTORY_POLL_MS,
  shouldCancel?: () => boolean,
  signal?: AbortSignal
): Promise<ComfyHistory> {
  const startTime = Date.now()
  const hasTimeout = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
  while (!hasTimeout || Date.now() - startTime < timeout) {
    if (signal?.aborted) throw abortReason(signal)
    if (shouldCancel && shouldCancel()) {
      throw Object.assign(new Error(`Task ${promptId} was cancelled`), { name: 'AbortError' })
    }

    const history = await raceAbort(httpCli.history(promptId, signal), signal)
    if (history?.[promptId]?.outputs) return history[promptId]
    await delay(poll, signal)
  }
  // 超时不是 ComfyUI 内置，这里伪造一个
  return {
    prompt: [0, promptId, {}, { client_id: '' }, []],
    outputs: {},
    status: {
      status_str: 'error',
      completed: false,
      messages: [
        [
          'execution_error',
          {
            prompt_id: promptId,
            timestamp: Date.now(),
            node_id: '',
            node_type: '',
            executed: [],
            exception_message: `waitPromptId timeout after ${timeout}ms`,
            exception_type: 'TimeoutError',
            traceback: [],
            current_inputs: {},
            current_outputs: []
          }
        ]
      ]
    }
  }
}
