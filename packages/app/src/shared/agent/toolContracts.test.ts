import { describe, expect, it } from 'vitest'
import {
  createAbortError,
  createAgentToolInvocationResult,
  isAbortError,
  throwIfAborted,
  type AgentToolInvocationRequest
} from './toolContracts'
import { buildAgentSessionIdentity } from './sessionIdentity'

const session = buildAgentSessionIdentity({
  channel: 'generic',
  scopeType: 'dm',
  scopeId: 'tool-contracts'
})

describe('agent tool contracts', () => {
  it('creates abort errors from string, Error, and unknown reasons', () => {
    expect(createAbortError('stop')).toMatchObject({ name: 'AbortError', message: 'stop' })
    expect(createAbortError(new Error('nested'))).toMatchObject({
      name: 'AbortError',
      message: 'nested'
    })
    expect(createAbortError()).toMatchObject({
      name: 'AbortError',
      message: 'Operation aborted.'
    })
  })

  it('detects abort errors by name or cancellation wording', () => {
    const named = new Error('anything')
    named.name = 'AbortError'

    expect(isAbortError(named)).toBe(true)
    expect(isAbortError(new Error('request cancelled by user'))).toBe(true)
    expect(isAbortError(new Error('request failed'))).toBe(false)
    expect(isAbortError('cancelled')).toBe(false)
  })

  it('throws only when the supplied signal is already aborted', () => {
    throwIfAborted()
    const controller = new AbortController()
    throwIfAborted(controller.signal)

    controller.abort(new Error('stop now'))

    expect(() => throwIfAborted(controller.signal)).toThrow('stop now')
  })

  it('normalizes invocation results with defaults and optional payloads', () => {
    const request: AgentToolInvocationRequest = {
      invocationId: 'invoke-1',
      toolName: 'demo.tool',
      args: {},
      session,
      capabilityId: 'cap.demo'
    }

    expect(
      createAgentToolInvocationResult(request, {
        ok: false,
        error: { message: 'failed', code: 'E_DEMO' },
        metadata: { retryable: false },
        content: 'details'
      })
    ).toMatchObject({
      invocationId: 'invoke-1',
      toolName: 'demo.tool',
      capabilityId: 'cap.demo',
      sessionKey: session.sessionKey,
      ok: false,
      durationMs: 0,
      content: 'details',
      metadata: { retryable: false },
      error: { message: 'failed', code: 'E_DEMO' }
    })

    expect(
      createAgentToolInvocationResult(
        {
          ...request,
          invocationId: undefined,
          capabilityId: undefined
        },
        { ok: true }
      )
    ).toMatchObject({
      toolName: 'demo.tool',
      sessionKey: session.sessionKey,
      ok: true
    })
  })
})
