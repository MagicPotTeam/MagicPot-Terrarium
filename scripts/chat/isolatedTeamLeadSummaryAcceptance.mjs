// Synthetic-only acceptance orchestration, NOT a standalone desktop launcher.
// Concrete isolated root/bootstrap/page/mock adapters are intentionally required:
// no default adapter can launch Electron, read a profile, or dispatch a request.
import { createHash, randomUUID } from 'node:crypto'
import { coordinateSyntheticLeadSummary } from './isolatedTeamLeadSummaryDesktop.mjs'

const attempts = new WeakSet()
async function bounded(action, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(action).then(value => ({ status: 'ok', value }), error => ({ status: 'error', error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unknown' }), timeoutMs) })
    ])
  } finally { clearTimeout(timer) }
}

/** Injected adapters MUST only operate on a newly owned isolated root and resources.
 * timeout is not cancellation; any timed-out action consumes the attempt forever.
 * The caller must arrange durable exclusive stage writes and a single-use root. */
export async function runSyntheticSummaryAcceptance(identity, adapters, timeoutMs = 5000) {
  if (!identity || typeof identity !== 'object') throw Error('Unique synthetic identity required')
  if (attempts.has(identity)) throw Error('Attempt already reserved; no replay')
  attempts.add(identity)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Invalid timeout')
  for (const key of ['record', 'prepare', 'seed', 'verify', 'send', 'observe', 'cleanup', 'writeResult']) if (typeof adapters?.[key] !== 'function') throw Error('Missing isolated adapter: ' + key)
  const state = { status: 'observation-only', finalConfirmation: 'not-confirmed', stage: 'reserved', attempted: false, processTree: 'unknown' }
  let businessError, cleanupOutcome = 'unknown'
  const call = async (name, ...args) => {
    const outcome = await bounded(() => adapters[name](...args), timeoutMs)
    if (outcome.status !== 'ok') throw Error(`${name}: ${outcome.status}; no replay`)
    return outcome.value
  }
  try {
    await coordinateSyntheticLeadSummary(identity, {
      record: async snapshot => { Object.assign(state, snapshot); await call('record', { ...state }) },
      prepare: () => call('prepare'), seed: () => call('seed'), verify: () => call('verify'),
      send: () => call('send'), observe: () => call('observe'),
      cleanup: async () => { const result = await bounded(() => adapters.cleanup(), timeoutMs); cleanupOutcome = result.status; if (result.status !== 'ok') throw Error('cleanup: ' + result.status) }
    })
  } catch (error) { businessError = error instanceof Error ? error.message : 'unknown failure' }
  // A disk result is never a pass; a later writer cannot mint a valid CLI receipt.
  const receiptId = randomUUID()
  const serialized = JSON.stringify({ ...state, status: 'observation-only', finalConfirmation: 'not-confirmed', cleanupOutcome, businessError: businessError ?? null, receiptId }, null, 2)
  const sha256 = createHash('sha256').update(serialized).digest('hex')
  const written = await bounded(() => adapters.writeResult(serialized), timeoutMs)
  if (written.status !== 'ok') throw Error('Observation write ' + written.status + '; no receipt, no replay')
  return { status: 'observation-only', receiptId, sha256, businessError, cleanupOutcome }
}
