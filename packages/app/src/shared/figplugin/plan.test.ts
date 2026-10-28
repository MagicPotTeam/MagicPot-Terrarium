import { describe, expect, it, vi } from 'vitest'
import type { FigPluginContext } from './bridge'
import {
  checkFigPluginPlan,
  FIGPLUGIN_PLAN_MAX_BYTES,
  FIGPLUGIN_PLAN_MAX_STEPS,
  snapshotFigPluginPlanData,
  type FigPluginPlan
} from './plan'

const context = (): FigPluginContext => ({
  selectionRevision: 'synthetic-snapshot-1',
  nodes: [
    { id: '1:2', type: 'FRAME', name: 'Captured label', locked: false },
    { id: '1:3', type: 'TEXT', name: 'Other label', locked: false }
  ]
})
const plan = (): FigPluginPlan => ({
  schemaVersion: 1,
  mode: 'plan-only',
  selectionRevision: context().selectionRevision,
  steps: [{ command: 'node.rename', targetId: '1:2', name: 'Synthetic new label' }]
})
const check = (value: unknown, captured: unknown = context(), current: unknown = context()) =>
  checkFigPluginPlan(value, captured, current)

describe('inert FIGPLUGIN plan checking (not execution authority)', () => {
  it('accepts an exact proposal without changing or interpreting labels', () => {
    const value = plan()
    value.steps[0].name = ' <img src=x onerror=alert(1)> '
    const before = structuredClone(value)
    const result = check(value)
    expect(result).toEqual({ ok: true, plan: value })
    expect(value).toEqual(before)
    if (result.ok) expect(result.plan).not.toBe(value)
  })

  it.each([
    { schemaVersion: 2 },
    { mode: 'execute' },
    { script: 'alert(1)' },
    { path: 'C:/fixture-data/file.txt' },
    { sessionToken: 'synthetic-token' },
    { permissions: ['write'] },
    { consent: true },
    { host: 'photoshop' }
  ])('rejects unknown versions, fields and authority %j', (extra) => {
    expect(check({ ...plan(), ...extra })).toEqual({ ok: false, code: 'INVALID_PLAN' })
  })

  it.each([
    { command: 'eval' },
    { command: 'node.delete' },
    { targetId: 12 },
    { script: 'arbitrary-script' },
    { url: 'https://synthetic.invalid' },
    { path: '../file' },
    { args: { unlocked: true } }
  ])('rejects unknown commands and nested fields %j', (extra) => {
    const value = plan()
    expect(check({ ...value, steps: [{ ...value.steps[0], ...extra }] })).toEqual({
      ok: false,
      code: 'INVALID_PLAN'
    })
  })

  it.each([
    '',
    '   ',
    '\t',
    'a\nb',
    'a\u0000b',
    'a\u007fb',
    'a\u0085b',
    'a\u202eb',
    'a\u2066b',
    'a\u200eb',
    'a\u061cb',
    'x'.repeat(121),
    '界'.repeat(86)
  ])('rejects blank, control, bidi and oversized names %j', (name) => {
    const value = plan()
    value.steps[0].name = name
    expect(check(value)).toEqual({ ok: false, code: 'INVALID_PLAN' })
  })

  it.each(['x'.repeat(120), '界'.repeat(85) + 'x', ' e\u0301 ', 'synthetic 😀 label'])(
    'preserves accepted name units/bytes and Unicode exactly',
    (name) => {
      const value = plan()
      value.steps[0].name = name
      expect(check(value)).toEqual({ ok: true, plan: value })
    }
  )

  it('bounds step count independently of context capacity', () => {
    const snapshot = context()
    snapshot.nodes = Array.from({ length: FIGPLUGIN_PLAN_MAX_STEPS + 1 }, (_, index) => ({
      ...snapshot.nodes[0],
      id: `node-${index}`
    }))
    const value = plan()
    value.steps = snapshot.nodes.map((node) => ({
      command: 'node.rename',
      targetId: node.id,
      name: 'New'
    }))
    expect(check(value, snapshot, snapshot)).toEqual({ ok: false, code: 'INVALID_PLAN' })
    value.steps.pop()
    expect(check(value, snapshot, snapshot)).toEqual({ ok: true, plan: value })
    expect(check({ ...value, steps: [] })).toEqual({ ok: false, code: 'INVALID_PLAN' })
  })

  it('enforces canonical UTF-8 bytes at the boundary, including escaped IDs', () => {
    const snapshot = context()
    snapshot.nodes = Array.from({ length: 20 }, (_, index) => ({
      ...snapshot.nodes[0],
      id: `node-${index}-` + 'x'.repeat(110)
    }))
    const value = plan()
    value.steps = snapshot.nodes.map((node) => ({
      command: 'node.rename',
      targetId: node.id,
      name: '界'.repeat(85)
    }))
    const size = () => new TextEncoder().encode(JSON.stringify(value)).byteLength
    expect(size()).toBeGreaterThan(FIGPLUGIN_PLAN_MAX_BYTES)
    for (const step of value.steps) {
      while (size() > FIGPLUGIN_PLAN_MAX_BYTES && step.name.length > 1) {
        const difference = size() - FIGPLUGIN_PLAN_MAX_BYTES
        step.name =
          difference >= 3
            ? step.name.slice(0, -1)
            : step.name.slice(0, -1) + 'x'.repeat(3 - difference)
      }
    }
    expect(size()).toBe(FIGPLUGIN_PLAN_MAX_BYTES)
    expect(check(value, snapshot, snapshot)).toEqual({ ok: true, plan: value })
    value.steps[0].name += 'x'
    expect(check(value, snapshot, snapshot)).toEqual({ ok: false, code: 'PLAN_TOO_LARGE' })
  })

  it('rejects duplicate targets and duplicate captured node identities', () => {
    const value = plan()
    value.steps.push({ ...value.steps[0], name: 'Second proposal' })
    expect(check(value)).toEqual({ ok: false, code: 'DUPLICATE_TARGET' })
    const snapshot = context()
    snapshot.nodes.push(snapshot.nodes[0])
    expect(check(plan(), snapshot, snapshot)).toEqual({ ok: false, code: 'INVALID_CONTEXT' })
  })

  it('does not grant a target by spelling, label, empty context or plan-provided scope', () => {
    const value = plan()
    value.steps[0].targetId = 'outside-selection'
    expect(check(value)).toEqual({ ok: false, code: 'OUT_OF_SCOPE' })
    const empty = { ...context(), nodes: [] }
    expect(check(plan(), empty, empty)).toEqual({ ok: false, code: 'OUT_OF_SCOPE' })
    expect(check({ ...plan(), allowedNodeIds: ['outside-selection'] })).toEqual({
      ok: false,
      code: 'INVALID_PLAN'
    })
  })

  it('rejects a locked target and missing lock information', () => {
    const snapshot = context()
    snapshot.nodes[0].locked = true
    expect(check(plan(), snapshot, snapshot)).toEqual({ ok: false, code: 'LOCKED_TARGET' })
    const missing = { ...context(), nodes: [{ id: '1:2', type: 'FRAME', name: 'Label' }] }
    expect(check(plan(), missing, missing)).toEqual({ ok: false, code: 'INVALID_CONTEXT' })
  })

  it.each([
    (value: FigPluginContext) => {
      value.selectionRevision = 'new-snapshot'
    },
    (value: FigPluginContext) => {
      value.nodes[0].name = 'Changed but same revision'
    },
    (value: FigPluginContext) => {
      value.nodes[0].locked = true
    },
    (value: FigPluginContext) => {
      value.nodes.reverse()
    },
    (value: FigPluginContext) => {
      value.documentLabel = 'Changed document label'
    }
  ])('rejects changed supplied context even if its revision is unchanged', (change) => {
    const current = context()
    change(current)
    expect(check(plan(), context(), current)).toEqual({ ok: false, code: 'STALE_CONTEXT' })
  })

  it('requires plan revision to match the captured snapshot', () => {
    expect(check({ ...plan(), selectionRevision: 'old-snapshot' })).toEqual({
      ok: false,
      code: 'STALE_CONTEXT'
    })
  })

  it('serializes a detached descriptor snapshot rather than reading caller objects twice', () => {
    let nameReads = 0
    const input = plan()
    input.steps[0] = new Proxy(input.steps[0], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'name') {
          nameReads++
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: nameReads === 1 ? 'Captured once' : 'x'.repeat(1024 * 1024)
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    const captured = snapshotFigPluginPlanData(input, FIGPLUGIN_PLAN_MAX_BYTES)
    expect(captured.ok).toBe(true)
    if (captured.ok) {
      expect(captured.data).toEqual({
        ...plan(),
        steps: [{ ...plan().steps[0], name: 'Captured once' }]
      })
    }
    expect(nameReads).toBe(1)
  })

  it('rejects an oversized array using its length before enumerating any of its keys', () => {
    const oversized = Array(101).fill('target')
    const enumerate = vi.spyOn(Reflect, 'ownKeys')
    let result: ReturnType<typeof snapshotFigPluginPlanData>
    let enumerated: boolean
    try {
      result = snapshotFigPluginPlanData(oversized, FIGPLUGIN_PLAN_MAX_BYTES)
      enumerated = enumerate.mock.calls.some(([value]) => value === oversized)
    } finally {
      enumerate.mockRestore()
    }
    expect(result).toEqual({ ok: false, code: 'INVALID_DATA' })
    expect(enumerated).toBe(false)
  })

  it('rejects non-JSON accessors and toJSON without executing them or exposing raw details', () => {
    const getter = vi.fn(() => {
      throw new Error('PRIVATE getter detail')
    })
    const value = { ...plan() }
    Object.defineProperty(value, 'steps', { enumerable: true, get: getter })
    expect(check(value)).toEqual({ ok: false, code: 'INVALID_PLAN' })
    const toJSON = vi.fn(() => plan())
    expect(check({ toJSON })).toEqual({ ok: false, code: 'INVALID_PLAN' })
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(check(cycle)).toEqual({ ok: false, code: 'INVALID_PLAN' })
  })
})
