export type WorkflowCompletionEvent = Readonly<{
  runId: string
  graphId: string
  status: 'completed' | 'failed' | 'cancelled'
  completedAt: number
  outputDigest?: string
}>

export type WorkflowCompletionListener = (event: WorkflowCompletionEvent) => void
const listeners = new Set<WorkflowCompletionListener>()

export const publishWorkflowCompletion = (event: WorkflowCompletionEvent): void => {
  for (const listener of listeners) listener(event)
}

export const subscribeWorkflowCompletions = (
  listener: WorkflowCompletionListener
): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const clearWorkflowCompletionListenersForTest = (): void => listeners.clear()
