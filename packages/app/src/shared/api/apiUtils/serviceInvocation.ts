export type ServiceInvocationContext = {
  methodName: string
  senderId?: number
  senderUrl?: string
  frameUrl?: string
  isMainFrame?: boolean
}
