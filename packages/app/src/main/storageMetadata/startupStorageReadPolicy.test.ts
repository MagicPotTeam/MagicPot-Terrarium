import { describe, expect, it, vi } from 'vitest'
import { evaluatePolicy, POLICY_REQUEST_DISCRIMINATOR, POLICY_REQUEST_VERSION, type PolicyRequest } from '@shared/magicAgentPlatform2/policy'
import { evaluateStartupStorageReadPolicy } from './startupStorageReadPolicy'

const fixture = (): PolicyRequest => ({
  discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION,
  requestId: 'startup-storage-read:test-1', actor: { kind: 'service', id: 'main-management-startup-storage-reader' },
  origin: 'renderer', action: 'management.startup-storage-metadata.read', transport: 'electron-ipc',
  target: { kind: 'startup-storage-metadata', id: 'main-startup-storage-snapshot' }, input: {}, effects: []
})
const denied = (input: unknown) => expect(evaluateStartupStorageReadPolicy(input, 123)?.effect ?? 'deny').toBe('deny')

describe('independent pure in-memory scalar read policy, not filesystem classification or catalog grant', () => {
  it('allows only its exact MAIN-built tuple via an explicit specific zero-external-effect rule with narrow bounds', () => {
    const request = fixture(), before = structuredClone(request), decision = evaluateStartupStorageReadPolicy(request, 123)
    expect(decision).toMatchObject({ effect: 'allow-with-constraints', evaluatedAt: 123, policyVersion: 'management-startup-storage-read/v1', matchedRuleIds: ['management-startup-storage-read-exact'], constraints: { readOnly: true, requireNoShell: true, maxTimeoutMs: 2000, maxOutputChars: 256 } })
    expect(decision?.approvalRequirement).toBeUndefined(); expect(decision?.audit).toMatchObject({ actor: request.actor, action: request.action, target: request.target, effects: [] })
    expect(request).toEqual(before)
  })
  it('does not weaken generic zero-effect deny or add a new standard effect kind for this endpoint', () => {
    expect(evaluatePolicy(fixture(), [], { evaluatedAt: 123, policyVersion: 'classification-only' })).toMatchObject({ effect: 'deny', reasonCode: 'no-effects' })
    expect(evaluateStartupStorageReadPolicy(fixture(), 123)?.effect).toBe('allow-with-constraints')
  })
  it.each(['actor-kind', 'actor-id', 'origin', 'action', 'target-kind', 'target-id', 'transport', 'actor-space', 'action-space', 'filesystem', 'database', 'network', 'credential', 'unknown-memory', 'catalog'] as const)('uses catch-all deny for wrong %s, not any generic read entitlement', field => {
    const input = fixture()
    if (field === 'actor-kind') input.actor.kind = 'user'
    if (field === 'actor-id') input.actor.id += '-other'
    if (field === 'origin') input.origin = 'assistant'
    if (field === 'action') input.action = 'files.read'
    if (field === 'target-kind') input.target.kind = 'file'
    if (field === 'target-id') input.target.id = '/private/path'
    if (field === 'transport') input.transport = 'http'
    if (field === 'actor-space') input.actor.id += ' '
    if (field === 'action-space') input.action += ' '
    if (field === 'filesystem') input.effects = [{ kind: 'filesystem.read', risk: 'read' }]
    if (field === 'database') input.effects = [{ kind: 'database.read', risk: 'read' }]
    if (field === 'network') input.effects = [{ kind: 'network.read', risk: 'read' }]
    if (field === 'credential') input.effects = [{ kind: 'credential.read', risk: 'high' }]
    if (field === 'unknown-memory') input.effects = [{ kind: 'memory.read', risk: 'read' }]
    if (field === 'catalog') { input.action = 'management.installed-catalog.read'; input.actor.id = 'main-management-installed-catalog-reader'; input.target = { kind: 'installed-package-catalog', id: 'main-user-data-installed-packages' }; input.effects = [{ kind: 'filesystem.read', risk: 'read', target: 'main-user-data-installed-packages' }] }
    denied(input)
  })
  it.each(['path', 'actor', 'policy', 'route', 'filesystem', 'allowedToolNames', 'metadata', 'confirmation', 'target', 'input', 'undefined', 'nonenumerable'] as const)('rejects extra %s claims before parser normalization', field => {
    const input = fixture()
    if (field === 'actor') input.actor.displayName = 'trusted user'
    else if (field === 'target') input.target.source = '/private'
    else if (field === 'input') input.input = { path: '/private', actor: 'user' }
    else if (field === 'nonenumerable') Object.defineProperty(input, 'hidden', { value: true })
    else Object.assign(input, { [field]: field === 'undefined' ? undefined : { approval: true } })
    denied(input); denied({ ...input, decision: { effect: 'allow' } })
  })
  it.each([null, undefined, [], true, 'allow', {}, { ...fixture(), effects: null }, { ...fixture(), actor: null }, { ...fixture(), input: [] }, { ...fixture(), version: 2 }, { ...fixture(), requestId: 'installed-catalog-read:test' }, { ...fixture(), requestId: 'startup-storage-read:' + 'x'.repeat(200) }])('fails closed for malformed input %#', denied)
  it('rejects proxies/accessors/cycles/sparse or expanded arrays without invoking getters or traps', () => {
    const trap = vi.fn(() => { throw new Error('do not inspect') }), input = fixture(), cycle = { ...input }; cycle.input = { self: cycle as unknown as string }
    const revoked = Proxy.revocable(input, {}); revoked.revoke()
    for (const value of [Object.defineProperty({ ...input }, 'action', { get: trap, enumerable: true }), { ...input, actor: Object.defineProperty({}, 'kind', { get: trap, enumerable: true }) }, new Proxy(input, { getPrototypeOf: trap, ownKeys: trap, get: trap }), revoked.proxy, cycle, { ...input, effects: new Array(1) }, { ...input, effects: Object.assign([], { extra: true }) }, { ...input, actor: { ...input.actor, id: 'x'.repeat(10000) } }]) denied(value)
    expect(trap).not.toHaveBeenCalled()
  })
  it.each([NaN, Infinity, -1, 0.5])('does not read implicit time or accept invalid evaluation timestamp %s', time => {
    expect(evaluateStartupStorageReadPolicy(fixture(), time)).toBeNull()
  })
  it('is deterministic, deeply immutable and binds the exact request digest independently of catalog decisions', () => {
    const first = evaluateStartupStorageReadPolicy(fixture(), 123), second = evaluateStartupStorageReadPolicy(fixture(), 123)
    expect(first).not.toBeNull(); expect(second).toEqual(first); expect(second).not.toBe(first)
    if (!first) throw new Error('Expected exact memory projection policy decision')
    expect(Object.isFrozen(first)).toBe(true); expect(() => first.matchedRuleIds.push('forged')).toThrow()
    expect(() => { first.constraints!.maxOutputChars = 131072 }).toThrow()
    const other = fixture(); other.requestId = 'startup-storage-read:test-2'
    expect(evaluateStartupStorageReadPolicy(other, 124)?.requestDigest).not.toBe(first.requestDigest)
    expect(evaluateStartupStorageReadPolicy(fixture(), 123)).toEqual(first)
  })
})
