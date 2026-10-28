import { Buffer } from 'node:buffer'
import { types } from 'node:util'
import { FIGPLUGIN_BRIDGE_ERRORS, type FigPluginBridgeErrorCode } from '@shared/figplugin/bridge'

/** The IPC protocol is distinct from the HTTP and plan protocol versions. */
export const FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL = 1 as const
/** Messages are transferred atomically by Electron utilityProcess. */
export const FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES = 128 * 1024
export const FIGPLUGIN_BRIDGE_CHILD_MAX_DEPTH = 32
export const FIGPLUGIN_BRIDGE_CHILD_MAX_NODES = 10_000

const REQUEST_ID = /^[a-f0-9]{32}$/
const TOKEN = /^[a-f0-9]{64}$/
const METHODS = [
  'redeem',
  'prepare',
  'prepareImageGeneration',
  'imageGenerationStatus',
  'cancelImageGeneration',
  'status',
  'readiness',
  'assetList',
  'assetChunk',
  'planAssetChunk',
  'cancel',
  'closeSession',
  'planStatus',
  'prepareVisualCorrection',
  'prepareTaskRecovery',
  'claimPlan',
  'planProgress',
  'planResult',
  'planPixelAudit'
] as const

export const FIGPLUGIN_BRIDGE_CHILD_RPC_METHODS = METHODS
export type FigPluginBridgeChildRpcMethod = (typeof METHODS)[number]

type WireObject = Record<string, unknown>

export type FigPluginBridgeChildRpcRequest = Readonly<{
  kind: 'request'
  protocol: typeof FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL
  nonce: string
  requestId: string
  /** Optional lineage ID; older protocol-1 peers may omit it. */
  correlationId?: string
  method: FigPluginBridgeChildRpcMethod
  session?: string
  token?: string
  body: unknown
}>

export type FigPluginBridgeChildRpcResponse = Readonly<
  | {
      kind: 'response'
      protocol: typeof FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL
      nonce: string
      requestId: string
      /** Echoed request lineage when supplied by the peer. */
      correlationId?: string
      ok: true
      result: unknown
    }
  | {
      kind: 'response'
      protocol: typeof FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL
      nonce: string
      requestId: string
      /** Echoed request lineage when supplied by the peer. */
      correlationId?: string
      ok: false
      errorCode: FigPluginBridgeErrorCode
    }
>

export type FigPluginBridgeChildRpcCancel = Readonly<{
  kind: 'cancel'
  protocol: typeof FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL
  nonce: string
  requestId: string
  correlationId?: string
}>

export type FigPluginBridgeChildRpcMessage =
  FigPluginBridgeChildRpcRequest | FigPluginBridgeChildRpcResponse | FigPluginBridgeChildRpcCancel

export type FigPluginBridgeChildWireErrorCode =
  'INVALID' | 'LIMIT' | 'PROTOCOL_MISMATCH' | 'NONCE_MISMATCH'

export class FigPluginBridgeChildWireError extends TypeError {
  readonly code: FigPluginBridgeChildWireErrorCode

  constructor(code: FigPluginBridgeChildWireErrorCode) {
    super(code === 'LIMIT' ? 'Bridge child wire limit exceeded' : 'Invalid bridge child wire value')
    this.name = 'FigPluginBridgeChildWireError'
    this.code = code
  }
}

const invalid = (): never => {
  throw new FigPluginBridgeChildWireError('INVALID')
}

const limited = (): never => {
  throw new FigPluginBridgeChildWireError('LIMIT')
}

const protocolMismatch = (): never => {
  throw new FigPluginBridgeChildWireError('PROTOCOL_MISMATCH')
}

const nonceMismatch = (): never => {
  throw new FigPluginBridgeChildWireError('NONCE_MISMATCH')
}

const isMethod = (value: unknown): value is FigPluginBridgeChildRpcMethod =>
  typeof value === 'string' && (METHODS as readonly string[]).includes(value)

const isNonce = (value: unknown): value is string =>
  typeof value === 'string' && REQUEST_ID.test(value)

