import type { LLMChatReq, LLMChatResp, LLMProxySvc } from '@shared/api/svcLLMProxy'

/** Unary IPC does not transport AbortSignal; cancel the exact main-owned request explicitly. */
export async function requestProjectComparison(
  request: LLMChatReq,
  signal: AbortSignal,
  service: Pick<LLMProxySvc, 'chat' | 'cancelConversation'>
): Promise<LLMChatResp> {
  if (signal.aborted) throw new DOMException('Comparison cancelled', 'AbortError')
  const conversationId = `project-comparison-${crypto.randomUUID()}`
  let rejectAbort!: (error: Error) => void
  let cancelled = false
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    // The cancellation service may fail during window shutdown. Never log its raw error.
    try {
      void service.cancelConversation({ conversationId }).catch(() => undefined)
    } catch {
      /* best effort */
    }
    rejectAbort(new DOMException('Comparison cancelled', 'AbortError'))
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await Promise.race([
      service.chat({ ...request, comparisonRouting: 'configured', conversationId }, { signal }),
      aborted
    ])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
