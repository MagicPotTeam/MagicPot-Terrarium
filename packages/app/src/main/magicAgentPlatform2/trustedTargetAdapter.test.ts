import { describe, expect, it } from 'vitest'
import {
  createTrustedTargetRequest,
  parseTrustedTargetRequest,
  redactTrustedTargetRequest
} from './trustedTargetAdapter'

const base = {
  targetKind: 'agent-run' as const,
  targetId: 'agent-1',
  requestId: 'request-1',
  actorId: 'scheduler-1',
  input: { prompt: 'run task', token: 'do-not-log' },
  sessionId: 'session-1'
}

describe('trusted target adapter', () => {
  it('creates fixed agent-run and graph-run schemas with only the permitted effect', () => {
    const agent = createTrustedTargetRequest(base)
    const graph = createTrustedTargetRequest({
      ...base,
      targetKind: 'graph-run',
      targetId: 'graph-1',
      graphId: 'graph-1',
      graphRunId: 'graph-run-1'
    })

    expect(agent.action).toBe('agent.run')
    expect(agent.target).toMatchObject({ kind: 'agent-run', id: 'agent-1' })
    expect(agent.effects).toEqual([{ kind: 'tool.invoke', target: 'agent.run', risk: 'high' }])
    expect(graph.action).toBe('graph.run')
    expect(graph.target).toMatchObject({ kind: 'graph-run', id: 'graph-1' })
    expect(graph.effects).toEqual([{ kind: 'tool.invoke', target: 'graph.run', risk: 'high' }])
    expect(agent.metadata.effectsFixed).toBe(true)
    expect(agent.metadata.digestMarker).toMatch(
      /^trusted-target:sha256|^trusted-target:[a-f0-9]{64}$/
    )
  })

  it('redacts secrets while retaining a digest marker for the original request', () => {
    const request = createTrustedTargetRequest(base)
    const audit = redactTrustedTargetRequest(request)

    expect(audit.request.input.token).toBe('[REDACTED]')
    expect(audit.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(audit.redactedPaths).toContain('input.token')
    expect(JSON.stringify(audit.request)).not.toContain('do-not-log')
    expect(audit.request.metadata).toBeDefined()
    expect(audit.request.metadata?.digestMarker).toBe(request.metadata.digestMarker)
  })

  it('fails closed for injection keys, forged effects, and forged digest markers', () => {
    expect(() =>
      createTrustedTargetRequest({ ...base, input: { __proto__: { allow: true } } })
    ).toThrow()
    expect(() => createTrustedTargetRequest({ ...base, input: { approval: true } })).toThrow()

    const request = createTrustedTargetRequest(base)
    const forgedEffects = {
      ...request,
      effects: [{ kind: 'filesystem.delete', risk: 'destructive' }]
    }
    expect(() => parseTrustedTargetRequest(forgedEffects)).toThrow('effects are invalid')

    const forgedDigest = {
      ...request,
      metadata: { ...request.metadata, digestMarker: 'trusted-target:forged' }
    }
    expect(() => parseTrustedTargetRequest(forgedDigest)).toThrow('digest marker mismatch')
  })

  it('round-trips only the canonical adapter schema', () => {
    const request = createTrustedTargetRequest({
      ...base,
      targetKind: 'graph-run',
      targetId: 'graph-1',
      graphId: 'graph-1',
      graphRunId: 'graph-run-1',
      nodeId: 'node-1'
    })
    const parsed = parseTrustedTargetRequest(JSON.parse(JSON.stringify(request)))
    expect(parsed).toEqual(request)
    expect(Object.isFrozen(request)).toBe(true)
  })
})
