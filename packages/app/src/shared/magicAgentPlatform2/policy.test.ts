import { createHash } from 'node:crypto'
import * as policy from './policy'
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_GRANT_DISCRIMINATOR,
  APPROVAL_GRANT_VERSION,
  POLICY_REQUEST_DISCRIMINATOR,
  POLICY_REQUEST_VERSION,
  APPROVAL_CONSUMPTION_RECEIPT_DISCRIMINATOR,
  APPROVAL_CONSUMPTION_VERSION,
  canonicalPolicyJson,
  sha256PolicyText,
  createAssistantToolPolicyRequest,
  createGraphToolPolicyRequest,
  createMcpToolPolicyRequest,
  createTriggerPolicyRequest,
  createTerminalPolicyRequest,
  digestPolicyRequest,
  evaluatePolicy,
  parseApprovalConsumptionIntent,
  parseApprovalConsumptionReceipt,
  parseApprovalGrant,
  parsePolicyDecision,
  parsePolicyRequest,
  parsePolicyRule,
  parsePolicyRules,
  type PolicyRequest,
  type PolicyRule
} from './policy'

const request = (patch: Partial<PolicyRequest> = {}): PolicyRequest => ({
  discriminator: POLICY_REQUEST_DISCRIMINATOR,
  version: POLICY_REQUEST_VERSION,
  requestId: 'r1',
  actor: { kind: 'agent', id: 'a1' },
  origin: 'assistant',
  action: 'file.read',
  target: { kind: 'file', id: '/tmp/a' },
  input: {},
  effects: [{ kind: 'filesystem.read', risk: 'read', target: '/tmp/a' }],
  ...patch
})
const options = { evaluatedAt: 1000, policyVersion: 'p1' }
const rule = (patch: Partial<PolicyRule> = {}): PolicyRule => ({
  ruleId: 'rule',
  priority: 1,
  effect: 'allow',
  explanation: 'allowed',
  ...patch
})

describe('trigger policy request factory', () => {
  const base = () => ({
    requestId: 'trigger-request-1',
    actor: { kind: 'scheduler', id: 'scheduler-1' },
    triggerId: 'trigger-1',
    occurrence: {
      occurrenceAt: 100,
      windowStart: 90,
      windowEnd: 110,
      missedCount: 1,
      nextFireAtAfter: 200,
      batchEndAt: 150
    },
    trigger: {
      type: 'schedule',
      title: 'Nightly',
      config: { intervalMs: 100 },
      metadata: { owner: 'ops' }
    },
    effects: [{ kind: 'filesystem.write', risk: 'high', target: '/workspace/out' }],
    runId: 'run-1',
    sessionId: 'session-1',
    graphId: 'graph-1',
    graphRunId: 'graph-run-1',
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    route: { kind: 'scheduler' },
    transport: 'internal',
    budget: { toolCalls: 1 },
    metadata: { source: 'test' }
  })

  it('creates the fixed canonical trigger request and JSON-safe projection', () => {
    const value = createTriggerPolicyRequest(base())
    expect(value).toMatchObject({
      origin: 'trigger',
      action: 'trigger.execute',
      target: { kind: 'trigger', id: 'trigger-1' },
      input: {
        occurrence: base().occurrence,
        trigger: base().trigger
      },
      effects: base().effects,
      runId: 'run-1',
      sessionId: 'session-1',
      graphId: 'graph-1',
      graphRunId: 'graph-run-1',
      agentId: 'agent-1',
      workspaceId: 'workspace-1'
    })
    expect(Object.isFrozen(value.input)).toBe(true)
  })

  it('requires at least one standard canonical effect', () => {
    expect(() => createTriggerPolicyRequest({ ...base(), effects: [] })).toThrow('non-empty')
    expect(() =>
      createTriggerPolicyRequest({
        ...base(),
        effects: [{ kind: 'custom.effect', risk: 'high' }]
      })
    ).toThrow('canonical PolicyEffect')
  })

  it('changes digest for trigger, occurrence, effects, actor, route, and config changes', () => {
    const digest = (value: ReturnType<typeof base>) =>
      digestPolicyRequest(createTriggerPolicyRequest(value))
    const original = base()
    const variants = [
      { ...original, triggerId: 'trigger-2' },
      { ...original, occurrence: { ...original.occurrence, occurrenceAt: 101 } },
      {
        ...original,
        effects: [{ kind: 'network.write', risk: 'high', target: '/api/output' }]
      },
      { ...original, actor: { kind: 'scheduler', id: 'scheduler-2' } },
      { ...original, route: { kind: 'retry' } },
      { ...original, trigger: { ...original.trigger, config: { intervalMs: 200 } } }
    ]
    for (const variant of variants) expect(digest(variant)).not.toBe(digest(original))
  })
})

