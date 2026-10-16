/* eslint-disable no-control-regex -- Paths and display names must never contain control bytes. */
import { z } from 'zod'
import type { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceError, ServiceValidationError } from './apiUtils/serviceValidation'

export const AGENT_LOCAL_FILE_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  returnedBytes: 64 * 1024,
  responseBytes: 128 * 1024,
  listEntries: 100,
  ttlMs: 30 * 60 * 1000,
  grants: 128,
  grantsPerScope: 16,
  deadlineMs: 10_000
})

export const AGENT_LOCAL_FILE_ERRORS = Object.freeze({
  GRANT_DENIED: 'Local file access is not authorized.',
  PATH_DENIED: 'This local path is not permitted.',
  NOT_FOUND: 'The selected local item is unavailable.',
  FILE_TOO_LARGE: 'The file exceeds the local file size limit.',
  TEXT_TOO_LARGE: 'The text exceeds the returned text size limit.',
  BINARY_FILE: 'Only text files can be read.',
  UNSUPPORTED_FORMAT: 'This file format is not supported.',
  INVALID_ENCODING: 'Only valid UTF-8 text is supported.',
  FILE_CHANGED: 'The local item changed during access.',
  GRANT_LIMIT: 'The local file grant limit has been reached.',
  BUSY: 'Too many local file requests are active.',
  CANCELLED: 'The local file request was cancelled.',
  TIMEOUT: 'The local file request timed out.',
  IO_ERROR: 'The local file operation failed.',
  INVALID_DOCUMENT: 'The document is invalid or damaged.',
  DOCUMENT_LIMIT: 'The document exceeds the extraction limits.',
  NO_TEXT: 'No supported text was found in the document.',
  EXTRACTION_FAILED: 'Document text extraction failed.',
  SCOPE_CHANGED: 'The active project, pane or conversation changed.'
})

export type AgentLocalFileErrorCode = keyof typeof AGENT_LOCAL_FILE_ERRORS

export class AgentLocalFileError extends ServiceError {
  constructor(code: AgentLocalFileErrorCode) {
    super(AGENT_LOCAL_FILE_ERRORS[code], { code })
  }
}

const safeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const boundedPath = z
  .string()
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]*$/)
const grantId = z.string().regex(/^[A-Za-z0-9_-]{32}$/)
const name = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\\u0000-\u001f\u007f]+$/)
const kind = z.enum(['file', 'directory'])

export const agentLocalFileScopeSchema = z
  .object({ projectId: safeId, paneId: safeId, sessionId: safeId })
  .strict()

export const setLocalFileScopeRequestSchema = z
  .object({
    scope: agentLocalFileScopeSchema,
    active: z.boolean(),
    // Monotonic renderer lifecycle revision. Optional for older callers; ChatPage supplies it.
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export const chooseLocalFileRequestSchema = z
  .object({
    scope: agentLocalFileScopeSchema,
    kind,
    suggestedPath: boundedPath.min(1).optional(),
    requestId: safeId
  })
  .strict()

export const readLocalFileRequestSchema = z
  .object({
    scope: agentLocalFileScopeSchema,
    grantId,
    relativePath: boundedPath.optional(),
    requestId: safeId
  })
  .strict()

export const listLocalFilesRequestSchema = readLocalFileRequestSchema
export const revokeLocalFilesRequestSchema = z
  .object({ scope: agentLocalFileScopeSchema, grantId: grantId.optional() })
  .strict()
export const cancelLocalFileRequestSchema = z
  .object({ scope: agentLocalFileScopeSchema, requestId: safeId })
  .strict()

export const agentLocalFileGrantSchema = z
  .object({
    id: grantId,
    kind,
    name,
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    readOnly: z.literal(true)
  })
  .strict()

const index = z.number().int().min(0).max(99999)
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
export const localDocumentLocatorSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('pdf-item'), page: z.number().int().min(1).max(200), item: index })
    .strict(),
  z
    .object({
      kind: z.literal('docx-paragraph'),
      part: z.literal('word/document.xml'),
      paragraph: index
    })
    .strict(),
  z
    .object({
      kind: z.literal('docx-table-cell'),
      part: z.literal('word/document.xml'),
      table: index,
      row: index,
      column: index
    })
    .strict(),
  z
    .object({
      kind: z.literal('xlsx-cell'),
      sheet: z.number().int().min(1).max(256),
      cell: excelCell
    })
    .strict(),
  z
    .object({
      kind: z.literal('pptx-shape'),
      slide: z.number().int().min(1).max(256),
      shape: index,
      paragraph: index
    })
    .strict()
])
export const localDocumentSchema = z
  .object({
    format: z.enum(['pdf', 'docx', 'xlsx', 'pptx']),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    segments: z
      .array(
        z
          .object({ text: z.string().min(1).max(65536), locator: localDocumentLocatorSchema })
          .strict()
      )
      .min(1)
      .max(512),
    warnings: z.array(z.enum(['output-truncated', 'reading-order-unverified'])).max(2)
  })
  .strict()

