import type { AssistantRoute, AssistantRunEvent, AssistantRunRecord } from './types'
import { getAssistantSessionKey } from './types'

const reviewRequired = () =>
  Object.assign(
    new Error(
      'This run has incomplete or inconsistent tool evidence; review its effects before resuming.'
    ),
    { code: 'TOOL_REPLAY_REQUIRES_REVIEW' }
  )
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** Resolve only a same-route resume chain, never a general follow-up/root-run link. */
export async function resolveAssistantToolReplayRunId(
  sourceRunId: string,
  route: AssistantRoute,
  getRun: (runId: string) => Promise<AssistantRunRecord | null | undefined>
): Promise<string> {
  const seen = new Set<string>()
  let id = sourceRunId
  for (let depth = 0; depth < 64; depth += 1) {
    if (seen.has(id)) throw reviewRequired()
    seen.add(id)
    const run = await getRun(id)
    if (
      !run ||
      run.runId !== id ||
      getAssistantSessionKey(run.route) !== getAssistantSessionKey(route)
    )
      throw reviewRequired()
    if (!run.resumeSourceRunId) return id
    id = run.resumeSourceRunId
  }
  throw reviewRequired()
}

/** Missing/malformed receipts never prove that an external effect did not happen. */
export function assertKnownAssistantToolOutcomes(
  events: readonly AssistantRunEvent[],
  runId: string,
  options: { requireRunStart?: boolean } = {}
): void {
  const sourceEvents = events.filter((event) => event.runId === runId)
  // Session journals are bounded. If the start boundary was evicted, earlier
  // effects may have been evicted too; an empty retained suffix is not proof of safety.
  if (options.requireRunStart && !sourceEvents.some((event) => event.type === 'queued'))
    throw reviewRequired()
  const intents = new Map<string, { name: string; callId: unknown; settled: boolean }>()
  for (const event of sourceEvents) {
    const action = record(event.metadata?.agentAction)
    if (!action || (action.type !== 'tool.invoke' && action.type !== 'tool.result')) continue
    const payload = record(action.payload)
    if (
      action.correlationId !== runId ||
      !payload ||
      !nonempty(payload.invocationId) ||
      !nonempty(payload.toolName) ||
      (payload.toolCallId !== undefined && !nonempty(payload.toolCallId))
    )
      throw reviewRequired()
    if (action.type === 'tool.invoke') {
      if (!record(payload.args) || intents.has(payload.invocationId)) throw reviewRequired()
      intents.set(payload.invocationId, {
        name: payload.toolName,
        callId: payload.toolCallId,
        settled: false
      })
      continue
    }
    const intent = intents.get(payload.invocationId)
    if (
      !intent ||
      intent.settled ||
      intent.name !== payload.toolName ||
      intent.callId !== payload.toolCallId ||
      typeof payload.ok !== 'boolean'
    )
      throw reviewRequired()
    intent.settled = true
  }
  if ([...intents.values()].some((intent) => !intent.settled)) throw reviewRequired()
}
