import { SUPPORTED_RUNTIME_PROTOCOL_MAJOR_VERSIONS } from './versions.js'

export type EnvelopeExtensions = Record<string, unknown>

export type MagicAgentEnvelope<TPayload = unknown> = {
  protocolVersion: string
  id: string
  type: string
  createdAt: number
  correlationId?: string
  causationId?: string
  payload: TPayload
  extensions?: EnvelopeExtensions
}

export const MAGIC_AGENT_ACTOR_KINDS = [
  'user',
  'agent',
  'system',
  'sdk',
  'trigger',
  'service'
] as const

export type MagicAgentStandardActorKind = (typeof MAGIC_AGENT_ACTOR_KINDS)[number]
export type MagicAgentActorKind = MagicAgentStandardActorKind | (string & {})

export type MagicAgentActorRef = {
  kind: MagicAgentActorKind
  id: string
  displayName?: string
}

export type MagicAgentExpectedRevision = {
  resourceId: string
  revision: number
}

export type MagicAgentCommand<TPayload = unknown> = MagicAgentEnvelope<TPayload> & {
  envelopeKind: 'command'
  actor: MagicAgentActorRef
  idempotencyKey: string
  expectedRevision?: MagicAgentExpectedRevision
}

export type MagicAgentRedaction = {
  applied: boolean
  paths: string[]
  reason?: string
}

export type MagicAgentEvent<TPayload = unknown> = MagicAgentEnvelope<TPayload> & {
  envelopeKind: 'event'
  streamId: string
  sequence: number
  actor?: MagicAgentActorRef
  redaction?: MagicAgentRedaction
}

export type MagicAgentCommandSuccess<TPayload = unknown> = {
  ok: true
  commandId: string
  completedAt: number
  payload: TPayload
  revision?: number
}

export type MagicAgentCommandFailure = {
  ok: false
  commandId: string
  completedAt: number
  error: {
    code: string
    message: string
    retryable: boolean
    details?: unknown
  }
}

export type MagicAgentCommandResult<TPayload = unknown> =
  | MagicAgentCommandSuccess<TPayload>
  | MagicAgentCommandFailure

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }
export type PayloadValidator<T> = (payload: unknown) => payload is T

export type EnvelopeParseResult<TPayload = unknown> = ParseResult<MagicAgentEnvelope<TPayload>>
export type CommandParseResult<TPayload = unknown> = ParseResult<MagicAgentCommand<TPayload>>
export type EventParseResult<TPayload = unknown> = ParseResult<MagicAgentEvent<TPayload>>
export type CommandResultParseResult<TPayload = unknown> = ParseResult<
  MagicAgentCommandResult<TPayload>
>

type ProtocolRecord = Record<string, unknown>

const hasOwn = (value: ProtocolRecord, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, field)

const ownValue = (value: ProtocolRecord, field: string): unknown =>
  hasOwn(value, field) ? value[field] : undefined

const isPlainRecord = (value: unknown): value is ProtocolRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const parseProtocolMajor = (value: string): number | undefined => {
  const match = /^(0|[1-9]\d*)(?:\.\d+){0,2}$/.exec(value)
  return match ? Number(match[1]) : undefined
}

const validatePayload = <TPayload>(
  payload: unknown,
  validator: PayloadValidator<TPayload> | undefined
): string | undefined => {
  if (validator && !validator(payload)) return 'payload failed validation.'
  return undefined
}

