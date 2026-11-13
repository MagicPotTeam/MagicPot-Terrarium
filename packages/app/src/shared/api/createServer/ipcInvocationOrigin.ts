import type { ServiceInvocationContext } from '../apiUtils/serviceInvocation'

export type IpcInvocationEvent = {
  sender?: { id?: unknown; getURL?: () => string | undefined }
  senderFrame?: { url?: unknown; parent?: unknown } | null
}
export type IpcInvocationOrigin = Readonly<{ sender: object; frame: object }>

const origins = new WeakMap<ServiceInvocationContext, IpcInvocationOrigin>()

/** MAIN-only transport seam; renderer payloads and copied contexts have no origin. */
export function createIpcInvocationContext(methodName: string, event: IpcInvocationEvent): ServiceInvocationContext {
  const sender = event.sender, frame = event.senderFrame
  const senderId = typeof sender?.id === 'number' ? sender.id : undefined
  const senderUrl = typeof sender?.getURL === 'function' ? sender.getURL() : undefined
  const capturedFrameUrl = frame?.url
  const frameUrl = typeof capturedFrameUrl === 'string' && capturedFrameUrl.trim() ? capturedFrameUrl : undefined
  const isMainFrame = frame ? frame.parent === null : undefined
  const invocation = Object.freeze({ methodName, ...(senderId !== undefined ? { senderId } : {}), ...(senderUrl ? { senderUrl } : {}), ...(frameUrl ? { frameUrl } : {}), ...(isMainFrame !== undefined ? { isMainFrame } : {}) })
  if (sender && frame) origins.set(invocation, Object.freeze({ sender, frame }))
  return invocation
}

/** Identity is never copied into the public/serialized invocation or request. */
export function getIpcInvocationOrigin(invocation: ServiceInvocationContext | undefined): IpcInvocationOrigin | undefined {
  return invocation && origins.get(invocation)
}
