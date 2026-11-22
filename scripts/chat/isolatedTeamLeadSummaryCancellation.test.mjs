// Synthetic abort contract; these fake pages are never Electron or real IDB.
// An AbortSignal stops later Node-side stages only. It cannot revoke a running
// renderer evaluate, IDB open/transaction, localStorage write, or click.
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { seedIsolatedTeamLead } from './isolatedTeamDesktopFixture.mjs'
import { seedSummaryOnIsolatedPage, addOnlySyntheticSummaryRows } from './isolatedTeamLeadSummaryPage.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

test('lead seed aborted while evaluating does not schedule a later reload', async () => {
  const controller = new AbortController(), gate = deferred(), entered = deferred(), events = []
  const page = {
    async waitForFunction() { events.push('pane') },
    async evaluate() { events.push('write'); entered.resolve(); await gate.promise; events.push('write-finished') },
    async reload() { events.push('reload') },
    locator() { return {} }
  }
  const attempt = seedIsolatedTeamLead(page, { profileId: 'isolated-image-responses', freshSyntheticProfile: true, signal: controller.signal })
  void attempt.catch(() => undefined)
  try {
    await Promise.race([entered.promise, attempt.then(() => { throw Error('seed settled before expected gate') }), delay(1000).then(() => { throw Error('seed gate not reached') })])
    controller.abort()
    gate.resolve()
    await assert.rejects(attempt, /aborted/i)
    assert.deepEqual(events, ['pane', 'write', 'write-finished'])
  } finally { controller.abort(); gate.resolve(); await attempt.catch(() => undefined) }
})

test('member seed aborted while its fake write is pending does not read or reload', async () => {
  const events = [], gate = deferred(), entered = deferred(), controller = new AbortController()
  let holdWrite = false
  const page = {
    async waitForFunction() { events.push('pane') },
    async evaluate(fn) {
      if (holdWrite && fn === addOnlySyntheticSummaryRows) { events.push('write'); entered.resolve(); await gate.promise; events.push('write-finished') }
      else events.push('evaluate')
    },
    async reload() { events.push('reload') },
    locator() { return {} }
  }
  const identity = await seedIsolatedTeamLead(page, { profileId: 'isolated-image-responses', freshSyntheticProfile: true })
  events.length = 0; holdWrite = true
  const members = [randomUUID(), randomUUID()].map(id => `isolated-summary-member-${id}`)
  const attempt = seedSummaryOnIsolatedPage(page, identity, members, { signal: controller.signal })
  void attempt.catch(() => undefined)
  try {
    await Promise.race([entered.promise, attempt.then(() => { throw Error('seed settled before expected gate') }), delay(1000).then(() => { throw Error('seed gate not reached') })])
    controller.abort()
    gate.resolve()
    await assert.rejects(attempt, /aborted/i)
    assert.deepEqual(events, ['pane', 'write', 'write-finished'])
  } finally { controller.abort(); gate.resolve(); await attempt.catch(() => undefined) }
})