/** Correlation IDs use the same bounded opaque shape as the transport nonce. */
export const isFigPluginBridgeChildCorrelationId = (value: unknown): value is string =>
  typeof value === 'string' && REQUEST_ID.test(value)

const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value)

const isPlainObject = (value: unknown): value is WireObject => {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)) return false
    return (
      Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
    )
  } catch {
    return false
  }
}

/**
 * Validate values before JSON.stringify. This prevents accessors/proxies from
 * executing in the trusted parent while constructing an IPC frame and bounds
 * recursive work before a frame-size check.
 */
const checkJsonValue = (
  value: unknown,
  depth: number,
  state: { nodes: number; seen: Set<object> }
): void => {
  if (depth > FIGPLUGIN_BRIDGE_CHILD_MAX_DEPTH) limited()
  state.nodes += 1
  if (state.nodes > FIGPLUGIN_BRIDGE_CHILD_MAX_NODES) limited()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    return
  }
  if (typeof value !== 'object') invalid()
  const objectValue = value as object
  if (state.seen.has(objectValue)) invalid()
  state.seen.add(objectValue)
  try {
    if (Array.isArray(value)) {
      let length: number | undefined
      const indexes: number[] = []
      for (const key of Reflect.ownKeys(objectValue)) {
        const stringKey = typeof key === 'string' ? key : invalid()
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, stringKey)
        if (!descriptor) {
          invalid()
          return
        }
        if (key === 'length') {
          if (!('value' in descriptor) || !Number.isSafeInteger(descriptor.value)) invalid()
          // Sparse arrays can make JSON.stringify allocate work proportional to
          // an attacker-controlled length even when they contain no elements.
          if (descriptor.value > FIGPLUGIN_BRIDGE_CHILD_MAX_NODES) limited()
          length = descriptor.value
          continue
        }
        if (
          !/^\d+$/.test(stringKey) ||
          String(Number(stringKey)) !== stringKey ||
          !('value' in descriptor) ||
          !descriptor.enumerable
        )
          invalid()
        indexes.push(Number(stringKey))
        checkJsonValue(descriptor.value, depth + 1, state)
      }
      // JSON arrays are dense; reject holes instead of silently normalizing
      // them to null during serialization.
      if (length === undefined) {
        invalid()
        return
      }
      const arrayLength = length
      if (indexes.length !== arrayLength) invalid()
      for (let index = 0; index < arrayLength; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid()
      }
      return
    }
    if (!isPlainObject(value)) invalid()
    for (const key of Reflect.ownKeys(objectValue)) {
      const stringKey = typeof key === 'string' ? key : invalid()
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, stringKey)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        invalid()
        return
      }
      checkJsonValue(descriptor.value, depth + 1, state)
    }
  } finally {
    state.seen.delete(objectValue)
  }
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (isPlainObject(value)) {
    const output: WireObject = Object.create(null)
    for (const key of Object.keys(value).sort()) output[key] = canonical(value[key] as unknown)
    return output
  }
  return value
}

const stringify = (value: unknown): string => {
  checkJsonValue(value, 0, { nodes: 0, seen: new Set() })
  let frame: string | undefined
  try {
    frame = JSON.stringify(canonical(value))
  } catch {
    invalid()
  }
  if (frame === undefined) invalid()
  const output = frame as string
  if (Buffer.byteLength(output, 'utf8') > FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES) limited()
  return output
}

const parse = (frame: unknown): WireObject => {
  if (typeof frame !== 'string') invalid()
  const text = frame as string
  if (Buffer.byteLength(text, 'utf8') > FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES) limited()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    invalid()
  }
  checkJsonValue(value, 0, { nodes: 0, seen: new Set() })
  if (!isPlainObject(value)) invalid()
  // Canonical JSON prevents alternate encodings of the same authority envelope.
  if (stringify(value) !== text) invalid()
  return value as WireObject
}

const exactKeys = (
  value: WireObject,
  required: readonly string[],
  optional: readonly string[] = []
): void => {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  if (keys.length < required.length || keys.some((key) => !allowed.has(key))) invalid()
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid()
}

