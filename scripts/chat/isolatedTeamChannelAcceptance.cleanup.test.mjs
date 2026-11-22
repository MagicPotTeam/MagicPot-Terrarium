import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { finalizeChannelRun } from './isolatedTeamChannelAcceptance.mjs'

const never = () => new Promise(() => {})
const fakeChild = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; return true } })

test('cleanup failures and hanging app do not hide original failure or skip mock and report', async () => {
  const child = fakeChild(), report = { status: 'failed', error: 'primary' }, writes = []
  let observations = 0, closes = 0
  await finalizeChannelRun({ report, app: { process: () => child, close: never }, mock: { observations: () => { observations++; throw Error('secret') }, close: () => { closes++; return never() } }, writeResult: data => { writes.push(JSON.parse(data)) }, timeoutMs: 5 })
  assert.equal(report.error, 'primary')
  assert.equal(report.cleanup.appClose, 'timeout')
  assert.equal(report.cleanup.child, 'unknown')
  assert.equal(report.cleanup.processTree, 'unknown')
  assert.equal(child.kills, 1)
  assert.equal(observations, 0); assert.equal(closes, 1); assert.equal(writes.length, 1)
  assert.equal(report.cleanup.mockObservations, undefined); assert.equal(report.cleanup.mockClose, 'timeout')
  assert.equal(report.status, 'failed')
})

test('normal observed owned exit preserves partial status; no tree success claim', async () => {
  const child = fakeChild(), report = { status: 'partial-passed' }
  const app = { process: () => child, close: async () => { child.exitCode = 0; child.emit('exit', 0) } }
  let written
  const outcome = await finalizeChannelRun({ report, app, mock: { observations: () => ({ design: 0, summary: 0, channel: 1, 'scratchpad-call': 0, 'scratchpad-result': 0, error: 0 }), close: async () => {} }, writeResult: data => { written = JSON.parse(data); assert.equal(createHash('sha256').update(data).digest('hex').length, 64) }, timeoutMs: 10 })
  assert.equal(child.kills, 0); assert.equal(written.status, 'observation-only')
  assert.equal(outcome.status, 'partial-passed'); assert.equal(outcome.reportReceipt.receiptId, written.receiptId)
  assert.equal(outcome.reportReceipt.sha256, createHash('sha256').update(JSON.stringify(written, null, 2)).digest('hex'))
  assert.equal(written.cleanup.child, 'observed'); assert.equal(written.cleanup.processTree, 'unknown')
})

test('missing resources and failed result write fail without retry', async () => {
  let writes = 0
  await assert.rejects(finalizeChannelRun({ report: { status: 'failed', error: 'setup failed' }, writeResult: () => { writes++; throw Error('private path') }, timeoutMs: 5 }), /CHANNEL_RESULT_WRITE_FAILED/)
  assert.equal(writes, 1)
})

test('late write after timeout remains observation only and cannot return success', async () => {
  let release, late
  const gate = new Promise(resolve => { release = resolve })
  const pending = finalizeChannelRun({ report: { status: 'partial-passed' }, mock: { close: async () => {}, observations: () => ({ design: 0, summary: 0, channel: 1, 'scratchpad-call': 0, 'scratchpad-result': 0, error: 0 }) }, writeResult: async data => { await gate; late = JSON.parse(data) }, timeoutMs: 5 })
  await assert.rejects(pending, /CHANNEL_RESULT_WRITE_FAILED/)
  release(); await gate; await Promise.resolve()
  assert.equal(late.status, 'observation-only')
  assert.equal(late.finalConfirmation, 'not-confirmed')
  assert.ok(!JSON.stringify(late).includes('partial-passed'))
})

test('post-close counts must have exact keys and values', async () => {
  const expected = { design: 0, summary: 0, channel: 1, 'scratchpad-call': 0, 'scratchpad-result': 0, error: 0 }
  for (const changed of [{ ...expected, channel: 2 }, { ...expected, unexpected: 1 }, { channel: 1 }]) {
    let current = expected, calls = 0
    const report = { status: 'partial-passed' }
    const result = await finalizeChannelRun({ report, mock: { close: async () => { current = changed }, observations: () => { calls++; return current } }, writeResult: () => {}, timeoutMs: 10 })
    assert.equal(calls, 1); assert.equal(result.status, 'failed')
  }
})

test('hanging observations do not prevent mock close and report', async () => {
  const report = { status: 'partial-passed' }; let closed = 0, written = 0
  await finalizeChannelRun({ report, mock: { observations: never, close: () => { closed++ } }, writeResult: () => { written++ }, timeoutMs: 5 })
  assert.equal(closed, 1); assert.equal(written, 1); assert.equal(report.status, 'failed')
})
