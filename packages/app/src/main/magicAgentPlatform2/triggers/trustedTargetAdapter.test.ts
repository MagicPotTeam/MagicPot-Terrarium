import { describe, expect, it } from 'vitest'
import {
  digestPolicyRequest,
  type TriggerPolicyRequestFactoryInput
} from '../../../shared/magicAgentPlatform2/policy'
import {
  adaptTrustedTriggerTarget,
  type TrustedTriggerExecutionTarget
} from './trustedTargetAdapter'

const base = (trustedTarget: unknown): Parameters<typeof adaptTrustedTriggerTarget>[0] => ({
  requestId: 'request-1',
  actor: { kind: 'scheduler', id: 'scheduler-1' },
  triggerId: 'trigger-1',
  occurrence: {
    occurrenceAt: 100,
    windowStart: 100,
    windowEnd: 100,
    missedCount: 0,
    nextFireAtAfter: 200
  },
  triggerBase: { type: 'schedule', title: 'Nightly', config: { ignored: true } },
  trustedTarget
})

describe('trusted trigger target adapter', () => {
  it('returns a boundary-compatible trigger request with canonical origin and action', () => {
    const result = adaptTrustedTriggerTarget(
      base({
        kind: 'agent-run',
        agentId: 'agent-1',
        prompt: 'secret prompt',
        sessionId: 'session-1'
      })
    )
    expect(result.request.origin).toBe('trigger')
    expect(result.request.action).toBe('trigger.execute')
    expect(result.request.target).toEqual({ kind: 'trigger', id: 'trigger-1' })
    expect(result.request.effects).toEqual([
      expect.objectContaining({ kind: 'tool.invoke', risk: 'high', target: 'agent-1' })
    ])
  })

  it('keeps raw execution payload main-only and excludes it from the policy request', () => {
    const result = adaptTrustedTriggerTarget(
      base({
        kind: 'agent-run',
        agentId: 'agent-1',
        prompt: 'secret prompt',
        sessionId: 'session-1'
      })
    )
    if (result.executionTarget.kind !== 'agent-run') throw new Error('expected agent target')
    expect(result.executionTarget.prompt).toBe('secret prompt')
    expect(JSON.stringify(result.request)).not.toContain('secret prompt')
    expect(JSON.stringify(result.request)).not.toContain('ignored')
    const triggerInput = result.request.input.trigger
    expect(
      triggerInput && typeof triggerInput === 'object' && !Array.isArray(triggerInput)
        ? triggerInput.config
        : undefined
    ).toMatchObject({
      targetKind: 'agent-run',
      destinationId: 'agent-1',
      sessionId: 'session-1',
      payloadDigest: expect.stringMatching(/^sha256:/)
    })
    expect(
      triggerInput && typeof triggerInput === 'object' && !Array.isArray(triggerInput)
        ? triggerInput.config
        : undefined
    ).not.toHaveProperty('prompt')
  })

  it('deep-freezes request, policy input, and execution target', () => {
    const result = adaptTrustedTriggerTarget(
      base({ kind: 'graph-run', graphId: 'graph-1', input: { secret: 'hidden' } })
    )
    expect(Object.isFrozen(result.request)).toBe(true)
    const trigger = result.request.input.trigger
    expect(trigger && typeof trigger === 'object' && !Array.isArray(trigger)).toBe(true)
    const config =
      trigger && typeof trigger === 'object' && !Array.isArray(trigger) ? trigger.config : undefined
    expect(config && typeof config === 'object' && !Array.isArray(config)).toBe(true)
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(result.executionTarget)).toBe(true)
  })

  it('changes payload digest and request digest when payload changes', () => {
    const first = adaptTrustedTriggerTarget(
      base({ kind: 'graph-run', graphId: 'graph-1', input: { secret: 'one' } })
    )
    const second = adaptTrustedTriggerTarget(
      base({ kind: 'graph-run', graphId: 'graph-1', input: { secret: 'two' } })
    )
    expect(
      (first.policyRequestInput.trigger.config as { payloadDigest?: string }).payloadDigest
    ).not.toBe(
      (second.policyRequestInput.trigger.config as { payloadDigest?: string }).payloadDigest
    )
    expect(digestPolicyRequest(first.request)).not.toBe(digestPolicyRequest(second.request))
  })

  it.each([
    ['unknown kind', { kind: 'other', id: 'x' }],
    ['extra key', { kind: 'agent-run', agentId: 'a', prompt: 'p', toolName: 'bad' }],
    ['missing prompt', { kind: 'agent-run', agentId: 'a' }],
    ['missing input', { kind: 'graph-run', graphId: 'g' }],
    ['non JSON input', { kind: 'graph-run', graphId: 'g', input: new Date() }]
  ])('fails closed for %s', (_name, target) => {
    expect(() => adaptTrustedTriggerTarget(base(target))).toThrow()
  })

  it('preserves validated raw execution target without exposing an alternate policy API', () => {
    const result = adaptTrustedTriggerTarget(
      base({ kind: 'graph-run', graphId: 'graph-1', input: { token: 'main-only' } })
    )
    const target: TrustedTriggerExecutionTarget = result.executionTarget
    expect(target.kind).toBe('graph-run')
    if (target.kind !== 'graph-run') throw new Error('expected graph target')
    expect(target.input).toEqual({ token: 'main-only' })
    expect(result.policyRequestInput.triggerId).toBe('trigger-1')
  })
})
