export type AbortSender = {
  abort: () => void
}
export type AbortReceiver = {
  isAborted: () => boolean
  onAbort: (handler: () => void) => void
}

/**
 * 因为 AbortSignal 只能存在于浏览器内，无法通过 context bridge 传递
 * 所以需要手动实现一套
 * 无锁。只保证 at least once
 */
export function newAbortHandler(): [AbortSender, AbortReceiver] {
  let isAborted = false
  const abortHandlers: (() => void)[] = []
  return [
    {
      abort: () => {
        if (isAborted) return
        isAborted = true
        const handlers = abortHandlers.splice(0)
        handlers.forEach((handler) => handler())
      }
    },
    {
      isAborted: () => isAborted,
      onAbort: (handler: () => void) => {
        if (isAborted) {
          handler()
          return
        }
        abortHandlers.push(handler)
      }
    }
  ]
}
