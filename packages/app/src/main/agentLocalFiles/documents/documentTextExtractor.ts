import {
  DOCUMENT_TEXT_PROTOCOL,
  checkDocumentTextRequest,
  checkDocumentTextResult,
  type DocumentTextFailureCode,
  type DocumentTextRequest,
  type DocumentTextResult,
  type DocumentTextValidationCode
} from './documentSchema'
import { extractOoxmlText, type OfficeTextExtractionOptions } from './ooxmlTextExtractor'
import {
  extractPdfText,
  type PdfTextExtractionOptions,
  type PdfTextRuntime
} from './pdfTextExtractor'

export type DocumentTextExtractionOptions = OfficeTextExtractionOptions & PdfTextExtractionOptions
// Without validated ingress there is no trustworthy job/format to echo in an envelope.
export type DocumentExtractionOutcome =
  DocumentTextResult | Readonly<{ ok: false; code: DocumentTextValidationCode }>

function failure(
  request: DocumentTextRequest,
  code: DocumentTextFailureCode
): Extract<DocumentTextResult, { ok: false }> {
  return {
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: request.jobId,
    format: request.format,
    ok: false,
    code
  }
}

/**
 * Pure bytes-only dispatch. It does not open paths, consult grants, upload text,
 * or start a worker. The caller must obtain bytes through the separately audited
 * main-process grant path and must still apply its own scope/approval checks.
 * The optional PDF runtime is trusted worker wiring, never part of a request or
 * renderer options. Missing provisioning fails closed; there is no regex fallback.
 */
export async function extractDocumentText(
  value: unknown,
  options: DocumentTextExtractionOptions = {},
  pdfRuntime?: PdfTextRuntime
): Promise<DocumentExtractionOutcome> {
  // Do not use `in`, property reads, casts, or coercion on caller-owned ingress.
  const checked = checkDocumentTextRequest(value)
  if (!checked.ok) return { ok: false, code: checked.code }
  const request = checked.request
  try {
    const result =
      request.format === 'pdf'
        ? await extractPdfText(request.bytes, request.jobId, options, pdfRuntime)
        : await extractOoxmlText(request.bytes, request.jobId, request.format, options)
    // Independently enforce correlation, shape and escaped-JSON budget after dispatch.
    const validated = checkDocumentTextResult(result, request.jobId, request.format)
    return validated.ok ? validated.result : failure(request, validated.code)
  } catch {
    // Never forward parser exception messages, stacks, paths or cause objects.
    return failure(request, 'EXECUTION_FAILED')
  }
}
