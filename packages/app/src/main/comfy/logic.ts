import { sleep } from '@shared/utils/utilFuncs'
import { ComfyHistory, ComfyHistoryResp, FileItem } from '@shared/comfy/types'

/**
 * 这里包含一些 ComfyUI 相关的逻辑封装
 * 可以依赖到 ComfyUI API ，但不直接发起请求，而是通过 ComfyHttpCli 封装
 */

const HISTORY_POLL_MS = 500 // 500ms
const HISTORY_TIMEOUT = 30 * 60 * 1000 // 30 minutes

// Wrapper for ComfyHttpCli
// 定义这个类型的目的是用我们内部的 Queue 逻辑接管 ComfyHttpCli 的请求
export type ComfyCliWrapper = {
  history: (promptId: string) => Promise<ComfyHistoryResp>
  view: (meta: FileItem) => Promise<Uint8Array>
}

// 等待 ComfyUI 生成 prompt_id 的执行
// 长执行，注意阻塞
export async function waitPromptId(
  httpCli: ComfyCliWrapper,
  promptId: string,
  timeout: number = HISTORY_TIMEOUT,
  poll: number = HISTORY_POLL_MS,
  shouldCancel?: () => boolean
): Promise<ComfyHistory> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeout) {
    // 检查是否应该取消
    if (shouldCancel && shouldCancel()) {
      throw new Error(`Task ${promptId} was cancelled`)
    }

    const history = await httpCli.history(promptId)
    if (history && history[promptId] && history[promptId].outputs) {
      return history[promptId]
    }
    await sleep(poll)
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
