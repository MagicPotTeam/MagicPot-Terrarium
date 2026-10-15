import { types } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  FIGPLUGIN_NATIVE_COMMAND_DOMAIN,
  FIGPLUGIN_NATIVE_COMMAND_VERSION,
  FIGPLUGIN_NATIVE_PRODUCTION_AVAILABLE,
  figPluginNativeAuditSchema,
  figPluginNativeClaimSchema,
  figPluginNativeGuaranteeSchema,
  figPluginNativeIntentSchema,
  figPluginNativeProgressSchema,
  figPluginNativeProposalSchema,
  figPluginNativeResultSchema,
  figPluginNativeStatusSchema,
  figPluginNativeWriteConsentSchema,
  parseFigPluginNativeCommandValue
} from './nativeCommand'

const actionId = 'a'.repeat(32)
const payloadSha256 = 'b'.repeat(64)
const wire = { domain: 'figplugin-native-rename', version: 1 } as const
const binding = (host: 'figma' | 'photoshop' = 'figma') => ({
  pluginId: 'native.rename',
  host,
  generation: 1,
  artifactSha256: 'c'.repeat(64),
  signerFingerprint: 'd'.repeat(64),
  manifestSha256: 'e'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:12345',
  projectId: 'project_1',
  profileId: 'profile-e\u0301',
  profileRevision: 'f'.repeat(64)
})
const plan = (count = 1, name = 'Renamed') => ({
  schemaVersion: 1,
  mode: 'plan-only',
  selectionRevision: 'observation-only',
  steps: Array.from({ length: count }, (_, index) => ({
    command: 'node.rename',
    targetId: `target-${index}`,
    name
  }))
})
const guarantee = (host: 'figma' | 'photoshop' = 'figma') =>
  host === 'figma'
    ? {
        host,
        policy: 'proposed',
        availability: 'production-unavailable',
        profile: 'figma-synchronous-detectable',
        revision: 'none',
        exclusion: false,
        rollback: 'none',
        cancellation: 'before-dispatch-only'
      }
    : {
        host,
        policy: 'proposed',
        availability: 'production-unavailable',
        profile: 'photoshop-modal-history',
        revision: 'none',
        exclusion: 'modal-scope',
        rollback: 'scoped-history',
        cancellation: 'modal-cooperative'
      }
const proposal = () => ({
  ...wire,
  purpose: 'native-rename-proposal',
  host: 'figma',
  plan: plan()
})
const intent = (host: 'figma' | 'photoshop' = 'figma') => ({
  ...wire,
  purpose: 'native-command-intent',
  host,
  actionId,
  binding: binding(host),
  authorityEpoch: '1'.repeat(32),
  instanceEpoch: '2'.repeat(32),
  expiresAt: 60_000,
  guarantee: guarantee(host),
  plan: plan()
})
const reference = (host: 'figma' | 'photoshop' = 'figma') => ({
  ...wire,
  actionId,
  payloadSha256,
  host,
  command: 'node.rename',
  evidence: 'unverified-host-report'
})
const event = (sequence = 1) => ({
  sequence,
  ordinal: 1,
  index: 0,
  phase: 'readback',
  completed: 1,
  total: 1,
  effect: 'applied'
})
const progress = () => ({
  ...reference(),
  purpose: 'native-command-progress',
  total: 1,
  cursor: 1,
  events: [event()]
})
const status = () => ({
  ...reference(),
  purpose: 'native-command-status',
  status: 'cancelled',
  total: 1,
  completed: 1,
  effect: 'applied',
  updatedAt: 10
})
const result = (host: 'figma' | 'photoshop' = 'figma') => ({
  ...reference(host),
  purpose: 'native-command-result',
  status: 'completed',
  total: 1,
  completed: 1,
  effect: 'applied',
  settledAt: 20,
  readback: [{ index: 0, observation: 'requested' }]
})
const consent = () => ({ ...wire, purpose: 'native-write-consent', actionId, payloadSha256 })
const parse = parseFigPluginNativeCommandValue

