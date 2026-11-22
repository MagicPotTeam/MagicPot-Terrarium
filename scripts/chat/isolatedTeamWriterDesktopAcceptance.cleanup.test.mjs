import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { finalizeWriterRun } from './isolatedTeamWriterDesktopAcceptance.mjs'

const counts = () => ({ design: 0, summary: 0, channel: 0, 'scratchpad-call': 1, 'scratchpad-result': 1, error: 0 })
const never = () => new Promise(() => {})
const child = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; return true } })
const fixture = () => {
  const c = child(), report = { status: 'partial-passed' }, writes = []
  return { c, report, writes, args: { report, app: { process: () => c, close: async () => { c.exitCode = 0; c.emit('exit') } }, mock: { close: async () => {}, observations: counts }, writeLog: async () => {}, writeResult: async data => { writes.push(data) }, timeoutMs: 5 } }
}

test('normal cleanup returns receipt bound to observation-only bytes', async () => {
  const f = fixture(), result = await finalizeWriterRun(f.args), disk = JSON.parse(f.writes[0])
  assert.equal(result.status, 'partial-passed'); assert.equal(disk.status, 'observation-only'); assert.equal(disk.finalConfirmation, 'not-confirmed')
  assert.equal(result.reportReceipt.receiptId, disk.receiptId)
  assert.equal(result.reportReceipt.sha256, createHash('sha256').update(f.writes[0], 'utf8').digest('hex'))
  assert.equal(result.cleanup.processTree, 'unknown'); assert.equal(f.c.kills, 0)
})

test('post-close counters are exact, no old snapshot', async () => {
  for (const value of [{ ...counts(), 'scratchpad-call': 2 }, { ...counts(), extra: 1 }, { channel: 0 }]) {
    const f = fixture(); let closed = false, calls = 0
    f.args.mock = { close: async () => { closed = true }, observations: () => { calls++; assert.ok(closed); return value } }
    assert.equal((await finalizeWriterRun(f.args)).status, 'failed'); assert.equal(calls, 1)
  }
})

test('cleanup failures and timeouts preserve primary failure and continue', async () => {
  for (const mode of ['throw', 'hang']) {
    const f = fixture(); f.report.status = 'failed'; f.report.error = { message: 'primary' }; let log = 0, obs = 0
    f.args.app.close = mode === 'throw' ? async () => { throw Error('close') } : never
    f.args.mock = { close: mode === 'throw' ? async () => { throw Error('mock') } : never, observations: () => { obs++; return counts() } }
    f.args.writeLog = () => { log++ }
    const result = await finalizeWriterRun(f.args)
    assert.equal(result.error.message, 'primary'); assert.equal(result.status, 'failed'); assert.equal(log, 1); assert.equal(f.writes.length, 1)
    assert.equal(obs, 0); assert.equal(f.c.kills, 1); assert.equal(result.cleanup.processTree, 'unknown')
  }
})

test('observation failure or timeout and missing resources fail', async () => {
  for (const observation of [() => { throw Error('bad') }, never]) {
    const f = fixture(); f.args.mock.observations = observation
    assert.equal((await finalizeWriterRun(f.args)).status, 'failed'); assert.equal(f.writes.length, 1)
  }
  const f = fixture(); f.args.app = undefined; f.args.mock = undefined
  assert.equal((await finalizeWriterRun(f.args)).status, 'failed')
})

test('log error or timeout cannot pass and result still attempted', async () => {
  for (const writeLog of [() => { throw Error('bad') }, never]) {
    const f = fixture(); f.args.writeLog = writeLog
    assert.equal((await finalizeWriterRun(f.args)).status, 'failed'); assert.equal(f.writes.length, 1)
  }
})

test('late result after timeout never contains a passed status', async () => {
  const f = fixture(); let release, late
  const gate = new Promise(resolve => { release = resolve })
  f.args.writeResult = async data => { await gate; late = data }
  await assert.rejects(finalizeWriterRun(f.args), /WRITER_RESULT_WRITE_FAILED/)
  release(); await gate; await Promise.resolve()
  assert.equal(JSON.parse(late).status, 'observation-only'); assert.equal(JSON.parse(late).finalConfirmation, 'not-confirmed')
  assert.ok(!late.includes('partial-passed'))
})

test('partial requires app handle, owned child, mock, clean close and zero exit', async () => {
  const variants = [
    f => { f.args.app = undefined },
    f => { f.args.app.process = () => undefined },
    f => { f.args.mock = undefined },
    f => { f.args.app.close = async () => { f.c.exitCode = 0; throw Error('close failed') } },
    f => { f.args.app.close = async () => { f.c.exitCode = 1 } },
    f => { f.args.app.close = async () => { f.c.signalCode = 'SIGTERM' } },
  ]
  for (const configure of variants) {
    const f = fixture(); configure(f)
    const result = await finalizeWriterRun(f.args)
    assert.equal(result.status, 'failed'); assert.equal(result.cleanup.processTree, 'unknown')
    assert.equal(JSON.parse(f.writes[0]).status, 'observation-only')
  }
})

test('log settles before result is attempted', async () => {
  const f = fixture(), order = []
  f.args.writeLog = () => { order.push('log'); throw Error('bad') }
  f.args.writeResult = data => { order.push('result'); assert.equal(JSON.parse(data).cleanup.logWrite, 'error') }
  assert.equal((await finalizeWriterRun(f.args)).status, 'failed')
  assert.deepEqual(order, ['log', 'result'])
})

test('result error fails without retry', async () => {
  const f = fixture(); let attempts = 0
  f.args.writeResult = () => { attempts++; throw Error('private') }
  await assert.rejects(finalizeWriterRun(f.args), /WRITER_RESULT_WRITE_FAILED/); assert.equal(attempts, 1)
})
