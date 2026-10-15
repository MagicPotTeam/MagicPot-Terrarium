import { describe, expect, it, vi } from 'vitest'
import {
  figPluginBridgeHashSchema,
  type FigPluginContext,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import type { FigPluginPlan } from '@shared/figplugin/plan'
import { createFigPluginPlanPreview, matchesFigPluginPlanPreview } from './planPreview'

const context = (): FigPluginContext => ({
  selectionRevision: 'synthetic-capture',
  nodes: [
    { id: '1:2', type: 'FRAME', name: 'Captured label', locked: false },
    { id: '1:3', type: 'TEXT', name: 'Second label', locked: false }
  ]
})
const binding = (): FigPluginRuntimeBinding => ({
  pluginId: 'synthetic.figma',
  host: 'figma',
  generation: 2,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:43117',
  projectId: 'synthetic-project',
  profileId: 'synthetic-profile',
  profileRevision: 'd'.repeat(64)
})
const scope = () => ({ context: context(), binding: binding(), callId: 'e'.repeat(32) })
const plan = (): FigPluginPlan => ({
  schemaVersion: 1,
  mode: 'plan-only',
  selectionRevision: 'synthetic-capture',
  steps: [{ command: 'node.rename', targetId: '1:2', name: 'New label' }]
})
const preview = () => {
  const current = scope()
  const result = createFigPluginPlanPreview(plan(), current, current.context)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('Synthetic preview fixture rejected')
  return result.preview
}

describe('main-only FIGPLUGIN inert preview hashes, never write grants', () => {
  it('retains the exact validated envelope without credentials, implicit consent or host effects', () => {
    const result = preview()
    expect(result).toEqual({
      envelope: { domain: 'figplugin-plan-preview/v1', plan: plan(), ...scope() },
      payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(matchesFigPluginPlanPreview(result, result.payloadSha256, scope())).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/sessionToken|api_key|consent|approved|execute/)
  })

  it('canonicalizes object key ordering but binds step ordering', () => {
    const value = plan()
    value.steps.push({ command: 'node.rename', targetId: '1:3', name: 'Second new label' })
    const current = scope()
    const one = createFigPluginPlanPreview(value, current, current.context)
    const shuffled = Object.fromEntries(Object.entries(value).reverse())
    const two = createFigPluginPlanPreview(shuffled, current, current.context)
    expect(two).toEqual(one)
    value.steps.reverse()
    expect(createFigPluginPlanPreview(value, current, current.context)).not.toEqual(one)
  })

  it.each([
    (value: ReturnType<typeof scope>) => {
      value.callId = 'f'.repeat(32)
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.pluginId = 'synthetic.other'
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.host = 'photoshop'
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.generation++
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.artifactSha256 = '1'.repeat(64)
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.signerFingerprint = '1'.repeat(64)
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.manifestSha256 = '1'.repeat(64)
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.bridgeOrigin = 'http://127.0.0.1:43118'
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.projectId = 'other-project'
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.profileId = 'other-profile'
    },
    (value: ReturnType<typeof scope>) => {
      value.binding.profileRevision = '1'.repeat(64)
    },
    (value: ReturnType<typeof scope>) => {
      value.context.selectionRevision = 'new-capture'
    },
    (value: ReturnType<typeof scope>) => {
      value.context.nodes[0].name = 'same revision changed name'
    },
    (value: ReturnType<typeof scope>) => {
      value.context.nodes[0].locked = true
    },
    (value: ReturnType<typeof scope>) => {
      value.context.nodes[0].type = 'INSTANCE'
    },
    (value: ReturnType<typeof scope>) => {
      value.context.nodes[0].id = 'missing-target'
    },
    (value: ReturnType<typeof scope>) => {
      value.context.nodes[0].geometry = { x: 0, y: 0, width: 10, height: 10, rotation: 0 }
    },
    (value: ReturnType<typeof scope>) => {
      value.context.documentLabel = 'different document label'
    }
  ])('does not match after any authority/snapshot change', (change) => {
    const saved = preview(),
      current = scope()
    change(current)
    expect(matchesFigPluginPlanPreview(saved, saved.payloadSha256, current)).toBe(false)
  })

  it('does not alias inputs and deeply freezes the retained preview', () => {
    const input = plan(),
      current = scope()
    const result = createFigPluginPlanPreview(input, current, current.context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const saved = result.preview,
      before = JSON.stringify(saved)
    input.steps[0].name = 'Mutated caller input'
    current.context.nodes[0].locked = true
    current.binding.generation++
    expect(JSON.stringify(saved)).toBe(before)
    for (const value of [
      saved,
      saved.envelope,
      saved.envelope.plan,
      saved.envelope.plan.steps,
      saved.envelope.plan.steps[0],
      saved.envelope.context,
      saved.envelope.context.nodes[0],
      saved.envelope.binding
    ]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    expect(matchesFigPluginPlanPreview(saved, saved.payloadSha256, scope())).toBe(true)
  })

  it('rejects tampered stored proposals and hashes, not just presented hash mismatch', () => {
    const saved = preview()
    const changed = structuredClone(saved)
    changed.envelope.plan.steps[0].name = 'Unreviewed proposal'
    expect(matchesFigPluginPlanPreview(changed, saved.payloadSha256, scope())).toBe(false)
    expect(
      matchesFigPluginPlanPreview(
        { ...saved, payloadSha256: '0'.repeat(64) },
        '0'.repeat(64),
        scope()
      )
    ).toBe(false)
    expect(matchesFigPluginPlanPreview(saved, '0'.repeat(64), scope())).toBe(false)
    expect(matchesFigPluginPlanPreview(saved, 'bad-hash', scope())).toBe(false)
    expect(
      matchesFigPluginPlanPreview({ ...saved, approved: true }, saved.payloadSha256, scope())
    ).toBe(false)
  })

  it('rejects wrong-length hashes before regex/schema processing or snapshot enumeration', () => {
    const parse = vi.spyOn(figPluginBridgeHashSchema, 'safeParse')
    let result: boolean
    let calls: number
    try {
      result = matchesFigPluginPlanPreview({}, 'a'.repeat(65), {})
      calls = parse.mock.calls.length
    } finally {
      parse.mockRestore()
    }
    expect(result).toBe(false)
    expect(calls).toBe(0)
  })

  it('rejects a nonstring hash without invoking accessors or exposing their errors', () => {
    const saved = preview()
    const getter = vi.fn(() => {
      throw new Error('PRIVATE hash getter detail')
    })
    const supplied = Object.defineProperty({}, 'then', { get: getter })
    expect(matchesFigPluginPlanPreview(saved, supplied, scope())).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects proxies at main ingress before invoking any object traps', () => {
    const trap = vi.fn(() => {
      throw new Error('PRIVATE proxy trap detail')
    })
    const proxied = <T extends object>(value: T): T =>
      new Proxy(value, {
        get: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
        getOwnPropertyDescriptor: trap
      })
    const current = scope()
    expect(createFigPluginPlanPreview(proxied(plan()), current, current.context)).toEqual({
      ok: false,
      code: 'INVALID_PLAN'
    })
    expect(createFigPluginPlanPreview(plan(), proxied(current), current.context)).toEqual({
      ok: false,
      code: 'INVALID_SCOPE'
    })
    expect(createFigPluginPlanPreview(plan(), current, proxied(current.context))).toEqual({
      ok: false,
      code: 'INVALID_CONTEXT'
    })
    const nested = plan()
    nested.steps[0] = proxied(nested.steps[0])
    expect(createFigPluginPlanPreview(nested, current, current.context)).toEqual({
      ok: false,
      code: 'INVALID_PLAN'
    })
    const saved = preview()
    expect(matchesFigPluginPlanPreview(proxied(saved), saved.payloadSha256, current)).toBe(false)
    expect(matchesFigPluginPlanPreview(saved, saved.payloadSha256, proxied(current))).toBe(false)
    expect(matchesFigPluginPlanPreview(saved, proxied({}), current)).toBe(false)
    const revoked = Proxy.revocable(plan(), {})
    revoked.revoke()
    expect(createFigPluginPlanPreview(revoked.proxy, current, current.context)).toEqual({
      ok: false,
      code: 'INVALID_PLAN'
    })
    expect(trap).not.toHaveBeenCalled()
  })

  it('rejects invalid scope and forged authority fields without exposing details', () => {
    const current = scope()
    expect(
      createFigPluginPlanPreview(plan(), { ...current, callId: 'bad-call' }, current.context)
    ).toEqual({ ok: false, code: 'INVALID_SCOPE' })
    expect(
      createFigPluginPlanPreview(
        plan(),
        { ...current, binding: { ...current.binding, api_key: 'PRIVATE fixture detail' } },
        current.context
      )
    ).toEqual({ ok: false, code: 'INVALID_SCOPE' })
    const changed = context()
    changed.nodes[0].locked = true
    expect(createFigPluginPlanPreview(plan(), current, changed)).toEqual({
      ok: false,
      code: 'STALE_CONTEXT'
    })
  })
})
