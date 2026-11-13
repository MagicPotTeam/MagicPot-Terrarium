import type { HtmlAppDocument } from './agentThreadHtmlHost'
import { openHtmlProcess, type IsolatedHtmlProcess } from './agentThreadHtmlProcess'
import type { AgentThreadHtmlRunLedger, HtmlRunTicket } from './agentThreadHtmlRunLedger'

/** Main-only composition. A checkpoint is data; it never authorizes this launch. */
export async function openTrackedHtmlProcess(document: HtmlAppDocument, options: Omit<Parameters<typeof openHtmlProcess>[1], 'beforeSpawn'> & {
  ledger: AgentThreadHtmlRunLedger
  ownerHash: string
  savedId?: string
}, launch = openHtmlProcess): Promise<IsolatedHtmlProcess> {
  let ticket: HtmlRunTicket | undefined, reported = false, confirmed = false
  const onClosed = (nativeConfirmed: boolean) => {
    if (reported) return
    reported = true
    let ledgerFailure = false
    if (ticket && nativeConfirmed) {
      try { options.ledger.confirmEmpty(ticket) } catch { ledgerFailure = true }
    }
    confirmed = nativeConfirmed && !ledgerFailure
    options.onClosed(confirmed)
  }
  try {
    const process = await launch(document, {
      ...(options.hidden !== undefined ? { hidden: options.hidden } : {}), signal: options.signal, assertLive: options.assertLive, onEvent: options.onEvent, onState: options.onState,
      beforeSpawn: () => {
        options.assertLive(); options.signal.throwIfAborted()
        if (ticket) throw new Error('HTML run admission already reserved.')
        ticket = options.ledger.reserve(options.ownerHash, options.savedId, options.assertLive)
      }, onClosed
    })
    // Only the fixed production launcher invokes beforeSpawn. A mistaken adapter
    // must not run the model document without a durable reservation.
    if (!ticket) { await process.close(); throw new Error('HTML launch did not commit its durable run admission.') }
    return {
      ...(process.captureState ? { captureState: () => process.captureState!() } : {}),
      update: next => process.update(next),
      close: async () => { const result = await process.close(); return { confirmed: result.confirmed && reported && confirmed } },
      get closed() { return process.closed }
    }
  } catch (error) {
    // Preflight rejection before reservation has no durable slot. Once reserved,
    // only the launcher's actual native completion/never-spawned path can clear it.
    if (ticket && !reported) onClosed(false)
    throw error
  }
}
