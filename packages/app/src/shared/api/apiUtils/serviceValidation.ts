import { isJsonDict, type JsonDict } from '@shared/utils/utilTypes'
import type { ServiceInvocationContext } from './serviceInvocation'
import type { ServerStreaming } from './streaming'

export const SERVICE_INTERNAL_ERROR_CODE = 'INTERNAL_ERROR'
export const SERVICE_VALIDATION_ERROR_CODE = 'VALIDATION_ERROR'

export type ServiceErrorCode =
  | typeof SERVICE_INTERNAL_ERROR_CODE
  | typeof SERVICE_VALIDATION_ERROR_CODE
  | (string & {})

export type ServiceErrorTransport = {
  message: string
  code?: ServiceErrorCode
  payload?: JsonDict
}

export type ServiceValidationIssue = {
  path: (string | number)[]
  message: string
  code?: string
}

export type ServiceSafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown }

export type ServiceSafeParseValidator<T> = {
  safeParse: (value: unknown) => ServiceSafeParseResult<T>
}

export type ServiceParseValidator<T> = {
  parse: (value: unknown) => T
}

export type ServicePredicateValidator<T> = (value: unknown) => value is T
export type ServiceTransformValidator<T> = (value: unknown) => T

export type ServiceValidator<T> =
  | ServiceSafeParseValidator<T>
  | ServiceParseValidator<T>
  | ServicePredicateValidator<T>
  | ServiceTransformValidator<T>

export type ServiceValidationOptions = {
  label?: string
}

export type UnaryServiceValidation<REQ, RESP> = {
  methodName?: string
  request?: ServiceValidator<REQ>
  response?: ServiceValidator<RESP>
}

export type UnaryServiceHandler<REQ, RESP> = (
  req: REQ,
  invocation?: ServiceInvocationContext
) => Promise<RESP>

export type ServerStreamingServiceValidation<REQ, RESP> = {
  methodName?: string
  request?: ServiceValidator<REQ>
  data?: ServiceValidator<RESP>
}

export type ServerStreamingServiceHandler<REQ, RESP> = (
  req: REQ,
  resp: ServerStreaming<RESP>,
  invocation?: ServiceInvocationContext
) => Promise<void>

export class ServiceError extends Error {
  readonly code: ServiceErrorCode
  readonly payload?: JsonDict
  readonly cause?: unknown

  constructor(
    message: string,
    options: { code?: ServiceErrorCode; payload?: JsonDict; cause?: unknown } = {}
  ) {
    super(message || 'Unknown error')
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = new.target.name
    this.code = options.code ?? SERVICE_INTERNAL_ERROR_CODE
    this.payload = options.payload
    this.cause = options.cause

    const ErrorWithCapture = Error as ErrorConstructor & {
      captureStackTrace?: (targetObject: object, constructorOpt?: object) => void
    }
    ErrorWithCapture.captureStackTrace?.(this, new.target)
  }

  toJSON(): ServiceErrorTransport {
    return serializeServiceError(this)
  }
}

export class ServiceValidationError extends ServiceError {
  readonly issues: ServiceValidationIssue[]

  constructor(label: string, cause?: unknown, issues = toServiceValidationIssues(cause)) {
    super(formatServiceValidationMessage(label, issues), {
      code: SERVICE_VALIDATION_ERROR_CODE,
      payload: createValidationPayload(label, issues),
      cause
    })
    this.issues = issues
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError
}

export function isServiceErrorTransport(value: unknown): value is ServiceErrorTransport {
  if (!isRecord(value) || typeof value.message !== 'string') {
    return false
  }
  if ('code' in value && value.code !== undefined && typeof value.code !== 'string') {
    return false
  }
  if ('payload' in value && value.payload !== undefined && !isJsonDict(value.payload)) {
    return false
  }
  return true
}

export function normalizeServiceError(
  error: unknown,
  options: { code?: ServiceErrorCode; fallbackMessage?: string; includeJsonPayload?: boolean } = {}
): ServiceError {
  if (error instanceof ServiceError) {
    return error
  }

  const fallbackMessage = options.fallbackMessage ?? 'Unknown error'
  const code = options.code ?? getStructuredErrorCode(error) ?? SERVICE_INTERNAL_ERROR_CODE
  const payload = getStructuredErrorPayload(error, options.includeJsonPayload ?? true)

  return new ServiceError(getServiceErrorMessage(error, fallbackMessage), {
    code,
    payload,
    cause: error
  })
}

export function serializeServiceError(
  error: unknown,
  options: { code?: ServiceErrorCode; fallbackMessage?: string; includeJsonPayload?: boolean } = {}
): ServiceErrorTransport {
  const normalized = normalizeServiceError(error, options)
  const transport: ServiceErrorTransport = {
    message: normalized.message,
    code: normalized.code
  }
  if (normalized.payload !== undefined) {
    transport.payload = normalized.payload
  }
  return transport
}

export function getServiceErrorMessage(error: unknown, fallbackMessage = 'Unknown error'): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  if (error === null || error === undefined || error === '') {
    return fallbackMessage
  }

  const stringified = stringifyUnknown(error)
  return stringified || fallbackMessage
}