describe('inert native rename contracts', () => {
  it('exports an independent, unavailable protocol, not a driver or grant', () => {
    expect(FIGPLUGIN_NATIVE_COMMAND_DOMAIN).toBe(wire.domain)
    expect(FIGPLUGIN_NATIVE_COMMAND_VERSION).toBe(1)
    expect(FIGPLUGIN_NATIVE_PRODUCTION_AVAILABLE).toBe(false)
    expect(parse(figPluginNativeProposalSchema, proposal()).ok).toBe(true)
    for (const host of ['figma', 'photoshop'] as const) {
      expect(parse(figPluginNativeIntentSchema, intent(host)).ok).toBe(true)
      expect(parse(figPluginNativeGuaranteeSchema, guarantee(host)).ok).toBe(true)
    }
  })

  it('rejects cross-domain, protocol, commands, scripts and proposal authority', () => {
    for (const extra of [
      { domain: 'figplugin-bridge' },
      { version: 2 },
      { protocol: 1 },
      { binding: binding() },
      { authorityEpoch: '1'.repeat(32) },
      { instanceEpoch: '2'.repeat(32) },
      { actionId },
      { approval: consent() },
      { guarantee: guarantee() },
      { payloadSha256 },
      { args: [] },
      { script: 'sensitive source' }
    ]) {
      expect(parse(figPluginNativeProposalSchema, { ...proposal(), ...extra }).ok).toBe(false)
    }
    for (const command of ['node.delete', 'batchPlay', 'eval']) {
      const value = proposal()
      value.plan.steps[0].command = command
      expect(parse(figPluginNativeProposalSchema, value).ok).toBe(false)
    }
    expect(
      parse(figPluginNativeProposalSchema, {
        ...proposal(),
        plan: { ...plan(), steps: [{ ...plan().steps[0], args: {} }] }
      }).ok
    ).toBe(false)
  })

  it('reuses strict binding without normalizing authority references', () => {
    for (const extra of [
      { token: 'secret' },
      { generation: 1.5 },
      { generation: Number.MAX_SAFE_INTEGER + 1 },
      { pluginId: ' native.rename' },
      { pluginId: 'native.rename\n' },
      { bridgeOrigin: 'http://localhost:12345' },
      { host: 'photoshop' },
      { projectId: 'project_1\n' },
      { artifactSha256: `${'c'.repeat(63)}\n` }
    ]) {
      expect(
        parse(figPluginNativeIntentSchema, { ...intent(), binding: { ...binding(), ...extra } }).ok
      ).toBe(false)
    }
    for (const field of ['actionId', 'authorityEpoch', 'instanceEpoch']) {
      for (const value of ['A'.repeat(32), `${'1'.repeat(31)}\n`, `${'1'.repeat(32)}\n`, 'x']) {
        expect(parse(figPluginNativeIntentSchema, { ...intent(), [field]: value }).ok).toBe(false)
      }
    }
    for (const expiresAt of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parse(figPluginNativeIntentSchema, { ...intent(), expiresAt }).ok).toBe(false)
    }
    const parsed = parse(figPluginNativeIntentSchema, intent())
    expect(parsed.ok && parsed.data.binding.profileId).toBe(binding().profileId)
  })

  it('cannot mix weak Figma and proposed Photoshop guarantees or enable production', () => {
    for (const extra of [
      { revision: 'native' },
      { exclusion: 'modal-scope' },
      { rollback: 'scoped-history' },
      { cancellation: 'modal-cooperative' },
      { profile: 'photoshop-modal-history' },
      { policy: 'enabled' },
      { availability: 'available' },
      { authenticated: true }
    ]) {
      expect(parse(figPluginNativeGuaranteeSchema, { ...guarantee(), ...extra }).ok).toBe(false)
    }
    for (const extra of [
      { revision: 'native' },
      { exclusion: true },
      { rollback: 'transaction' },
      { cancellation: 'before-dispatch-only' },
      { profile: 'figma-synchronous-detectable' }
    ]) {
      expect(
        parse(figPluginNativeGuaranteeSchema, { ...guarantee('photoshop'), ...extra }).ok
      ).toBe(false)
    }
    expect(
      parse(figPluginNativeIntentSchema, { ...intent(), guarantee: guarantee('photoshop') }).ok
    ).toBe(false)
  })

  it('rejects duplicate targets and preserves Unicode, whitespace and opaque observations', () => {
    const value = proposal()
    value.plan.steps.push({ ...value.plan.steps[0] })
    expect(parse(figPluginNativeProposalSchema, value).ok).toBe(false)
    for (const name of ['e\u0301', '\u00e9', ' A ', '😀'.repeat(60)]) {
      const checked = parse(figPluginNativeProposalSchema, { ...proposal(), plan: plan(1, name) })
      expect(checked.ok && checked.data.plan.steps[0].name).toBe(name)
    }
    const checked = parse(figPluginNativeProposalSchema, {
      ...proposal(),
      plan: { ...plan(), selectionRevision: 'untrusted-openEpoch-999' }
    })
    expect(checked.ok && checked.data.plan.selectionRevision).toBe('untrusted-openEpoch-999')
  })

  it('enforces step, name units, UTF-8 bytes, intent and independent binding/wire budgets', () => {
    expect(parse(figPluginNativeProposalSchema, { ...proposal(), plan: plan(20) }).ok).toBe(true)
    for (const next of [
      plan(0),
      plan(21),
      plan(1, 'x'.repeat(121)),
      plan(1, '界'.repeat(86)),
      plan(1, '😀'.repeat(61)),
      plan(1, '\n')
    ]) {
      expect(parse(figPluginNativeProposalSchema, { ...proposal(), plan: next }).ok).toBe(false)
    }
    const largePlan = plan(20, 'x'.repeat(120))
    largePlan.steps.forEach((step, index) => {
      step.targetId = `${index}-${'界'.repeat(125)}`
    })
    expect(parse(figPluginNativeProposalSchema, { ...proposal(), plan: largePlan }).ok).toBe(false)
    expect(
      figPluginNativeProposalSchema.safeParse({ ...proposal(), plan: largePlan }).success
    ).toBe(false)
    expect(
      parse(figPluginNativeIntentSchema, {
        ...intent(),
        binding: { ...binding(), profileId: '界'.repeat(512) }
      }).ok
    ).toBe(true)
    expect(
      parse(figPluginNativeIntentSchema, { ...intent(), padding: 'x'.repeat(65 * 1024) })
    ).toEqual({ ok: false, code: 'TOO_LARGE' })
  })

  it('separates native write consent from dialogue, pairing and hashes-as-grants', () => {
    expect(parse(figPluginNativeWriteConsentSchema, consent()).ok).toBe(true)
    for (const value of [
      { callId: actionId, payloadSha256 },
      { ...consent(), callId: actionId },
      { ...consent(), dialogueCallId: actionId },
      { ...consent(), approveBridge: true },
      { ...consent(), pairingSecret: payloadSha256 },
      { ...consent(), granted: true },
      { ...consent(), purpose: 'dialogue-consent' },
      { ...consent(), payloadSha256: `${'b'.repeat(63)}\n` }
    ]) {
      expect(parse(figPluginNativeWriteConsentSchema, value).ok).toBe(false)
    }
  })

  it('bounds fixed-command claims without introducing arbitrary API arguments', () => {
    const claim = {
      ...reference(),
      purpose: 'native-command-claim',
      total: 20,
      claimedAt: 0,
      expiresAt: 120_000
    }
    expect(parse(figPluginNativeClaimSchema, claim).ok).toBe(true)
    for (const extra of [
      { total: 21 },
      { total: 0 },
      { total: 1.5 },
      { command: 'eval' },
      { args: {} },
      { script: 'body' },
      { guarantee: guarantee('photoshop') },
      { claimedAt: -1 },
      { expiresAt: -1 },
      { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      { evidence: 'authenticated-host' }
    ]) {
      expect(parse(figPluginNativeClaimSchema, { ...claim, ...extra }).ok).toBe(false)
    }
    expect(parse(figPluginNativeClaimSchema, { ...claim, claimedAt: 2, expiresAt: 1 }).ok).toBe(
      false
    )
  })

  it('bounds progress ring/cursor/order and checks ordinal/index/completed/total', () => {
    const ring = {
      ...progress(),
      cursor: 1_000_000_000,
      events: Array.from({ length: 32 }, (_, i) => event(1_000_000_000 - 31 + i))
    }
    expect(parse(figPluginNativeProgressSchema, ring).ok).toBe(true)
    for (const extra of [
      { cursor: 1_000_000_001 },
      { cursor: -1 },
      { cursor: 0.5 },
      { events: Array.from({ length: 33 }, (_, i) => event(i + 1)), cursor: 33 },
      { events: [event(2), event(1)], cursor: 2 },
      { events: [event(), event()] },
      { events: [event(2)], cursor: 1 },
      { total: 21 }
    ]) {
      expect(parse(figPluginNativeProgressSchema, { ...progress(), ...extra }).ok).toBe(false)
    }
    for (const extra of [
      { index: 20 },
      { index: -1 },
      { ordinal: 21 },
      { ordinal: 0 },
      { ordinal: 2 },
      { completed: 2 },
      { completed: -1 },
      { completed: 0.5 },
      { total: 2 },
      { sequence: 0 },
      { sequence: 1_000_000_001 },
      { effect: 'rolled-back' },
      { name: 'real name' }
    ]) {
      expect(
        parse(figPluginNativeProgressSchema, { ...progress(), events: [{ ...event(), ...extra }] })
          .ok
      ).toBe(false)
    }
  })

  it('rejects internally contradictory progress counts and pre-dispatch effects', () => {
    const preDispatch = ['capturing', 'awaiting-write-consent', 'approved', 'claimed']
    for (const phase of preDispatch) {
      expect(
        parse(figPluginNativeProgressSchema, {
          ...progress(),
          events: [{ ...event(), phase, completed: 0, effect: 'none' }]
        }).ok
      ).toBe(true)
      for (const extra of [
        { completed: 1, effect: 'applied' },
        { completed: 0, effect: 'unknown' },
        { completed: 0, effect: 'partial' },
        { completed: 1, effect: 'none' }
      ]) {
        expect(
          parse(figPluginNativeProgressSchema, {
            ...progress(),
            events: [{ ...event(), phase, ...extra }]
          }).ok
        ).toBe(false)
      }
    }
    for (const extra of [
      { completed: 1, effect: 'none' },
      { completed: 0, effect: 'applied' },
      { completed: 1, effect: 'partial' }
    ]) {
      expect(
        parse(figPluginNativeProgressSchema, {
          ...progress(),
          events: [{ ...event(), ...extra }]
        }).ok
      ).toBe(false)
    }
    expect(
      parse(figPluginNativeProgressSchema, {
        ...progress(),
        events: [{ ...event(), phase: 'executing', completed: 0, effect: 'unknown' }]
      }).ok
    ).toBe(true)
  })

  it('requires original observations for a Photoshop rollback claim, even if explicitly unverified', () => {
    const rollback = {
      ...result('photoshop'),
      completed: 0,
      effect: 'rolled-back',
      readback: [{ index: 0, observation: 'original' }]
    }
    expect(parse(figPluginNativeResultSchema, rollback).ok).toBe(true)
    for (const observation of ['unknown', 'other', 'requested']) {
      for (const evidence of [undefined, 'unverified-host-report']) {
        const value: Record<string, unknown> = {
          ...rollback,
          readback: [{ index: 0, observation }]
        }
        if (evidence === undefined) delete value.evidence
        else value.evidence = evidence
        expect(parse(figPluginNativeResultSchema, value).ok).toBe(false)
      }
    }
  })

  it('rejects pre-dispatch lifecycle status claims of completed steps or document effects', () => {
    for (const lifecycle of [
      'queued',
      'capturing',
      'awaiting-write-consent',
      'approved',
      'claimed'
    ]) {
      expect(
        parse(figPluginNativeStatusSchema, {
          ...status(),
          status: lifecycle,
          completed: 0,
          effect: 'none'
        }).ok
      ).toBe(true)
      for (const extra of [
        { completed: 1, effect: 'applied' },
        { completed: 0, effect: 'partial' },
        { completed: 0, effect: 'unknown' },
        { completed: 1, effect: 'none' }
      ]) {
        expect(
          parse(figPluginNativeStatusSchema, { ...status(), status: lifecycle, ...extra }).ok
        ).toBe(false)
      }
    }
    for (const lifecycle of ['cancelled', 'failed', 'expired', 'quarantined']) {
      for (const effect of ['partial', 'unknown']) {
        expect(
          parse(figPluginNativeStatusSchema, {
            ...status(),
            status: lifecycle,
            completed: 0,
            effect
          }).ok
        ).toBe(true)
      }
    }
  })

  it('keeps cancellation status independent of observed effect', () => {
    expect(parse(figPluginNativeStatusSchema, status()).ok).toBe(true)
    expect(
      parse(figPluginNativeStatusSchema, { ...status(), completed: 0, effect: 'unknown' }).ok
    ).toBe(true)
    expect(parse(figPluginNativeResultSchema, { ...result(), status: 'cancelled' }).ok).toBe(true)
    expect(parse(figPluginNativeStatusSchema, { ...status(), effect: 'rolled-back' }).ok).toBe(
      false
    )
    expect(parse(figPluginNativeStatusSchema, { ...status(), completed: 2 }).ok).toBe(false)
  })

  it('requires complete per-step metadata and a matching requested-observation count', () => {
    expect(parse(figPluginNativeResultSchema, result()).ok).toBe(true)
    for (const extra of [
      { readback: [] },
      { total: 2 },
      { completed: 0 },
      { readback: [{ index: 1, observation: 'requested' }] },
      { readback: [{ index: 0, observation: 'unknown' }] },
      {
        total: 2,
        completed: 2,
        readback: [
          { index: 0, observation: 'requested' },
          { index: 0, observation: 'requested' }
        ]
      },
      { effect: 'none' },
      { effect: 'partial' },
      { settledAt: 0.5 }
    ]) {
      expect(parse(figPluginNativeResultSchema, { ...result(), ...extra }).ok).toBe(false)
    }
    for (const observation of ['original', 'other', 'unknown']) {
      const effect =
        observation === 'original' ? 'none' : observation === 'other' ? 'partial' : 'unknown'
      expect(
        parse(figPluginNativeResultSchema, {
          ...result(),
          completed: 0,
          effect,
          readback: [{ index: 0, observation }]
        }).ok
      ).toBe(true)
    }
    const rollback = {
      ...result('photoshop'),
      completed: 0,
      effect: 'rolled-back',
      readback: [{ index: 0, observation: 'original' }]
    }
    expect(parse(figPluginNativeResultSchema, rollback).ok).toBe(true)
    expect(parse(figPluginNativeResultSchema, { ...rollback, host: 'figma' }).ok).toBe(false)
    expect(
      parse(figPluginNativeResultSchema, { ...rollback, evidence: 'verified-rollback' }).ok
    ).toBe(false)
  })

  it('rejects pre-dispatch audit phases claiming effects without upgrading host evidence', () => {
    const audit = {
      ...wire,
      purpose: 'native-command-audit',
      actionId,
      payloadSha256,
      host: 'figma',
      index: 0,
      phase: 'capturing',
      effect: 'none',
      at: 20
    }
    for (const phase of ['capturing', 'awaiting-write-consent', 'approved', 'claimed']) {
      expect(parse(figPluginNativeAuditSchema, { ...audit, phase }).ok).toBe(true)
      for (const effect of ['applied', 'partial', 'unknown', 'rolled-back']) {
        expect(parse(figPluginNativeAuditSchema, { ...audit, phase, effect }).ok).toBe(false)
      }
    }
    for (const phase of ['executing', 'readback', 'settled']) {
      for (const effect of ['none', 'partial', 'unknown', 'applied']) {
        expect(parse(figPluginNativeAuditSchema, { ...audit, phase, effect }).ok).toBe(true)
      }
    }
    expect(
      parse(figPluginNativeAuditSchema, {
        ...audit,
        host: 'photoshop',
        phase: 'settled',
        effect: 'rolled-back'
      }).ok
    ).toBe(true)
    expect(
      parse(figPluginNativeAuditSchema, {
        ...audit,
        phase: 'settled',
        effect: 'rolled-back'
      }).ok
    ).toBe(false)
  })

  it('rejects sensitive free text and identifiers throughout metadata records', () => {
    const audit = {
      ...wire,
      purpose: 'native-command-audit',
      actionId,
      payloadSha256,
      host: 'figma',
      index: 0,
      phase: 'readback',
      effect: 'applied',
      at: 20
    }
    expect(parse(figPluginNativeAuditSchema, audit).ok).toBe(true)
    const records = [
      [
        figPluginNativeClaimSchema,
        { ...reference(), purpose: 'native-command-claim', total: 1, claimedAt: 0, expiresAt: 1 }
      ],
      [figPluginNativeStatusSchema, status()],
      [figPluginNativeResultSchema, result()],
      [figPluginNativeProgressSchema, progress()],
      [figPluginNativeAuditSchema, audit],
      [figPluginNativeWriteConsentSchema, consent()]
    ] as const
    for (const field of [
      'name',
      'path',
      'targetId',
      'documentId',
      'sourceBody',
      'message',
      'error',
      'args',
      'script',
      'token'
    ]) {
      for (const [schema, value] of records) {
        expect(parse(schema, { ...value, [field]: 'sensitive' }).ok).toBe(false)
      }
      expect(
        parse(figPluginNativeResultSchema, {
          ...result(),
          readback: [{ index: 0, observation: 'requested', [field]: 'sensitive' }]
        }).ok
      ).toBe(false)
    }
  })

  it('detaches input before validation without invoking getters or toJSON', () => {
    let calls = 0
    const getter = Object.defineProperty(proposal(), 'host', {
      enumerable: true,
      get: () => {
        calls += 1
        return 'figma'
      }
    })
    expect(parse(figPluginNativeProposalSchema, getter)).toEqual({
      ok: false,
      code: 'INVALID_DATA'
    })
    const jsonHook = {
      ...proposal(),
      toJSON: () => {
        calls += 1
        return proposal()
      }
    }
    expect(parse(figPluginNativeProposalSchema, jsonHook)).toEqual({
      ok: false,
      code: 'INVALID_DATA'
    })
    expect(calls).toBe(0)
    const value = proposal()
    const detached = parse(figPluginNativeProposalSchema, value)
    value.plan.steps[0].name = 'changed later'
    expect(detached.ok && detached.data.plan.steps[0].name).toBe('Renamed')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const invalid of [
      cycle,
      new Date(),
      { ...proposal(), steps: Array(101).fill(null) },
      {
        ...proposal(),
        huge: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), null]))
      }
    ]) {
      expect(parse(figPluginNativeProposalSchema, invalid).ok).toBe(false)
    }
  })

  it('requires main isProxy rejection before reflection, not a shared Proxy sandbox', () => {
    let traps = 0
    const proxy = new Proxy(proposal(), {
      ownKeys: () => {
        traps += 1
        throw new Error('secret trap')
      }
    })
    expect(parse(figPluginNativeProposalSchema, proxy, types.isProxy)).toEqual({
      ok: false,
      code: 'INVALID_DATA'
    })
    expect(traps).toBe(0)
    expect(
      parse(
        figPluginNativeProposalSchema,
        { ...proposal(), plan: new Proxy(plan(), {}) },
        types.isProxy
      ).ok
    ).toBe(false)
    expect(parse(figPluginNativeProposalSchema, proxy)).toEqual({ ok: false, code: 'INVALID_DATA' })
    expect(traps).toBe(1)
    expect(parse(figPluginNativeProposalSchema, new Proxy(proposal(), {})).ok).toBe(true)
  })

  it('returns only safe fixed error codes for unknown keys and thrown validators', () => {
    const checked = parse(figPluginNativeResultSchema, {
      ...result(),
      'fixture/path/name': 'secret'
    })
    expect(checked).toEqual({ ok: false, code: 'INVALID_COMMAND' })
    expect(JSON.stringify(checked)).not.toContain('secret')
    expect(JSON.stringify(checked)).not.toContain('fixture/path/name')
    const throwing = figPluginNativeProposalSchema.refine(() => {
      throw new Error('raw secret error')
    })
    expect(parse(throwing, proposal())).toEqual({ ok: false, code: 'INVALID_COMMAND' })
  })
})
