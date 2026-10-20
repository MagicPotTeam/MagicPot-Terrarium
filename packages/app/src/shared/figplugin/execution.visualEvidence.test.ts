import { describe, expect, it } from 'vitest'
import {
  figPluginExecutionResultRequestSchema,
  figPluginExecutionStatusSchema,
  figPluginVisualEvidenceSchema
} from './execution'

const point = (value: string) => ({ sha256: value.repeat(64), width: 64, height: 32 })
const evidence = {
  targetId: 'node_1',
  before: point('a'),
  after: point('b'),
  changed: true
}
const readback = {
  version: 1 as const,
  kind: 'host-plan-readback' as const,
  host: 'figma' as const,
  documentId: 'document_1',
  scopeId: 'page_1',
  captureId: 'c'.repeat(32),
  steps: [
    {
      targetId: 'node_1',
      command: 'node.rename' as const,
      observation: 'requested' as const,
      value: 'New name'
    }
  ]
}
const result = {
  protocol: 1 as const,
  executionId: 'd'.repeat(32),
  actionId: 'e'.repeat(32),
  status: 'completed' as const,
  effect: 'applied' as const,
  completed: 1,
  total: 1,
  readback,
  visualEvidence: [evidence]
}

describe('FIGPLUGIN visual evidence contract', () => {
  it('accepts bounded before/after hashes on an applied completed result', () => {
    expect(figPluginExecutionResultRequestSchema.parse(result).visualEvidence).toEqual([evidence])
    expect(
      figPluginExecutionStatusSchema.parse({
        protocol: 1,
        executionId: result.executionId,
        callId: 'f'.repeat(32),
        state: 'completed',
        completed: 1,
        total: 1,
        effect: 'applied',
        updatedAt: 1,
        visualEvidence: [evidence]
      }).visualEvidence
    ).toEqual([evidence])
  })

  it('rejects a claimed changed flag that disagrees with the bounded hashes', () => {
    expect(() =>
      figPluginVisualEvidenceSchema.parse({ ...evidence, after: evidence.before, changed: true })
    ).toThrow(/change mismatch/i)
  })

  it('rejects duplicate targets and dimensions outside the 512px evidence bound', () => {
    expect(() =>
      figPluginExecutionResultRequestSchema.parse({
        ...result,
        visualEvidence: [evidence, { ...evidence }]
      })
    ).toThrow(/duplicate/i)
    expect(() =>
      figPluginExecutionResultRequestSchema.parse({
        ...result,
        visualEvidence: [{ ...evidence, after: { ...evidence.after, width: 513 } }]
      })
    ).toThrow()
  })

  it('does not attach visual evidence to a failed or nonterminal execution', () => {
    expect(() =>
      figPluginExecutionResultRequestSchema.parse({
        ...result,
        status: 'failed',
        effect: 'unknown',
        completed: 0,
        errorCode: 'QUARANTINED'
      })
    ).toThrow(/visual evidence/i)
    expect(() =>
      figPluginExecutionStatusSchema.parse({
        protocol: 1,
        executionId: result.executionId,
        callId: 'f'.repeat(32),
        state: 'readback',
        completed: 1,
        total: 1,
        effect: 'applied',
        updatedAt: 1,
        visualEvidence: [evidence]
      })
    ).toThrow(/visual evidence/i)
  })
})