describe('policy contracts and digest', () => {
  it('uses a standard SHA-256 implementation', () => {
    const empty = request({ input: { text: '' } })
    expect(digestPolicyRequest(empty)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(digestPolicyRequest(request())).toBe(
      'sha256:56503eb16421635aac8302deafcfeac78e971a8d3aaf2469ea8ea52c467e490b'
    )
    expect(digestPolicyRequest(empty)).toBe(digestPolicyRequest(JSON.parse(JSON.stringify(empty))))
  })
  it('matches Node SHA-256 UTF-8 semantics including unpaired surrogates', () => {
    for (const text of ['', 'abc', '魔法🪴', '\ud800', '\udc00'])
      expect(sha256PolicyText(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    expect(canonicalPolicyJson({ b: 1, a: '🪴' })).toBe('{"a":"🪴","b":1}')
  })
  it('canonicalizes object key order', () =>
    expect(digestPolicyRequest(request({ input: { a: 1, b: 2 } }))).toBe(
      digestPolicyRequest(request({ input: { b: 2, a: 1 } }))
    ))
  it('preserves unknown JSON-safe fields', () => {
    const parsed = parsePolicyRequest({ ...request(), future: { ok: true } })
    expect(parsed.ok && (parsed.value as unknown as { future: unknown }).future).toEqual({
      ok: true
    })
  })
  it.each([
    [
      'cycle',
      () => {
        const x: Record<string, unknown> = {}
        x.x = x
        return { ...request(), input: x }
      }
    ],
    ['nonfinite', () => ({ ...request(), input: { n: Infinity } })],
    ['date', () => ({ ...request(), input: { d: new Date() } })],
    [
      'getter',
      () => ({
        ...request(),
        input: Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 })
      })
    ],
    [
      'proxy',
      () => ({
        ...request(),
        input: new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('no')
            }
          }
        )
      })
    ]
  ])('rejects unsafe %s input', (_name, build) =>
    expect(parsePolicyRequest(build()).ok).toBe(false)
  )
  it('rejects dangerous keys', () =>
    expect(parsePolicyRequest({ ...request(), input: JSON.parse('{"__proto__":1}') }).ok).toBe(
      false
    ))
  it('preserves null and empty allowed tool lists', () => {
    const nullTools = parsePolicyRequest(request({ allowedToolNames: null }))
    const emptyTools = parsePolicyRequest(request({ allowedToolNames: [] }))
    expect(nullTools.ok && nullTools.value.allowedToolNames).toBeNull()
    expect(emptyTools.ok && emptyTools.value.allowedToolNames).toEqual([])
  })
  it('accepts custom origins and effects', () =>
    expect(
      parsePolicyRequest(
        request({ origin: 'future', effects: [{ kind: 'future.effect', risk: 'future' }] })
      ).ok
    ).toBe(true))
  it('trims opaque action and effect strings', () => {
    const parsed = parsePolicyRequest(
      request({ action: ' x ', effects: [{ kind: ' filesystem.read ', risk: ' read ' }] })
    )
    expect(parsed.ok && parsed.value.action).toBe('x')
    expect(parsed.ok && parsed.value.effects[0].kind).toBe('filesystem.read')
  })
  it('deep freezes and detaches parsed input', () => {
    const source = request({ input: { nested: { x: 1 } } })
    const parsed = parsePolicyRequest(source)
    source.input.nested = { x: 2 }
    expect(parsed.ok && parsed.value.input.nested).toEqual({ x: 1 })
    expect(parsed.ok && Object.isFrozen(parsed.value.input)).toBe(true)
  })
})

