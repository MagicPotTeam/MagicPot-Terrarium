import { types } from 'node:util'
import {
  DOCUMENT_TEXT_LIMITS,
  DOCUMENT_TEXT_PROTOCOL,
  checkDocumentTextRequest,
  checkDocumentTextResult,
  type DocumentTextFailureCode,
  type DocumentTextResult
} from './documentSchema'

/** Trusted in-process options; the wire protocol has no signal. Defensive descriptor
 * checks are not a sandbox for forged/copied native signal state or modified globals. */
export type PdfTextExtractionOptions = Readonly<{
  signal?: AbortSignal
  deadlineAt?: number
}>
export type PdfExtractionOutcome =
  DocumentTextResult | Readonly<{ ok: false; code: 'INVALID' | 'LIMIT' }>

type TextChunk = { items: readonly ({ str: string } | { type: string })[] }
type TextReader = {
  read(): PromiseLike<{ done: boolean; value?: TextChunk }>
  cancel(reason: Error): PromiseLike<void>
  releaseLock(): void
}
type PdfDocument = {
  readonly numPages: number
  readonly isPureXfa: boolean
  getPermissions(): PromiseLike<ReadonlySet<number> | null>
  getMetadata(): PromiseLike<{ info: unknown }>
  getPage(page: number): PromiseLike<{
    streamTextContent(options: { includeMarkedContent: false; disableNormalization: false }): {
      getReader(): TextReader
    }
  }>
}
type LoadingTask = {
  readonly promise: PromiseLike<PdfDocument>
  onPassword: ((updatePassword: (password: string) => void, reason: number) => void) | null
  destroy(): PromiseLike<void>
}
/** Trusted, separately provisioned pdf.js API, never deserialized from a request.
 * The index signature admits pdf.js initialization flags without importing a dependency. */
export type PdfTextRuntime = Readonly<{
  version: string
  getDocument(parameters: { data: Uint8Array; [key: string]: unknown }): LoadingTask
}>

type Success = Extract<DocumentTextResult, { ok: true }>
const signalPrototype = AbortSignal.prototype
const abortGetter = Object.getOwnPropertyDescriptor(signalPrototype, 'aborted')!.get!
const reasonGetter = Object.getOwnPropertyDescriptor(signalPrototype, 'reason')!.get!
const signalMethodSymbols = new Set([
  ...Object.getOwnPropertySymbols(signalPrototype),
  ...Object.getOwnPropertySymbols(EventTarget.prototype)
])

/** Check own data before native getters: Node can store its state in own symbols.
 * Never traverse private state, listener collections, composite sources or abort reasons. */
function validateSignal(value: unknown): boolean {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== signalPrototype
  )
    throw new TypeError()
  const keys = Reflect.ownKeys(value)
  if (keys.length > 32) throw new TypeError()
  const functions: unknown[] = []
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'symbol' || !('value' in field) || signalMethodSymbols.has(key))
      throw new TypeError()
    if (typeof field.value === 'function') functions.push(field.value)
  }
  const aborted = Reflect.apply(abortGetter, value, []) as boolean
  if (functions.length) {
    if (!aborted) throw new TypeError()
    // A function is allowed only as the opaque reason, identified via the public intrinsic.
    const reason: unknown = Reflect.apply(reasonGetter, value, [])
    if (functions.some((field) => field !== reason)) throw new TypeError()
  }
  return aborted
}

function snapshotOptions(value: unknown): PdfTextExtractionOptions {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError()
  const copy: { signal?: AbortSignal; deadlineAt?: number } = {}
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'signal' && key !== 'deadlineAt') throw new TypeError()
    const field = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in field) || !field.enumerable) throw new TypeError()
    if (field.value === undefined) continue
    if (key === 'signal') {
      validateSignal(field.value)
      copy.signal = field.value
    } else {
      if (typeof field.value !== 'number' || !Number.isFinite(field.value)) throw new TypeError()
      copy.deadlineAt = field.value
    }
  }
  return copy
}

