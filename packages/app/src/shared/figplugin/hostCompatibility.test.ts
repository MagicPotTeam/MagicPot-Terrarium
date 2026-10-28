import { describe, expect, it } from 'vitest'
import {
  assertHostPlanCompatibility,
  FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION,
  FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION,
  FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION,
  negotiateHostPlanCompatibility
} from './hostCompatibility'
import { type HostContext, type HostPlan } from './hostPlan'
import { validateHostPlan } from './hostPlanningClient'

const captureId = 'a'.repeat(32)
const plan = (overrides: Partial<HostPlan> = {}): HostPlan => ({
  schemaVersion: FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION,
  kind: 'host-plan',
  captureId,
  steps: [{ command: 'node.rename', targetId: 'node', name: 'new name' }],
  ...overrides
})

const context = (
  execution: HostContext['execution'] | null = {
    mode: 'native-write',
    adapterVersion: 'figma-native-1',
    supports: ['node.rename'],
    rollback: 'verified-in-place',
    visualAudit: 'unavailable'
  }
): HostContext => ({
  version: FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION,
  host: 'figma',
  documentId: 'doc',
  scopeId: 'page',
  captureId,
  selectedIds: ['node'],
  nodes: [
    {
      id: 'node',
      type: 'TEXT',
      name: 'old name',
      parentId: 'page',
      ancestors: [],
      locked: false,
      visible: true,
      commands: ['node.rename']
    }
  ],
  ...(execution === null ? {} : { execution })
})

describe('host protocol/schema compatibility negotiation', () => {
  it('negotiates independent context, plan and adapter versions', () => {
    expect(negotiateHostPlanCompatibility(context(), plan())).toEqual({
      ok: true,
      contextProtocol: FIGPLUGIN_HOST_CONTEXT_PROTOCOL_VERSION,
      planSchema: FIGPLUGIN_HOST_PLAN_SCHEMA_VERSION,
      adapter: { state: 'current', version: 'figma-native-1' },
      commands: ['node.rename']
    })
  })

  it('allows read-only planning without pretending an adapter is available', () => {
    expect(negotiateHostPlanCompatibility(context(null), plan())).toMatchObject({
      ok: true,
      adapter: { state: 'planning-only' },
      commands: []
    })
  })

  it.each([
    ['context protocol', { ...context(), version: 2 }, undefined, 'UNSUPPORTED_CONTEXT_PROTOCOL'],
    ['plan schema', context(), { ...plan(), schemaVersion: 3 }, 'UNSUPPORTED_PLAN_SCHEMA'],
    [
      'adapter host',
      context({
        mode: 'native-write',
        adapterVersion: 'photoshop-uxp-native-1',
        supports: ['node.rename'],
        rollback: 'verified-in-place',
        visualAudit: 'unavailable'
      }),
      plan(),
      'ADAPTER_HOST_MISMATCH'
    ],
    [
      'adapter major',
      context({
        mode: 'native-write',
        adapterVersion: `figma-native-${FIGPLUGIN_HOST_ADAPTER_MAJOR_VERSION + 1}`,
        supports: ['node.rename'],
        rollback: 'verified-in-place',
        visualAudit: 'unavailable'
      }),
      plan(),
      'ADAPTER_VERSION_UNSUPPORTED'
    ]
  ] as const)('fails closed for incompatible %s', (_label, rawContext, rawPlan, code) => {
    const result = negotiateHostPlanCompatibility(rawContext, rawPlan ?? plan())
    expect(result).toMatchObject({ ok: false, code })
    expect(() => assertHostPlanCompatibility(rawContext, rawPlan ?? plan())).toThrow(code)
  })

  it('reports a missing adapter command without treating the context as malformed', () => {
    const rawContext = context({
      mode: 'native-write',
      adapterVersion: 'figma-native-1',
      supports: ['node.opacity'],
      rollback: 'verified-in-place',
      visualAudit: 'unavailable'
    })
    rawContext.nodes[0].commands = ['node.opacity']
    rawContext.nodes[0].opacity = 0.5
    rawContext.nodes[0].type = 'RECTANGLE'
    const rawPlan: HostPlan = {
      ...plan(),
      steps: [{ command: 'node.rename', targetId: 'node', name: 'new name' }]
    }
    expect(negotiateHostPlanCompatibility(rawContext, rawPlan)).toMatchObject({
      ok: false,
      code: 'CAPABILITY_MISSING',
      missing: ['node.rename']
    })
  })

  it('keeps opaque legacy adapter identifiers usable but does not classify them as current', () => {
    expect(
      negotiateHostPlanCompatibility(
        context({
          mode: 'native-write',
          adapterVersion: 'fixture-adapter',
          supports: ['node.rename'],
          rollback: 'verified-in-place',
          visualAudit: 'unavailable'
        }),
        plan()
      )
    ).toMatchObject({ ok: true, adapter: { state: 'opaque', version: 'fixture-adapter' } })
  })

  it('enforces negotiation at the shared planning-client boundary', () => {
    const incompatible = context({
      mode: 'native-write',
      adapterVersion: 'photoshop-uxp-native-1',
      supports: ['node.rename'],
      rollback: 'verified-in-place',
      visualAudit: 'unavailable'
    })
    expect(() => validateHostPlan(plan(), incompatible)).toThrow('ADAPTER_HOST_MISMATCH')
  })
})
