import { describe, expect, it } from 'vitest'
import { createHostPlanningPreview } from './hostPlanPreview'
import {
  createHostPlanReadback,
  hostContextSchema,
  normalizeHostPlan,
  parseHostPlan,
  validateHostPlanExecution,
  type HostContext,
  type HostPlan
} from './hostPlan'
const context: HostContext = {
  version: 1,
  host: 'photoshop',
  documentId: '1',
  scopeId: '1',
  captureId: 'a'.repeat(32),
  selectedIds: ['2'],
  nodes: [
    {
      id: '2',
      type: 'pixel',
      name: 'Owned',
      parentId: null,
      ancestors: [],
      locked: false,
      visible: true,
      opacity: 1,
      commands: ['node.opacity']
    }
  ],
  execution: {
    mode: 'native-write',
    adapterVersion: 'photoshop-uxp-native-1',
    supports: ['node.opacity'],
    rollback: 'verified-in-place',
    visualAudit: 'hash-only',
    opacityEncoding: 'uint8'
  }
}
const plan = (opacity: number): HostPlan => ({
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: context.captureId,
  steps: [{ command: 'node.opacity', targetId: '2', opacity }]
})
describe('explicit native uint8 opacity contract', () => {
  it('normalizes before preview and approval, not by lying about native readback', () => {
    const source = plan(0.5),
      p = parseHostPlan(JSON.stringify(source), context)
    expect(p.steps[0]).toMatchObject({ opacity: 128 / 255 })
    expect(source.steps[0]).toMatchObject({ opacity: 0.5 })
    const preview = createHostPlanningPreview(JSON.stringify(source), context)
    expect(preview.plan).toEqual(p)
    expect(preview.differences[0].after).toBe(128 / 255)
    expect(() => validateHostPlanExecution(source, context)).toThrow('HOST_PRECISION_MISMATCH')
    expect(() => validateHostPlanExecution(p, context)).not.toThrow()
    const after = structuredClone(context)
    after.nodes[0].opacity = 128 / 255
    expect(createHostPlanReadback(context, after, p).steps[0]).toMatchObject({
      observation: 'requested',
      value: 128 / 255
    })
    after.nodes[0].opacity = 127 / 255
    expect(createHostPlanReadback(context, after, p).steps[0].observation).toBe('other')
  })
  it('keeps all 256 representable values unchanged and refuses model-provided arbitrary precision', () => {
    for (let i = 0; i <= 255; i++)
      expect(normalizeHostPlan(plan(i / 255), context)).toEqual(plan(i / 255))
    for (const opacityEncoding of ['float32', 'uint16', true, 255, 0])
      expect(
        hostContextSchema.safeParse({
          ...context,
          execution: { ...context.execution, opacityEncoding }
        }).success
      ).toBe(false)
    expect(hostContextSchema.safeParse({ ...context, host: 'figma' }).success).toBe(false)
  })
  it('does not change legacy or non-advertising adapter values and cannot bypass bounds or locks', () => {
    const legacy = structuredClone(context)
    delete legacy.execution!.opacityEncoding
    expect(parseHostPlan(JSON.stringify(plan(0.5)), legacy)).toEqual(plan(0.5))
    expect(() => parseHostPlan(JSON.stringify(plan(-0.01)), context)).toThrow()
    expect(() => parseHostPlan(JSON.stringify(plan(1.01)), context)).toThrow()
    const locked = structuredClone(context)
    locked.nodes[0].locked = true
    expect(() => parseHostPlan(JSON.stringify(plan(0.5)), locked)).toThrow('LOCKED_TARGET')
  })
})
