import { Buffer } from 'node:buffer'
import { types } from 'node:util'
import {
  checkDocumentTextRequest,
  checkDocumentTextResult,
  DOCUMENT_TEXT_PROTOCOL,
  type DocumentTextFailureCode,
  type DocumentTextFormat,
  type DocumentTextRequest,
  type DocumentTextResult,
  type DocumentTextValidationCode
} from './documentSchema'

/** Fixed IPC framing budgets. These are wire budgets, not caller policy. */
export const DOCUMENT_REQUEST_DECODED_BYTES = 8 * 1024 * 1024
export const DOCUMENT_REQUEST_BASE64_CHARS = Math.ceil(DOCUMENT_REQUEST_DECODED_BYTES / 3) * 4
// JSON framing adds only a small fixed envelope around the base64 payload.
export const DOCUMENT_REQUEST_FRAME_BYTES = DOCUMENT_REQUEST_BASE64_CHARS + 512
export const DOCUMENT_RESULT_FRAME_BYTES = 128 * 1024

const formats = ['pdf', 'docx', 'xlsx', 'pptx'] as const
const failureCodes = [
  'UNSUPPORTED',
  'NO_TEXT',
  'INVALID',
  'LIMIT',
  'TIMEOUT',
  'CANCELLED',
  'EXECUTION_FAILED'
] as const
const requestWireKeys = ['protocol', 'jobId', 'format', 'bytes'] as const
const failureWireKeys = ['protocol', 'jobId', 'ok', 'format', 'code'] as const

type DocumentTextSuccess = Extract<DocumentTextResult, { ok: true }>

export type DocumentWorkerFailure = {
  protocol: typeof DOCUMENT_TEXT_PROTOCOL
  jobId: string
  ok: false
  format: DocumentTextFormat
  code: DocumentTextFailureCode
}

export type DocumentWorkerResult = DocumentTextSuccess | DocumentWorkerFailure

export type DocumentWorkerWireParseResult =
  { ok: true; result: DocumentWorkerResult } | { ok: false; code: DocumentTextValidationCode }

export type DocumentWorkerRequestWireParseResult =
  { ok: true; request: DocumentTextRequest } | { ok: false; code: DocumentTextValidationCode }

/** Deliberately fixed-message: no raw JSON, filenames, stacks, or secret payloads cross IPC. */
class DocumentWorkerWireError extends TypeError {
  readonly code: DocumentTextValidationCode

  constructor(code: DocumentTextValidationCode) {
    super(
      code === 'LIMIT'
        ? 'Document worker wire limit exceeded'
        : 'Invalid document worker wire value'
    )
    this.name = 'DocumentWorkerWireError'
    this.code = code
  }
}

function invalid(): { ok: false; code: 'INVALID' } {
  return { ok: false, code: 'INVALID' }
}

function limited(): { ok: false; code: 'LIMIT' } {
  return { ok: false, code: 'LIMIT' }
}

function isDocumentTextFormat(value: unknown): value is DocumentTextFormat {
  return (
    typeof value === 'string' &&
    (value === formats[0] || value === formats[1] || value === formats[2] || value === formats[3])
  )
}

function isDocumentTextFailureCode(value: unknown): value is DocumentTextFailureCode {
  return (
    typeof value === 'string' &&
    (value === failureCodes[0] ||
      value === failureCodes[1] ||
      value === failureCodes[2] ||
      value === failureCodes[3] ||
      value === failureCodes[4] ||
      value === failureCodes[5] ||
      value === failureCodes[6])
  )
}

function isJobId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 32 && /^[a-f0-9]{32}$/.test(value)
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function actualUtf8Bytes(value: string): number | null {
  if (hasLoneSurrogate(value)) return null
  return Buffer.byteLength(value, 'utf8')
}

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function parsedFields(value: unknown, required: readonly string[]): Record<string, unknown> | null {
  if (!isPlainJsonRecord(value)) return null
  const names = Object.keys(value)
  if (names.length !== required.length || !names.every((name) => required.includes(name)))
    return null
  const copy = Object.create(null) as Record<string, unknown>
  for (const name of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null
    copy[name] = descriptor.value
  }
  return copy
}

function safeOwnDataProperty(
  value: unknown,
  name: string
): { ok: true; value: unknown } | { ok: false } {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return { ok: false }
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return { ok: false }
    return { ok: true, value: descriptor.value }
  } catch {
    return { ok: false }
  }
}

function safeObjectFields(
  value: unknown,
  required: readonly string[]
): Record<string, unknown> | null {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return null
    const names = Reflect.ownKeys(value)
    if (
      names.length !== required.length ||
      !names.every((name) => typeof name === 'string' && required.includes(name))
    )
      return null
    const copy = Object.create(null) as Record<string, unknown>
    for (const name of required) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null
      copy[name] = descriptor.value
    }
    return copy
  } catch {
    return null
  }
}

