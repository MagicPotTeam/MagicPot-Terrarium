import { describe, expect, it } from 'vitest'
import {
  FIGPLUGIN_VISUAL_CORRECTION_AUTHORIZATION_TTL_MS,
  FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
  figPluginDesktopVisualBaselineAcceptanceSchema,
  figPluginDesktopVisualCorrectionAuthorizationRequestSchema,
  figPluginExecutionDesktopStateSchema,
  figPluginExecutionResultRequestSchema,
  figPluginExecutionStatusSchema,
  figPluginVisualBaselineComparisonSchema,
  figPluginVisualBaselineSchema,
  figPluginVisualCorrectionAuthorizationSchema,
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
        visualEvidence: [evidence],
        visualEvidenceSha256: 'f'.repeat(64)
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

  it('requires the evidence digest and evidence array together on public status', () => {
    expect(() =>
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
      })
    ).toThrow(/incomplete visual evidence status/i)
    expect(() =>
      figPluginExecutionStatusSchema.parse({
        protocol: 1,
        executionId: result.executionId,
        callId: 'f'.repeat(32),
        state: 'completed',
        completed: 1,
        total: 1,
        effect: 'applied',
        updatedAt: 1,
        visualEvidenceSha256: 'f'.repeat(64)
      })
    ).toThrow(/incomplete visual evidence status/i)
  })

  it('accepts a bounded user checkpoint descriptor with a fixed correction round cap', () => {
    const baseline = figPluginVisualBaselineSchema.parse({
      protocol: 1,
      baselineId: '1'.repeat(32),
      sourceExecutionId: result.executionId,
      pluginId: 'demo.figma',
      host: 'figma',
      projectId: 'project_1',
      documentId: readback.documentId,
      scopeId: readback.scopeId,
      captureId: readback.captureId,
      planSha256: '2'.repeat(64),
      contextSha256: '3'.repeat(64),
      visualEvidenceSha256: '4'.repeat(64),
      adapterVersion: 'figma-native-1',
      targets: [{ targetId: evidence.targetId, accepted: evidence.after }],
      acceptedAt: 10,
      expiresAt: 20,
      correctionRoundsUsed: 0,
      maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS
    })
    expect(
      figPluginExecutionDesktopStateSchema.parse({
        previews: [],
        statuses: [],
        baselines: [baseline],
        correctionAuthorizations: []
      }).baselines
    ).toEqual([baseline])
    expect(
      figPluginDesktopVisualBaselineAcceptanceSchema.parse({
        executionId: baseline.sourceExecutionId,
        visualEvidenceSha256: baseline.visualEvidenceSha256
      })
    ).toEqual({
      executionId: baseline.sourceExecutionId,
      visualEvidenceSha256: baseline.visualEvidenceSha256
    })
    expect(() =>
      figPluginVisualBaselineSchema.parse({
        ...baseline,
        targets: [baseline.targets[0], baseline.targets[0]]
      })
    ).toThrow(/duplicate visual baseline target/i)
    expect(() =>
      figPluginVisualBaselineSchema.parse({ ...baseline, expiresAt: baseline.acceptedAt })
    ).toThrow(/expiry/i)
    expect(() =>
      figPluginVisualBaselineSchema.parse({
        ...baseline,
        correctionRoundsUsed: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS + 1
      })
    ).toThrow()
  })

  it('accepts one bounded future correction authorization without claiming execution', () => {
    const authorizedAt = 100
    const authorization = figPluginVisualCorrectionAuthorizationSchema.parse({
      protocol: 1,
      authorizationId: '5'.repeat(32),
      baselineId: '1'.repeat(32),
      sourceExecutionId: result.executionId,
      pluginId: 'demo.figma',
      host: 'figma',
      projectId: 'project_1',
      documentId: readback.documentId,
      scopeId: readback.scopeId,
      captureId: readback.captureId,
      adapterVersion: 'figma-native-1',
      baselineEvidenceSha256: '4'.repeat(64),
      visualEvidenceSha256: 'f'.repeat(64),
      comparisonSha256: '6'.repeat(64),
      authorizedTargetIds: ['node_1', 'node_2'],
      round: 1,
      maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
      authorizedAt,
      expiresAt: authorizedAt + FIGPLUGIN_VISUAL_CORRECTION_AUTHORIZATION_TTL_MS,
      state: 'authorized'
    })
    expect(
      figPluginExecutionDesktopStateSchema.parse({
        previews: [],
        statuses: [],
        baselines: [],
        correctionAuthorizations: [authorization]
      }).correctionAuthorizations
    ).toEqual([authorization])
    expect(
      figPluginDesktopVisualCorrectionAuthorizationRequestSchema.parse({
        executionId: authorization.sourceExecutionId,
        baselineId: authorization.baselineId,
        visualEvidenceSha256: authorization.visualEvidenceSha256
      })
    ).toEqual({
      executionId: authorization.sourceExecutionId,
      baselineId: authorization.baselineId,
      visualEvidenceSha256: authorization.visualEvidenceSha256
    })
    expect(() =>
      figPluginVisualCorrectionAuthorizationSchema.parse({
        ...authorization,
        authorizedTargetIds: ['node_2', 'node_1']
      })
    ).toThrow(/unsorted/i)
    expect(() =>
      figPluginVisualCorrectionAuthorizationSchema.parse({
        ...authorization,
        authorizedTargetIds: ['node_1', 'node_1']
      })
    ).toThrow(/duplicate/i)
    expect(() =>
      figPluginVisualCorrectionAuthorizationSchema.parse({
        ...authorization,
        expiresAt: authorization.authorizedAt
      })
    ).toThrow(/expiry/i)
  })

  it('validates exact and changed comparisons against an accepted bounded checkpoint', () => {
    const exact = figPluginVisualBaselineComparisonSchema.parse({
      protocol: 1,
      baselineId: '1'.repeat(32),
      executionId: result.executionId,
      baselineEvidenceSha256: '4'.repeat(64),
      visualEvidenceSha256: 'f'.repeat(64),
      comparedAt: 10,
      targets: [
        {
          targetId: evidence.targetId,
          baseline: evidence.after,
          current: evidence.after,
          changed: false
        }
      ],
      changedCount: 0,
      exactMatch: true
    })
    expect(
      figPluginExecutionStatusSchema.parse({
        protocol: 1,
        executionId: result.executionId,
        callId: 'f'.repeat(32),
        state: 'completed',
        completed: 1,
        total: 1,
        effect: 'applied',
        updatedAt: 10,
        visualEvidence: [evidence],
        visualEvidenceSha256: exact.visualEvidenceSha256,
        visualBaselineComparison: exact
      }).visualBaselineComparison
    ).toEqual(exact)

    const changed = figPluginVisualBaselineComparisonSchema.parse({
      ...exact,
      targets: [
        {
          targetId: evidence.targetId,
          baseline: point('c'),
          current: evidence.after,
          changed: true
        }
      ],
      changedCount: 1,
      exactMatch: false
    })
    expect(changed.changedCount).toBe(1)
    expect(changed.exactMatch).toBe(false)
  })

  it('rejects forged visual comparisons and status bindings', () => {
    const comparison = {
      protocol: 1,
      baselineId: '1'.repeat(32),
      executionId: result.executionId,
      baselineEvidenceSha256: '4'.repeat(64),
      visualEvidenceSha256: 'f'.repeat(64),
      comparedAt: 10,
      targets: [
        {
          targetId: evidence.targetId,
          baseline: evidence.after,
          current: evidence.after,
          changed: false
        }
      ],
      changedCount: 0,
      exactMatch: true
    }
    expect(() =>
      figPluginVisualBaselineComparisonSchema.parse({
        ...comparison,
        targets: [{ ...comparison.targets[0], changed: true }]
      })
    ).toThrow(/change mismatch/i)
    expect(() =>
      figPluginVisualBaselineComparisonSchema.parse({ ...comparison, changedCount: 1 })
    ).toThrow(/changed count mismatch/i)
    expect(() =>
      figPluginVisualBaselineComparisonSchema.parse({ ...comparison, exactMatch: false })
    ).toThrow(/exact match mismatch/i)

    const status = {
      protocol: 1,
      executionId: result.executionId,
      callId: 'f'.repeat(32),
      state: 'completed',
      completed: 1,
      total: 1,
      effect: 'applied',
      updatedAt: 10,
      visualEvidence: [evidence],
      visualEvidenceSha256: comparison.visualEvidenceSha256,
      visualBaselineComparison: comparison
    }
    expect(() =>
      figPluginExecutionStatusSchema.parse({
        ...status,
        visualBaselineComparison: {
          ...comparison,
          executionId: '2'.repeat(32)
        }
      })
    ).toThrow(/execution mismatch/i)
    expect(() =>
      figPluginExecutionStatusSchema.parse({
        ...status,
        visualEvidenceSha256: 'e'.repeat(64)
      })
    ).toThrow(/evidence mismatch/i)
    expect(() =>
      figPluginExecutionStatusSchema.parse({
        ...status,
        visualBaselineComparison: {
          ...comparison,
          targets: [
            {
              ...comparison.targets[0],
              current: point('d'),
              changed: true
            }
          ],
          changedCount: 1,
          exactMatch: false
        }
      })
    ).toThrow(/target mismatch/i)
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
        visualEvidence: [evidence],
        visualEvidenceSha256: 'f'.repeat(64)
      })
    ).toThrow(/visual evidence/i)
  })
})