function wellFormedUnicode(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

export const readLocalFileResponseSchema = z
  .object({
    name,
    relativePath: boundedPath,
    content: z.string().max(AGENT_LOCAL_FILE_LIMITS.returnedBytes),
    encoding: z.literal('utf-8'),
    sizeBytes: z.number().int().min(0).max(AGENT_LOCAL_FILE_LIMITS.fileBytes),
    returnedBytes: z.number().int().min(0).max(AGENT_LOCAL_FILE_LIMITS.returnedBytes),
    truncated: z.boolean(),
    document: localDocumentSchema.optional()
  })
  .strict()
  .refine((value) => {
    const utf8 = (text: string) => new TextEncoder().encode(text).byteLength
    if (!wellFormedUnicode(value.content) || utf8(value.content) !== value.returnedBytes)
      return false
    // Plain text already has a strict decoded byte bound. JSON escaping can expand it
    // beyond the document envelope; preserve the existing valid 64-KiB text contract.
    if (!value.document) return !value.truncated
    if (utf8(JSON.stringify(value)) > AGENT_LOCAL_FILE_LIMITS.responseBytes) return false
    const { format, segments, warnings } = value.document
    if (!segments.every((segment) => wellFormedUnicode(segment.text))) return false
    if (
      new Set(warnings).size !== warnings.length ||
      value.truncated !== warnings.includes('output-truncated')
    )
      return false
    if (segments.map((segment) => segment.text).join('') !== value.content) return false
    return segments.every(({ locator }) =>
      format === 'pdf'
        ? locator.kind === 'pdf-item'
        : format === 'docx'
          ? locator.kind === 'docx-paragraph' || locator.kind === 'docx-table-cell'
          : format === 'xlsx'
            ? locator.kind === 'xlsx-cell'
            : locator.kind === 'pptx-shape'
    )
  })

export const listLocalFilesResponseSchema = z
  .object({
    entries: z.array(z.object({ name, kind }).strict()).max(AGENT_LOCAL_FILE_LIMITS.listEntries),
    truncated: z.boolean()
  })
  .strict()

export type AgentLocalFileScope = z.infer<typeof agentLocalFileScopeSchema>
export type AgentLocalFileGrant = z.infer<typeof agentLocalFileGrantSchema>
export type SetLocalFileScopeRequest = z.infer<typeof setLocalFileScopeRequestSchema>
export type LocalDocumentLocator = z.infer<typeof localDocumentLocatorSchema>
export type ChooseLocalFileRequest = z.infer<typeof chooseLocalFileRequestSchema>
export type ReadLocalFileRequest = z.infer<typeof readLocalFileRequestSchema>
export type ListLocalFilesRequest = z.infer<typeof listLocalFilesRequestSchema>
export type RevokeLocalFilesRequest = z.infer<typeof revokeLocalFilesRequestSchema>
export type CancelLocalFileRequest = z.infer<typeof cancelLocalFileRequestSchema>
export type ReadLocalFileResponse = z.infer<typeof readLocalFileResponseSchema>
export type ListLocalFilesResponse = z.infer<typeof listLocalFilesResponseSchema>

/** Never attach Zod issues or caller data: IPC validation failures may be logged. */
export function parseAgentLocalFileValue<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch {
    throw new ServiceValidationError('Local file service value')
  }
}

const validate =
  <T>(schema: z.ZodType<T>) =>
  (value: unknown): T =>
    parseAgentLocalFileValue(schema, value)

export type AgentLocalFilesSvc = {
  setScope(req: SetLocalFileScopeRequest): Promise<void>
  choose(req: ChooseLocalFileRequest): Promise<AgentLocalFileGrant | null>
  read(req: ReadLocalFileRequest): Promise<ReadLocalFileResponse>
  list(req: ListLocalFilesRequest): Promise<ListLocalFilesResponse>
  revoke(req: RevokeLocalFilesRequest): Promise<void>
  cancel(req: CancelLocalFileRequest): Promise<void>
}

// Core read-only file service. Main owns the native chooser and trusted sender identity.
export const agentLocalFilesSvcDef: ServiceDefSheet<AgentLocalFilesSvc> = {
  setScope: {
    type: 'unary',
    request: validate(setLocalFileScopeRequestSchema),
    response: validate(z.void())
  },
  choose: {
    type: 'unary',
    request: validate(chooseLocalFileRequestSchema),
    response: validate(agentLocalFileGrantSchema.nullable())
  },
  read: {
    type: 'unary',
    request: validate(readLocalFileRequestSchema),
    response: validate(readLocalFileResponseSchema)
  },
  list: {
    type: 'unary',
    request: validate(listLocalFilesRequestSchema),
    response: validate(listLocalFilesResponseSchema)
  },
  revoke: {
    type: 'unary',
    request: validate(revokeLocalFilesRequestSchema),
    response: validate(z.void())
  },
  cancel: {
    type: 'unary',
    request: validate(cancelLocalFileRequestSchema),
    response: validate(z.void())
  }
}
