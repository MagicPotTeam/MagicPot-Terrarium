import type { FetchImpl } from '@shared/llm/clients'

export type ProviderDispatchReceipt =
  | { state: 'not-dispatched'; charged: true; grantsPermission: false }
  | { state: 'response-complete'; status: number; responseBytes: number; charged: true; grantsPermission: false }
  | { state: 'unknown'; charged: true; grantsPermission: false }
export type ProviderDispatchFetchOptions<Ticket extends object> = {
  /** Main-selected exact endpoint, not renderer/model input. No implicit redirects. */
  endpoint: string; fetch: FetchImpl; signal: AbortSignal; assertLive(): void
  /** Synchronous durable reservation BEFORE invoking the delegate fetch. This is
   * conservative possibly-dispatched charging, never proof of network transmission. */
  reserve(): Ticket
  /** Synchronous durable receipt. EOF is transport evidence, not billing/business success. */
  settle(ticket: Ticket, receipt: ProviderDispatchReceipt): void
  timeoutMs?: number; requestBytes?: number; responseBytes?: number
}
export type ProviderDispatchFetch = {
  fetch: FetchImpl
  readonly state: 'idle' | 'active' | 'blocked' | 'disposed'
  dispose(): void
}
const failure = (message: string) => Object.assign(new Error(message), { code: 'PROVIDER_DISPATCH_ADMISSION', retryBlocked: true })
const thenable = (value: unknown) => Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function')
const limit = (value: number | undefined, fallback: number, maximum: number) => {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw failure('Invalid provider dispatch resource limit.')
  return n
}
/** Main-only transport prerequisite. Normal unmetered chat does not use it;
 * trusted user-selected capped recordkeeping does, never an autonomous runner.
 * Counts invocations of the supplied FetchImpl, not TCP/proxy/provider-internal
 * retries or billable operations. The adapter must honor redirect:error and
 * credentials:omit. Never forward callbacks/tickets/receipts to a provider.
 * One active request; unread/cancelled/failed/expired bodies block future sends.
 * Response cloning/tee are unsupported: they can prefetch an unread body or hide
 * a single-branch cancellation. The trusted adapter must not bypass own-method
 * guards with prototype calls; this is not a hostile-JavaScript sandbox.
 * No execution authority, goal counters, automatic retry or persistent recovery
 * is created here; the fixed durable adapter supplies these prerequisites. */
