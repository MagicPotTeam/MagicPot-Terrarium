import { describe, expect, it } from 'vitest'

import {
  CanvasImageResourceBudgetTracker,
  buildCanvasImageResourceBudgetMetricsSnapshot,
  estimateCanvasImageTextureBytes,
  getCanvasImageResourceBudgetEvictionCandidates,
  resolveCanvasImageResourceBudgetAdmission,
  type CanvasImageResourceBudgetReservation
} from './canvasImageResourceBudget'

function reservation(
  id: string,
  overrides: Partial<CanvasImageResourceBudgetReservation> = {}
): CanvasImageResourceBudgetReservation {
  return {
    id,
    sourceTextureBytes: 0,
    thumbnailTextureBytes: 0,
    decodedInFlightBytes: 0,
    objectUrlCount: 0,
    activeSourceUpgrades: 0,
    evictable: true,
    visible: true,
    selected: false,
    priority: 0,
    lastAccessedAt: 0,
    ...overrides
  }
}

describe('canvasImageResourceBudget', () => {
  it('allows admission when source, thumbnail, decode, object URL, and source upgrade usage fits limits', () => {
    const decision = resolveCanvasImageResourceBudgetAdmission({
      currentUsage: {
        sourceTextureBytes: estimateCanvasImageTextureBytes(8, 8),
        thumbnailTextureBytes: 64,
        decodedInFlightBytes: 128,
        objectUrlCount: 1,
        activeSourceUpgrades: 1
      },
      request: {
        sourceTextureBytes: 128,
        thumbnailTextureBytes: 32,
        decodedInFlightBytes: 64,
        objectUrlCount: 1,
        activeSourceUpgrades: 1
      },
      limits: {
        sourceTextureBytes: 512,
        thumbnailTextureBytes: 128,
        decodedInFlightBytes: 256,
        objectUrlCount: 3,
        activeSourceUpgrades: 2
      }
    })

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('within-budget')
    expect(decision.reasons).toEqual([])
    expect(decision.projectedUsage).toEqual({
      sourceTextureBytes: 384,
      thumbnailTextureBytes: 96,
      decodedInFlightBytes: 192,
      objectUrlCount: 2,
      activeSourceUpgrades: 2
    })
  })

  it('denies admission with deterministic budget reasons for exceeded resources', () => {
    const decision = resolveCanvasImageResourceBudgetAdmission({
      currentUsage: {
        sourceTextureBytes: 900,
        thumbnailTextureBytes: 90,
        decodedInFlightBytes: 100,
        objectUrlCount: 1,
        activeSourceUpgrades: 0
      },
      request: {
        sourceTextureBytes: 200,
        thumbnailTextureBytes: 20,
        decodedInFlightBytes: 60,
        objectUrlCount: 1,
        activeSourceUpgrades: 1
      },
      limits: {
        sourceTextureBytes: 1024,
        thumbnailTextureBytes: 100,
        decodedInFlightBytes: 128,
        objectUrlCount: 10,
        activeSourceUpgrades: 2
      }
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('source-texture-budget')
    expect(decision.reasons).toEqual([
      'source-texture-budget',
      'thumbnail-texture-budget',
      'decoded-in-flight-budget'
    ])
    expect(decision.overBudget.map((pressure) => pressure.key)).toEqual([
      'sourceTextureBytes',
      'thumbnailTextureBytes',
      'decodedInFlightBytes'
    ])
  })

  it('tracks object URL budget independently from byte budgets', () => {
    const tracker = new CanvasImageResourceBudgetTracker({
      sourceTextureBytes: 10_000,
      thumbnailTextureBytes: 10_000,
      decodedInFlightBytes: 10_000,
      objectUrlCount: 2,
      activeSourceUpgrades: 10
    })

    expect(tracker.admit(reservation('url-a', { objectUrlCount: 1 })).allowed).toBe(true)
    expect(tracker.admit(reservation('url-b', { objectUrlCount: 1 })).allowed).toBe(true)

    const denied = tracker.admit(reservation('url-c', { objectUrlCount: 1 }))

    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('object-url-budget')
    expect(denied.projectedUsage.objectUrlCount).toBe(3)
    expect(tracker.getUsage().objectUrlCount).toBe(2)
  })

  it('enforces the active source upgrade budget for concurrent source upgrades', () => {
    const tracker = new CanvasImageResourceBudgetTracker({
      sourceTextureBytes: 10_000,
      thumbnailTextureBytes: 10_000,
      decodedInFlightBytes: 10_000,
      objectUrlCount: 10,
      activeSourceUpgrades: 1
    })

    expect(
      tracker.admit(
        reservation('upgrade-a', {
          decodedInFlightBytes: 512,
          activeSourceUpgrades: 1
        })
      ).allowed
    ).toBe(true)

    const denied = tracker.admit(
      reservation('upgrade-b', {
        decodedInFlightBytes: 128,
        activeSourceUpgrades: 1
      })
    )

    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('source-upgrade-budget')
    expect(denied.projectedUsage.activeSourceUpgrades).toBe(2)
  })

  it('returns eviction candidates that release pressured resources while protecting selected or explicit IDs', () => {
    const candidates = getCanvasImageResourceBudgetEvictionCandidates({
      limits: {
        sourceTextureBytes: 1_000,
        thumbnailTextureBytes: 1_000,
        decodedInFlightBytes: 512,
        objectUrlCount: 2,
        activeSourceUpgrades: 1
      },
      reservations: [
        reservation('visible-selected-source', {
          sourceTextureBytes: 800,
          selected: true,
          lastAccessedAt: 1
        }),
        reservation('offscreen-old-source', {
          sourceTextureBytes: 500,
          visible: false,
          lastAccessedAt: 1
        }),
        reservation('protected-object-url', {
          objectUrlCount: 1,
          visible: false,
          lastAccessedAt: 0
        }),
        reservation('upgrade-decode', {
          decodedInFlightBytes: 256,
          activeSourceUpgrades: 1,
          visible: false,
          lastAccessedAt: 2
        }),
        reservation('not-evictable', {
          sourceTextureBytes: 500,
          evictable: false
        })
      ],
      request: {
        sourceTextureBytes: 300,
        decodedInFlightBytes: 300,
        objectUrlCount: 2,
        activeSourceUpgrades: 1
      },
      protectedIds: new Set(['protected-object-url'])
    })

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'offscreen-old-source',
      'upgrade-decode',
      'visible-selected-source'
    ])
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        reason: 'source-texture-budget',
        reasons: ['source-texture-budget'],
        release: expect.objectContaining({ sourceTextureBytes: 500 })
      })
    )
    expect(candidates[1].reasons).toEqual(['decoded-in-flight-budget', 'source-upgrade-budget'])
  })

  it('builds a metrics snapshot with usage, remaining capacity, pressure, and reservation counts', () => {
    const snapshot = buildCanvasImageResourceBudgetMetricsSnapshot({
      limits: {
        sourceTextureBytes: 1_000,
        thumbnailTextureBytes: 256,
        decodedInFlightBytes: 512,
        objectUrlCount: 2,
        activeSourceUpgrades: 1
      },
      reservations: [
        reservation('source', { sourceTextureBytes: 1_100 }),
        reservation('thumbnail', { thumbnailTextureBytes: 128 }),
        reservation('decode-url-upgrade', {
          decodedInFlightBytes: 512,
          objectUrlCount: 2,
          activeSourceUpgrades: 1,
          evictable: false
        })
      ]
    })

    expect(snapshot.version).toBe(1)
    expect(snapshot.usage).toEqual({
      sourceTextureBytes: 1_100,
      thumbnailTextureBytes: 128,
      decodedInFlightBytes: 512,
      objectUrlCount: 2,
      activeSourceUpgrades: 1
    })
    expect(snapshot.remaining).toEqual({
      sourceTextureBytes: 0,
      thumbnailTextureBytes: 128,
      decodedInFlightBytes: 0,
      objectUrlCount: 0,
      activeSourceUpgrades: 0
    })
    expect(snapshot.pressure).toEqual({
      sourceTextureBytes: 'over-budget',
      thumbnailTextureBytes: 'available',
      decodedInFlightBytes: 'at-limit',
      objectUrlCount: 'at-limit',
      activeSourceUpgrades: 'at-limit'
    })
    expect(snapshot.overBudget).toEqual([
      expect.objectContaining({
        key: 'sourceTextureBytes',
        reason: 'source-texture-budget',
        excess: 100
      })
    ])
    expect(snapshot.reservationCount).toBe(3)
    expect(snapshot.evictableReservationCount).toBe(2)
    expect(snapshot.sourceTextureReservationCount).toBe(1)
    expect(snapshot.thumbnailTextureReservationCount).toBe(1)
    expect(snapshot.decodedInFlightReservationCount).toBe(1)
    expect(snapshot.objectUrlReservationCount).toBe(1)
    expect(snapshot.activeSourceUpgradeReservationCount).toBe(1)
  })
})
