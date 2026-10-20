import { types } from 'node:util'
import { z } from 'zod'

// Inert internal parser protocol: schema validity never authorizes a file read or content upload.
// No service, worker, dependency loader or document parser is registered by this module.
export const DOCUMENT_TEXT_PROTOCOL = 'magicpot-document-text/v1' as const
// Shared policy ceilings. This inert schema enforces only input/envelope/segments/locator
// limits; ZIP/XML/PDF work budgets and deadline/heap enforcement belong to future components.
export const DOCUMENT_TEXT_LIMITS = Object.freeze({
  inputBytes: 1024 * 1024,
  // Bounded metadata budget, separate from the unchanged returned text limit.
  envelopeBytes: 128 * 1024,
  segments: 1024,
  zipEntries: 256,
  zipEntryBytes: 4 * 1024 * 1024,
  zipExpandedBytes: 16 * 1024 * 1024,
  xmlDepth: 64,
  xmlElements: 100000,
  pdfPages: 200,
  pdfItems: 100000,
  deadlineMs: 5000,
  heapMiB: 256
})
const formatSchema = z.enum(['pdf', 'docx', 'xlsx', 'pptx'])
const idSchema = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]{32}$/)
export type DocumentTextFormat = z.infer<typeof formatSchema>
export type DocumentTextRequest = {
  protocol: typeof DOCUMENT_TEXT_PROTOCOL
  jobId: string
  format: DocumentTextFormat
  bytes: Uint8Array
}
export type DocumentTextValidationCode = 'INVALID' | 'LIMIT'

const boundedIndex = z
  .number()
  .int()
  .min(0)
  .max(DOCUMENT_TEXT_LIMITS.xmlElements - 1)
const excelCell = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/)
  .refine((cell) => {
    const match = /^([A-Z]+)([0-9]+)$/.exec(cell)
    if (!match) return false
    let column = 0
    for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64
    return column <= 16384 && Number(match[2]) <= 1048576
  })
const locatorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('pdf-item'),
      page: z.number().int().min(1).max(DOCUMENT_TEXT_LIMITS.pdfPages),
      item: z
        .number()
        .int()
        .min(0)
        .max(DOCUMENT_TEXT_LIMITS.pdfItems - 1)
    })
    .strict(),
  z
    .object({
      kind: z.literal('docx-paragraph'),
      part: z.literal('word/document.xml'),
      paragraph: boundedIndex
    })
    .strict(),
  z
    .object({
      kind: z.literal('docx-table-cell'),
      part: z.literal('word/document.xml'),
      table: boundedIndex,
      row: boundedIndex,
      column: boundedIndex
    })
    .strict(),
  z
    .object({
      kind: z.literal('xlsx-cell'),
      sheet: z.number().int().min(1).max(DOCUMENT_TEXT_LIMITS.zipEntries),
      cell: excelCell
    })
    .strict(),
  z
    .object({
      kind: z.literal('pptx-shape'),
      slide: z.number().int().min(1).max(DOCUMENT_TEXT_LIMITS.zipEntries),
      shape: boundedIndex,
      paragraph: boundedIndex
    })
    .strict()
])
const failureCodeSchema = z.enum([
  'UNSUPPORTED',
  'NO_TEXT',
  'INVALID',
  'LIMIT',
  'TIMEOUT',
  'CANCELLED',
  'EXECUTION_FAILED'
])
const resultSchema = z
  .discriminatedUnion('ok', [
    z
      .object({
        protocol: z.literal(DOCUMENT_TEXT_PROTOCOL),
        jobId: idSchema,
        ok: z.literal(true),
        format: formatSchema,
        segments: z
          .array(
            z
              .object({
                text: z.string().min(1).max(DOCUMENT_TEXT_LIMITS.envelopeBytes),
                locator: locatorSchema
              })
              .strict()
          )
          .min(1)
          .max(DOCUMENT_TEXT_LIMITS.segments),
        truncated: z.boolean(),
        warnings: z.array(z.enum(['output-truncated', 'reading-order-unverified'])).max(2)
      })
      .strict(),
    z
      .object({
        protocol: z.literal(DOCUMENT_TEXT_PROTOCOL),
        jobId: idSchema,
        format: formatSchema,
        ok: z.literal(false),
        code: failureCodeSchema
      })
      .strict()
  ])
  .refine((result) => {
    if (!result.ok) return true
    if (new Set(result.warnings).size !== result.warnings.length) return false
    if (result.truncated !== result.warnings.includes('output-truncated')) return false
    return result.segments.every(({ locator }) => {
      if (result.format === 'pdf') return locator.kind === 'pdf-item'
      if (result.format === 'docx')
        return locator.kind === 'docx-paragraph' || locator.kind === 'docx-table-cell'
      if (result.format === 'xlsx') return locator.kind === 'xlsx-cell'
      return locator.kind === 'pptx-shape'
    })
  })
export type DocumentTextResult = z.infer<typeof resultSchema>
export type DocumentTextFailureCode = z.infer<typeof failureCodeSchema>
export type DocumentTextLocator = z.infer<typeof locatorSchema>

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const arrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const limitExceeded = Symbol('Document envelope budget')

function dataFields(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) throw new TypeError()
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError()
  const names = Reflect.ownKeys(value)
  if (
    names.length !== required.length ||
    !names.every((key) => typeof key === 'string' && required.includes(key))
  )
    throw new TypeError()
  const copy: Record<string, unknown> = Object.create(null)
  for (const name of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError()
    copy[name] = descriptor.value
  }
  return copy
}

