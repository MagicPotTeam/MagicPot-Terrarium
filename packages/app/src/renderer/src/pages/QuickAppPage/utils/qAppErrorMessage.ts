const COMFY_LOGIN_REQUIRED = 'Please login first to use this node'
const COMFY_LOGIN_HTTP_STATUS = /\bHTTP\s*(401|403)\b/i
const COMFY_UNAUTHORIZED = /\bunauthorized\b/i

export const QAPP_INPUT_IMAGE_REQUIRED_MESSAGE =
  '\u8bf7\u5148\u52a0\u8f7d\u56fe\u50cf\u540e\u518d\u751f\u6210'

export const QAPP_COMFY_LOGIN_REQUIRED_MESSAGE =
  '\u5f53\u524d ComfyUI API \u8282\u70b9\u9700\u8981\u767b\u5f55\u6216\u586b\u5199\u6709\u6548\u7684 Comfy API Key\uff0c\u8bf7\u68c0\u67e5\u5feb\u5e94\u7528\u9762\u677f\u91cc\u7684 Comfy API Key \u914d\u7f6e\u540e\u91cd\u8bd5'

export const normalizeQAppErrorMessage = (raw: string): string => {
  if (raw.includes('[Errno 2]') && raw.includes('input')) {
    return QAPP_INPUT_IMAGE_REQUIRED_MESSAGE
  }

  if (
    raw.includes(COMFY_LOGIN_REQUIRED) ||
    COMFY_LOGIN_HTTP_STATUS.test(raw) ||
    COMFY_UNAUTHORIZED.test(raw)
  ) {
    return QAPP_COMFY_LOGIN_REQUIRED_MESSAGE
  }

  return raw
}
