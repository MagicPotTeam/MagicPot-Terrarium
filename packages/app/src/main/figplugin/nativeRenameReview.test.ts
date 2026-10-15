import { describe, expect, it, vi } from 'vitest'
import type { FigPluginSelectionSnapshot } from '@shared/figplugin/selectionSnapshot'
import { createNativeRenameReview } from './nativeRenameReview'

const fixture = (host: 'figma' | 'photoshop' = 'figma') => {
  const target = host === 'figma' ? '1:2' : '2'
  const parent = host === 'figma' ? '0:1' : '3'
  const snapshot: FigPluginSelectionSnapshot = {
    protocol: 1,
    purpose: 'read-only-selection-review',
    host,
    complete: true,
    document: {
      id: host === 'figma' ? '0:0' : '1',
      idSource: host === 'figma' ? 'figma-plugin-root' : 'photoshop-open-document',
      openEpoch: 'a'.repeat(32) + ':1',
      openEpochSource: 'plugin-observation',
      pageId: host === 'figma' ? parent : null
    },
    observation: { sequence: 1, source: 'capture-counter' },
    capabilities: {
      readSnapshot: true,
      writeCommands: [],
      authenticatedHost: false,
      nativeDocumentRevision: false,
      mutationExclusion: false,
      rollback: false,
      remoteMutationTracking: false
    },
    nodes: [
      {
        id: target,
        parentId: parent,
        kind: host === 'figma' ? 'FRAME' : 'pixel',
        name: 'Original 完整名',
        role: 'scene',
        visible: true,
        locked: false
      },
      {
        id: parent,
        parentId: null,
        kind: host === 'figma' ? 'PAGE' : 'group',
        name: 'Parent',
        role: host === 'figma' ? 'structural' : 'scene',
        visible: host === 'figma' ? null : true,
        locked: host === 'figma' ? null : false
      }
    ],
    selected: [{ id: target, ancestors: [parent], effectiveLocked: false, effectiveVisible: true }]
  }
  const proposal = {
    domain: 'figplugin-native-rename',
    version: 1,
    purpose: 'native-rename-proposal',
    host,
    plan: {
      schemaVersion: 1,
      mode: 'plan-only',
      selectionRevision: 'owned-observation',
      steps: [{ command: 'node.rename', targetId: target, name: '新名字' }]
    }
  }
  const run = () =>
    createNativeRenameReview(proposal, JSON.stringify(snapshot), 'owned-observation')
  return { snapshot, proposal, run }
}