const parseEnvelopeUnsafe = <TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): EnvelopeParseResult<TPayload> => {
  if (!isPlainRecord(input)) return { ok: false, error: 'Envelope must be a plain object.' }

  const protocolVersion = ownValue(input, 'protocolVersion')
  if (typeof protocolVersion !== 'string') {
    return { ok: false, error: 'protocolVersion must be an own string field.' }
  }

  const major = parseProtocolMajor(protocolVersion)
  if (major === undefined || !SUPPORTED_RUNTIME_PROTOCOL_MAJOR_VERSIONS.includes(major)) {
    return { ok: false, error: `Unsupported runtime protocol version: ${protocolVersion}` }
  }
  if (!isNonEmptyString(ownValue(input, 'id'))) return { ok: false, error: 'id is required.' }
  if (!isNonEmptyString(ownValue(input, 'type'))) return { ok: false, error: 'type is required.' }

  const createdAt = ownValue(input, 'createdAt')
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return { ok: false, error: 'createdAt must be a finite number.' }
  }
  if (!hasOwn(input, 'payload')) return { ok: false, error: 'payload is required.' }

  const correlationId = ownValue(input, 'correlationId')
  if (correlationId !== undefined && !isNonEmptyString(correlationId)) {
    return { ok: false, error: 'correlationId must be a non-empty string.' }
  }
  const causationId = ownValue(input, 'causationId')
  if (causationId !== undefined && !isNonEmptyString(causationId)) {
    return { ok: false, error: 'causationId must be a non-empty string.' }
  }
  const extensions = ownValue(input, 'extensions')
  if (extensions !== undefined && !isPlainRecord(extensions)) {
    return { ok: false, error: 'extensions must be a plain object.' }
  }

  const payloadError = validatePayload(ownValue(input, 'payload'), payloadValidator)
  if (payloadError) return { ok: false, error: payloadError }
  return { ok: true, value: input as MagicAgentEnvelope<TPayload> }
}

export function parseMagicAgentEnvelope(input: unknown): EnvelopeParseResult<unknown>
export function parseMagicAgentEnvelope<TPayload>(
  input: unknown,
  payloadValidator: PayloadValidator<TPayload>
): EnvelopeParseResult<TPayload>
export function parseMagicAgentEnvelope<TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): EnvelopeParseResult<TPayload> {
  try {
    return parseEnvelopeUnsafe(input, payloadValidator)
  } catch {
    return { ok: false, error: 'Envelope could not be read safely.' }
  }
}

const validateActor = (value: unknown, field: string): string | undefined => {
  if (!isPlainRecord(value)) return `${field} must be a plain object.`
  if (!isNonEmptyString(ownValue(value, 'kind'))) return `${field}.kind is required.`
  if (!isNonEmptyString(ownValue(value, 'id'))) return `${field}.id is required.`
  const displayName = ownValue(value, 'displayName')
  if (displayName !== undefined && !isNonEmptyString(displayName)) {
    return `${field}.displayName must be a non-empty string.`
  }
  return undefined
}

const parseCommandUnsafe = <TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): CommandParseResult<TPayload> => {
  const envelope = parseEnvelopeUnsafe(input, payloadValidator)
  if (!envelope.ok) return envelope
  const value = input as ProtocolRecord

  if (ownValue(value, 'envelopeKind') !== 'command') {
    return { ok: false, error: 'envelopeKind must be an own field equal to "command".' }
  }
  const actorError = validateActor(ownValue(value, 'actor'), 'actor')
  if (actorError) return { ok: false, error: actorError }
  if (!isNonEmptyString(ownValue(value, 'idempotencyKey'))) {
    return { ok: false, error: 'idempotencyKey is required.' }
  }

  const expectedRevision = ownValue(value, 'expectedRevision')
  if (expectedRevision !== undefined) {
    if (!isPlainRecord(expectedRevision)) {
      return { ok: false, error: 'expectedRevision must be a plain object.' }
    }
    if (!isNonEmptyString(ownValue(expectedRevision, 'resourceId'))) {
      return { ok: false, error: 'expectedRevision.resourceId is required.' }
    }
    if (!isNonNegativeSafeInteger(ownValue(expectedRevision, 'revision'))) {
      return {
        ok: false,
        error: 'expectedRevision.revision must be a non-negative safe integer.'
      }
    }
  }
  return { ok: true, value: input as MagicAgentCommand<TPayload> }
}

