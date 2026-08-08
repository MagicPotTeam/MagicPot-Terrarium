import { describe, expect, it } from 'vitest'
import {
  MAGIC_AGENT_ACTOR_KINDS,
  assertMagicAgentCommand,
  assertMagicAgentCommandResult,
  assertMagicAgentEvent,
  parseMagicAgentCommand,
  parseMagicAgentCommandResult,
  parseMagicAgentEnvelope,
  parseMagicAgentEvent
} from './index'

const envelope = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: '2.1.0',
  id: 'env-1',
  type: 'example.created',
  createdAt: 1,
  payload: { secret: 'value' },
  ...overrides
})

const command = (overrides: Record<string, unknown> = {}) => ({
  ...envelope(),
  envelopeKind: 'command',
  actor: { kind: 'agent', id: 'actor-1' },
  idempotencyKey: 'key-1',
  ...overrides
})

const event = (overrides: Record<string, unknown> = {}) => ({
  ...envelope(),
  envelopeKind: 'event',
  streamId: 'stream-1',
  sequence: 0,
  ...overrides
})

const success = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  commandId: 'command-1',
  completedAt: 2,
  payload: { value: 1 },
  ...overrides
})

const failure = (overrides: Record<string, unknown> = {}) => ({
  ok: false,
  commandId: 'command-1',
  completedAt: 2,
  error: { code: 'FAILED', message: 'failed', retryable: false },
  ...overrides
})

const expectError = (result: { ok: boolean; error?: string }, error: string) => {
  expect(result).toEqual({ ok: false, error })
}

