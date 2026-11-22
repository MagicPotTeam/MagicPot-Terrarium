// Synthetic summary coordination only. No Electron, network, filesystem, profile or runner is started here.
// This is not an acceptance runner: integration is blocked until seed, strict mock,
// bootstrap, selector and owned-resource cleanup contracts are frozen and verified.
// Contract: run is a caller-owned unique object; steps.record(snapshot) must
// durably record observation-only stage/attempted before resolving; prepare,
// seed and verify must reject unless isolated setup, seed readback and real
// loaded member order are confirmed; send performs one explicitly authorized
// synthetic action; observe records independent outcomes; cleanup owns only
// resources obtained by this run. This helper supplies no timeout or cancellation.
// A rejected or unknown record/send must never be retried with this run.
const reservations = new WeakSet()

/** One synchronous reservation per opaque run identity, including failures and unknowns. */
export async function coordinateSyntheticLeadSummary(run, steps) {
  if (!run || (typeof run !== 'object' && typeof run !== 'function')) throw new TypeError('Run identity required')
  if (reservations.has(run)) throw new Error('Run already attempted; do not replay')
  reservations.add(run)
  if (!steps || ['record', 'prepare', 'seed', 'verify', 'send', 'observe', 'cleanup'].some(name => typeof steps[name] !== 'function')) throw new TypeError('Incomplete coordinator')
  const state = { status: 'observation-only', finalConfirmation: 'not-confirmed', stage: 'reserved', attempted: false }
  let failure, failed = false
  try {
    // The record callback must resolve only after its exclusively owned observation
    // record is persisted. A failure or unknown outcome forbids the next action.
    await steps.record({ ...state })
    state.stage = 'prepare'; await steps.record({ ...state }); await steps.prepare()
    state.stage = 'seed'; await steps.record({ ...state }); await steps.seed()
    state.stage = 'verify'; await steps.record({ ...state }); await steps.verify()
    state.stage = 'send'; state.attempted = true
    await steps.record({ ...state })
    await steps.send()
    state.stage = 'observe'; await steps.record({ ...state }); await steps.observe()
  } catch (error) { failure = error; failed = true }
  try { await steps.cleanup() } catch (error) { failure = failed ? new AggregateError([failure, error], 'Operation and cleanup failed') : error; failed = true }
  if (failed) throw failure
  return { ...state }
}