function failure(jobId: string, code: DocumentTextFailureCode): PdfExtractionOutcome {
  const result = {
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId,
    format: 'pdf' as const,
    ok: false as const,
    code
  }
  const checked = checkDocumentTextResult(result, jobId, 'pdf')
  return checked.ok ? checked.result : { ok: false, code: checked.code }
}

function parserFailure(error: unknown): DocumentTextFailureCode {
  // Library failures are trusted, but messages/stacks are neither read nor returned.
  if (error !== null && typeof error === 'object' && !types.isProxy(error)) {
    const name = Object.getOwnPropertyDescriptor(error, 'name')?.value
    if (name === 'PasswordException') return 'UNSUPPORTED'
    if (name === 'InvalidPDFException' || name === 'FormatError') return 'INVALID'
  }
  return 'EXECUTION_FAILED'
}

function createBudget(options: PdfTextExtractionOptions, startedAt: number, startedClock: number) {
  const duration = Math.max(
    0,
    Math.min(
      DOCUMENT_TEXT_LIMITS.deadlineMs,
      options.deadlineAt === undefined
        ? DOCUMENT_TEXT_LIMITS.deadlineMs
        : options.deadlineAt - startedAt
    )
  )
  const expires = startedClock + duration
  let stopped: DocumentTextFailureCode | undefined
  let terminal: DocumentTextFailureCode | undefined
  let rejectStop!: (error: unknown) => void
  let rejectTerminal!: (error: unknown) => void
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStop = reject
  })
  const cleanupInterrupted = new Promise<never>((_resolve, reject) => {
    rejectTerminal = reject
  })
  // A stop can happen between waits; attach handlers before installing timers.
  void interrupted.catch(() => {})
  void cleanupInterrupted.catch(() => {})
  const stop = (code: DocumentTextFailureCode): void => {
    if (!stopped) {
      stopped = code
      rejectStop(code)
    }
    if (!terminal && (code === 'CANCELLED' || code === 'TIMEOUT' || code === 'INVALID')) {
      terminal = code
      rejectTerminal(code)
    }
  }
  const pollSignal = (): void => {
    try {
      if (!terminal && options.signal && validateSignal(options.signal)) stop('CANCELLED')
    } catch {
      stop('INVALID')
    }
  }
  const check = (cleanup = false): void => {
    pollSignal()
    if (!terminal && performance.now() >= expires) stop('TIMEOUT')
    const code = terminal ?? (cleanup ? undefined : stopped)
    if (code) throw code
  }
  const timer = setTimeout(
    () => {
      pollSignal()
      stop('TIMEOUT')
    },
    Math.max(0, expires - performance.now())
  )
  // Never subscribe to caller-owned signals: even native listener methods consult mutable hooks.
  const poll = options.signal ? setInterval(pollSignal, 10) : undefined
  return {
    check,
    stop,
    get code() {
      return terminal ?? stopped
    },
    async wait<T>(work: PromiseLike<T>, cleanup = false): Promise<T> {
      const pending = Promise.resolve(work)
      // Observe late rejections even when cancellation wins the race.
      void pending.catch(() => {})
      check(cleanup)
      const result = await Promise.race([pending, cleanup ? cleanupInterrupted : interrupted])
      check(cleanup)
      return result
    },
    async settleInterruptedCleanup(work: PromiseLike<unknown>): Promise<void> {
      const pending = Promise.resolve(work)
      void pending.catch(() => {})
      // Cancellation must stay responsive, but do not abandon already-started teardown
      // immediately. Never extend the original deadline; process exit remains the
      // supervisor's responsibility if this short grace cannot confirm teardown.
      const remaining = Math.max(0, Math.min(100, expires - performance.now()))
      if (!remaining) return
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, remaining)
          })
        ])
      } catch {
        // Every cleanup promise is observed by the caller; no diagnostics escape.
      } finally {
        clearTimeout(graceTimer)
      }
    },
    close(): void {
      clearTimeout(timer)
      clearInterval(poll)
    }
  }
}

/** Bytes-only text extraction, not a sandbox. The parent must still enforce a hard
 * process deadline/heap ceiling and confirm process exit after a cooperative timeout. */