/** Main-only safe ingress. Reject Proxies before reflection and read typed arrays intrinsically.
 * The caller still must bound raw IPC input before decoding; own-key enumeration is not a sandbox
 * for arbitrarily wide in-process objects. A detached byte copy is not a file-access grant. */
export function checkDocumentTextRequest(
  value: unknown
): { ok: true; request: DocumentTextRequest } | { ok: false; code: DocumentTextValidationCode } {
  try {
    const data = dataFields(value, ['protocol', 'jobId', 'format', 'bytes'])
    if (
      data.protocol !== DOCUMENT_TEXT_PROTOCOL ||
      typeof data.jobId !== 'string' ||
      typeof data.format !== 'string'
    )
      throw new TypeError()
    const jobId = idSchema.parse(data.jobId),
      format = formatSchema.parse(data.format)
    if (
      typeof data.bytes !== 'object' ||
      data.bytes === null ||
      types.isProxy(data.bytes) ||
      !types.isUint8Array(data.bytes)
    )
      throw new TypeError()
    const buffer = Reflect.apply(arrayBufferGetter, data.bytes, [])
    if (
      !types.isArrayBuffer(buffer) ||
      (resizableGetter && Reflect.apply(resizableGetter, buffer, []))
    )
      throw new TypeError()
    const offset = Reflect.apply(byteOffsetGetter, data.bytes, [])
    const length = Reflect.apply(byteLengthGetter, data.bytes, [])
    if (length > DOCUMENT_TEXT_LIMITS.inputBytes) throw limitExceeded
    if (!length) throw new TypeError()
    // Construct an intrinsic view so caller-owned buffer/length/iterator properties cannot run.
    const copy = new Uint8Array(length)
    copy.set(new Uint8Array(buffer, offset, length))
    const pdf =
      copy.length >= 5 &&
      copy[0] === 0x25 &&
      copy[1] === 0x50 &&
      copy[2] === 0x44 &&
      copy[3] === 0x46 &&
      copy[4] === 0x2d
    const zip =
      copy.length >= 4 && copy[0] === 0x50 && copy[1] === 0x4b && copy[2] === 3 && copy[3] === 4
    if (format === 'pdf' ? !pdf : !zip) throw new TypeError()
    return { ok: true, request: { protocol: DOCUMENT_TEXT_PROTOCOL, jobId, format, bytes: copy } }
  } catch (error) {
    return { ok: false, code: error === limitExceeded ? 'LIMIT' : 'INVALID' }
  }
}

function detachResult(value: unknown): unknown {
  const ancestors = new Set<object>()
  let values = 0,
    units = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++values > 8192 || depth > 8) throw limitExceeded
    if (typeof item === 'string') {
      units += item.length
      if (units > DOCUMENT_TEXT_LIMITS.envelopeBytes) throw limitExceeded
      for (let index = 0; index < item.length; index += 1) {
        const code = item.charCodeAt(index)
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = item.charCodeAt(++index)
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError()
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError()
      }
      return item
    }
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item))
      throw new TypeError()
    const array = Array.isArray(item)
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new TypeError()
    const length = array ? Object.getOwnPropertyDescriptor(item, 'length')?.value : 0
    if (
      array &&
      (!Number.isInteger(length) || length < 0 || length > DOCUMENT_TEXT_LIMITS.segments)
    )
      throw limitExceeded
    const names = Reflect.ownKeys(item)
    if (
      names.length > (array ? DOCUMENT_TEXT_LIMITS.segments + 1 : 16) ||
      (array && names.length !== length + 1)
    )
      throw new TypeError()
    const copy: unknown[] | Record<string, unknown> = array
      ? []
      : (Object.create(null) as Record<string, unknown>)
    ancestors.add(item)
    for (const name of names) {
      if (array && name === 'length') continue
      if (
        typeof name !== 'string' ||
        ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(name)
      )
        throw new TypeError()
      if (array && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length))
        throw new TypeError()
      const descriptor = Object.getOwnPropertyDescriptor(item, name)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError()
      units += name.length
      if (units > DOCUMENT_TEXT_LIMITS.envelopeBytes) throw limitExceeded
      const detached = visit(descriptor.value, depth + 1)
      if (array) (copy as unknown[])[Number(name)] = detached
      else (copy as Record<string, unknown>)[name] = detached
    }
    ancestors.delete(item)
    return copy
  }
  const detached = visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(detached), 'utf8') > DOCUMENT_TEXT_LIMITS.envelopeBytes)
    throw limitExceeded
  return detached
}

/** Validates a fully detached, bytes-bounded worker response with exact parent-owned correlation.
 * Only the parent may add byte hashes/display names/provenance and recheck live scope/grant. */
export function checkDocumentTextResult(
  value: unknown,
  expectedJobId: string,
  expectedFormat: DocumentTextFormat
): { ok: true; result: DocumentTextResult } | { ok: false; code: DocumentTextValidationCode } {
  try {
    if (typeof expectedJobId !== 'string' || typeof expectedFormat !== 'string')
      throw new TypeError()
    idSchema.parse(expectedJobId)
    formatSchema.parse(expectedFormat)
    const result = resultSchema.parse(detachResult(value))
    if (result.jobId !== expectedJobId || result.format !== expectedFormat) throw new TypeError()
    return { ok: true, result }
  } catch (error) {
    return { ok: false, code: error === limitExceeded ? 'LIMIT' : 'INVALID' }
  }
}
