import { describe, expect, it, vi } from 'vitest'
import { evaluatePolicy, POLICY_REQUEST_DISCRIMINATOR, POLICY_REQUEST_VERSION, type PolicyRequest } from '@shared/magicAgentPlatform2/policy'
import { evaluateInstalledCatalogReadPolicy } from './installedCatalogPolicy'

const fixture = (): PolicyRequest => ({
  discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION,
  requestId: 'installed-catalog-read:test-1', actor: { kind: 'service', id: 'main-management-installed-catalog-reader' },
  origin: 'renderer', action: 'management.installed-catalog.read', transport: 'electron-ipc',
  target: { kind: 'installed-package-catalog', id: 'main-user-data-installed-packages' }, input: {},
  effects: [{ kind: 'filesystem.read', risk: 'read', target: 'main-user-data-installed-packages' }]
})
const denied = (request: unknown): void => {
  const decision = evaluateInstalledCatalogReadPolicy(request, 123)
  expect(decision?.effect ?? 'deny').toBe('deny')
}

describe('dedicated pure installed-catalog endpoint policy, not renderer admission or durable authorization', () => {
  it('explicitly allows only the complete MAIN-built service/action/target/effect tuple with fixed readonly bounds', () => {
    const request = fixture(), before = structuredClone(request)
    const decision = evaluateInstalledCatalogReadPolicy(request, 123)
    expect(decision).toMatchObject({ effect: 'allow-with-constraints', evaluatedAt: 123, policyVersion: 'management-installed-catalog-read/v1', matchedRuleIds: ['management-installed-catalog-read-exact'], constraints: { readOnly: true, requireNoShell: true, maxTimeoutMs: 2000, maxOutputChars: 131072 } })
    expect(decision?.audit).toMatchObject({ actor: request.actor, origin: 'renderer', action: request.action, target: request.target })
    expect(decision?.approvalRequirement).toBeUndefined()
    expect(request).toEqual(before)
    expect(JSON.stringify(decision)).not.toContain('sourcePath')
  })

  it.each(['actorKind', 'actorId', 'origin', 'action', 'targetKind', 'targetId', 'effectKind', 'effectRisk', 'effectTarget', 'transport', 'emptyEffects', 'extraEffect', 'duplicateEffect', 'whitespaceActor', 'whitespaceAction', 'whitespaceEffect'] as const)('uses endpoint-local catch-all deny for wrong %s, never generic known-read fallback', field => {
    const request = fixture()
    if (field === 'actorKind') request.actor.kind = 'user'
    if (field === 'actorId') request.actor.id += '-other'
    if (field === 'origin') request.origin = 'assistant'
    if (field === 'action') request.action = 'files.read'
    if (field === 'targetKind') request.target.kind = 'file'
    if (field === 'targetId') request.target.id = '/renderer/path'
    if (field === 'effectKind') request.effects[0].kind = 'network.read'
    if (field === 'effectRisk') request.effects[0].risk = 'low'
    if (field === 'effectTarget') request.effects[0].target = '/renderer/path'
    if (field === 'transport') request.transport = 'http'
    if (field === 'emptyEffects') request.effects = []
    if (field === 'extraEffect') request.effects.push({ kind: 'filesystem.write', target: request.target.id, risk: 'high' })
    if (field === 'duplicateEffect') request.effects.push({ ...request.effects[0] })
    if (field === 'whitespaceActor') request.actor.id += ' '
    if (field === 'whitespaceAction') request.action += ' '
    if (field === 'whitespaceEffect') request.effects[0].kind += ' '
    const decision = evaluateInstalledCatalogReadPolicy(request, 123)
    expect(decision).toMatchObject({ effect: 'deny', matchedRuleIds: ['management-installed-catalog-read-default-deny'], reasonCode: 'rule-deny' })
  })

  it('does not inherit generic read classification even when it would allow a forged actor/action/effect tuple', () => {
    const request = fixture(); request.actor = { kind: 'assistant', id: 'forged' }; request.origin = 'assistant'; request.action = 'unrelated.action'
    expect(evaluatePolicy(request, [], { evaluatedAt: 123, policyVersion: 'classification-only' }).effect).toBe('allow-with-constraints')
    expect(evaluateInstalledCatalogReadPolicy(request, 123)).toMatchObject({ effect: 'deny', matchedRuleIds: ['management-installed-catalog-read-default-deny'] })
  })

  it.each(['route', 'filesystem', 'allowedToolNames', 'metadata', 'confirmation', 'actor', 'target', 'effect', 'input', 'undefined', 'nonenumerable'] as const)('does not accept extra %s claims or a caller-supplied decision', field => {
    const request = fixture()
    if (['route', 'filesystem', 'allowedToolNames', 'metadata', 'confirmation'].includes(field)) Object.assign(request, { [field]: field === 'confirmation' ? true : { path: '/untrusted', policy: 'allow' } })
    if (field === 'actor') request.actor.displayName = 'Authenticated owner'
    if (field === 'target') request.target.source = '/untrusted'
    if (field === 'effect') request.effects[0].metadata = { approval: true }
    if (field === 'input') request.input = { policy: 'allow', actor: 'user', path: '/untrusted' }
    if (field === 'undefined') Object.assign(request, { extra: undefined })
    if (field === 'nonenumerable') Object.defineProperty(request, 'hidden', { value: 'allow', enumerable: false })
    denied(request)
    denied({ ...request, decision: { effect: 'allow', readOnly: true } })
  })

  it.each([null, undefined, [], 'allow', { effect: 'allow' }, { ...fixture(), effects: null }, { ...fixture(), actor: null }, { ...fixture(), input: [] }, { ...fixture(), version: 2 }])('fails closed for malformed request %#', request => denied(request))

  it('rejects accessors, proxies, cycles, oversized values and sparse/extra-property arrays without invoking getters', () => {
    const getter = vi.fn(() => { throw new Error('do not execute') }), request = fixture()
    const accessor = Object.defineProperty({ ...request }, 'action', { get: getter, enumerable: true })
    const actorAccessor = { ...request, actor: Object.defineProperty({}, 'kind', { get: getter, enumerable: true }) }
    const proxy = new Proxy(request, { getPrototypeOf: getter, ownKeys: getter, get: getter })
    const cycle = { ...request }; cycle.input = { self: cycle as unknown as string }
    const sparse = { ...request, effects: new Array(1) }, extraArray = { ...request, effects: Object.assign([...request.effects], { extra: true }) }
    for (const invalid of [accessor, actorAccessor, proxy, cycle, sparse, extraArray, { ...request, requestId: 'installed-catalog-read:' + 'x'.repeat(200) }, { ...request, actor: { ...request.actor, id: 'x'.repeat(10000) } }]) denied(invalid)
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, -1, 0.5])('does not use implicit time or accept invalid evaluation timestamp %s', evaluatedAt => {
    expect(evaluateInstalledCatalogReadPolicy(fixture(), evaluatedAt)).toBeNull()
  })

  it('is deterministic and deeply immutable so a caller cannot widen actor or rule state through a returned decision', () => {
    const first = evaluateInstalledCatalogReadPolicy(fixture(), 123)
    expect(first).not.toBeNull()
    const same = evaluateInstalledCatalogReadPolicy(fixture(), 123)
    expect(same).toEqual(first); expect(same).not.toBe(first)
    if (!first) throw new Error('Expected explicit constrained policy decision')
    expect(Object.isFrozen(first)).toBe(true)
    expect(() => first.matchedRuleIds.push('forged')).toThrow()
    expect(() => { first.constraints!.readOnly = false }).toThrow()
    const forgedCopy = structuredClone(first)
    forgedCopy.matchedRuleIds.push('forged'); forgedCopy.constraints!.readOnly = false
    expect(forgedCopy).not.toEqual(same)
    expect(evaluateInstalledCatalogReadPolicy(fixture(), 123)).toEqual(same)
    const other = fixture(); other.requestId = 'installed-catalog-read:test-2'
    expect(evaluateInstalledCatalogReadPolicy(other, 124)?.requestDigest).not.toBe(same?.requestDigest)
    expect(evaluateInstalledCatalogReadPolicy({ ...fixture(), actor: { kind: 'service', id: 'different' } }, 125)?.effect).toBe('deny')
  })
})
