import { describe, expect, it, vi } from 'vitest'
import { AssistantToolResultError, createReportedFileEditFailure, forwardReportedFileEditFailure, settleFileEditFailureFeedback, takeFileEditFailureFeedback, toAssistantToolIpcError } from './toolFailure'
import { IpcServiceError } from '@shared/api/apiUtils/unaryIpcResult'

describe('MAIN typed tool receipt projection', () => {
  it('projects only known receipt fields and does not forward Error diagnostics', () => {
    const result = { content: 'failed', metadata: { rollback: { succeeded: false } }, extra: 'not a result field' }
    const failure = new AssistantToolResultError({ message: 'failed', code: 'E_FAILED' }, result)
    Object.assign(failure, { body: 'provider secret', headers: { secret: true }, metadata: { ignored: 'unrelated', toolHistory: [{ runId: 'run', toolCallId: 'call', toolName: 'file', args: {}, status: 'failed', content: 'failed', extra: 'not a history field' }] } })
    const projected = toAssistantToolIpcError(failure)
    expect(projected).toBeInstanceOf(IpcServiceError)
    expect(projected.payload).toEqual({ kind: 'agent-tool-failure/v1', toolResult: { content: 'failed', metadata: result.metadata }, toolHistory: [{ runId: 'run', toolCallId: 'call', toolName: 'file', args: {}, status: 'failed', content: 'failed' }] })
    expect(projected).not.toHaveProperty('body')
    expect(projected).not.toHaveProperty('headers')
    expect(projected).not.toHaveProperty('toolResult')
  })
  it.each(['getter', 'proxy', 'large', 'cycle'] as const)('omits the whole %s receipt without masking failure or invoking hooks', kind => {
    const hook = vi.fn(() => { throw new Error('must not run') }), metadata: Record<string, unknown> = {}
    if (kind === 'getter') Object.defineProperty(metadata, 'rollback', { enumerable: true, get: hook })
    if (kind === 'cycle') metadata.self = metadata
    const failure = new AssistantToolResultError({ message: 'still failed', code: 'E_FAILED' }, { content: kind === 'large' ? 'x'.repeat(65537) : 'failed', metadata: kind === 'proxy' ? new Proxy({}, { ownKeys: hook }) : metadata })
    expect(toAssistantToolIpcError(failure)).toMatchObject({ message: 'still failed', code: 'E_FAILED', payload: { kind: 'agent-tool-failure/v1', receiptOmitted: true } })
    expect(hook).not.toHaveBeenCalled()
    expect(failure.toolResult.content.length).toBe(kind === 'large' ? 65537 : 6)
  })
})

describe('MAIN file edit failure explanation identity, never serialized authority', () => {
  const identity = { routeKey: 'canvas:thread:owned', runId: 'run', toolCallId: 'run:tool:0' }
  const details = { message: 'Exact replacement failed.', code: 'MAGIC_AGENT_FILES_EDIT_FAILED' }
  const receipt = { content: '{"error":"failed"}', metadata: { report: { failed: 1, writeStatus: 'committed' } } }

  it('requires producer provenance plus completed publication and consumes only once', () => {
    const original = createReportedFileEditFailure(details, receipt)
    expect(takeFileEditFailureFeedback(original, identity)).toBe(false)
    const kernelResult = { ok: false, ...receipt, error: details }, normalized = { ...kernelResult }
    forwardReportedFileEditFailure(original, kernelResult)
    forwardReportedFileEditFailure(kernelResult, normalized)
    const gatewayError = new AssistantToolResultError(details, receipt)
    forwardReportedFileEditFailure(normalized, gatewayError)
    expect(takeFileEditFailureFeedback(gatewayError, identity)).toBe(false)
    settleFileEditFailureFeedback(gatewayError, identity)
    expect(takeFileEditFailureFeedback(gatewayError, identity)).toBe(true)
    expect(takeFileEditFailureFeedback(gatewayError, identity)).toBe(false)
    expect(Object.getOwnPropertySymbols(original)).toEqual([])
    expect(gatewayError.toolResult).toBe(receipt)
    expect(toAssistantToolIpcError(gatewayError).payload).toEqual({ kind: 'agent-tool-failure/v1', toolResult: receipt, toolHistory: [] })
  })

  it.each(['routeKey', 'runId', 'toolCallId'] as const)('different %s burns rather than reuses the single explanation witness', field => {
    const failure = createReportedFileEditFailure(details, receipt)
    settleFileEditFailureFeedback(failure, identity)
    expect(takeFileEditFailureFeedback(failure, { ...identity, [field]: 'other' })).toBe(false)
    expect(takeFileEditFailureFeedback(failure, identity)).toBe(false)
  })

  it.each(['generic', 'shape', 'serialized', 'unknown-code', 'settled-replay'] as const)('never grants feedback from %s data', kind => {
    const source = createReportedFileEditFailure(details, receipt)
    const fake = kind === 'generic' ? new AssistantToolResultError(details, receipt)
      : kind === 'shape' ? Object.assign(new Error(details.message), { code: details.code, toolResult: receipt, feedback: true })
      : kind === 'serialized' ? Object.assign(new AssistantToolResultError(details, receipt), JSON.parse(JSON.stringify(source)))
      : createReportedFileEditFailure({ ...details, code: kind === 'unknown-code' ? 'TOOL_EXECUTION_OUTCOME_UNKNOWN' : 'TOOL_EXECUTION_ALREADY_SETTLED' }, receipt)
    settleFileEditFailureFeedback(fake, identity)
    expect(takeFileEditFailureFeedback(fake, identity)).toBe(false)
    if (kind === 'unknown-code' || kind === 'settled-replay') return
    const target = new AssistantToolResultError(details, receipt)
    forwardReportedFileEditFailure(fake, target)
    settleFileEditFailureFeedback(target, identity)
    expect(takeFileEditFailureFeedback(target, identity)).toBe(false)
  })
})
