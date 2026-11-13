import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDisabledHtmlScope } from './chatPageDisabledHtmlScope.mjs'

const scope = id => ({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }, conversationId: id })
const req = (s, revision, active) => ({ ...s, lifecycleRevision: revision, active })
const setup = () => { const violations = []; const a = scope('a'), b = scope('b'); const model = createDisabledHtmlScope({ scopes: [a, b], deny: reason => { violations.push(reason) } }); return { a, b, model, violations } }

describe('fixture-only disabled HTML scope', () => {
  it('returns no token and pairs strict replay generations and distinct scopes', async () => {
    const { a, b, model } = setup()
    assert.deepEqual(await model.setAgentHtmlScope(req(a, 1, true)), {})
    assert.deepEqual(await model.setAgentHtmlScope(req(a, 1, false)), {})
    assert.deepEqual(await model.setAgentHtmlScope(req(a, 2, true)), {})
    assert.deepEqual(await model.setAgentHtmlScope(req(b, 1, true)), {})
    await model.setAgentHtmlScope(req(a, 2, false)); await model.setAgentHtmlScope(req(b, 1, false))
    model.assertRetired()
    assert.deepEqual(model.audit().entries.map(x => [x.scope, x.revision, x.activations, x.retirements]), [[0, 1, 1, 1], [0, 2, 1, 1], [1, 1, 1, 1]])
  })
  it('fails closed for wrong scopes, invalid input and additional fields even if deny returns', async () => {
    const { a, model, violations } = setup()
    for (const value of [req(scope('unknown'), 1, true), req(a, 0, true), req(a, Number.MAX_SAFE_INTEGER + 1, true), req(a, 1, 'true'), { ...req(a, 1, true), token: 'bad' }, { ...req(a, 1, true), route: { ...a.route, extra: true } }]) await assert.rejects(model.setAgentHtmlScope(value))
    assert.equal(violations.length, 6)
    assert.deepEqual(model.audit().entries, [])
  })
  it('rejects duplicate, stale, cross-scope and unmatched retirement, and checks teardown', async () => {
    const { a, b, model, violations } = setup()
    await assert.rejects(model.setAgentHtmlScope(req(a, 1, false)))
    await model.setAgentHtmlScope(req(a, 2, true))
    await assert.rejects(model.setAgentHtmlScope(req(a, 2, true)))
    await assert.rejects(model.setAgentHtmlScope(req(a, 3, true)))
    await assert.rejects(model.setAgentHtmlScope(req(b, 2, false)))
    await assert.rejects(model.setAgentHtmlScope(req(a, 1, false)))
    assert.throws(() => model.assertRetired())
    await model.setAgentHtmlScope(req(a, 2, false))
    await assert.rejects(model.setAgentHtmlScope(req(a, 1, true)))
    await assert.rejects(model.setAgentHtmlScope(req(a, 2, false)))
    model.assertRetired()
    assert.equal(violations.length, 8)
  })
  it('freezes snapshots and facade, fixes whitelist at construction, and retains external sticky denial', async () => {
    const { a, model, violations } = setup()
    a.conversationId = 'mutated'
    await assert.rejects(model.setAgentHtmlScope(req(a, 1, true)))
    const original = scope('a')
    await model.setAgentHtmlScope(req(original, 3, true))
    const snapshot = model.audit()
    assert.throws(() => { snapshot.entries[0].activations = 99 }, TypeError)
    assert.throws(() => { snapshot.active.push({}) }, TypeError)
    assert.throws(() => { model.execute = () => {} }, TypeError)
    assert.equal(model.execute, undefined)
    await model.setAgentHtmlScope(req(original, 3, false))
    assert.equal(snapshot.active.length, 1)
    assert.equal(model.audit().entries[0].activations, 1)
    assert.equal(violations.length, 1)
    model.assertRetired()
  })
  it('propagates throwing denier after it records the violation', async () => {
    const violations = []
    const model = createDisabledHtmlScope({ scopes: [scope('a')], deny: reason => { violations.push(reason); throw Error('sticky deny') } })
    await assert.rejects(model.setAgentHtmlScope(req(scope('b'), 1, true)), /sticky deny/)
    assert.deepEqual(violations, ['disabledHtmlScope:unknown-scope'])
  })
})
