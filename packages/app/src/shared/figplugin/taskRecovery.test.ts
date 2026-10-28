import { describe, it, expect } from 'vitest'
import {
  captureTaskRecoveryScope,
  prepareTaskRecoveryPlan,
  figPluginTaskRecoveryPrepareRequestSchema
} from './taskRecovery'
import { type HostContext, type HostPlan } from './hostPlan'
const original: HostContext = {
  version: 1,
  recoveryIdentity: 'a'.repeat(32),
  host: 'figma',
  documentId: 'doc',
  scopeId: 'page',
  captureId: '1'.repeat(32),
  selectedIds: ['text'],
  execution: {
    mode: 'native-write',
    adapterVersion: 'figma-native-1',
    supports: ['node.rename', 'node.opacity', 'node.visibility', 'text.content', 'layout.flow'],
    rollback: 'verified-in-place',
    visualAudit: 'hash-only'
  },
  nodes: [
    {
      id: 'text',
      type: 'TEXT',
      name: 'Original',
      parentId: 'page',
      ancestors: [{ id: 'page', type: 'PAGE', locked: false }],
      locked: false,
      visible: true,
      opacity: 1,
      text: 'Before',
      fontKey: 'Inter-Regular',
      commands: ['node.rename', 'node.opacity', 'node.visibility', 'text.content'],
      children: []
    }
  ]
}
const plan: HostPlan = {
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: original.captureId,
  steps: [
    { command: 'node.rename', targetId: 'text', name: 'Accepted' },
    { command: 'text.content', targetId: 'text', text: 'Accepted text' }
  ]
}
const fresh = () => ({ ...structuredClone(original), captureId: '2'.repeat(32) })
describe('accepted task property recovery', () => {
  it('reconstructs only accepted task assignments and preserves unrelated edits', () => {
    const scope = captureTaskRecoveryScope(plan, original),
      current = fresh()
    current.nodes[0].name = 'User changed'
    current.nodes[0].opacity = 0.2
    current.nodes[0].visible = false
    const input = structuredClone(current)
    const result = prepareTaskRecoveryPlan(plan, scope, current)
    expect(result.plan.steps).toEqual(plan.steps)
    expect(result.plan.captureId).toBe(current.captureId)
    expect(result.unchanged).toBe(false)
    expect(current).toEqual(input)
    expect(JSON.stringify(scope)).not.toMatch(/Accepted text|Before|Original/)
  })
  it('no-op recognizes task properties without mistaking it for pixel or document equality', () => {
    const current = fresh()
    current.nodes[0].name = 'Accepted'
    current.nodes[0].text = 'Accepted text'
    current.nodes[0].opacity = 0.1
    expect(
      prepareTaskRecoveryPlan(plan, captureTaskRecoveryScope(plan, original), current).unchanged
    ).toBe(true)
  })
  it.each([
    'host',
    'document',
    'scope',
    'adapter',
    'selection',
    'lock',
    'ancestorLock',
    'parent',
    'type',
    'font',
    'commands',
    'missing'
  ])('refuses %s changes rather than broadening restoration', (mode) => {
    const current = fresh()
    if (mode === 'host') current.host = 'photoshop'
    if (mode === 'document') current.documentId = 'other'
    if (mode === 'scope') current.scopeId = 'other'
    if (mode === 'adapter') current.execution!.adapterVersion = 'other'
    if (mode === 'selection') current.selectedIds = []
    if (mode === 'lock') current.nodes[0].locked = true
    if (mode === 'ancestorLock') current.nodes[0].ancestors[0].locked = true
    if (mode === 'parent') current.nodes[0].parentId = 'other'
    if (mode === 'type') current.nodes[0].type = 'FRAME'
    if (mode === 'font') current.nodes[0].fontKey = 'Other-Font'
    if (mode === 'commands') current.nodes[0].commands = []
    if (mode === 'missing') current.nodes = []
    expect(() =>
      prepareTaskRecoveryPlan(plan, captureTaskRecoveryScope(plan, original), current)
    ).toThrow()
  })
  it('revalidates complete layout descendants and never recreates deleted or moved children', () => {
    const context = structuredClone(original)
    const node = context.nodes[0]
    node.type = 'FRAME'
    node.commands = ['layout.flow']
    node.children = ['child']
    node.layout = { direction: 'HORIZONTAL', gap: 4, padding: [1, 2, 3, 4] }
    context.nodes.push({
      ...structuredClone(original.nodes[0]),
      id: 'child',
      parentId: 'text',
      ancestors: [{ id: 'text', type: 'FRAME', locked: false }, ...node.ancestors],
      children: []
    })
    const layoutPlan: HostPlan = {
      ...plan,
      steps: [
        {
          command: 'layout.flow',
          targetId: 'text',
          layout: { direction: 'VERTICAL', gap: 16, padding: [4, 3, 2, 1] }
        }
      ]
    }
    const scope = captureTaskRecoveryScope(layoutPlan, context)
    expect(prepareTaskRecoveryPlan(layoutPlan, scope, context).plan.steps).toEqual(layoutPlan.steps)
    context.nodes[0].children = []
    expect(() => prepareTaskRecoveryPlan(layoutPlan, scope, context)).toThrow()
  })
  it('rejects raw plan, extra fields and a mismatched capture identity at the request boundary', () => {
    const input = { protocol: 1, sequence: 2, requestId: '2'.repeat(32), hostContext: fresh() }
    expect(figPluginTaskRecoveryPrepareRequestSchema.safeParse(input).success).toBe(true)
    expect(figPluginTaskRecoveryPrepareRequestSchema.safeParse({ ...input, plan }).success).toBe(
      false
    )
    expect(
      figPluginTaskRecoveryPrepareRequestSchema.safeParse({ ...input, requestId: '3'.repeat(32) })
        .success
    ).toBe(false)
  })
})

it('rejects a missing or different native recovery identity even with identical document and target IDs', () => {
  const scope = captureTaskRecoveryScope(plan, original)
  for (const identity of [undefined, 'b'.repeat(32)]) {
    const context = fresh()
    context.recoveryIdentity = identity
    expect(() => prepareTaskRecoveryPlan(plan, scope, context)).toThrow()
  }
})
