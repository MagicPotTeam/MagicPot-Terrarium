import test from 'node:test'
import assert from 'node:assert/strict'
import { seedIsolatedTeamLead, sendIsolatedWriter, approveIsolatedWriter } from './isolatedTeamDesktopFixture.mjs'

// All browser, storage, service and UI operations are fakes; no Electron or I/O.
async function setup({ pendingChanges = [], clickError = false, cardRejected = false } = {}) {
  let identity, checks = 0, clicks = 0
  const expected = { approvalId: 'approval-1', revision: 4, writerId: 'writer-1' }
  const button = { count: async () => 1, click: async () => { clicks++; if (clickError) throw new Error('unknown click outcome') } }
  const locator = {
    waitFor: async () => {}, fill: async () => {}, count: async () => 1,
    filter() { return this }, locator() { return this }, getByRole() { return button },
    getAttribute: async key => key === 'data-approval-id' ? (cardRejected ? 'other-card' : expected.approvalId) : String(expected.revision),
    click: async () => {}
  }
  const page = {
    waitForFunction: async () => {}, reload: async () => {}, locator: () => locator,
    getByText: () => locator,
    evaluate: async fn => {
      const source = String(fn)
      if (source.includes('listPendingApprovals')) {
        const current = pendingChanges[checks++] ?? expected
        return { approvals: [{ approvalId: current.approvalId, revision: current.revision, request: { request: {
          route: { channel: 'canvas', scopeType: 'thread', scopeId: identity.projectId, threadId: 'agent-1' },
          sessionId: 'writer-1', action: 'memory.note.write', target: { kind: 'tool', id: 'scratchpad' },
          input: { conversationId: 'writer-1', action: 'set', key: 'fixture', value: 'approved-value', expectedRevision: 0 }
        } } }] }
      }
      if (source.includes('getAgentNotes')) return { revision: 0, notes: [] }
      if (source.includes('getAll()')) return [
        { id: 'designer-1', name: '设计师', messageCount: 0 },
        { id: 'writer-1', name: '文案', messageCount: 0 }
      ]
      return undefined
    }
  }
  identity = await seedIsolatedTeamLead(page, { profileId: 'synthetic', freshSyntheticProfile: true })
  await sendIsolatedWriter(page, identity)
  return { page, identity, expected, clicks: () => clicks }
}

test('expected is mandatory and mismatched fields never click', async () => {
  for (const change of [undefined, { approvalId: 'wrong' }, { revision: 5 }, { writerId: 'wrong' }]) {
    const f = await setup()
    const expected = change === undefined ? undefined : { ...f.expected, ...change }
    await assert.rejects(approveIsolatedWriter(f.page, f.identity, expected))
    assert.equal(f.clicks(), 0)
  }
})

test('second MAIN observation changing id or revision never clicks', async () => {
  for (const changed of [{ approvalId: 'other', revision: 4, writerId: 'writer-1' }, { approvalId: 'approval-1', revision: 5, writerId: 'writer-1' }]) {
    const f = await setup({ pendingChanges: [undefined, changed] })
    await assert.rejects(approveIsolatedWriter(f.page, f.identity, f.expected))
    assert.equal(f.clicks(), 0)
  }
})

test('success and concurrent calls reserve once', async () => {
  const f = await setup()
  const results = await Promise.allSettled([approveIsolatedWriter(f.page, f.identity, f.expected), approveIsolatedWriter(f.page, f.identity, f.expected)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal(f.clicks(), 1)
})

test('invalid card is rejected without click', async () => {
  const f = await setup({ cardRejected: true })
  await assert.rejects(approveIsolatedWriter(f.page, f.identity, f.expected))
  assert.equal(f.clicks(), 0)
})

test('unknown click outcome is not retried', async () => {
  const f = await setup({ clickError: true })
  await assert.rejects(approveIsolatedWriter(f.page, f.identity, f.expected))
  await assert.rejects(approveIsolatedWriter(f.page, f.identity, f.expected))
  assert.equal(f.clicks(), 1)
})

test('expected is snapshotted before asynchronous inspection', async () => {
  const f = await setup()
  const expected = { ...f.expected }
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const evaluate = f.page.evaluate
  let gated = false
  f.page.evaluate = async (fn, ...args) => {
    if (!gated && String(fn).includes('listPendingApprovals')) {
      gated = true
      entered()
      await gate
    }
    return evaluate(fn, ...args)
  }
  const rootLocator = f.page.locator
  const selectors = []
  f.page.locator = (...args) => {
    const locator = rootLocator(...args)
    if (!locator.recordingInstalled) {
      const nested = locator.locator
      locator.locator = function (selector) { selectors.push(selector); return nested.call(this, selector) }
      locator.recordingInstalled = true
    }
    return locator
  }
  let result
  try {
    const attempt = approveIsolatedWriter(f.page, f.identity, expected)
    await started
    Object.assign(expected, { approvalId: 'changed', revision: 9, writerId: 'other' })
    release()
    result = await attempt
  } finally { release() }
  assert.equal(result.approvalId, f.expected.approvalId)
  assert.equal(result.revision, f.expected.revision)
  assert.equal(result.writerId, f.expected.writerId)
  assert(selectors.includes('[data-approval-id="approval-1"][data-approval-revision="4"]'))
  assert.equal(f.clicks(), 1)
})

test('second MAIN inspection with changed writer rejects without clicking', async () => {
  const f = await setup()
  const evaluate = f.page.evaluate
  let memberReads = 0, pendingReads = 0
  f.page.evaluate = async (fn, ...args) => {
    const source = String(fn)
    if (source.includes('getAll()')) {
      memberReads++
      const members = await evaluate(fn, ...args)
      return memberReads === 2 ? members.map(member => member.name === '文案' ? { ...member, id: 'writer-2' } : member) : members
    }
    if (source.includes('listPendingApprovals')) {
      pendingReads++
      const response = await evaluate(fn, ...args)
      if (pendingReads === 2) {
        const request = response.approvals[0].request.request
        request.sessionId = 'writer-2'
        request.input.conversationId = 'writer-2'
      }
      return response
    }
    return evaluate(fn, ...args)
  }
  await assert.rejects(approveIsolatedWriter(f.page, f.identity, f.expected), /Pending approval changed before click/)
  assert.equal(memberReads, 2)
  assert.equal(pendingReads, 2)
  assert.equal(f.clicks(), 0)
})
