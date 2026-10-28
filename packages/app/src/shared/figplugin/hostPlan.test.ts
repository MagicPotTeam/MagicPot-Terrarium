import { escapePlanningDisplay } from './hostPlan'
import { describe, expect, it } from 'vitest'
import {
  createHostPlanReadback,
  hostContextSchema,
  parseHostPlan,
  validateHostPlanReadback,
  type HostContext,
  type HostPlan
} from './hostPlan'

const context = (): HostContext => ({
  version: 1,
  host: 'figma',
  documentId: 'doc',
  scopeId: 'page',
  captureId: 'a'.repeat(32),
  nodes: [
    {
      id: '1:2',
      type: 'TEXT',
      name: '原图层',
      parentId: 'page',
      ancestors: [{ id: 'page', type: 'PAGE', locked: false }],
      locked: false,
      visible: true,
      opacity: 1,
      children: [],
      text: '原文字',
      commands: ['node.rename', 'node.opacity', 'node.visibility', 'text.content']
    }
  ]
})
const plan = (): HostPlan => ({
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: 'a'.repeat(32),
  steps: [{ command: 'node.rename', targetId: '1:2', name: '新图层' }]
})

describe('shared host plan data contract', () => {
  it('preserves Unicode, names, references and exact values without executing anything', () => {
    expect(parseHostPlan(JSON.stringify(plan()), context())).toEqual(plan())
    expect(context().nodes[0].name).toBe('原图层')
  })
  it.each([
    { command: 'node.opacity', targetId: '1:2', opacity: 0.25 },
    { command: 'node.visibility', targetId: '1:2', visible: false },
    { command: 'text.content', targetId: '1:2', text: '新的文字\n第二行' }
  ])('validates capability-declared command data %#', (step) => {
    expect(parseHostPlan(JSON.stringify({ ...plan(), steps: [step] }), context()).steps).toEqual([
      step
    ])
  })
  it.each([
    { command: 'eval', targetId: '1:2', code: 'throw new Error()' },
    { command: 'node.rename', targetId: 'outside', name: 'x' },
    { command: 'node.rename', targetId: '1:2', name: 'x', confirmed: true },
    { command: 'node.rename', targetId: '1:2', name: 'x\u202ey' },
    { command: 'node.opacity', targetId: '1:2', opacity: 101 },
    { command: 'node.visibility', targetId: '1:2', visible: 'yes' },
    { command: 'text.content', targetId: '1:2', text: 'x'.repeat(4097) },
    {
      command: 'layout.flow',
      targetId: '1:2',
      layout: { direction: 'HORIZONTAL', gap: 4, padding: [1, 1, 1, 1] }
    }
  ])('rejects unknown, unauthorized or malformed plan data %#', (step) => {
    expect(() => parseHostPlan(JSON.stringify({ ...plan(), steps: [step] }), context())).toThrow()
  })
  it('rejects a different capture identity', () => {
    expect(() =>
      parseHostPlan(JSON.stringify({ ...plan(), captureId: 'b'.repeat(32) }), context())
    ).toThrow('STALE_CONTEXT')
  })
  it('rejects duplicate commands for one target', () => {
    expect(() =>
      parseHostPlan(
        JSON.stringify({ ...plan(), steps: [plan().steps[0], plan().steps[0]] }),
        context()
      )
    ).toThrow('DUPLICATE_COMMAND')
  })
  it.each(['self', 'ancestor'])('rejects %s locked nodes', (kind) => {
    const c = context()
    if (kind === 'self') c.nodes[0].locked = true
    else c.nodes[0].ancestors[0].locked = true
    expect(() => parseHostPlan(JSON.stringify(plan()), c)).toThrow('LOCKED_TARGET')
  })
  it('does not infer a capability from the node type', () => {
    const c = context()
    c.nodes[0].commands = []
    expect(() => parseHostPlan(JSON.stringify(plan()), c)).toThrow('UNSUPPORTED_COMMAND')
  })
  it('rejects duplicate node capabilities instead of treating them as independent authority', () => {
    const c = context()
    c.nodes[0].commands = ['node.rename', 'node.rename']
    expect(hostContextSchema.safeParse(c).success).toBe(false)
  })
  it('rejects duplicate adapter capabilities before planning or execution', () => {
    const c = context()
    c.nodes[0].type = 'FRAME'
    c.nodes[0].commands = ['node.rename']
    c.selectedIds = ['1:2']
    c.execution = {
      mode: 'native-write',
      adapterVersion: 'fixture',
      supports: ['node.rename', 'node.rename'],
      rollback: 'none',
      visualAudit: 'unavailable'
    }
    expect(hostContextSchema.safeParse(c).success).toBe(false)
  })
  it('rejects plan prose and truncated JSON rather than interpreting it', () => {
    for (const text of [
      JSON.stringify(plan()) + ' Sorry',
      '```json\n' + JSON.stringify(plan()) + '\n```',
      JSON.stringify(plan()).slice(0, -3)
    ])
      expect(() => parseHostPlan(text, context())).toThrow()
  })
  it('bounds bytes before JSON parsing', () => {
    expect(() => parseHostPlan('界'.repeat(6000), context())).toThrow('PLAN_TOO_LARGE')
  })
  it('requires every layout descendant to be explicitly in scope', () => {
    const c = context()
    c.nodes[0].type = 'FRAME'
    c.nodes[0].commands = ['layout.flow']
    c.nodes[0].children = ['child']
    const p = {
      ...plan(),
      steps: [
        {
          command: 'layout.flow',
          targetId: '1:2',
          layout: { direction: 'HORIZONTAL', gap: 4, padding: [1, 1, 1, 1] }
        }
      ]
    }
    expect(() => parseHostPlan(JSON.stringify(p), c)).toThrow('LAYOUT_SCOPE_INCOMPLETE')
    c.nodes.push({ ...c.nodes[0], id: 'child', parentId: '1:2', children: [] })
    expect(parseHostPlan(JSON.stringify(p), c).steps).toHaveLength(1)
    c.nodes[1].children = ['1:2']
    expect(() => parseHostPlan(JSON.stringify(p), c)).toThrow('LAYOUT_SCOPE_INCOMPLETE')
  })
  it('rejects duplicate node identities and oversized snapshots', () => {
    const c = context()
    c.nodes.push({ ...c.nodes[0] })
    expect(hostContextSchema.safeParse(c).success).toBe(false)
    c.nodes = Array.from({ length: 20 }, (_, i) => ({
      ...context().nodes[0],
      id: String(i),
      name: '界'.repeat(4096)
    }))
    expect(hostContextSchema.safeParse(c).success).toBe(false)
  })
  it('does not accept newline-suffixed capture identifiers', () => {
    const c = context()
    c.captureId += '\n'
    expect(hostContextSchema.safeParse(c).success).toBe(false)
    expect(() =>
      parseHostPlan(JSON.stringify({ ...plan(), captureId: plan().captureId + '\n' }), context())
    ).toThrow()
  })
  it('strictly binds requested, original, other and unknown observations to their values', () => {
    const before = context()
    const after = structuredClone(before)
    after.nodes[0].name = '新图层'
    const valid = createHostPlanReadback(before, after, plan())
    expect(validateHostPlanReadback(plan(), before, valid)).toEqual(valid)

    const requestedWrong = structuredClone(valid)
    requestedWrong.steps[0].value = '伪造值'
    expect(() => validateHostPlanReadback(plan(), before, requestedWrong)).toThrow(
      'INVALID_READBACK'
    )

    const requestedMissing = structuredClone(valid)
    delete requestedMissing.steps[0].value
    expect(() => validateHostPlanReadback(plan(), before, requestedMissing)).toThrow(
      'INVALID_READBACK'
    )

    const original = createHostPlanReadback(before, before, plan())
    expect(original.steps[0].observation).toBe('original')
    const originalWrong = structuredClone(original)
    originalWrong.steps[0].value = '伪造原值'
    expect(() => validateHostPlanReadback(plan(), before, originalWrong)).toThrow(
      'INVALID_READBACK'
    )

    const otherContext = structuredClone(before)
    otherContext.nodes[0].name = '中间值'
    const other = createHostPlanReadback(before, otherContext, plan())
    expect(other.steps[0].observation).toBe('other')
    const otherRequested = structuredClone(other)
    otherRequested.steps[0].value = '新图层'
    expect(() => validateHostPlanReadback(plan(), before, otherRequested)).toThrow(
      'INVALID_READBACK'
    )
    const otherOriginal = structuredClone(other)
    otherOriginal.steps[0].value = '原图层'
    expect(() => validateHostPlanReadback(plan(), before, otherOriginal)).toThrow(
      'INVALID_READBACK'
    )

    const unknownBefore = structuredClone(before)
    delete unknownBefore.nodes[0].text
    const unknown = createHostPlanReadback(unknownBefore, structuredClone(unknownBefore), {
      ...plan(),
      steps: [{ command: 'text.content', targetId: '1:2', text: '新文字' }]
    })
    expect(unknown.steps[0].observation).toBe('unknown')
    expect(
      validateHostPlanReadback(
        { ...plan(), steps: [{ command: 'text.content', targetId: '1:2', text: '新文字' }] },
        unknownBefore,
        unknown
      )
    ).toEqual(unknown)
    const unknownWithValue = structuredClone(unknown)
    unknownWithValue.steps[0].value = '不应存在'
    expect(() =>
      validateHostPlanReadback(
        { ...plan(), steps: [{ command: 'text.content', targetId: '1:2', text: '新文字' }] },
        unknownBefore,
        unknownWithValue
      )
    ).toThrow('INVALID_READBACK')

    const originalWithoutValue = structuredClone(unknown)
    originalWithoutValue.steps[0].observation = 'original'
    expect(() =>
      validateHostPlanReadback(
        { ...plan(), steps: [{ command: 'text.content', targetId: '1:2', text: '新文字' }] },
        unknownBefore,
        originalWithoutValue
      )
    ).toThrow('INVALID_READBACK')
  })
  it('compares structured values canonically rather than by object key order', () => {
    const before = structuredClone(context())
    before.nodes[0].type = 'FRAME'
    before.nodes[0].commands = ['layout.flow']
    before.nodes[0].children = []
    const layoutPlan: HostPlan = {
      ...plan(),
      steps: [
        {
          command: 'layout.flow',
          targetId: '1:2',
          layout: { direction: 'HORIZONTAL', gap: 4, padding: [1, 2, 3, 4] }
        }
      ]
    }
    const after = structuredClone(before)
    after.nodes[0].layout = {
      padding: [1, 2, 3, 4],
      gap: 4,
      direction: 'HORIZONTAL'
    }
    const readback = createHostPlanReadback(before, after, layoutPlan)
    expect(readback.steps[0].observation).toBe('requested')
    readback.steps[0].value = { padding: [1, 2, 3, 4], gap: 4, direction: 'HORIZONTAL' }
    expect(validateHostPlanReadback(layoutPlan, before, readback)).toEqual(readback)
  })
})

it('escapes directional display controls without changing the actual context', () => {
  const input = 'Owned\u202e name'
  expect(escapePlanningDisplay(input)).toBe('Owned\\u202e name')
  expect(input).toContain('\u202e')
})