export function validateServiceValue<T>(
  value: unknown,
  validator: ServiceValidator<T> | undefined,
  options: ServiceValidationOptions = {}
): T {
  if (validator === undefined) {
    return value as T
  }

  const label = options.label ?? 'service value'

  if (hasSafeParse(validator)) {
    const result = validator.safeParse(value)
    if (result.success) {
      return result.data
    }
    throw new ServiceValidationError(label, result.error)
  }

  if (hasParse(validator)) {
    try {
      return validator.parse(value)
    } catch (error) {
      throw new ServiceValidationError(label, error)
    }
  }

  try {
    const result = validator(value)
    if (typeof result === 'boolean') {
      if (result) {
        return value as T
      }
      throw new ServiceValidationError(label)
    }
    return result as T
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      throw error
    }
    throw new ServiceValidationError(label, error)
  }
}

export function withServiceValidation<REQ, RESP>(
  handler: UnaryServiceHandler<REQ, RESP>,
  validation: UnaryServiceValidation<REQ, RESP> = {}
): UnaryServiceHandler<REQ, RESP> {
  return async (req: REQ, invocation?: ServiceInvocationContext): Promise<RESP> => {
    const parsedReq = validateServiceValue(req, validation.request, {
      label: formatValidationLabel(validation.methodName, 'request')
    })
    const resp = await handler(parsedReq, invocation)
    return validateServiceValue(resp, validation.response, {
      label: formatValidationLabel(validation.methodName, 'response')
    })
  }
}

export function withServerStreamingValidation<REQ, RESP>(
  handler: ServerStreamingServiceHandler<REQ, RESP>,
  validation: ServerStreamingServiceValidation<REQ, RESP> = {}
): ServerStreamingServiceHandler<REQ, RESP> {
  return async (
    req: REQ,
    resp: ServerStreaming<RESP>,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const parsedReq = validateServiceValue(req, validation.request, {
      label: formatValidationLabel(validation.methodName, 'request')
    })
    const validatedResp = validation.data
      ? {
          ...resp,
          onData: (data: RESP) => {
            resp.onData(
              validateServiceValue(data, validation.data, {
                label: formatValidationLabel(validation.methodName, 'stream data')
              })
            )
          }
        }
      : resp

    await handler(parsedReq, validatedResp, invocation)
  }
}

export function toServiceValidationIssues(error: unknown): ServiceValidationIssue[] {
  const issueSource = getIssueSource(error)
  if (issueSource) {
    const issues = issueSource.map(toServiceValidationIssue).filter(isDefined)
    if (issues.length > 0) {
      return issues
    }
  }

  const message = getServiceErrorMessage(error, 'Failed validation')
  return [
    {
      path: [],
      message
    }
  ]
}

export function formatServiceValidationMessage(
  label: string,
  issues: ServiceValidationIssue[]
): string {
  if (issues.length === 0) {
    return `Invalid ${label}`
  }

  const renderedIssues = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')

  return `Invalid ${label}: ${renderedIssues}`
}

function createValidationPayload(label: string, issues: ServiceValidationIssue[]): JsonDict {
  return {
    label,
    issues: issues.map((issue) => {
      const result: JsonDict = {
        path: issue.path,
        message: issue.message
      }
      if (issue.code !== undefined) {
        result.code = issue.code
      }
      return result
    })
  }
}

function formatValidationLabel(methodName: string | undefined, part: string): string {
  return methodName ? `${methodName} ${part}` : `service ${part}`
}

function hasSafeParse<T>(
  validator: ServiceValidator<T>
): validator is ServiceSafeParseValidator<T> {
  return (
    typeof validator === 'object' &&
    validator !== null &&
    'safeParse' in validator &&
    typeof validator.safeParse === 'function'
  )
}

function hasParse<T>(validator: ServiceValidator<T>): validator is ServiceParseValidator<T> {
  return (
    typeof validator === 'object' &&
    validator !== null &&
    'parse' in validator &&
    typeof validator.parse === 'function'
  )
}

function getStructuredErrorCode(error: unknown): ServiceErrorCode | undefined {
  if (isRecord(error) && typeof error.code === 'string' && error.code.trim()) {
    return error.code
  }
  return undefined
}

function getStructuredErrorPayload(
  error: unknown,
  includeJsonPayload: boolean
): JsonDict | undefined {
  if (isServiceErrorTransport(error) && error.payload !== undefined) {
    return error.payload
  }
  if (error instanceof Error) {
    return undefined
  }
  if (includeJsonPayload && isJsonDict(error)) {
    return error
  }
  return undefined
}

function getIssueSource(error: unknown): unknown[] | undefined {
  if (Array.isArray(error)) {
    return error
  }
  if (!isRecord(error)) {
    return undefined
  }
  if (Array.isArray(error.issues)) {
    return error.issues
  }
  if (Array.isArray(error.errors)) {
    return error.errors
  }
  return undefined
}

function toServiceValidationIssue(value: unknown): ServiceValidationIssue | undefined {
  if (typeof value === 'string') {
    return {
      path: [],
      message: value
    }
  }
  if (!isRecord(value)) {
    return undefined
  }

  const message =
    typeof value.message === 'string' && value.message.trim() ? value.message : 'Invalid value'
  const issue: ServiceValidationIssue = {
    path: normalizeIssuePath(value.path),
    message
  }
  if (typeof value.code === 'string' && value.code.trim()) {
    issue.code = value.code
  }
  return issue
}

function normalizeIssuePath(path: unknown): (string | number)[] {
  if (!Array.isArray(path)) {
    return []
  }
  return path.flatMap((item) => {
    if (typeof item === 'string' || typeof item === 'number') {
      return [item]
    }
    if (typeof item === 'symbol') {
      return [item.description ?? 'symbol']
    }
    return [String(item)]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    const json = JSON.stringify(value)
    if (json && json !== '{}') {
      return json
    }
  } catch {
    // Fall through to String for circular objects and non-JSON values.
  }
  return String(value)
}