describe('rules and engine', () => {
  it('sorts priority descending', () => {
    const parsed = parsePolicyRules([
      rule({ ruleId: 'low' }),
      rule({ ruleId: 'high', priority: 2 })
    ])
    expect(parsed.ok && parsed.value.map((x) => x.ruleId)).toEqual(['high', 'low'])
  })
  it('uses only the highest matching priority tier', () => {
    const decision = evaluatePolicy(
      request(),
      [
        rule({ ruleId: 'low-deny', priority: 1, effect: 'deny' }),
        rule({ ruleId: 'high-allow', priority: 2 })
      ],
      options
    )
    expect(decision.effect).toBe('allow')
    expect(decision.matchedRuleIds).toEqual(['high-allow'])
  })
  it('sorts ties by rule id', () => {
    const parsed = parsePolicyRules([rule({ ruleId: 'b' }), rule({ ruleId: 'a' })])
    expect(parsed.ok && parsed.value.map((x) => x.ruleId)).toEqual(['a', 'b'])
  })
  it('rejects duplicate and empty match arrays', () => {
    expect(parsePolicyRule(rule({ match: { actions: [] } })).ok).toBe(false)
    expect(parsePolicyRule(rule({ match: { actions: ['x', 'x'] } })).ok).toBe(false)
  })
  it('rejects invalid request digest match values', () => {
    expect(parsePolicyRule(rule({ match: { requestDigests: [] } })).ok).toBe(false)
    expect(parsePolicyRule(rule({ match: { requestDigests: ['sha256:ABC'] } })).ok).toBe(false)
    expect(
      parsePolicyRule(rule({ match: { requestDigests: [` sha256:${'a'.repeat(64)} `] } })).ok
    ).toBe(false)
    expect(
      parsePolicyRule(
        rule({
          match: {
            requestDigests: [`sha256:${'a'.repeat(64)}`, `sha256:${'a'.repeat(64)}`]
          }
        })
      ).ok
    ).toBe(false)
  })
  it.each(['allow', 'deny'] as const)('rejects constraints for %s rules', (effect) => {
    expect(parsePolicyRule(rule({ effect, constraints: { readOnly: true } }))).toEqual({
      ok: false,
      error: 'constraints: is only valid for require-approval or allow-with-constraints'
    })
  })
  it('accepts optional constraints for require-approval rules', () => {
    expect(parsePolicyRule(rule({ effect: 'require-approval' })).ok).toBe(true)
    expect(
      parsePolicyRule(rule({ effect: 'require-approval', constraints: { allowedRoots: ['/a'] } }))
    ).toMatchObject({ ok: true, value: { constraints: { allowedRoots: ['/a'] } } })
  })
  it('requires non-empty constraints for allow-with-constraints rules', () => {
    expect(parsePolicyRule(rule({ effect: 'allow-with-constraints' }))).toEqual({
      ok: false,
      error: 'constraints: must be non-empty for allow-with-constraints'
    })
    expect(
      parsePolicyRule(rule({ effect: 'allow-with-constraints', constraints: { readOnly: true } }))
        .ok
    ).toBe(true)
  })
  it.each([
    [{ origins: ['graph'] }, false],
    [{ actions: ['file.read'] }, true],
    [{ actionPrefixes: ['file.'] }, true],
    [{ targetKinds: ['file'] }, true],
    [{ actorKinds: ['agent'] }, true],
    [{ effectKinds: ['filesystem.read'] }, true],
    [{ risks: ['read'] }, true],
    [{ transports: ['mcp'] }, false]
  ])('matches dimensions %#', (match, matches) =>
    expect(evaluatePolicy(request(), [rule({ match })], options).matchedRuleIds.length > 0).toBe(
      matches
    )
  )
  it('requires every effect to be covered by effectKinds', () =>
    expect(
      evaluatePolicy(
        request({
          effects: [
            { kind: 'filesystem.read', risk: 'read' },
            { kind: 'network.read', risk: 'read' }
          ]
        }),
        [rule({ match: { effectKinds: ['filesystem.read'] } })],
        options
      ).matchedRuleIds
    ).toEqual([]))
  it('requires exact specificity for empty effects', () =>
    expect(
      evaluatePolicy(
        request({ effects: [] }),
        [
          rule({
            match: {
              origins: ['assistant'],
              actions: ['file.read'],
              actorKinds: ['agent'],
              targetKinds: ['file']
            }
          })
        ],
        options
      ).effect
    ).toBe('allow'))
  it('denies empty effects by default', () =>
    expect(evaluatePolicy(request({ effects: [] }), [], options).reasonCode).toBe('no-effects'))
  it('allows known reads conservatively', () =>
    expect(evaluatePolicy(request(), [], options)).toMatchObject({
      effect: 'allow-with-constraints',
      constraints: { readOnly: true, requireNoShell: true }
    }))
  it('hard-denies unknown effects despite allow rule', () =>
    expect(
      evaluatePolicy(request({ effects: [{ kind: 'custom', risk: 'low' }] }), [rule()], options)
        .reasonCode
    ).toBe('unknown-effect'))
  it('requires approval for high risk', () =>
    expect(
      evaluatePolicy(request({ effects: [{ kind: 'network.write', risk: 'high' }] }), [], options)
        .effect
    ).toBe('require-approval'))
  it('requires approval for destructive risk', () =>
    expect(
      evaluatePolicy(
        request({ effects: [{ kind: 'filesystem.delete', risk: 'destructive' }] }),
        [],
        options
      ).reasonCode
    ).toBe('destructive-effect'))
  it('cannot spoof kind-derived risk floors', () => {
    const deletion = evaluatePolicy(
      request({ effects: [{ kind: 'filesystem.delete', risk: 'low' }] }),
      [
        rule({
          match: {
            origins: ['assistant'],
            actions: ['file.read'],
            actorKinds: ['agent'],
            targetKinds: ['file'],
            effectKinds: ['filesystem.delete']
          }
        })
      ],
      options
    )
    expect(deletion).toMatchObject({
      effect: 'require-approval',
      reasonCode: 'destructive-safety-floor',
      audit: {
        effects: [{ kind: 'filesystem.delete', declaredRisk: 'low', effectiveRisk: 'destructive' }]
      }
    })
    expect(
      evaluatePolicy(request({ effects: [{ kind: 'credential.read', risk: 'low' }] }), [], options)
        .effect
    ).toBe('require-approval')
  })
  it('explicitly allows known high risk only with exact specificity and request digest', () => {
    const highRiskRequest = request({
      action: 'tool.invoke',
      target: { kind: 'tool', id: 'shell' },
      input: { args: ['echo', 'ok'], path: '/tmp/a', toolName: 'shell' },
      effects: [{ kind: 'process.execute', risk: 'high' }]
    })
    const exactMatch = {
      origins: ['assistant'],
      actions: ['tool.invoke'],
      actorKinds: ['agent'],
      targetKinds: ['tool'],
      effectKinds: ['process.execute']
    }
    const withoutDigest = evaluatePolicy(highRiskRequest, [rule({ match: exactMatch })], options)
    expect(withoutDigest.effect).toBe('require-approval')

    const initial = evaluatePolicy(highRiskRequest, [], options)
    const digestRule = rule({
      match: { ...exactMatch, requestDigests: [initial.requestDigest] }
    })
    expect(evaluatePolicy(highRiskRequest, [digestRule], options).effect).toBe('allow')

    for (const changed of [
      request({
        ...highRiskRequest,
        input: { ...highRiskRequest.input, args: ['echo', 'changed'] }
      }),
      request({ ...highRiskRequest, input: { ...highRiskRequest.input, path: '/tmp/b' } }),
      request({ ...highRiskRequest, input: { ...highRiskRequest.input, toolName: 'other' } })
    ]) {
      expect(digestPolicyRequest(changed)).not.toBe(initial.requestDigest)
      expect(evaluatePolicy(changed, [digestRule], options).effect).toBe('require-approval')
    }
  })
  it('keeps destructive operations behind approval even with an exact request digest', () => {
    const destructiveRequest = request({
      effects: [{ kind: 'filesystem.delete', risk: 'destructive' }]
    })
    const digest = digestPolicyRequest(destructiveRequest)
    expect(
      evaluatePolicy(
        destructiveRequest,
        [
          rule({
            match: {
              origins: ['assistant'],
              actions: ['file.read'],
              actorKinds: ['agent'],
              targetKinds: ['file'],
              effectKinds: ['filesystem.delete'],
              requestDigests: [digest]
            }
          })
        ],
        options
      ).effect
    ).toBe('require-approval')
  })
  it('allows a scoped low-risk read rule without a request digest', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({
            match: {
              origins: ['assistant'],
              actions: ['file.read'],
              actorKinds: ['agent'],
              targetKinds: ['file'],
              effectKinds: ['filesystem.read']
            }
          })
        ],
        options
      ).effect
    ).toBe('allow'))
  it('gives deny precedence', () =>
    expect(
      evaluatePolicy(request(), [rule(), rule({ ruleId: 'deny', effect: 'deny' })], options).effect
    ).toBe('deny'))
  it('gives deny precedence without merging same-tier constraints', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ ruleId: 'deny', effect: 'deny' }),
          rule({
            ruleId: 'constraint-a',
            effect: 'allow-with-constraints',
            constraints: { allowedRoots: ['/a'] }
          }),
          rule({
            ruleId: 'constraint-b',
            effect: 'allow-with-constraints',
            constraints: { allowedRoots: ['/b'] }
          })
        ],
        options
      )
    ).toMatchObject({ effect: 'deny', reasonCode: 'rule-deny' }))
  it('gives approval precedence over allow', () =>
    expect(
      evaluatePolicy(
        request(),
        [rule(), rule({ ruleId: 'approve', effect: 'require-approval' })],
        options
      ).effect
    ).toBe('require-approval'))
  it('inherits same-tier constraints into an approval decision', () => {
    const decision = evaluatePolicy(
      request(),
      [
        rule({
          ruleId: 'approve',
          effect: 'require-approval',
          constraints: { allowedRoots: ['/a', '/b'] }
        }),
        rule({
          ruleId: 'constrain',
          effect: 'allow-with-constraints',
          constraints: { allowedRoots: ['/b'], readOnly: true }
        })
      ],
      options
    )
    expect(decision).toMatchObject({
      effect: 'require-approval',
      constraints: { allowedRoots: ['/b'], readOnly: true },
      approvalRequirement: {
        scopeKind: 'request',
        scopeValue: 'r1',
        maxUses: 1,
        expiresInMs: 300000,
        reason: 'Policy approval required'
      }
    })
  })
  it('denies approval when same-tier constraints have an empty intersection', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ ruleId: 'approve', effect: 'require-approval' }),
          rule({
            ruleId: 'constraint-a',
            effect: 'allow-with-constraints',
            constraints: { allowedRoots: ['/a'] }
          }),
          rule({
            ruleId: 'constraint-b',
            effect: 'allow-with-constraints',
            constraints: { allowedRoots: ['/b'] }
          })
        ],
        options
      )
    ).toMatchObject({ effect: 'deny', reasonCode: 'constraints-empty' }))
  it('denies approval when same-tier constraint metadata conflicts', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ ruleId: 'approve', effect: 'require-approval' }),
          rule({
            ruleId: 'constraint-a',
            effect: 'allow-with-constraints',
            constraints: { metadata: { mode: 'a' } }
          }),
          rule({
            ruleId: 'constraint-b',
            effect: 'allow-with-constraints',
            constraints: { metadata: { mode: 'b' } }
          })
        ],
        options
      )
    ).toMatchObject({ effect: 'deny', reasonCode: 'constraints-conflict' }))
  it('does not inherit lower-priority constraints into an approval decision', () => {
    const decision = evaluatePolicy(
      request(),
      [
        rule({ ruleId: 'approve', priority: 2, effect: 'require-approval' }),
        rule({
          ruleId: 'lower-constraint',
          effect: 'allow-with-constraints',
          constraints: { allowedRoots: ['/lower'], readOnly: true }
        })
      ],
      options
    )
    expect(decision.effect).toBe('require-approval')
    expect(decision.constraints).toBeUndefined()
    expect(decision.matchedRuleIds).toEqual(['approve'])
  })
  it('intersects arrays', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ effect: 'allow-with-constraints', constraints: { allowedRoots: ['/a', '/b'] } }),
          rule({
            ruleId: 'r2',
            effect: 'allow-with-constraints',
            constraints: { allowedRoots: ['/b'] }
          })
        ],
        options
      ).constraints?.allowedRoots
    ).toEqual(['/b']))
  it('denies empty intersections', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ effect: 'allow-with-constraints', constraints: { allowedRoots: ['/a'] } }),
          rule({
            ruleId: 'r2',
            effect: 'allow-with-constraints',
            constraints: { allowedRoots: ['/b'] }
          })
        ],
        options
      ).reasonCode
    ).toBe('constraints-empty'))
  it('takes numeric minima', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ effect: 'allow-with-constraints', constraints: { maxTimeoutMs: 10 } }),
          rule({ ruleId: 'r2', effect: 'allow-with-constraints', constraints: { maxTimeoutMs: 5 } })
        ],
        options
      ).constraints?.maxTimeoutMs
    ).toBe(5))
  it('ORs restrictive booleans', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ effect: 'allow-with-constraints', constraints: { readOnly: false } }),
          rule({ ruleId: 'r2', effect: 'allow-with-constraints', constraints: { readOnly: true } })
        ],
        options
      ).constraints?.readOnly
    ).toBe(true))
  it('merges identical metadata', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ effect: 'allow-with-constraints', constraints: { metadata: { x: 1 } } }),
          rule({
            ruleId: 'r2',
            effect: 'allow-with-constraints',
            constraints: { metadata: { x: 1 } }
          })
        ],
        options
      ).constraints?.metadata
    ).toEqual({ x: 1 }))
  it('denies metadata conflicts', () =>
    expect(
      evaluatePolicy(
        request(),
        [
          rule({ effect: 'allow-with-constraints', constraints: { metadata: { x: 1 } } }),
          rule({
            ruleId: 'r2',
            effect: 'allow-with-constraints',
            constraints: { metadata: { x: 2 } }
          })
        ],
        options
      ).reasonCode
    ).toBe('constraints-conflict'))
  it('is deterministic and frozen', () => {
    const a = evaluatePolicy(request(), [], options)
    const b = evaluatePolicy(request(), [], options)
    expect(a).toEqual(b)
    expect(Object.isFrozen(a.audit.effects)).toBe(true)
    expect(a.decisionId).toMatch(/^policy-decision:[0-9a-f]{64}$/)
  })
  it('never treats legacy confirmation as approval', () =>
    expect(
      evaluatePolicy(
        request({ confirmation: true, effects: [{ kind: 'process.execute', risk: 'high' }] }),
        [],
        options
      ).effect
    ).toBe('require-approval'))
})