describe('Magic Agent Platform 2 protocol parsers', () => {
  it('preserves valid input and opaque field identity', () => {
    const payload = { nested: true }
    const extensions = Object.create(null) as Record<string, unknown>
    extensions.future = { enabled: true }
    const input = envelope({ payload, extensions, futureTopLevel: 123 })

    const parsed = parseMagicAgentEnvelope(input)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value).toBe(input)
      expect(parsed.value.payload).toBe(payload)
      expect(parsed.value.extensions).toBe(extensions)
      expect((parsed.value as Record<string, unknown>).futureTopLevel).toBe(123)
    }
  })

  it('keeps protocol major version behavior', () => {
    expect(parseMagicAgentEnvelope(envelope({ protocolVersion: '2' })).ok).toBe(true)
    expect(parseMagicAgentEnvelope(envelope({ protocolVersion: '2.3' })).ok).toBe(true)
    expectError(
      parseMagicAgentEnvelope(envelope({ protocolVersion: '999.0.0' })),
      'Unsupported runtime protocol version: 999.0.0'
    )
  })

  it('requires a validator before returning a typed payload', () => {
    type Payload = { value: number }
    const validator = (payload: unknown): payload is Payload =>
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).value === 'number'

    const input = envelope({ payload: { value: 1 } })
    const unvalidated = parseMagicAgentEnvelope(input)
    const validated = parseMagicAgentEnvelope(input, validator)
    expect(unvalidated.ok).toBe(true)
    expect(validated.ok).toBe(true)
    if (validated.ok) expect(validated.value.payload.value).toBe(1)
    expectError(
      parseMagicAgentEnvelope(envelope({ payload: { value: 'bad' } }), validator),
      'payload failed validation.'
    )
    expect(parseMagicAgentCommand(command({ payload: { value: 1 } }), validator).ok).toBe(true)
    expect(parseMagicAgentEvent(event({ payload: { value: 1 } }), validator).ok).toBe(true)
    expect(parseMagicAgentCommandResult(success(), validator).ok).toBe(true)
    const rejectsPayload = (_payload: unknown): _payload is never => false
    expectError(parseMagicAgentCommand(command(), rejectsPayload), 'payload failed validation.')
    expectError(parseMagicAgentEvent(event(), rejectsPayload), 'payload failed validation.')
    expectError(
      parseMagicAgentCommandResult(success(), rejectsPayload),
      'payload failed validation.'
    )
    expect(parseMagicAgentCommandResult(failure(), rejectsPayload).ok).toBe(true)
  })

  it('only accepts plain protocol records, including null-prototype records', () => {
    class Instance {
      protocolVersion = '2.0.0'
      id = 'id'
      type = 'type'
      createdAt = 1
      payload = null
    }

    for (const input of [new Date(), new Map(), new Set(), /x/, new Instance(), []]) {
      expect(parseMagicAgentEnvelope(input).ok).toBe(false)
    }

    const nullPrototype = Object.assign(Object.create(null), envelope())
    expect(parseMagicAgentEnvelope(nullPrototype).ok).toBe(true)
    expect(parseMagicAgentEnvelope(envelope({ extensions: new Date() })).ok).toBe(false)
    expect(parseMagicAgentCommand(command({ actor: new Map() })).ok).toBe(false)
    expect(parseMagicAgentCommand(command({ expectedRevision: new Set() })).ok).toBe(false)
    expect(parseMagicAgentEvent(event({ redaction: /x/ })).ok).toBe(false)
    expect(parseMagicAgentCommandResult(failure({ error: new Date() })).ok).toBe(false)
  })

  it('requires all protocol fields to be own properties', () => {
    const inheritedEnvelope = Object.create(envelope())
    expect(parseMagicAgentEnvelope(inheritedEnvelope).ok).toBe(false)

    const actor = Object.assign(Object.create(null), { id: 'own' })
    expectError(parseMagicAgentCommand(command({ actor })), 'actor.kind is required.')

    const inheritedResult = Object.create(success())
    expect(parseMagicAgentCommandResult(inheritedResult).ok).toBe(false)
  })

  it('contains getter and Proxy failures with parser-specific stable errors', () => {
    const badEnvelope = envelope()
    Object.defineProperty(badEnvelope, 'id', {
      get: () => {
        throw new Error('boom')
      }
    })
    expectError(parseMagicAgentEnvelope(badEnvelope), 'Envelope could not be read safely.')
    expectError(parseMagicAgentCommand(badEnvelope), 'Command could not be read safely.')
    expectError(parseMagicAgentEvent(badEnvelope), 'Event could not be read safely.')

    const badResult = success()
    Object.defineProperty(badResult, 'ok', {
      get: () => {
        throw new Error('boom')
      }
    })
    expectError(parseMagicAgentCommandResult(badResult), 'Command result could not be read safely.')

    const proxy = new Proxy(envelope(), {
      getPrototypeOf: () => {
        throw new Error('boom')
      }
    })
    expectError(parseMagicAgentEnvelope(proxy), 'Envelope could not be read safely.')
  })

  it('accepts extensible non-empty actor kinds while retaining standard constants', () => {
    expect(MAGIC_AGENT_ACTOR_KINDS).toEqual([
      'user',
      'agent',
      'system',
      'sdk',
      'trigger',
      'service'
    ])
    expect(parseMagicAgentCommand(command({ actor: { kind: 'plugin-worker', id: 'x' } })).ok).toBe(
      true
    )
    expect(parseMagicAgentCommand(command({ actor: { kind: ' ', id: 'x' } })).ok).toBe(false)
    expect(parseMagicAgentCommand(command({ actor: { kind: 'agent', id: ' ' } })).ok).toBe(false)
    expect(
      parseMagicAgentCommand(command({ actor: { kind: 'agent', id: 'x', displayName: ' ' } })).ok
    ).toBe(false)
  })

  it('validates redaction invariants and safe dot paths', () => {
    expect(
      parseMagicAgentEvent(event({ redaction: { applied: true, paths: ['payload.secret-key'] } }))
        .ok
    ).toBe(true)
    expect(
      parseMagicAgentEvent(
        event({ redaction: { applied: false, paths: [], reason: 'not needed' } })
      ).ok
    ).toBe(true)

    for (const redaction of [
      { applied: true, paths: [] },
      { applied: false, paths: ['payload.secret'] },
      { applied: true, paths: ['payload..secret'] },
      { applied: true, paths: ['payload.secret value'] },
      { applied: true, paths: ['payload.__proto__.x'] },
      { applied: true, paths: ['constructor.x'] },
      { applied: true, paths: ['prototype.x'] },
      { applied: true, paths: ['payload.secret'], reason: ' ' }
    ]) {
      expect(parseMagicAgentEvent(event({ redaction })).ok).toBe(false)
    }
  })

  it('rejects whitespace identifiers, non-finite timestamps and invalid revisions', () => {
    for (const field of ['id', 'type', 'correlationId', 'causationId']) {
      expect(parseMagicAgentEnvelope(envelope({ [field]: ' ' })).ok).toBe(false)
    }
    expect(parseMagicAgentEnvelope(envelope({ createdAt: Number.NaN })).ok).toBe(false)
    expect(parseMagicAgentEnvelope(envelope({ createdAt: Infinity })).ok).toBe(false)
    expect(parseMagicAgentCommand(command({ idempotencyKey: ' ' })).ok).toBe(false)
    expect(
      parseMagicAgentCommand(command({ expectedRevision: { resourceId: ' ', revision: 0 } })).ok
    ).toBe(false)
    expect(parseMagicAgentEvent(event({ streamId: ' ' })).ok).toBe(false)
    expect(parseMagicAgentCommandResult(success({ commandId: ' ' })).ok).toBe(false)
    expect(parseMagicAgentCommandResult(success({ completedAt: Number.NaN })).ok).toBe(false)
    expect(parseMagicAgentCommandResult(success({ revision: Number.NaN })).ok).toBe(false)
  })

  it('rejects ambiguous command result branches and preserves failure details', () => {
    expectError(
      parseMagicAgentCommandResult(success({ error: { code: 'X' } })),
      'error is not allowed for a successful command result.'
    )
    expectError(
      parseMagicAgentCommandResult(failure({ payload: null })),
      'payload and revision are not allowed for a failed command result.'
    )
    expect(parseMagicAgentCommandResult(failure({ revision: 0 })).ok).toBe(false)

    const details = new Date()
    const input = failure({ error: { code: 'X', message: 'x', retryable: false, details } })
    const parsed = parseMagicAgentCommandResult(input)
    expect(parsed.ok).toBe(true)
    if (parsed.ok && !parsed.value.ok) expect(parsed.value.error.details).toBe(details)
  })

  it('assert helpers use the same validation and preserve identity', () => {
    const inputCommand = command()
    const inputEvent = event()
    const inputSuccess = success()
    expect(assertMagicAgentCommand(inputCommand)).toBe(inputCommand)
    expect(assertMagicAgentEvent(inputEvent)).toBe(inputEvent)
    expect(assertMagicAgentCommandResult(inputSuccess)).toBe(inputSuccess)
    const rejectsPayload = (_payload: unknown): _payload is never => false
    expect(() => assertMagicAgentCommand(command(), rejectsPayload)).toThrow(
      'payload failed validation.'
    )
  })
})