describe('main-only native rename metadata review (not write authority)', () => {
  for (const host of ['figma', 'photoshop'] as const)
    it(`binds complete ${host} metadata to read-only old/new review`, () => {
      const f = fixture(host),
        before = JSON.stringify(f),
        result = f.run()
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.code)
      expect(result.review.writeAvailable).toBe(false)
      expect(result.review.evidence).toBe('unverified-host-metadata')
      expect(result.review.rows).toMatchObject([
        { oldName: 'Original 完整名', newName: '新名字', ancestors: [{ name: 'Parent' }] }
      ])
      expect(result.review.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.review.reviewSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(Object.isFrozen(result.review.rows[0].ancestors)).toBe(true)
      expect(JSON.stringify(f)).toBe(before)
      f.snapshot.nodes[0].name = 'later change'
      expect(result.review.rows[0].oldName).toBe('Original 完整名')
      expect(f.run()).not.toEqual(result)
    })

  it('does not equate a capture counter or matching digest with write permission', () => {
    const f = fixture(),
      first = f.run()
    f.snapshot.observation.sequence++
    const second = f.run()
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('fixture')
    expect(second.review.snapshotSha256).not.toBe(first.review.snapshotSha256)
    expect(second.review.writeAvailable).toBe(false)
    expect(second.review.document.openEpochSource).toBe('plugin-observation')
  })

  it('preserves exact Unicode/long old names without trimming or normalization', () => {
    const f = fixture()
    f.snapshot.nodes[0].name = ' e\u0301 😀 ' + '甲'.repeat(1000)
    const result = f.run()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.review.rows[0].oldName).toBe(f.snapshot.nodes[0].name)
  })

  for (const kind of [
    'self-lock',
    'ancestor-lock',
    'hidden',
    'outside',
    'structural',
    'host',
    'revision',
    'duplicate'
  ] as const)
    it(`refuses ${kind} without returning names or partial rows`, () => {
      const f = fixture(kind === 'ancestor-lock' ? 'photoshop' : 'figma')
      if (kind === 'self-lock') {
        f.snapshot.nodes[0].locked = true
        f.snapshot.selected[0].effectiveLocked = true
      }
      if (kind === 'ancestor-lock') {
        f.snapshot.nodes[1].locked = true
        f.snapshot.selected[0].effectiveLocked = true
      }
      if (kind === 'hidden') {
        f.snapshot.nodes[0].visible = false
        f.snapshot.selected[0].effectiveVisible = false
      }
      if (kind === 'outside') f.proposal.plan.steps[0].targetId = 'not-selected'
      if (kind === 'structural') f.proposal.plan.steps[0].targetId = f.snapshot.nodes[1].id
      if (kind === 'host') f.proposal.host = 'photoshop'
      if (kind === 'revision') f.proposal.plan.selectionRevision = 'stale'
      if (kind === 'duplicate') f.proposal.plan.steps.push({ ...f.proposal.plan.steps[0] })
      const result = f.run()
      expect(result.ok).toBe(false)
      expect(Object.keys(result).sort()).toEqual(['code', 'ok'])
      expect(JSON.stringify(result)).not.toContain('Original')
    })

  it('rejects raw oversized, malformed and relationship-invalid snapshots', () => {
    const f = fixture()
    expect(
      createNativeRenameReview(f.proposal, ' '.repeat(256 * 1024 + 1), 'owned-observation')
    ).toEqual({ ok: false, code: 'SNAPSHOT_TOO_LARGE' })
    expect(createNativeRenameReview(f.proposal, '{', 'owned-observation')).toEqual({
      ok: false,
      code: 'INVALID_SNAPSHOT'
    })
    f.snapshot.selected[0].ancestors = []
    expect(f.run()).toEqual({ ok: false, code: 'INVALID_SNAPSHOT' })
  })

  it('does not invoke proposal accessors or Proxy traps', () => {
    const f = fixture(),
      getter = vi.fn(() => f.proposal.plan)
    Object.defineProperty(f.proposal, 'plan', { get: getter })
    expect(f.run().ok).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    const trap = vi.fn(() => [])
    expect(
      createNativeRenameReview(
        new Proxy({}, { ownKeys: trap }),
        JSON.stringify(f.snapshot),
        'owned-observation'
      ).ok
    ).toBe(false)
    expect(trap).not.toHaveBeenCalled()
  })

  it('measures raw input bytes before parsing and rejects malformed Unicode proposals', () => {
    const f = fixture()
    expect(createNativeRenameReview(f.proposal, '甲'.repeat(90000), 'owned-observation')).toEqual({
      ok: false,
      code: 'SNAPSHOT_TOO_LARGE'
    })
    f.proposal.plan.steps[0].name = '\ud800'
    expect(f.run()).toEqual({ ok: false, code: 'INVALID_PROPOSAL' })
  })

  it('binds the complete target set and new names, including explicit unchanged names', () => {
    const f = fixture()
    const original = f.run()
    f.proposal.plan.steps[0].name = f.snapshot.nodes[0].name
    const unchanged = f.run()
    expect(original.ok && unchanged.ok).toBe(true)
    if (!original.ok || !unchanged.ok) throw new Error('fixture')
    expect(unchanged.review.rows[0].wouldChange).toBe(false)
    expect(original.review.snapshotSha256).toBe(unchanged.review.snapshotSha256)
    expect(original.review.reviewSha256).not.toBe(unchanged.review.reviewSha256)
    expect(() => {
      unchanged.review.document.id = 'forged'
    }).toThrow()
  })

  it('rejects complete previews beyond 64KiB without truncation', () => {
    const f = fixture('photoshop'),
      template = f.snapshot.nodes[0]
    f.snapshot.nodes = Array.from({ length: 20 }, (_, i) => ({
      ...template,
      id: String(i + 2),
      parentId: null,
      name: 'x'.repeat(4096)
    }))
    f.snapshot.selected = f.snapshot.nodes.map((n) => ({
      id: n.id,
      ancestors: [],
      effectiveLocked: false,
      effectiveVisible: true
    }))
    f.proposal.plan.steps = f.snapshot.nodes.map((n) => ({
      command: 'node.rename',
      targetId: n.id,
      name: 'new'
    }))
    expect(f.run()).toEqual({ ok: false, code: 'REVIEW_TOO_LARGE' })
  })
})