describe('approval contracts', () => {
  const grant = (patch: Record<string, unknown> = {}) => ({
    discriminator: APPROVAL_GRANT_DISCRIMINATOR,
    version: APPROVAL_GRANT_VERSION,
    grantId: 'g1',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    actor: { kind: 'agent', id: 'a1' },
    scope: { kind: 'request', value: 'r1' },
    issuedAt: 900,
    expiresAt: 2000,
    maxUses: 1,
    useCount: 0,
    approvedBy: { kind: 'user', id: 'u1' },
    constraints: { readOnly: true },
    ...patch
  })
  it('strictly parses and deeply freezes future store contracts', () => {
    const parsed = parseApprovalGrant(grant())
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true)
    expect(parsed.ok && Object.isFrozen(parsed.value.constraints)).toBe(true)
    expect(parseApprovalGrant(grant({ expiresAt: 900 })).ok).toBe(false)
    expect(parseApprovalGrant(grant({ maxUses: 0 })).ok).toBe(false)
  })
  it('parses non-authorizing intent and receipt SDK data', () => {
    const seed = {
      discriminator: 'magic-agent.approval-consumption-intent.v1',
      version: APPROVAL_CONSUMPTION_VERSION,
      grantId: 'g1',
      requestDigest: `sha256:${'a'.repeat(64)}`,
      expectedUseCount: 0,
      nextUseCount: 1,
      actor: { kind: 'agent', id: 'a1' },
      scope: { kind: 'request', value: 'r1' },
      evaluatedAt: 1000,
      expiresAt: 2000,
      authorization: false
    }
    const intent = {
      ...seed,
      intentId: `approval-intent:${sha256PolicyText(canonicalPolicyJson(seed))}`
    }
    const parsedIntent = parseApprovalConsumptionIntent(intent)
    expect(parsedIntent.ok && parsedIntent.value.authorization).toBe(false)
    expect(parsedIntent.ok && Object.isFrozen(parsedIntent.value)).toBe(true)
    const receipt = {
      discriminator: APPROVAL_CONSUMPTION_RECEIPT_DISCRIMINATOR,
      version: APPROVAL_CONSUMPTION_VERSION,
      intentId: intent.intentId,
      grantId: 'g1',
      requestDigest: seed.requestDigest,
      previousUseCount: 0,
      nextUseCount: 1,
      consumedAt: 1001,
      storeRevision: '1',
      storeId: 'future-store'
    }
    const parsedReceipt = parseApprovalConsumptionReceipt(receipt)
    expect(parsedReceipt.ok && Object.isFrozen(parsedReceipt.value)).toBe(true)
    expect(parseApprovalConsumptionIntent({ ...intent, authorization: true }).ok).toBe(false)
  })
  it('exports no shared approval authorization API', () => {
    expect(policy).not.toHaveProperty('prepareApprovalGrantConsumption')
    expect(policy).not.toHaveProperty('applyApprovalConsumptionReceipt')
  })
  it('decision hashes provide integrity checking only', () => {
    expect(parsePolicyDecision(evaluatePolicy(request(), [], options)).ok).toBe(true)
  })
})
describe('adapters', () => {
  const base = {
    requestId: 'x',
    actor: { kind: 'agent' as const, id: 'a' },
    target: { kind: 'tool', id: 't' }
  }
  it('preserves assistant null and empty tool lists', () => {
    expect(
      createAssistantToolPolicyRequest({ ...base, allowedToolNames: null }).allowedToolNames
    ).toBeNull()
    expect(
      createAssistantToolPolicyRequest({ ...base, allowedToolNames: [] }).allowedToolNames
    ).toEqual([])
  })
  it('preserves graph identifiers and route', () =>
    expect(
      createGraphToolPolicyRequest({
        ...base,
        graphId: 'g',
        graphRunId: 'gr',
        nodeId: 'n',
        route: { channel: 'c' }
      })
    ).toMatchObject({
      origin: 'graph',
      graphId: 'g',
      graphRunId: 'gr',
      nodeId: 'n',
      route: { channel: 'c' }
    }))
  it('preserves MCP transport and route', () =>
    expect(
      createMcpToolPolicyRequest({ ...base, transport: 'stdio', route: { server: 's' } })
    ).toMatchObject({ origin: 'mcp', transport: 'mcp', route: { server: 's' } }))
  it('omits optional terminal cwd and confirmation and ignores injected fixed fields', () => {
    const terminal = createTerminalPolicyRequest({ ...base, command: 'pwd' })
    expect(terminal.filesystem).toBeUndefined()
    expect(terminal.confirmation).toBeUndefined()
    expect(terminal.effects).toHaveLength(1)
    const injected = createAssistantToolPolicyRequest({
      ...base,
      origin: 'renderer',
      action: 'filesystem.delete',
      target: { kind: 'credential', id: 't' },
      effects: [{ kind: 'filesystem.read', risk: 'read' }],
      input: { injected: true },
      confirmation: true
    } as unknown as Parameters<typeof createAssistantToolPolicyRequest>[0])
    expect(injected.origin).toBe('assistant')
    expect(injected.action).toBe('tool.invoke')
    expect(injected.target.kind).toBe('tool')
    expect(injected.input).toEqual({})
    expect(injected.confirmation).toBeUndefined()
    expect(injected.effects[0]).toMatchObject({ kind: 'tool.invoke', risk: 'high' })
  })
  it('preserves terminal command context and confirmation evidence', () => {
    const terminal = createTerminalPolicyRequest({
      ...base,
      command: 'git',
      args: ['status'],
      cwd: '/w',
      confirm: true
    })
    expect(terminal).toMatchObject({
      input: { command: 'git', args: ['status'] },
      filesystem: { cwd: '/w' },
      confirmation: true
    })
    expect(terminal.effects[0]).toMatchObject({ kind: 'process.execute', risk: 'high' })
    expect(terminal.effects[1]).toMatchObject({ kind: 'filesystem.read', risk: 'read' })
  })
})
