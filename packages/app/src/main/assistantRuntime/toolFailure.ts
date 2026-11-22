import { isProxy } from 'node:util/types'
import { IpcServiceError } from '@shared/api/apiUtils/unaryIpcResult'
import { omittedAgentToolFailure, readAgentToolFailurePayload } from '@shared/api/agentThreadToolFailure'
import type { AgentToolFailurePayload } from '@shared/api/agentThreadToolFailure'
import type { AssistantToolCallResult } from './toolRegistry'

/** Main-only reported failure data, not evidence that an effect was rolled back or completed. */
export class AssistantToolResultError extends Error {
  readonly code?: string

  constructor(error: { message: string; code?: string }, readonly toolResult: AssistantToolCallResult) {
    super(error.message)
    this.name = 'AssistantToolResultError'
    if (error.code !== undefined) this.code = error.code
  }
}

// MAIN identity-only provenance, deliberately absent from errors/results/IPC/JSON.
// Reported data alone is never proof of successful journal/observer publication.
const reportedFileEditFailures = new WeakSet<object>()
type FileEditFeedbackIdentity = Readonly<{ routeKey: string; runId: string; toolCallId: string }>
const settledFileEditFeedback = new WeakMap<AssistantToolResultError, FileEditFeedbackIdentity>()

/** Called only by the built-in files.edit host-error branch, not generic providers. */
export function createReportedFileEditFailure(error: { message: string; code: string }, result: AssistantToolCallResult): AssistantToolResultError {
  const failure = new AssistantToolResultError(error, result)
  reportedFileEditFailures.add(failure)
  return failure
}

/** Carry identity through MAIN kernel normalization, never a persisted field. */
export function forwardReportedFileEditFailure(source: object, target: object): void {
  if (reportedFileEditFailures.has(source)) reportedFileEditFailures.add(target)
}

/** Adapter calls only after the known failure's journal AND observer fulfilled. */
export function settleFileEditFailureFeedback(error: unknown, identity: FileEditFeedbackIdentity): void {
  if (error instanceof AssistantToolResultError && reportedFileEditFailures.has(error) && error.code === 'MAGIC_AGENT_FILES_EDIT_FAILED')
    settledFileEditFeedback.set(error, { ...identity })
}

/** One same-request explanation only; not tool, retry, resume or rollback authority. */
export function takeFileEditFailureFeedback(error: unknown, identity: FileEditFeedbackIdentity): error is AssistantToolResultError {
  if (!(error instanceof AssistantToolResultError)) return false
  const settled = settledFileEditFeedback.get(error)
  settledFileEditFeedback.delete(error)
  return Boolean(settled && settled.routeKey === identity.routeKey && settled.runId === identity.runId && settled.toolCallId === identity.toolCallId)
}

/** Project only the existing receipt/history fields at the final unary IPC exit.
 * Journal data is untouched. Unsafe/large data is explicitly omitted as a whole.
 */
export function toAssistantToolIpcError(error: AssistantToolResultError): IpcServiceError {
  let payload: AgentToolFailurePayload = omittedAgentToolFailure()
  try {
    const own = (value: unknown, key: string): unknown => {
      if (!value || typeof value !== 'object' || isProxy(value)) throw new Error('Unsafe receipt')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor && !('value' in descriptor)) throw new Error('Unsafe receipt')
      return descriptor?.value
    }
    const select = (value: unknown, fields: string[]): Record<string, unknown> => Object.fromEntries(fields.flatMap(key => {
      const item = own(value, key)
      return item === undefined ? [] : [[key, item]]
    }))
    const metadata = own(error, 'metadata')
    const history = metadata === undefined ? [] : own(metadata, 'toolHistory') ?? []
    if (!Array.isArray(history) || isProxy(history) || history.length > 256) throw new Error('Unsafe receipt')
    // Read array descriptors, never caller-defined iterators/getters or toJSON.
    const projectedHistory = Array.from({ length: history.length }, (_, index) => select(own(history, String(index)), ['runId', 'toolCallId', 'toolName', 'args', 'status', 'content', 'error', 'metadata']))
    const candidate = { kind: 'agent-tool-failure/v1', toolResult: select(own(error, 'toolResult'), ['content', 'metadata']), toolHistory: projectedHistory }
    let nodes = 0
    const rejectProxies = (value: unknown, depth: number): void => {
      if (++nodes > 2048 || depth > 16) throw new Error('Unsafe receipt')
      if (value && typeof value === 'object') {
        if (isProxy(value)) throw new Error('Unsafe receipt')
        const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value))
        if (descriptors.length > 257) throw new Error('Unsafe receipt')
        for (const [key, descriptor] of descriptors) {
          if (Array.isArray(value) && key === 'length') continue
          if (!('value' in descriptor)) throw new Error('Unsafe receipt')
          rejectProxies(descriptor.value, depth + 1)
        }
      }
    }
    rejectProxies(candidate, 0)
    payload = readAgentToolFailurePayload(candidate) ?? payload
  } catch { /* Preserve failure; do not replace it with a serialization exception. */ }
  return new IpcServiceError(error.message, { code: error.code, payload })
}