// Encoder arguments are local values, but still reject accessors/proxies at
// the boundary so reading a field cannot execute attacker-controlled code.
const safeInput = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): WireObject => {
  if (!isPlainObject(value)) invalid()
  const input = value as WireObject
  exactKeys(input, required, optional)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') invalid()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid()
  }
  return input
}

const base = (
  value: WireObject,
  kind: 'request' | 'response' | 'cancel',
  expectedNonce?: string
) => {
  const required =
    kind === 'request'
      ? ['kind', 'protocol', 'nonce', 'requestId', 'method', 'body']
      : ['kind', 'protocol', 'nonce', 'requestId']
  exactKeys(
    value,
    required,
    kind === 'request'
      ? ['session', 'token', 'correlationId']
      : kind === 'response'
        ? ['ok', 'result', 'errorCode', 'correlationId']
        : ['correlationId']
  )
  if (value.kind !== kind) invalid()
  if (value.protocol !== FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL) protocolMismatch()
  if (!isNonce(value.nonce)) invalid()
  if (expectedNonce !== undefined && !isNonce(expectedNonce)) invalid()
  if (expectedNonce !== undefined && value.nonce !== expectedNonce) nonceMismatch()
  if (!isNonce(value.requestId)) invalid()
  if (
    value.correlationId !== undefined &&
    !isFigPluginBridgeChildCorrelationId(value.correlationId)
  )
    invalid()
}

export function encodeFigPluginBridgeChildRpcRequest(input: {
  nonce: string
  requestId: string
  correlationId?: string
  method: FigPluginBridgeChildRpcMethod
  session?: string
  token?: string
  body: unknown
}): string {
  const source = safeInput(
    input,
    ['nonce', 'requestId', 'method', 'body'],
    ['session', 'token', 'correlationId']
  )
  const nonceValue = source.nonce
  const requestIdValue = source.requestId
  const correlationIdValue = source.correlationId
  const methodValue = source.method
  const sessionValue = source.session
  const tokenValue = source.token
  if (
    !isNonce(nonceValue) ||
    !isNonce(requestIdValue) ||
    !isMethod(methodValue) ||
    (correlationIdValue !== undefined && !isFigPluginBridgeChildCorrelationId(correlationIdValue))
  )
    invalid()
  const hasSession = sessionValue !== undefined
  const hasToken = tokenValue !== undefined
  if (
    hasSession !== hasToken ||
    (hasSession && !isNonce(sessionValue)) ||
    (hasToken && !isToken(tokenValue))
  )
    invalid()
  if (methodValue === 'redeem' && (hasSession || hasToken)) invalid()
  if (methodValue !== 'redeem' && (!hasSession || !hasToken)) invalid()
  return stringify({
    kind: 'request',
    protocol: FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL,
    nonce: nonceValue,
    requestId: requestIdValue,
    ...(correlationIdValue === undefined ? {} : { correlationId: correlationIdValue }),
    method: methodValue,
    ...(hasSession ? { session: sessionValue, token: tokenValue } : {}),
    body: source.body
  })
}

export function decodeFigPluginBridgeChildRpcRequest(
  frame: unknown,
  expectedNonce?: string
): FigPluginBridgeChildRpcRequest {
  const value = parse(frame)
  base(value, 'request', expectedNonce)
  if (!isMethod(value.method)) invalid()
  const hasSession = value.session !== undefined
  const hasToken = value.token !== undefined
  if (
    hasSession !== hasToken ||
    (hasSession && !isNonce(value.session)) ||
    (hasToken && !isToken(value.token))
  )
    invalid()
  if (value.method === 'redeem' && (hasSession || hasToken)) invalid()
  if (value.method !== 'redeem' && (!hasSession || !hasToken)) invalid()
  return value as FigPluginBridgeChildRpcRequest
}