function parseRawJsonFrame(
  frame: unknown,
  limit: number
): { ok: true; value: unknown; frame: string } | { ok: false; code: 'INVALID' | 'LIMIT' } {
  if (typeof frame !== 'string') return invalid()
  if (frame.length > limit) return limited()
  const byteLength = actualUtf8Bytes(frame)
  if (byteLength === null) return invalid()
  if (byteLength > limit) return limited()
  try {
    return { ok: true, value: JSON.parse(frame) as unknown, frame }
  } catch {
    // Never expose JSON.parse's input-dependent message across the worker boundary.
    return invalid()
  }
}

type DecodedBase64 = { ok: true; bytes: Uint8Array } | { ok: false; code: 'INVALID' | 'LIMIT' }

function decodeCanonicalBase64(value: unknown): DecodedBase64 {
  if (typeof value !== 'string') return invalid()
  if (value.length > DOCUMENT_REQUEST_BASE64_CHARS) return limited()
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return invalid()

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const decodedLength = (value.length / 4) * 3 - padding
  if (decodedLength > DOCUMENT_REQUEST_DECODED_BYTES) return limited()

  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return invalid()
  }
  if (decoded.length > DOCUMENT_REQUEST_DECODED_BYTES) return limited()
  if (decoded.toString('base64') !== value) return invalid()

  const copy = new Uint8Array(decoded.length)
  copy.set(decoded)
  return { ok: true, bytes: copy }
}

function requestWire(
  jobId: string,
  format: DocumentTextFormat,
  bytes: string
): {
  protocol: typeof DOCUMENT_TEXT_PROTOCOL
  jobId: string
  format: DocumentTextFormat
  bytes: string
} {
  return { protocol: DOCUMENT_TEXT_PROTOCOL, jobId, format, bytes }
}

function stringifyWithinLimit(value: unknown, limit: number): string {
  const frame = JSON.stringify(value)
  if (typeof frame !== 'string') throw new DocumentWorkerWireError('INVALID')
  const byteLength = actualUtf8Bytes(frame)
  if (byteLength === null) throw new DocumentWorkerWireError('INVALID')
  if (byteLength > limit) throw new DocumentWorkerWireError('LIMIT')
  return frame
}

function canonicalLocator(locator: DocumentTextSuccess['segments'][number]['locator']) {
  switch (locator.kind) {
    case 'pdf-item':
      return { kind: 'pdf-item' as const, page: locator.page, item: locator.item }
    case 'docx-paragraph':
      return {
        kind: 'docx-paragraph' as const,
        part: locator.part,
        paragraph: locator.paragraph
      }
    case 'docx-table-cell':
      return {
        kind: 'docx-table-cell' as const,
        part: locator.part,
        table: locator.table,
        row: locator.row,
        column: locator.column
      }
    case 'xlsx-cell':
      return { kind: 'xlsx-cell' as const, sheet: locator.sheet, cell: locator.cell }
    case 'pptx-shape':
      return {
        kind: 'pptx-shape' as const,
        slide: locator.slide,
        shape: locator.shape,
        paragraph: locator.paragraph
      }
  }
}

function canonicalSuccess(result: DocumentTextSuccess): DocumentTextSuccess {
  return {
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: result.jobId,
    ok: true,
    format: result.format,
    segments: result.segments.map((segment) => ({
      text: segment.text,
      locator: canonicalLocator(segment.locator)
    })),
    truncated: result.truncated,
    warnings: [...result.warnings]
  }
}

function validateExpected(
  expectedJobId: unknown,
  expectedFormat: unknown
): expectedJobId is string {
  return isJobId(expectedJobId) && isDocumentTextFormat(expectedFormat)
}

function failureFromFields(
  fields: Record<string, unknown>,
  expectedJobId: string,
  expectedFormat: DocumentTextFormat
): DocumentWorkerFailure | null {
  if (
    fields.protocol !== DOCUMENT_TEXT_PROTOCOL ||
    fields.jobId !== expectedJobId ||
    fields.ok !== false ||
    fields.format !== expectedFormat ||
    !isDocumentTextFailureCode(fields.code)
  )
    return null
  return {
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: expectedJobId,
    ok: false,
    format: expectedFormat,
    code: fields.code
  }
}

