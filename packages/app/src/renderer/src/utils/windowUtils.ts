import { Api } from '@shared/api'

/**
 * Renderer 中统一拿 API 的方式
 * 不知为何直接从 window.api 拿会丢类型推导
 * 从这里拿可以保证类型正确
 * @returns Api
 */
export function api(): Api {
  return window.api
}

export function hasManagedComfyStartupApi(): boolean {
  const svcHyper = (
    window.api as unknown as {
      svcHyper?: {
        comfyPortDetect?: unknown
        connectSubProcess?: unknown
      }
    }
  )?.svcHyper

  return (
    typeof svcHyper?.comfyPortDetect === 'function' &&
    typeof svcHyper?.connectSubProcess === 'function'
  )
}