export function encodeFigPluginBridgeChildRpcResponse(input: {
  nonce: string
  requestId: string
  correlationId?: string
  result: unknown
}): string
export function encodeFigPluginBridgeChildRpcResponse(input: {
  nonce: string
  requestId: string
  correlationId?: string
  errorCode: FigPluginBridgeErrorCode
}): string
export function encodeFigPluginBridgeChildRpcResponse(input: {
  nonce: string
  requestId: string
  correlationId?: string
  result?: unknown
  errorCode?: FigPluginBridgeErrorCode
}): string {
  const source = safeInput(input, ['nonce', 'requestId'], ['correlationId', 'result', 'errorCode'])
  const nonceValue = source.nonce
  const requestIdValue = source.requestId
  const correlationIdValue = source.correlationId
  if (
    !isNonce(nonceValue) ||
    !isNonce(requestIdValue) ||
    (correlationIdValue !== undefined && !isFigPluginBridgeChildCorrelationId(correlationIdValue))
  )
    invalid()
  const hasResult = Object.prototype.hasOwnProperty.call(source, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(source, 'errorCode')
  if (hasResult && hasError) invalid()
  const success = !hasError
  const errorCode = source.errorCode
  if (
    !success &&
    (typeof errorCode !== 'string' ||
      !Object.prototype.hasOwnProperty.call(FIGPLUGIN_BRIDGE_ERRORS, errorCode))
  )
    invalid()
  // JSON has no undefined value. Preserve void Runtime methods as an explicit
  // null result instead of silently dropping the result field.
  const result = source.result === undefined ? null : source.result
  return stringify({
    kind: 'response',
    protocol: FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL,
    nonce: nonceValue,
    requestId: requestIdValue,
    ...(correlationIdValue === undefined ? {} : { correlationId: correlationIdValue }),
    ok: success,
    ...(success ? { result } : { errorCode })
  })
}

export function decodeFigPluginBridgeChildRpcResponse(
  frame: unknown,
  expectedNonce?: string
): FigPluginBridgeChildRpcResponse {
  const value = parse(frame)
  base(value, 'response', expectedNonce)
  if (typeof value.ok !== 'boolean') invalid()
  if (value.ok) {
    if (
      !Object.prototype.hasOwnProperty.call(value, 'result') ||
      Object.prototype.hasOwnProperty.call(value, 'errorCode')
    )
      invalid()
  } else {
    if (
      Object.prototype.hasOwnProperty.call(value, 'result') ||
      !Object.prototype.hasOwnProperty.call(value, 'errorCode')
    )
      invalid()
    if (
      typeof value.errorCode !== 'string' ||
      !Object.prototype.hasOwnProperty.call(FIGPLUGIN_BRIDGE_ERRORS, value.errorCode)
    )
      invalid()
  }
  return value as FigPluginBridgeChildRpcResponse
}

export function encodeFigPluginBridgeChildRpcCancel(input: {
  nonce: string
  requestId: string
  correlationId?: string
}): string {
  const source = safeInput(input, ['nonce', 'requestId'], ['correlationId'])
  if (
    !isNonce(source.nonce) ||
    !isNonce(source.requestId) ||
    (source.correlationId !== undefined &&
      !isFigPluginBridgeChildCorrelationId(source.correlationId))
  )
    invalid()
  return stringify({
    kind: 'cancel',
    protocol: FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL,
    nonce: source.nonce,
    requestId: source.requestId,
    ...(source.correlationId === undefined ? {} : { correlationId: source.correlationId })
  })
}

export function decodeFigPluginBridgeChildRpcCancel(
  frame: unknown,
  expectedNonce?: string
): FigPluginBridgeChildRpcCancel {
  const value = parse(frame)
  base(value, 'cancel', expectedNonce)
  return value as FigPluginBridgeChildRpcCancel
}

// Short aliases make the wire helpers convenient in child entrypoints without
// exposing any untyped or arbitrary IPC operation.
export const serializeFigPluginBridgeChildRpcRequest = encodeFigPluginBridgeChildRpcRequest
export const parseFigPluginBridgeChildRpcRequest = decodeFigPluginBridgeChildRpcRequest
export const serializeFigPluginBridgeChildRpcResponse = encodeFigPluginBridgeChildRpcResponse
export const parseFigPluginBridgeChildRpcResponse = decodeFigPluginBridgeChildRpcResponse
export const serializeFigPluginBridgeChildRpcCancel = encodeFigPluginBridgeChildRpcCancel
export const parseFigPluginBridgeChildRpcCancel = decodeFigPluginBridgeChildRpcCancel
