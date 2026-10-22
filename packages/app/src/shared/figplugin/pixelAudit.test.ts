import { describe, expect, it } from 'vitest'
import {
  figPluginPixelAuditRequestSchema,
  figPluginPixelAuditSchema,
  pixelAuditMatchesComparison,
  summarizePixelTargets
} from './pixelAudit'
const reference = {
  baselineId: 'a'.repeat(32),
  baselineEvidenceSha256: 'b'.repeat(64),
  visualEvidenceSha256: 'c'.repeat(64),
  targets: [
    {
      targetId: 'owned',
      baseline: { sha256: '1'.repeat(64), width: 4, height: 3 },
      current: { sha256: '2'.repeat(64), width: 4, height: 3 }
    }
  ]
}
const target = {
  targetId: 'owned',
  status: 'compared' as const,
  pixelCount: 12,
  changedPixels: 1,
  maxChannelDelta: 10,
  absoluteDelta: 10,
  changedBounds: { x: 2, y: 1, width: 1, height: 1 }
}
const request = {
  ...reference,
  protocol: 1,
  executionId: 'd'.repeat(32),
  actionId: 'e'.repeat(32),
  policy: 'rgba8-exact-v1',
  targets: [target]
}

describe('pixel evidence contract', () => {
  it('binds exact per-target metrics and derives the summary rather than trusting a host pass flag', () => {
    const parsed = figPluginPixelAuditRequestSchema.parse(request)
    expect(pixelAuditMatchesComparison(parsed, reference)).toBe(true)
    expect(summarizePixelTargets(parsed.targets)).toEqual({
      outcome: 'different',
      comparedTargets: 1,
      unavailableTargets: 0,
      changedTargets: 1,
      changedPixels: 1
    })
    const report = {
      ...reference,
      policy: request.policy,
      targets: parsed.targets,
      checkedAt: 100,
      ...summarizePixelTargets(parsed.targets)
    }
    expect(figPluginPixelAuditSchema.parse(report)).toEqual(report)
    expect(() => figPluginPixelAuditSchema.parse({ ...report, outcome: 'match' })).toThrow()
  })
  it.each([
    { changedPixels: 13 },
    { changedPixels: 0 },
    { pixelCount: 0 },
    { maxChannelDelta: 0 },
    { maxChannelDelta: 256 },
    { absoluteDelta: 0 },
    { absoluteDelta: 41 },
    { changedBounds: null },
    { changedBounds: { x: 0, y: 0, width: 0, height: 1 } },
    { pixels: 'PRIVATE' },
    { png: 'PRIVATE' }
  ])('rejects inconsistent or raw pixel payload %j', (change) => {
    expect(() =>
      figPluginPixelAuditRequestSchema.parse({ ...request, targets: [{ ...target, ...change }] })
    ).toThrow()
  })
  it('rejects foreign/duplicate/missing/oversized targets and wrong source fingerprints', () => {
    expect(() =>
      figPluginPixelAuditRequestSchema.parse({ ...request, targets: [target, target] })
    ).toThrow()
    expect(() => figPluginPixelAuditRequestSchema.parse({ ...request, targets: [] })).toThrow()
    expect(() =>
      figPluginPixelAuditRequestSchema.parse({
        ...request,
        targets: Array.from({ length: 21 }, (_, i) => ({ ...target, targetId: String(i) }))
      })
    ).toThrow()
    for (const change of [
      { baselineId: 'f'.repeat(32) },
      { visualEvidenceSha256: 'f'.repeat(64) },
      { baselineEvidenceSha256: 'f'.repeat(64) },
      { targets: [{ ...target, targetId: 'foreign' }] },
      { targets: [{ ...target, pixelCount: 13 }] },
      { targets: [{ ...target, changedBounds: { x: 4, y: 1, width: 1, height: 1 } }] }
    ])
      expect(pixelAuditMatchesComparison({ ...request, ...change }, reference)).toBe(false)
  })
  it('missing pixels are incomplete, and size mismatch is never silently resampled', () => {
    expect(summarizePixelTargets([{ targetId: 'owned', status: 'unavailable' }]).outcome).toBe(
      'incomplete'
    )
    const report = {
      ...request,
      targets: [{ targetId: 'owned', status: 'dimensions-changed' as const }]
    }
    expect(pixelAuditMatchesComparison(report, reference)).toBe(false)
    expect(
      pixelAuditMatchesComparison(report, {
        ...reference,
        targets: [
          { ...reference.targets[0], current: { ...reference.targets[0].current, width: 5 } }
        ]
      })
    ).toBe(true)
    expect(
      pixelAuditMatchesComparison(request, {
        ...reference,
        targets: [{ ...reference.targets[0], current: reference.targets[0].baseline }]
      })
    ).toBe(false)
  })
})