export function parseMagicAgentCommand(input: unknown): CommandParseResult<unknown>
export function parseMagicAgentCommand<TPayload>(
  input: unknown,
  payloadValidator: PayloadValidator<TPayload>
): CommandParseResult<TPayload>
export function parseMagicAgentCommand<TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): CommandParseResult<TPayload> {
  try {
    return parseCommandUnsafe(input, payloadValidator)
  } catch {
    return { ok: false, error: 'Command could not be read safely.' }
  }
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const isSafeRedactionPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value
    .split('.')
    .every((segment) => /^[A-Za-z0-9_-]+$/.test(segment) && !FORBIDDEN_PATH_SEGMENTS.has(segment))

const validateRedaction = (value: unknown): string | undefined => {
  if (!isPlainRecord(value)) return 'redaction must be a plain object.'
  const applied = ownValue(value, 'applied')
  if (typeof applied !== 'boolean') return 'redaction.applied must be an own boolean field.'
  const paths = ownValue(value, 'paths')
  if (!Array.isArray(paths) || !paths.every(isSafeRedactionPath)) {
    return 'redaction.paths must contain only safe dot paths.'
  }
  if (applied && paths.length === 0)
    return 'redaction.paths must not be empty when applied is true.'
  if (!applied && paths.length !== 0) return 'redaction.paths must be empty when applied is false.'
  const reason = ownValue(value, 'reason')
  if (reason !== undefined && !isNonEmptyString(reason)) {
    return 'redaction.reason must be a non-empty string.'
  }
  return undefined
}

const parseEventUnsafe = <TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): EventParseResult<TPayload> => {
  const envelope = parseEnvelopeUnsafe(input, payloadValidator)
  if (!envelope.ok) return envelope
  const value = input as ProtocolRecord

  if (ownValue(value, 'envelopeKind') !== 'event') {
    return { ok: false, error: 'envelopeKind must be an own field equal to "event".' }
  }
  if (!isNonEmptyString(ownValue(value, 'streamId'))) {
    return { ok: false, error: 'streamId is required.' }
  }
  if (!isNonNegativeSafeInteger(ownValue(value, 'sequence'))) {
    return { ok: false, error: 'sequence must be a non-negative safe integer.' }
  }
  const actor = ownValue(value, 'actor')
  if (actor !== undefined) {
    const actorError = validateActor(actor, 'actor')
    if (actorError) return { ok: false, error: actorError }
  }
  const redaction = ownValue(value, 'redaction')
  if (redaction !== undefined) {
    const redactionError = validateRedaction(redaction)
    if (redactionError) return { ok: false, error: redactionError }
  }
  return { ok: true, value: input as MagicAgentEvent<TPayload> }
}

export function parseMagicAgentEvent(input: unknown): EventParseResult<unknown>
export function parseMagicAgentEvent<TPayload>(
  input: unknown,
  payloadValidator: PayloadValidator<TPayload>
): EventParseResult<TPayload>
export function parseMagicAgentEvent<TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): EventParseResult<TPayload> {
  try {
    return parseEventUnsafe(input, payloadValidator)
  } catch {
    return { ok: false, error: 'Event could not be read safely.' }
  }
}