function schemaFailure(
  failure: DocumentWorkerFailure,
  expectedJobId: string,
  expectedFormat: DocumentTextFormat
): DocumentWorkerFailure | null {
  const checked = checkDocumentTextResult(failure, expectedJobId, expectedFormat)
  if (!checked.ok || checked.result.ok) return null
  // Keep the wire-field insertion order rather than depending on Zod's output order.
  return failure
}

/** Main-only ingress: validated bytes are encoded, never arbitrary-stringified. */
export function serializeDocumentTextRequest(request: unknown): string {
  const checked = checkDocumentTextRequest(request)
  if (!checked.ok) throw new DocumentWorkerWireError(checked.code)
  const bytes = Buffer.from(checked.request.bytes).toString('base64')
  return stringifyWithinLimit(
    requestWire(checked.request.jobId, checked.request.format, bytes),
    DOCUMENT_REQUEST_FRAME_BYTES
  )
}

export function parseDocumentTextRequestFrame(
  frame: unknown
): DocumentWorkerRequestWireParseResult {
  const parsed = parseRawJsonFrame(frame, DOCUMENT_REQUEST_FRAME_BYTES)
  if (!parsed.ok) return parsed
  const fields = parsedFields(parsed.value, requestWireKeys)
  if (!fields) return invalid()
  if (
    fields.protocol !== DOCUMENT_TEXT_PROTOCOL ||
    typeof fields.jobId !== 'string' ||
    !isDocumentTextFormat(fields.format)
  )
    return invalid()

  const decoded = decodeCanonicalBase64(fields.bytes)
  if (!decoded.ok) return decoded
  const checked = checkDocumentTextRequest({
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: fields.jobId,
    format: fields.format,
    bytes: decoded.bytes
  })
  if (!checked.ok) return checked

  const canonical = stringifyWithinLimit(
    requestWire(checked.request.jobId, checked.request.format, fields.bytes as string),
    DOCUMENT_REQUEST_FRAME_BYTES
  )
  if (canonical !== parsed.frame) return invalid()
  return checked
}

/** Main-only ingress: result shape, correlation, and the new failure format are checked first. */
export function serializeDocumentTextResult(
  result: unknown,
  expectedJobId: string,
  expectedFormat: DocumentTextFormat
): string {
  if (!validateExpected(expectedJobId, expectedFormat)) throw new DocumentWorkerWireError('INVALID')

  const okField = safeOwnDataProperty(result, 'ok')
  if (!okField.ok) throw new DocumentWorkerWireError('INVALID')

  if (okField.value === false) {
    const fields = safeObjectFields(result, failureWireKeys)
    const failure = fields ? failureFromFields(fields, expectedJobId, expectedFormat) : null
    const checkedFailure = failure ? schemaFailure(failure, expectedJobId, expectedFormat) : null
    if (!checkedFailure) throw new DocumentWorkerWireError('INVALID')
    return stringifyWithinLimit(checkedFailure, DOCUMENT_RESULT_FRAME_BYTES)
  }

  const checked = checkDocumentTextResult(result, expectedJobId, expectedFormat)
  if (!checked.ok) throw new DocumentWorkerWireError(checked.code)
  if (!checked.result.ok) throw new DocumentWorkerWireError('INVALID')
  return stringifyWithinLimit(canonicalSuccess(checked.result), DOCUMENT_RESULT_FRAME_BYTES)
}

export function parseDocumentTextResultFrame(
  frame: unknown,
  expectedJobId: string,
  expectedFormat: DocumentTextFormat
): DocumentWorkerWireParseResult {
  if (!validateExpected(expectedJobId, expectedFormat)) return invalid()
  const parsed = parseRawJsonFrame(frame, DOCUMENT_RESULT_FRAME_BYTES)
  if (!parsed.ok) return parsed

  const okField = safeOwnDataProperty(parsed.value, 'ok')
  if (!okField.ok) return invalid()
  if (okField.value === false) {
    const fields = parsedFields(parsed.value, failureWireKeys)
    const failure = fields ? failureFromFields(fields, expectedJobId, expectedFormat) : null
    const checkedFailure = failure ? schemaFailure(failure, expectedJobId, expectedFormat) : null
    if (!checkedFailure) return invalid()
    if (stringifyWithinLimit(checkedFailure, DOCUMENT_RESULT_FRAME_BYTES) !== parsed.frame)
      return invalid()
    return { ok: true, result: checkedFailure }
  }
  if (okField.value !== true) return invalid()

  const checked = checkDocumentTextResult(parsed.value, expectedJobId, expectedFormat)
  if (!checked.ok || !checked.result.ok) return invalid()
  const result = canonicalSuccess(checked.result)
  if (stringifyWithinLimit(result, DOCUMENT_RESULT_FRAME_BYTES) !== parsed.frame) return invalid()
  return { ok: true, result }
}
