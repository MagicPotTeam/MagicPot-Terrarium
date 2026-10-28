import { describe, expect, it } from 'vitest'
import {
  buildModelInvocationHeaders,
  createModelInvocationContract,
  createModelInvocationRequest,
  isCurrentModelInvocation,
  normalizeModelInvocationContract,
  normalizeModelInvocationError,
  toModelInvocationError,
  MODEL_INVOCATION_SCHEMA,
  MODEL_INVOCATION_VERSION
} from './modelInvocationContract'

const identity = {
  project: 'project-a',
  session: 'session-a',
  task: 'chat',
  requestId: 'request-a'
} as const

const options = {
  resourceRefs: [{ ref: 'resource://document/one', kind: 'document' as const, label: 'one' }],
  permission: { granted: true, capabilities: ['model.invoke'] },
  cancel: { requested: false },
  timeout: { deadlineMs: 10_000 }
}

describe('model invocation contract', () => {
  it('requires explicit permission and a positive finite deadline', () => {
    expect(() =>
      createModelInvocationRequest(
        identity,
        { prompt: 'hello' },
        {
          ...options,
          permission: { granted: false, capabilities: [] }
        }
      )
    ).toThrow('permission is denied')

    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createModelInvocationRequest(
          identity,
          { prompt: 'hello' },
          {
            ...options,
            timeout: { deadlineMs }
          }
        )
      ).toThrow('positive finite')
    }
  })

  it('accepts opaque resource refs and rejects inline or credential-bearing refs', () => {
    const request = createModelInvocationRequest(identity, { prompt: 'hello' }, options)
    expect(request).toMatchObject({
      project: identity.project,
      session: identity.session,
      task: identity.task,
      requestId: identity.requestId,
      version: MODEL_INVOCATION_VERSION,
      schema: MODEL_INVOCATION_SCHEMA,
      resourceRefs: [{ ref: 'resource://document/one', kind: 'document', label: 'one' }]
    })

    for (const ref of [
      'data:text/plain;base64,SGVsbG8=',
      'blob:https://owned.example/id',
      'resource://file?api_key=secret'
    ]) {
      expect(() =>
        createModelInvocationRequest(
          identity,
          { prompt: 'hello' },
          {
            ...options,
            resourceRefs: [{ ref, kind: 'opaque' }]
          }
        )
      ).toThrow('opaque and credential-free')
    }
  })

  it('normalizes an envelope and emits only bounded correlation headers', () => {
    const contract = createModelInvocationContract(identity, options)
    const headers = buildModelInvocationHeaders(contract)
    expect(headers).toEqual({
      'X-MagicPot-Invocation-Id': identity.requestId,
      'X-MagicPot-Invocation-Version': String(MODEL_INVOCATION_VERSION),
      'X-MagicPot-Invocation-Schema': MODEL_INVOCATION_SCHEMA
    })
    expect(headers).not.toHaveProperty('X-MagicPot-Invocation-Project')

    const detached = normalizeModelInvocationContract({
      ...contract,
      resourceRefs: [...contract.resourceRefs]
    })
    expect(detached).toEqual(contract)
    expect(detached.resourceRefs).not.toBe(contract.resourceRefs)
  })

  it('fails closed for malformed or header-unsafe envelopes', () => {
    expect(() =>
      normalizeModelInvocationContract({
        ...createModelInvocationContract(identity, options),
        version: 99
      })
    ).toThrow('version is unsupported')
    expect(() =>
      createModelInvocationContract({ ...identity, requestId: 'bad\nrequest' }, options)
    ).toThrow('safe bounded identifier')
    expect(() =>
      createModelInvocationContract(identity, {
        ...options,
        resourceRefs: Array.from({ length: 129 }, (_, index) => ({
          ref: `resource://${index}`,
          kind: 'opaque' as const
        }))
      })
    ).toThrow('too many resource refs')
  })

  it('normalizes bounded error details and preserves safe status metadata', () => {
    const normalized = normalizeModelInvocationError({
      kind: 'upstream',
      code: '  bad_gateway ',
      message: '  provider failed  ',
      status: 502,
      retryable: true,
      detail: `  ${'x'.repeat(5000)}  `
    })
    expect(normalized).toMatchObject({
      kind: 'upstream',
      code: 'bad_gateway',
      message: 'provider failed',
      status: 502,
      retryable: true
    })
    expect(normalized.detail).toHaveLength(4096)

    expect(toModelInvocationError(new Error('transport failed'))).toEqual({
      kind: 'unknown',
      message: 'transport failed'
    })
  })

  it('rejects stale events after a session or request switch', () => {
    const current = {
      ...identity,
      version: MODEL_INVOCATION_VERSION,
      schema: MODEL_INVOCATION_SCHEMA
    }
    expect(isCurrentModelInvocation(current, current)).toBe(true)
    expect(isCurrentModelInvocation({ ...current, requestId: 'request-old' }, current)).toBe(false)
    expect(isCurrentModelInvocation({ ...current, session: 'session-old' }, current)).toBe(false)
    expect(
      isCurrentModelInvocation(
        { ...current, schema: 'unknown.schema' as typeof MODEL_INVOCATION_SCHEMA },
        current
      )
    ).toBe(false)
  })
})