const parseCommandResultUnsafe = <TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): CommandResultParseResult<TPayload> => {
  if (!isPlainRecord(input)) return { ok: false, error: 'Command result must be a plain object.' }
  const ok = ownValue(input, 'ok')
  if (typeof ok !== 'boolean') return { ok: false, error: 'ok must be an own boolean field.' }
  if (!isNonEmptyString(ownValue(input, 'commandId'))) {
    return { ok: false, error: 'commandId is required.' }
  }
  const completedAt = ownValue(input, 'completedAt')
  if (typeof completedAt !== 'number' || !Number.isFinite(completedAt)) {
    return { ok: false, error: 'completedAt must be a finite number.' }
  }

  if (ok) {
    if (hasOwn(input, 'error')) {
      return { ok: false, error: 'error is not allowed for a successful command result.' }
    }
    if (!hasOwn(input, 'payload')) {
      return { ok: false, error: 'payload is required for a successful command result.' }
    }
    const revision = ownValue(input, 'revision')
    if (revision !== undefined && !isNonNegativeSafeInteger(revision)) {
      return { ok: false, error: 'revision must be a non-negative safe integer.' }
    }
    const payloadError = validatePayload(ownValue(input, 'payload'), payloadValidator)
    if (payloadError) return { ok: false, error: payloadError }
  } else {
    if (hasOwn(input, 'payload') || hasOwn(input, 'revision')) {
      return {
        ok: false,
        error: 'payload and revision are not allowed for a failed command result.'
      }
    }
    const error = ownValue(input, 'error')
    if (!isPlainRecord(error)) {
      return { ok: false, error: 'error must be a plain object for a failed command result.' }
    }
    if (!isNonEmptyString(ownValue(error, 'code'))) {
      return { ok: false, error: 'error.code is required.' }
    }
    if (!isNonEmptyString(ownValue(error, 'message'))) {
      return { ok: false, error: 'error.message is required.' }
    }
    if (typeof ownValue(error, 'retryable') !== 'boolean') {
      return { ok: false, error: 'error.retryable must be an own boolean field.' }
    }
  }
  return { ok: true, value: input as MagicAgentCommandResult<TPayload> }
}

export function parseMagicAgentCommandResult(input: unknown): CommandResultParseResult<unknown>
export function parseMagicAgentCommandResult<TPayload>(
  input: unknown,
  payloadValidator: PayloadValidator<TPayload>
): CommandResultParseResult<TPayload>
export function parseMagicAgentCommandResult<TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): CommandResultParseResult<TPayload> {
  try {
    return parseCommandResultUnsafe(input, payloadValidator)
  } catch {
    return { ok: false, error: 'Command result could not be read safely.' }
  }
}

const assertParsed = <T>(result: ParseResult<T>): T => {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export function assertMagicAgentEnvelope(input: unknown): MagicAgentEnvelope<unknown>
export function assertMagicAgentEnvelope<TPayload>(
  input: unknown,
  payloadValidator: PayloadValidator<TPayload>
): MagicAgentEnvelope<TPayload>
export function assertMagicAgentEnvelope<TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): MagicAgentEnvelope<TPayload> {
  return assertParsed(
    parseMagicAgentEnvelope(input, payloadValidator as PayloadValidator<TPayload>)
  )
}

export function assertMagicAgentCommand(input: unknown): MagicAgentCommand<unknown>
export function assertMagicAgentCommand<TPayload>(
  input: unknown,
  payloadValidator: PayloadValidator<TPayload>
): MagicAgentCommand<TPayload>
export function assertMagicAgentCommand<TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): MagicAgentCommand<TPayload> {
  return assertParsed(parseMagicAgentCommand(input, payloadValidator as PayloadValidator<TPayload>))
}

export function assertMagicAgentEvent(input: unknown): MagicAgentEvent<unknown>
export function assertMagicAgentEvent<TPayload>(
  input: unknown,
  payloadValidator: PayloadValidator<TPayload>
): MagicAgentEvent<TPayload>
export function assertMagicAgentEvent<TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): MagicAgentEvent<TPayload> {
  return assertParsed(parseMagicAgentEvent(input, payloadValidator as PayloadValidator<TPayload>))
}

export function assertMagicAgentCommandResult(input: unknown): MagicAgentCommandResult<unknown>
export function assertMagicAgentCommandResult<TPayload>(
  input: unknown,
  payloadValidator: PayloadValidator<TPayload>
): MagicAgentCommandResult<TPayload>
export function assertMagicAgentCommandResult<TPayload>(
  input: unknown,
  payloadValidator?: PayloadValidator<TPayload>
): MagicAgentCommandResult<TPayload> {
  return assertParsed(
    parseMagicAgentCommandResult(input, payloadValidator as PayloadValidator<TPayload>)
  )
}
