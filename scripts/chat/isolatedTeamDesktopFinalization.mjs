import { createHash, randomUUID } from 'node:crypto'

// Bounds asynchronous waiting, not synchronous blocking or the underlying operation.
// Late results remain possible. Callbacks must return promptly and must not block
// the event loop; the caller must use a unique, exclusively created run path.
async function bounded(action, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(action).then(value => ({ status: 'ok', value }), () => ({ status: 'error' })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs) })
    ])
  } finally { clearTimeout(timer) }
}

/**
 * Cleanup candidate for the synthetic two-member runner. The shared mock clears
 * observations when closed, so this cannot establish an exact whole-run zero
 * request count: a provisional run is downgraded even after normal cleanup.
 * Passing the direct child exit check is not proof of process-tree cleanup.
 *
 * The result writer must promptly return a Promise that fulfills only when its
 * exclusively-created target has been written. A resolved Promise is a caller
 * assertion, not an independent fsync, read-back or path-integrity proof.
 */
export async function finalizeTeamMembersRun({ report, app, mock, writeLog, writeResult, timeoutMs = 5000 }) {
  const businessStatus = typeof report.status === 'string' ? report.status : 'unknown'
  const error = report.error
  const businessError = error instanceof Error
    ? { name: error.name, message: error.message }
    : error && typeof error === 'object' && typeof error.message === 'string'
      ? { name: typeof error.name === 'string' ? error.name : 'Error', message: error.message }
      : typeof error === 'string' ? { name: 'Error', message: error } : null
  const cleanup = { processTree: 'unknown', providerClosingWindow: 'unknown', postCloseObservations: 'unavailable' }
  let child
  if (app) {
    try { child = app.process() } catch { cleanup.child = 'unknown' }
    const closed = await bounded(() => app.close(), timeoutMs)
    cleanup.appClose = closed.status
    if (closed.status !== 'ok') report.status = 'failed'
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        let onExit
        const exited = await bounded(() => new Promise(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve()
          onExit = resolve
          child.once('exit', onExit)
        }), timeoutMs)
        if (onExit) child.removeListener('exit', onExit)
        cleanup.child = exited.status === 'ok' ? 'observed' : 'unknown'
        if (cleanup.child === 'unknown' && child.exitCode === null && child.signalCode === null) {
          try { cleanup.killRequested = child.kill() === true } catch { cleanup.killRequested = false }
        }
      } else cleanup.child = 'observed'
      cleanup.pid = child.pid ?? null
      cleanup.exitCode = child.exitCode
      cleanup.signalCode = child.signalCode
      if (cleanup.child !== 'observed' || child.exitCode !== 0 || child.signalCode !== null || cleanup.killRequested !== undefined) report.status = 'failed'
    } else { cleanup.child = 'unknown'; report.status = 'failed' }
  } else { cleanup.child = 'unknown'; report.status = 'failed' }

  if (mock) {
    const observations = await bounded(() => mock.observations(), timeoutMs)
    cleanup.preCloseObservations = observations.status
    if (observations.status === 'ok') {
      report.provider = observations.value
      if (!Array.isArray(observations.value) || observations.value.length !== 0) report.status = 'failed'
    } else report.status = 'failed'
    const closed = await bounded(() => mock.close(), timeoutMs)
    cleanup.mockClose = closed.status
    if (closed.status !== 'ok') report.status = 'failed'
  } else report.status = 'failed'

  // Even a successful close clears the only observation store; do not certify
  // the zero-request requirement for a potentially late in-flight request.
  report.status = 'failed'
  const log = await bounded(writeLog, timeoutMs)
  cleanup.logWrite = log.status
  if (log.status !== 'ok') report.status = 'failed'
  report.cleanup = cleanup
  const receiptId = randomUUID()
  const observation = { ...report }
  delete observation.reportReceipt
  delete observation.error
  const serialized = JSON.stringify({ ...observation, businessStatus, businessError, status: 'observation-only', finalConfirmation: 'not-confirmed', receiptId }, null, 2)
  const sha256 = createHash('sha256').update(serialized, 'utf8').digest('hex')
  const written = await bounded(() => {
    const completion = writeResult(serialized)
    if (!completion || typeof completion.then !== 'function') throw new TypeError('Result writer must return a completion promise')
    return completion
  }, timeoutMs)
  if (written.status !== 'ok') {
    const failure = new Error('TEAM_MEMBERS_RESULT_WRITE_FAILED')
    failure.businessStatus = businessStatus
    failure.businessError = businessError
    failure.writeOutcome = written.status
    failure.cleanup = cleanup
    throw failure
  }
  return { ...report, reportReceipt: { receiptId, sha256 } }
}
