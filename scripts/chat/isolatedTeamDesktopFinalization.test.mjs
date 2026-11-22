import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { finalizeTeamMembersRun } from './isolatedTeamDesktopFinalization.mjs'

const never = () => new Promise(() => {})
const child = () => Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; return true } })
const fixture = () => {
  const c = child(), report = { status: 'partial-passed', stage: 'two-ui-members-visible-and-in-session-store' }, writes = [], order = []
  const args = {
    report,
    app: { process: () => c, close: async () => { order.push('app-close'); c.exitCode = 0; c.emit('exit') } },
    mock: { observations: () => { order.push('observe'); return [] }, close: async () => { order.push('mock-close') } },
    writeLog: async () => { order.push('log') },
    writeResult: async bytes => { order.push('result'); writes.push(bytes) },
    timeoutMs: 10
  }
  return { c, report, writes, order, args }
}

test('normal close observes app exit and provides only provisional receipt-bound evidence', async () => {
  const f = fixture(), result = await finalizeTeamMembersRun(f.args)
  const disk = JSON.parse(f.writes[0])
  assert.deepEqual(f.order, ['app-close', 'observe', 'mock-close', 'log', 'result'])
  // The existing mock erases observations at close, so the closing window is
  // unknowable; normal cleanup cannot establish a whole-run zero-request pass.
  assert.equal(result.status, 'failed')
  assert.equal(result.cleanup.child, 'observed'); assert.equal(result.cleanup.processTree, 'unknown')
  assert.equal(result.cleanup.postCloseObservations, 'unavailable')
  assert.equal(result.cleanup.providerClosingWindow, 'unknown')
  assert.equal(disk.status, 'observation-only'); assert.equal(disk.finalConfirmation, 'not-confirmed')
  assert.equal(result.reportReceipt.receiptId, disk.receiptId)
  assert.equal(result.reportReceipt.sha256, createHash('sha256').update(f.writes[0], 'utf8').digest('hex'))
  assert.equal(f.c.kills, 0)
})

test('every purported success status fails closed while the provider closing window is unknown', async () => {
  for (const status of ['passed', 'partial-passed', 'success', 'ok', 'running', undefined]) {
    const f = fixture(); f.report.status = status
    const result = await finalizeTeamMembersRun(f.args)
    assert.equal(result.status, 'failed')
    assert.equal(JSON.parse(f.writes[0]).businessStatus, status ?? 'unknown')
  }
})

test('preserves a normalized first Error and business status in the observation', async () => {
  const f = fixture(); f.report.status = 'failed'; f.report.error = new Error('synthetic failure')
  const result = await finalizeTeamMembersRun(f.args)
  const disk = JSON.parse(f.writes[0])
  assert.equal(result.status, 'failed')
  assert.equal(disk.status, 'observation-only'); assert.equal(disk.businessStatus, 'failed')
  assert.deepEqual(disk.businessError, { name: 'Error', message: 'synthetic failure' })
})

test('a result writer must return a promise completion, not a synchronous stream flag', async () => {
  const f = fixture(); f.args.writeResult = () => true
  await assert.rejects(finalizeTeamMembersRun(f.args), /TEAM_MEMBERS_RESULT_WRITE_FAILED/)
})

test('a failed result write preserves the first business error on rejection', async () => {
  const f = fixture(); f.report.status = 'failed'; f.report.error = new Error('first error')
  f.args.writeResult = async () => { throw Error('write failed') }
  await assert.rejects(finalizeTeamMembersRun(f.args), error => {
    assert.equal(error.message, 'TEAM_MEMBERS_RESULT_WRITE_FAILED')
    assert.equal(error.businessStatus, 'failed')
    assert.deepEqual(error.businessError, { name: 'Error', message: 'first error' })
    assert.equal(error.writeOutcome, 'error')
    return true
  })
})

test('a stale input receipt cannot appear in the evidence snapshot', async () => {
  const f = fixture()
  f.report.reportReceipt = { receiptId: 'STALE', sha256: 'stale' }
  const result = await finalizeTeamMembersRun(f.args)
  const disk = JSON.parse(f.writes[0])
  assert.equal(disk.reportReceipt, undefined)
  assert.notEqual(result.reportReceipt.receiptId, 'STALE')
  assert.equal(result.reportReceipt.sha256, createHash('sha256').update(f.writes[0], 'utf8').digest('hex'))
})

test('hanging app and mock cleanup preserve original failure and still attempt log and result', async () => {
  const f = fixture(); f.report.status = 'failed'; f.report.error = { message: 'original' }
  f.args.app.close = never; f.args.mock.close = never
  const result = await finalizeTeamMembersRun(f.args)
  assert.equal(result.status, 'failed'); assert.equal(result.error.message, 'original')
  assert.equal(result.cleanup.appClose, 'timeout'); assert.equal(result.cleanup.child, 'unknown')
  assert.equal(result.cleanup.mockClose, 'timeout'); assert.equal(result.cleanup.processTree, 'unknown')
  assert.equal(f.c.kills, 1); assert.equal(f.writes.length, 1)
  assert.deepEqual(f.order.slice(-2), ['log', 'result'])
})

test('missing or unsuccessful cleanup cannot return partial success', async () => {
  for (const configure of [
    f => { f.args.app = undefined },
    f => { f.args.app.process = () => undefined },
    f => { f.args.mock = undefined },
    f => { f.args.app.close = async () => { f.c.exitCode = 0; throw Error('failed close') } },
    f => { f.args.app.close = async () => { f.c.exitCode = 1 } },
    f => { f.args.app.close = async () => { f.c.signalCode = 'SIGTERM' } },
    f => { f.args.mock.close = async () => { throw Error('failed close') } },
    f => { f.args.mock.observations = () => [{ bytes: 1 }] },
    f => { f.args.mock.observations = never },
    f => { f.args.writeLog = never }
  ]) {
    const f = fixture(); configure(f)
    const result = await finalizeTeamMembersRun(f.args)
    assert.equal(result.status, 'failed')
    assert.equal(JSON.parse(f.writes[0]).status, 'observation-only')
    assert.equal(result.cleanup.processTree, 'unknown')
  }
})

test('result timeout cannot later produce a passed file or a success receipt', async () => {
  const f = fixture(); let release, late
  const gate = new Promise(resolve => { release = resolve })
  f.args.writeResult = async bytes => { await gate; late = bytes }
  try {
    await assert.rejects(finalizeTeamMembersRun(f.args), /TEAM_MEMBERS_RESULT_WRITE_FAILED/)
  } finally { release(); await gate; await Promise.resolve() }
  assert.equal(JSON.parse(late).status, 'observation-only')
  assert.equal(JSON.parse(late).finalConfirmation, 'not-confirmed')
  assert.equal(JSON.parse(late).businessStatus, 'partial-passed')
  assert.equal(JSON.parse(late).receiptId.length > 0, true)
})

test('close-time observations stay unknown when the mock clears them', async () => {
  const f = fixture(); const observations = []
  f.args.mock = {
    observations: () => observations.slice(),
    close: async () => { observations.push({ bytes: 1 }); observations.length = 0 }
  }
  const result = await finalizeTeamMembersRun(f.args)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.provider, [])
  assert.equal(result.cleanup.providerClosingWindow, 'unknown')
  assert.equal(result.cleanup.postCloseObservations, 'unavailable')
})
