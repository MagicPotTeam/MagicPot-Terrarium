import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HOST_PLAN_SYSTEM_MESSAGE, governHostPlanResponse } from './planGovernance'
import { hostPlanSchema, type HostContext } from '@shared/figplugin/hostPlan'

const context = (): HostContext => ({
  version: 1,
  host: 'photoshop',
  documentId: 'owned-doc',
  scopeId: 'owned-doc',
  captureId: 'a'.repeat(32),
  nodes: [
    {
      id: 'layer-1',
      type: 'text',
      name: 'Old name',
      parentId: null,
      ancestors: [],
      children: [],
      locked: false,
      visible: true,
      opacity: 1,
      text: 'Old text',
      commands: ['node.rename', 'text.content']
    }
  ]
})
const plan = () => ({
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: 'a'.repeat(32),
  steps: [{ command: 'node.rename', targetId: 'layer-1', name: 'New name' }]
})

describe('model plan governance (never a native executor)', () => {
  it('derives the model schema directly from the response validation schema', () => {
    const serialized = JSON.stringify(
      z.toJSONSchema(hostPlanSchema, { target: 'draft-7', reused: 'inline', cycles: 'throw' })
    )
    expect(HOST_PLAN_SYSTEM_MESSAGE.endsWith(serialized)).toBe(true)
    const schema = JSON.parse(serialized)
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.steps.maxItems).toBe(20)
    expect(HOST_PLAN_SYSTEM_MESSAGE).toContain('READ-ONLY PLANNING')
  })
  it('computes an exact diff and does not accept a provider supplied risk or confirmation', () => {
    const c = context()
    const before = JSON.stringify(c)
    expect(governHostPlanResponse(JSON.stringify(plan()), c)).toEqual({
      kind: 'host-plan-preview',
      executable: false,
      risk: 'low',
      plan: plan(),
      differences: [
        { targetId: 'layer-1', command: 'node.rename', before: 'Old name', after: 'New name' }
      ]
    })
    expect(JSON.stringify(c)).toBe(before)
    for (const extra of [{ risk: 'low' }, { confirmed: true }, { executable: true }])
      expect(() => governHostPlanResponse(JSON.stringify({ ...plan(), ...extra }), c)).toThrow()
  })
  it('reports medium risk for non-rename plans', () => {
    const p = {
      ...plan(),
      steps: [{ command: 'text.content', targetId: 'layer-1', text: 'New text' }]
    }
    expect(governHostPlanResponse(JSON.stringify(p), context())).toMatchObject({
      executable: false,
      risk: 'medium'
    })
  })
  it('rejects a plan when before-value data is missing', () => {
    const c = context()
    delete c.nodes[0].text
    const p = {
      ...plan(),
      steps: [{ command: 'text.content', targetId: 'layer-1', text: 'New text' }]
    }
    expect(() => governHostPlanResponse(JSON.stringify(p), c)).toThrow('INCOMPLETE_CONTEXT')
  })
  it('does not describe a no-op as a successful change', () => {
    const p = plan()
    p.steps[0].name = 'Old name'
    expect(() => governHostPlanResponse(JSON.stringify(p), context())).toThrow('NO_CHANGES')
  })
  it('includes the actual before-value, not a model-supplied rollback claim', () => {
    const p = plan()
    Object.assign(p.steps[0], { before: 'fake old value' })
    expect(() => governHostPlanResponse(JSON.stringify(p), context())).toThrow()
  })
})