export function createProviderDispatchFetch<Ticket extends object>(options: ProviderDispatchFetchOptions<Ticket>): ProviderDispatchFetch {
  const endpoint = new URL(options.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || /[?#]/.test(endpoint.href) || endpoint.href.length > 4096 || endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw failure('Unsupported exact provider dispatch endpoint.')
  const timeoutMs = limit(options.timeoutMs, 120000, 300000), maxRequest = limit(options.requestBytes, 1024 * 1024, 4 * 1024 * 1024), maxResponse = limit(options.responseBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
  const tickets = new WeakSet<object>()
  let state: ProviderDispatchFetch['state'] = 'idle'
  let disposed = false, active: { abort(): void } | undefined
  const check = () => {
    const current = () => { options.signal.throwIfAborted(); if (disposed) throw failure('Provider dispatch wrapper was disposed.'); if (state === 'blocked') throw failure('Prior provider dispatch is uncertain; another send is blocked.') }
    current()
    const result: unknown = options.assertLive()
    if (thenable(result)) { void Promise.resolve(result).catch(() => undefined); throw failure('Provider dispatch live guard must complete synchronously.') }
    current() // A trusted callback can still synchronously revoke/dispose.
  }
  const fetch: FetchImpl = async (input, init) => {
    if (state === 'blocked') throw failure('Prior provider dispatch is uncertain; another send is blocked.')
    if (state !== 'idle' || disposed) throw failure('A provider dispatch is already active or disposed.')
    state = 'active' // Lock BEFORE any callback, including initial assertLive/validation.
    let url!: URL, requestBody!: string, requestSignal: AbortSignal | null | undefined, headers!: Headers
    try {
      check()
      // Reject stream/Request input before reservation: no async pre-send body reads,
      // implicit cloning, attachment setup or retry of a consumed stream body.
      const candidate = typeof input === 'string' ? new URL(input) : input instanceof URL ? new URL(input.href) : undefined
      const { method, body: suppliedBody, signal: suppliedSignal, headers: suppliedHeaders, redirect, credentials } = init ?? {}
      if (!candidate || candidate.href !== endpoint.href || method?.toUpperCase() !== 'POST' || typeof suppliedBody !== 'string' || !suppliedBody || Buffer.byteLength(suppliedBody, 'utf8') > maxRequest || redirect && redirect !== 'error' || credentials && credentials !== 'omit') throw failure('Provider dispatch requires exact-endpoint bounded JSON POST with no redirects or ambient credentials.')
      url = candidate; requestBody = suppliedBody; requestSignal = suppliedSignal
      headers = new Headers(suppliedHeaders)
      if (!/^application\/json(?:\s*;|$)/i.test(headers.get('content-type') ?? '') || headers.has('cookie') || headers.has('proxy-authorization')) throw failure('Provider dispatch requires explicit JSON headers without ambient cookies.')
      let json: unknown
      try { json = JSON.parse(requestBody) } catch { throw failure('Provider dispatch body is not valid JSON.') }
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw failure('Provider dispatch JSON must be an object.')
      check(); requestSignal?.throwIfAborted()
    } catch (error) { if (state === 'active') state = disposed ? 'disposed' : 'idle'; throw error }
    let ticket: Ticket
    try {
      ticket = options.reserve()
      if (!ticket || typeof ticket !== 'object' || thenable(ticket)) {
        if (thenable(ticket)) void Promise.resolve(ticket).catch(() => undefined)
        throw failure('Provider dispatch reservation must be a synchronous opaque capability.')
      }
      if (tickets.has(ticket)) throw failure('Provider dispatch reservation capability must be fresh for each delegate invocation.')
      tickets.add(ticket)
    } catch (error) { state = 'blocked'; throw error }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, options.signal, ...(requestSignal ? [requestSignal] : [])])
    const started = performance.now(), expires = started + timeoutMs
    let invoked = false, settled = false, bytes = 0, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    let ownedResponse: Response | undefined
    let abortReason: unknown
    const stopReader = () => { try { void reader?.cancel().catch(() => undefined) } catch { /* Preserve uncertainty. */ } }
    const finish = (receipt: ProviderDispatchReceipt) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort)
      try {
        const result: unknown = options.settle(ticket, receipt)
        if (thenable(result)) { void Promise.resolve(result).catch(() => undefined); throw failure('Provider dispatch settlement must commit synchronously.') }
      } catch { state = 'blocked'; active = undefined; throw failure('Provider dispatch receipt could not be durably confirmed; another send is blocked.') }
      active = undefined; state = receipt.state === 'unknown' ? 'blocked' : disposed ? 'disposed' : 'idle'
    }
    const markUnknown = (reason: unknown) => {
      abortReason ??= reason
      try { finish({ state: invoked ? 'unknown' : 'not-dispatched', charged: true, grantsPermission: false }) }
      catch (error) { abortReason = error }
      if (!controller.signal.aborted) controller.abort(abortReason)
      stopReader()
      if (!reader && ownedResponse) { try { void ownedResponse.body?.cancel().catch(() => undefined) } catch { /* Uncertain response retained. */ } }
      try { streamController?.error(abortReason) } catch { /* Already closed or cancelled. */ }
    }
    function onAbort() { markUnknown(signal.reason ?? failure('Provider dispatch aborted.')) }
    const deadline = () => {
      if (performance.now() >= expires) markUnknown(failure('Provider dispatch deadline expired.'))
      if (signal.aborted || abortReason !== undefined) throw abortReason ?? signal.reason
      check()
      if (performance.now() >= expires) markUnknown(failure('Provider dispatch deadline expired during live guard.'))
      if (signal.aborted || abortReason !== undefined || settled) throw abortReason ?? signal.reason ?? failure('Provider dispatch is already settled.')
    }
    active = { abort: () => markUnknown(failure('Provider dispatch disposed before confirmed response EOF.')) }
    const timer = setTimeout(() => markUnknown(failure('Provider dispatch deadline expired.')), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      deadline() // Revalidate after durable reservation and immediately before invocation.
      invoked = true
      const pending = options.fetch(url.href, { method: 'POST', body: requestBody, headers, signal, redirect: 'error', credentials: 'omit' })
      // Observe late responses even when a transport ignores AbortSignal.
      void pending.then(response => { if (settled) { try { void response.body?.cancel().catch(() => undefined) } catch { /* No success inference. */ } } }, () => undefined)
      let rejectAbort!: (reason: unknown) => void
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
      const cancelWait = () => rejectAbort(abortReason ?? signal.reason ?? failure('Provider dispatch aborted.'))
      signal.addEventListener('abort', cancelWait, { once: true })
      if (signal.aborted) cancelWait()
      let response: Response
      try { response = await Promise.race([pending, aborted]); ownedResponse = response }
      finally { signal.removeEventListener('abort', cancelWait) }
      deadline()
      if (response.redirected || response.url && new URL(response.url).href !== endpoint.href || response.status < 200 || response.status >= 300 && response.status < 400 || response.type === 'opaque' || response.type === 'opaqueredirect') {
        try { void response.body?.cancel().catch(() => undefined) } catch { /* Retain fence. */ }
        throw failure('Provider dispatch returned a redirected or unsupported response.')
      }
      if (!response.body) {
        if (![204, 205].includes(response.status)) throw failure('Provider dispatch has no observable response body EOF.')
        finish({ state: 'response-complete', status: response.status, responseBytes: 0, charged: true, grantsPermission: false })
        if (signal.aborted || abortReason !== undefined || disposed) throw abortReason ?? signal.reason ?? failure('Provider dispatch disposed during receipt settlement.')
        return response
      }
      reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        start(value) { streamController = value },
        async pull(value) {
          try {
            deadline()
            const chunk = await reader!.read()
            deadline()
            if (chunk.done) {
              finish({ state: 'response-complete', status: response.status, responseBytes: bytes, charged: true, grantsPermission: false })
              reader!.releaseLock(); value.close(); return
            }
            if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > maxResponse - bytes) throw failure('Provider dispatch response byte budget exceeded.')
            bytes += chunk.value.byteLength; value.enqueue(chunk.value)
          } catch (error) { markUnknown(error); try { value.error(abortReason ?? error) } catch { /* Already errored. */ } }
        },
        cancel(reason) { markUnknown(reason ?? failure('Provider response reader cancelled before EOF.')) }
      }, { highWaterMark: 0 }) // Never consume/clear an unobserved response ahead of its owner.
      const denySplitting = (): never => { const error = failure('Provider dispatch response cloning and tee are unsupported.'); markUnknown(error); throw error }
      Object.defineProperty(body, 'tee', { value: denySplitting })
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperties(wrapped, { clone: { value: denySplitting }, url: { value: response.url || endpoint.href }, redirected: { value: false } })
      return wrapped
    } catch (error) {
      markUnknown(error)
      throw abortReason ?? error
    }
  }
  return {
    fetch,
    get state() { return state },
    dispose() { if (disposed) return; disposed = true; if (active) active.abort(); else if (state !== 'blocked') state = 'disposed' }
  }
}