export async function extractPdfText(
  input: unknown,
  jobId: unknown,
  options: PdfTextExtractionOptions = {},
  runtime?: PdfTextRuntime
): Promise<PdfExtractionOutcome> {
  const startedAt = Date.now(),
    startedClock = performance.now()
  const checked = checkDocumentTextRequest({
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId,
    format: 'pdf',
    bytes: input
  })
  if (!checked.ok) return { ok: false, code: checked.code }
  const request = checked.request
  let settings: PdfTextExtractionOptions
  try {
    settings = snapshotOptions(options)
  } catch {
    return failure(request.jobId, 'INVALID')
  }
  let budget: ReturnType<typeof createBudget>
  try {
    budget = createBudget(settings, startedAt, startedClock)
  } catch {
    return failure(request.jobId, 'INVALID')
  }
  let task: LoadingTask | undefined
  let reader: TextReader | undefined
  let readerFailure: { error: unknown } | undefined
  let result: PdfExtractionOutcome = failure(request.jobId, 'EXECUTION_FAILED')
  const denyResource = (): never => {
    // pdf.js can swallow font/resource errors. Latch a failure independently of its promise.
    budget.stop('UNSUPPORTED')
    throw new Error('PDF resource access denied')
  }
  class DeniedFactory {
    fetch = denyResource
    create = denyResource
    reset = denyResource
    addFilter = denyResource
    addHCMFilter = denyResource
    addAlphaFilter = denyResource
    addLuminosityFilter = denyResource
    addHighlightHCMFilter = denyResource
    destroy(): void {
      // These inert factories never allocate any resource.
    }
  }
  try {
    budget.check()
    if (!runtime || runtime.version !== '6.3.289' || typeof runtime.getDocument !== 'function')
      throw new Error('PDF runtime unavailable')
    task = runtime.getDocument({
      data: request.bytes,
      enableXfa: false,
      useWorkerFetch: false,
      useWasm: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
      verbosity: 0,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      maxImageSize: 0,
      enableHWA: false,
      enableWebGPU: false,
      BinaryDataFactory: DeniedFactory,
      CanvasFactory: DeniedFactory,
      FilterFactory: DeniedFactory
    })
    const loading = Promise.resolve(task.promise)
    void loading.catch(() => {})
    task.onPassword = () => budget.stop('UNSUPPORTED')
    const document = await budget.wait(loading)
    if (document.isPureXfa || (await budget.wait(document.getPermissions())) !== null) {
      budget.stop('UNSUPPORTED')
      budget.check()
    }
    // Permissions can be null for a malformed encryption dictionary with no /P.
    // Inspect only the library's encryption flag; no metadata is copied to the output.
    const { info } = await budget.wait(document.getMetadata())
    if (info === null || typeof info !== 'object') throw new Error('Invalid PDF metadata')
    const encryption = Object.getOwnPropertyDescriptor(info, 'EncryptFilterName')
    if (!encryption || !('value' in encryption)) throw new Error('Invalid PDF encryption flag')
    if (encryption.value !== null) {
      budget.stop('UNSUPPORTED')
      budget.check()
    }
    const pages = document.numPages
    if (!Number.isInteger(pages) || pages < 1) throw { name: 'InvalidPDFException' }
    if (pages > DOCUMENT_TEXT_LIMITS.pdfPages) {
      budget.stop('LIMIT')
      budget.check()
    }
    const output: Success = {
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: request.jobId,
      format: 'pdf',
      ok: true,
      segments: [],
      truncated: false,
      warnings: ['reading-order-unverified']
    }
    // Reserve the larger, truncated envelope, including all escaping, commas and locators.
    let outputBytes = Buffer.byteLength(
      JSON.stringify({
        ...output,
        truncated: true,
        warnings: ['reading-order-unverified', 'output-truncated']
      }),
      'utf8'
    )
    let items = 0
    pagesLoop: for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      budget.check()
      const page = await budget.wait(document.getPage(pageNumber))
      reader = page
        .streamTextContent({ includeMarkedContent: false, disableNormalization: false })
        .getReader()
      readerFailure = undefined
      let itemNumber = 0
      while (true) {
        budget.check()
        const chunk = await budget.wait(
          Promise.resolve(reader.read()).catch((error: unknown) => {
            readerFailure = { error }
            throw error
          })
        )
        if (chunk.done) {
          reader.releaseLock()
          reader = undefined
          break
        }
        if (!chunk.value || !Array.isArray(chunk.value.items))
          throw new Error('Invalid PDF text stream')
        items += chunk.value.items.length
        if (items > DOCUMENT_TEXT_LIMITS.pdfItems) {
          budget.stop('LIMIT')
          budget.check()
        }
        for (const item of chunk.value.items) {
          budget.check()
          const index = itemNumber++
          if (!('str' in item)) continue
          if (typeof item.str !== 'string') throw new Error('Invalid PDF text item')
          if (!item.str) continue
          if (output.segments.length === DOCUMENT_TEXT_LIMITS.segments) {
            output.truncated = true
            break pagesLoop
          }
          const segment = {
            text: item.str,
            locator: { kind: 'pdf-item' as const, page: pageNumber, item: index }
          }
          const size =
            item.str.length > DOCUMENT_TEXT_LIMITS.envelopeBytes
              ? DOCUMENT_TEXT_LIMITS.envelopeBytes + 1
              : Buffer.byteLength(JSON.stringify(segment), 'utf8') +
                (output.segments.length ? 1 : 0)
          if (outputBytes + size > DOCUMENT_TEXT_LIMITS.envelopeBytes) {
            if (!output.segments.length) {
              budget.stop('LIMIT')
              budget.check()
            }
            output.truncated = true
            break pagesLoop
          }
          output.segments.push(segment)
          outputBytes += size
        }
      }
    }
    if (output.truncated) output.warnings.push('output-truncated')
    result = output.segments.length ? output : failure(request.jobId, 'NO_TEXT')
  } catch (error) {
    result = failure(request.jobId, budget.code ?? parserFailure(error))
  } finally {
    // Start every cleanup before awaiting any: a dead cancel must not prevent destroy.
    const cleanup: Promise<void>[] = []
    let cleanupFailed = false
    const startCleanup = (call: () => void | PromiseLike<void>): void => {
      try {
        cleanup.push(
          Promise.resolve(call()).catch(() => {
            cleanupFailed = true
          })
        )
      } catch {
        cleanupFailed = true
      }
    }
    if (reader) {
      const active = reader
      startCleanup(() =>
        // pdf.js requires an Error even when policy rejection wins before the read fails.
        Promise.resolve(active.cancel(new Error('PDF text extraction stopped'))).catch(
          (error: unknown) => {
            // An errored ReadableStream repeats its stored read error on cancel; that
            // is not a second teardown failure. Distinct cancel failures still fail closed.
            if (!readerFailure || error !== readerFailure.error) throw error
          }
        )
      )
      startCleanup(() => active.releaseLock())
    }
    // LoadingTask owns its document/worker. Calling document.destroy as well would double-destroy.
    if (task) {
      const activeTask = task
      startCleanup(() => {
        activeTask.onPassword = null
      })
      startCleanup(() => activeTask.destroy())
    }
    const allCleanup = Promise.all(cleanup)
    try {
      await budget.wait(allCleanup, true)
    } catch (error) {
      await budget.settleInterruptedCleanup(allCleanup)
      if (budget.code || result.ok)
        result = failure(request.jobId, budget.code ?? parserFailure(error))
    }
    // A lifecycle failure must not be disguised as an ordinary no-text/policy/parser
    // result. Preserve the parent's controlled cancellation/timeout reason, however.
    if (cleanupFailed && budget.code !== 'CANCELLED' && budget.code !== 'TIMEOUT')
      result = failure(request.jobId, 'EXECUTION_FAILED')
    else if (budget.code) result = failure(request.jobId, budget.code)
    try {
      budget.close()
    } catch {
      result = failure(request.jobId, 'INVALID')
    }
  }
  const validated = checkDocumentTextResult(result, request.jobId, 'pdf')
  return validated.ok ? validated.result : failure(request.jobId, validated.code)
}
