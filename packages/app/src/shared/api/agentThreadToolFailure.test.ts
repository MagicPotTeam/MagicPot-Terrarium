import { describe, expect, it, vi } from 'vitest'
import { AGENT_TOOL_FAILURE_MAX_BYTES, readAgentToolFailurePayload } from './agentThreadToolFailure'
import { unwrapUnaryIpcResult } from './apiUtils/unaryIpcResult'

const receipt = () => ({ kind: 'agent-tool-failure/v1', toolResult: { content: '' }, toolHistory: [{ runId: 'run', toolCallId: 'call', toolName: 'tool', args: {}, status: 'failed', content: '' }] })
describe('bounded unary tool failure data', () => {
  it('detaches the full passive receipt and preserves explicitly empty content', () => {
    const original = receipt(), copy = readAgentToolFailurePayload(original)
    expect(copy).toEqual(original)
    expect(copy).not.toBe(original)
    original.toolHistory[0].content = 'later mutation'
    expect(copy?.toolHistory).toMatchObject([{ content: '' }])
  })
  it('bounds the entire serialized UTF-8 receipt, not JavaScript string length', () => {
    const original = receipt(), overhead = new TextEncoder().encode(JSON.stringify(original)).length
    original.toolResult.content = 'a'.repeat(AGENT_TOOL_FAILURE_MAX_BYTES - overhead)
    expect(readAgentToolFailurePayload(original)).toEqual(original)
    original.toolResult.content += 'a'
    expect(readAgentToolFailurePayload(original)).toBeUndefined()
    original.toolResult.content = '中'.repeat(24000)
    expect(readAgentToolFailurePayload(original)).toBeUndefined()
  })
  it.each(['root', 'result', 'entry', 'status', 'mixed-omission', 'missing-result'] as const)('rejects malformed/extra %s fields', kind => {
    const original = receipt()
    if (kind === 'root') Object.assign(original, { body: 'raw provider diagnostic' })
    if (kind === 'result') Object.assign(original.toolResult, { execute: true })
    if (kind === 'entry') Object.assign(original.toolHistory[0], { approval: 'claimed' })
    if (kind === 'status') original.toolHistory[0].status = 'ok'
    if (kind === 'mixed-omission') Object.assign(original, { receiptOmitted: true })
    if (kind === 'missing-result') delete (original as { toolResult?: unknown }).toolResult
    expect(readAgentToolFailurePayload(original)).toBeUndefined()
  })
  it.each(['getter', 'toJSON', 'function', 'cycle', 'depth', 'nodes', 'members', 'sparse', 'reserved', 'class'] as const)('rejects %s passive-data violations without hooks', kind => {
    const hook = vi.fn(() => { throw new Error('must not execute') })
    const value: Record<string, unknown> = {}
    if (kind === 'getter') Object.defineProperty(value, 'x', { enumerable: true, get: hook })
    if (kind === 'toJSON') value.toJSON = hook
    if (kind === 'function') value.fn = hook
    if (kind === 'cycle') value.self = value
    if (kind === 'depth') { let parent = value; for (let i = 0; i < 17; i++) { parent.next = {}; parent = parent.next as Record<string, unknown> } }
    if (kind === 'nodes') value.nodes = Array.from({ length: 100 }, () => Array(24).fill(null))
    if (kind === 'members') for (let i = 0; i < 257; i++) value[`k${i}`] = i
    if (kind === 'sparse') value.items = new Array(4)
    if (kind === 'reserved') Object.assign(value, JSON.parse('{"constructor":{"approved":true}}'))
    const original = { ...receipt(), toolResult: { content: '', metadata: kind === 'class' ? new Date() : value } }
    expect(readAgentToolFailurePayload(original)).toBeUndefined()
    expect(hook).not.toHaveBeenCalled()
  })
  it('keeps exact omission and undefined success distinct from malformed envelopes', () => {
    const omitted = { kind: 'agent-tool-failure/v1', receiptOmitted: true }
    expect(readAgentToolFailurePayload(omitted)).toEqual(omitted)
    expect(unwrapUnaryIpcResult({ ok: true, value: undefined })).toBeUndefined()
    expect(() => unwrapUnaryIpcResult({ ok: true })).toThrow('Invalid unary IPC result')
    expect(() => unwrapUnaryIpcResult({ ok: false, error: { message: 'failed', payload: omitted } })).toThrow()
  })
})
