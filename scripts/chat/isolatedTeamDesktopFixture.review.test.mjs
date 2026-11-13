// Fake Chromium IndexedDB events: no Electron, disk profile or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { seedIsolatedTeamLead } from './isolatedTeamDesktopFixture.mjs'

test('blocked lead IDB open closes a late connection without writing', async () => {
  const oldIdb = globalThis.indexedDB, oldWindow = globalThis.window, oldDocument = globalThis.document
  const events = []
  let request
  globalThis.indexedDB = { open() { request = {}; queueMicrotask(() => request.onblocked()); return request } }
  globalThis.window = { api: {} }
  globalThis.document = { querySelector: () => ({ childElementCount: 1 }) }
  const page = { async waitForFunction() { return undefined }, async evaluate(fn, arg) { return fn(arg) }, async reload() { events.push('reload') }, locator() { return {} } }
  try {
    await assert.rejects(seedIsolatedTeamLead(page, { profileId: 'isolated-image-responses', freshSyntheticProfile: true }), /blocked/i)
    request.transaction = { abort() { events.push('upgrade-aborted') } }
    request.result = { close() { events.push('closed') }, objectStoreNames: { contains: () => false }, createObjectStore() { events.push('created') }, transaction() { events.push('transaction'); throw Error('late write') } }
    request.onupgradeneeded()
    request.onsuccess()
    await Promise.resolve()
    assert.deepEqual(events, ['upgrade-aborted', 'closed'])
  } finally { globalThis.indexedDB = oldIdb; globalThis.window = oldWindow; globalThis.document = oldDocument }
})

test('lead IDB transaction request error waits for terminal abort', async () => {
  const oldIdb = globalThis.indexedDB, oldWindow = globalThis.window, oldDocument = globalThis.document
  let tx, settled = false
  globalThis.indexedDB = { open() { const request = {}; request.result = { close() { return undefined }, transaction() { tx = { error: Error('constraint'), objectStore: () => ({ keyPath: 'storageKey', add() { return undefined } }) }; queueMicrotask(() => tx.onerror?.()); return tx } }; queueMicrotask(() => request.onsuccess()); return request } }
  globalThis.window = { api: {} }
  globalThis.document = { querySelector: () => ({ childElementCount: 1 }) }
  const page = { async waitForFunction() { return undefined }, async evaluate(fn, arg) { return fn(arg) }, async reload() { return undefined }, locator() { return {} } }
  const attempt = seedIsolatedTeamLead(page, { profileId: 'isolated-image-responses', freshSyntheticProfile: true })
  void attempt.then(() => { settled = true }, () => { settled = true })
  try {
    for (let i = 0; !tx && i < 10; i++) await Promise.resolve()
    assert.ok(tx, 'fake transaction created')
    await delay(0)
    assert.equal(settled, false)
    tx.onabort()
    await assert.rejects(attempt, /constraint/i)
  } finally {
    tx?.onabort?.()
    await attempt.catch(() => undefined)
    globalThis.indexedDB = oldIdb; globalThis.window = oldWindow; globalThis.document = oldDocument
  }
})
