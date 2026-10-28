import { extractDocumentText } from './documentTextExtractor'
import { DOCUMENT_TEXT_PROTOCOL, type DocumentTextRequest } from './documentSchema'
import type { PdfTextRuntime } from './pdfTextExtractor'
import { parseDocumentTextRequestFrame, serializeDocumentTextResult } from './documentWorkerWire'
import { DOCUMENT_PROCESS_RECEIPT_ACK } from './documentProcessSupervisor'

export type DocumentWorkerPort = {
  on(event: 'message', listener: (event: { data: unknown; ports?: unknown[] }) => void): unknown
  removeListener(
    event: 'message',
    listener: (event: { data: unknown; ports?: unknown[] }) => void
  ): unknown
  postMessage(frame: string): void
}

/** Native dynamic ESM imports deliberately remain external in the standalone CJS bundle. */
export async function loadDocumentPdfRuntime(): Promise<PdfTextRuntime> {
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  // utilityProcess is not a browser and pdf.js excludes it from its Node detection.
  // Preload the fixed WorkerMessageHandler to use an in-process PDF engine INSIDE
  // the real utility child, rather than a web Worker or a request-selected worker URL.
  const global = globalThis as typeof globalThis & { pdfjsWorker?: unknown }
  global.pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler }
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (pdf.version !== '6.3.289') throw new Error('Document runtime unavailable')
  return pdf as unknown as PdfTextRuntime
}

/** Single request/result, exact receipt then native exit. No path, grant or provider ingress. */
export function runDocumentWorker(
  port: DocumentWorkerPort,
  exit: (code: number) => void,
  loadPdf: () => Promise<PdfTextRuntime> = loadDocumentPdfRuntime
): void {
  let phase: 'input' | 'extracting' | 'receipt' | 'closed' = 'input'
  const stop = (code: number): void => {
    if (phase === 'closed') return
    phase = 'closed'
    clearTimeout(watchdog)
    port.removeListener('message', onMessage)
    exit(code)
  }
  const watchdog = setTimeout(() => stop(2), 6000)
  const failure = (request: DocumentTextRequest) => ({
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: request.jobId,
    format: request.format,
    ok: false as const,
    code: 'EXECUTION_FAILED' as const
  })
  const extract = async (request: DocumentTextRequest): Promise<void> => {
    let result: unknown
    try {
      const pdf = request.format === 'pdf' ? await loadPdf() : undefined
      result = await extractDocumentText(request, { deadlineAt: Date.now() + 4000 }, pdf)
    } catch {
      result = failure(request)
    }
    if (phase !== 'extracting') return
    let frame: string
    try {
      frame = serializeDocumentTextResult(result, request.jobId, request.format)
    } catch {
      frame = serializeDocumentTextResult(failure(request), request.jobId, request.format)
    }
    phase = 'receipt'
    try {
      port.postMessage(frame)
    } catch {
      stop(2)
    }
  }
  const onMessage = (event: { data: unknown; ports?: unknown[] }): void => {
    if (phase === 'closed') return
    if (event.ports?.length) {
      stop(2)
      return
    }
    if (phase === 'receipt' && event.data === DOCUMENT_PROCESS_RECEIPT_ACK) {
      stop(0)
      return
    }
    if (phase !== 'input') {
      stop(2)
      return
    }
    const parsed = parseDocumentTextRequestFrame(event.data)
    if (!parsed.ok) {
      stop(2)
      return
    }
    phase = 'extracting'
    void extract(parsed.request).catch(() => stop(2))
  }
  port.on('message', onMessage)
}
