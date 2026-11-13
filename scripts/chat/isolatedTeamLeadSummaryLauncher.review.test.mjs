// Pure package-entry guard tests; this does not execute the launcher or Electron.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertIsolatedSummaryPackage, withSyntheticDeadline, persistSummaryReceipt, sendOnceWithDurableAttempt, classifySummaryFailure, classifySummaryCleanup, classifySummaryResources, runLeadSummaryLauncher } from './isolatedTeamLeadSummaryLauncher.mjs'

test('real launcher is disabled before preflight until unknown-tree quarantine exists', async () => {
  await assert.rejects(runLeadSummaryLauncher('/not-a-run-root', '/not-a-worker'), /launcher disabled.*quarantine/i)
})

test('only the private CommonJS bootstrap is an accepted package entry', () => {
  const expected = { name: 'magicpot-isolated-image-acceptance', type: 'commonjs', main: 'bootstrap.cjs' }
  assert.doesNotThrow(() => assertIsolatedSummaryPackage(expected))
  for (const value of [
    { ...expected, main: 'out/main/index.js' },
    { ...expected, main: '../bootstrap.cjs' },
    { ...expected, main: undefined },
    { ...expected, type: 'module' },
    { ...expected, name: 'other' },
    null
  ]) assert.throws(() => assertIsolatedSummaryPackage(value))
})

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('a native click or observation error after a send attempt is explicitly unknown', () => {
  assert.equal(classifySummaryFailure(true, Error('Playwright TimeoutError')), 'observation-unknown-after-send')
  assert.equal(classifySummaryFailure('marker-outcome-unknown', Error('disk')), 'observation-unknown-marker')
  assert.equal(classifySummaryFailure(false, Error('preflight')), 'not-observed')
  assert.equal(classifySummaryFailure(false, Object.assign(Error('timeout'), { code: 'SYNTHETIC_DEADLINE' })), 'observation-unknown-deadline')
  assert.equal(classifySummaryFailure(false, Object.assign(Error('deadline'), { code: 'SYNTHETIC_DEADLINE' }), 'reserve'), 'observation-unknown-root-reservation')
  assert.equal(classifySummaryFailure(false, Error('EEXIST'), 'reserve'), 'observation-unknown-root-reservation')
})

test('late unreturned resource startup remains unknown, never not-created', () => {
  const clean = { app: 'not-created', mock: 'not-created' }
  assert.deepEqual(classifySummaryResources(false, undefined, false, undefined, clean), clean)
  assert.deepEqual(classifySummaryResources(true, undefined, true, undefined, clean), { app: 'launch-outcome-unknown', mock: 'startup-or-cleanup-unknown' })
  assert.deepEqual(classifySummaryResources(true, {}, true, {}, { app: 'ok', mock: 'ok' }), { app: 'ok', mock: 'ok' })
})

test('observed business output does not mask incomplete cleanup or provider settlement', () => {
  const stats = { received: 1, success: 1, rejected: 0, incomplete: 0, active: 0 }
  const clean = { app: 'ok', child: 'observed', mock: 'ok', processTree: 'observed', provider: stats }
  assert.equal(classifySummaryCleanup('synthetic-summary-observed', clean), 'synthetic-summary-observed')
  for (const patch of [{ app: 'unknown' }, { child: 'unknown' }, { processTree: 'unknown' }]) {
    assert.equal(classifySummaryCleanup('synthetic-summary-observed', { ...clean, ...patch }), 'synthetic-summary-observed-cleanup-unknown')
  }
  assert.equal(classifySummaryCleanup('synthetic-summary-observed', { ...clean, provider: { ...stats, received: 2 } }), 'observation-unknown-provider-settlement')
  assert.equal(classifySummaryCleanup('not-observed', { ...clean, app: 'launch-outcome-unknown' }), 'observation-unknown-cleanup-after-not-observed')
  assert.equal(classifySummaryCleanup('observation-unknown-after-send', { ...clean, app: 'launch-outcome-unknown' }), 'observation-unknown-after-send')
})

test('deadline abandons downstream work and reports unknown without replay', async () => {
  const gate = deferred(), calls = []
  const flow = async () => {
    await withSyntheticDeadline(() => gate.promise, 5, 'synthetic seed')
    calls.push('send')
  }
  await assert.rejects(flow(), /Timed out: synthetic seed.*unknown/)
  gate.resolve('late')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [])
})

test('marker deadline cannot dispatch a click when the marker completes later', async () => {
  const owner = {}, gate = deferred(), calls = []
  const attempt = sendOnceWithDurableAttempt(owner, () => withSyntheticDeadline(() => gate.promise, 5, 'synthetic marker'), async () => { calls.push('click') })
  await assert.rejects(attempt, /Timed out: synthetic marker/)
  gate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [])
  await assert.rejects(sendOnceWithDurableAttempt(owner, async () => {}, async () => { calls.push('retry') }), /no replay/)
})

test('late launch fulfillment invokes owned-handle cleanup once, not the continuation', async () => {
  const gate = deferred(), calls = [], app = { id: 'fake-app' }
  await assert.rejects(withSyntheticDeadline(() => gate.promise, 5, 'synthetic launch', value => { calls.push(value) }), /Timed out: synthetic launch/)
  gate.resolve(app)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [app])
})

test('successful report persistence records a digest of exactly the written bytes', async () => {
  const report = { attempted: true, outcome: 'synthetic-summary-observed', error: null, cleanup: { processTree: 'unknown' } }
  let written = ''
  const receipt = await persistSummaryReceipt(report, async value => { written = value }, 100)
  assert.equal(receipt.reportPersistence, 'ok')
  assert.equal(receipt.sha256, createHash('sha256').update(written).digest('hex'))
  assert.equal(JSON.parse(written).receiptId, receipt.receiptId)
  assert.equal(JSON.parse(written).attempted, true)
})

test('failed report persistence returns a structured unknown receipt with attempt and cleanup', async () => {
  const cleanup = { processTree: 'unknown', app: 'ok' }
  const report = { attempted: true, outcome: 'synthetic-summary-observed', error: null, cleanup }
  let calls = 0
  const receipt = await persistSummaryReceipt(report, async () => { calls++; throw Error('synthetic disk full') }, 100)
  assert.equal(calls, 1)
  assert.equal(receipt.status, 'observation-only')
  assert.equal(receipt.attempted, true)
  assert.equal(receipt.outcome, 'observation-unknown-report-persistence')
  assert.equal(receipt.reportPersistence, 'failed')
  assert.equal(receipt.sha256, null)
  assert.deepEqual(receipt.cleanup, cleanup)
})

test('timed out report persistence remains unknown even if the write settles late', async () => {
  const gate = deferred(); let calls = 0
  const report = { attempted: true, outcome: 'not-observed', error: 'synthetic failure', cleanup: { processTree: 'unknown' } }
  const receipt = await persistSummaryReceipt(report, () => { calls++; return gate.promise }, 5)
  assert.equal(receipt.reportPersistence, 'unknown')
  assert.equal(receipt.outcome, 'observation-unknown-report-persistence')
  assert.equal(receipt.attempted, true)
  gate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
})
