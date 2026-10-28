import { describe, expect, it, vi } from 'vitest'
import {
  createHostAdapterLifecycle,
  hostAdapterLifecycleDiagnosticsSchema,
  hostAdapterLifecycleCapabilitiesSchema,
  hostAdapterLifecycleResultSchema,
  hostAdapterLifecycleTransitionSchema,
  canTransitionHostAdapterLifecycle,
  type HostAdapterLifecycleOptions
} from './hostAdapterLifecycle'
import { createHostPlanReadback, type HostContext, type HostPlan } from './hostPlan'

const captureId = 'a'.repeat(32)

const context = (adapterVersion = 'fixture'): HostContext => ({
  version: 1,
  host: 'figma',
  documentId: 'doc',
  scopeId: 'page',
  captureId,
  selectedIds: ['1:2'],
  nodes: [
    {
      id: '1:2',
      type: 'FRAME',
      name: '原名称',
      parentId: 'page',
      ancestors: [{ id: 'page', type: 'PAGE', locked: false }],
      locked: false,
      visible: true,
      commands: ['node.rename']
    }
  ],
  execution: {
    mode: 'native-write',
    adapterVersion,
    supports: ['node.rename'],
    rollback: 'none',
    visualAudit: 'unavailable'
  }
})

const plan = (): HostPlan => ({
  schemaVersion: 2,
  kind: 'host-plan',
  captureId,
  steps: [{ command: 'node.rename', targetId: '1:2', name: '新名称' }]
})

const options = (
  overrides: Partial<HostAdapterLifecycleOptions<undefined, { changed: boolean }>> = {}
): HostAdapterLifecycleOptions<undefined, { changed: boolean }> => ({
  host: 'figma',
  adapterVersion: 'fixture',
  captureContext: () => context(),
  execute: () => ({ changed: true }),
  readback: ({ context: before, plan: currentPlan }) => {
    const after = structuredClone(before)
    after.nodes[0].name = '新名称'
    return createHostPlanReadback(before, after, currentPlan)
  },
  ...overrides
})

describe('shared HostAdapter lifecycle', () => {
  it('exposes a bounded capability discovery contract', () => {
    const discovered = {
      host: 'figma' as const,
      execution: context().execution!
    }
    expect(hostAdapterLifecycleCapabilitiesSchema.parse(discovered)).toEqual(discovered)
    const lifecycle = createHostAdapterLifecycle(
      options({ discoverCapabilities: () => discovered })
    )
    expect(lifecycle.discoverCapabilities()).toEqual(discovered)
    expect(() =>
      createHostAdapterLifecycle(
        options({
          discoverCapabilities: () =>
            ({
              ...discovered,
              host: 'photoshop'
            }) as never
        })
      ).discoverCapabilities()
    ).toThrow('STALE_CONTEXT')
  })

  it('enforces capability discovery when validatePlan is called directly', () => {
    const lifecycle = createHostAdapterLifecycle(
      options({
        discoverCapabilities: () => ({
          host: 'figma',
          execution: { ...context().execution!, rollback: 'native-history' }
        })
      })
    )
    expect(() => lifecycle.validatePlan(plan(), context())).toThrow('STALE_CONTEXT')

    const malformed = createHostAdapterLifecycle(
      options({ discoverCapabilities: () => ({ host: 'figma' }) as never })
    )
    expect(() => malformed.validatePlan(plan(), context())).toThrow('CAPABILITY_DISCOVERY_FAILED')
  })

  it('requires captured execution capabilities to match discovery before preparation', async () => {
    const execute = vi.fn(() => ({ changed: true }))
    const discoverCapabilities = vi.fn(() => ({
      host: 'figma' as const,
      execution: context().execution!
    }))
    const lifecycle = createHostAdapterLifecycle(
      options({
        discoverCapabilities,
        captureContext: () => ({
          ...context(),
          execution: {
            ...context().execution!,
            rollback: 'native-history'
          }
        }),
        execute
      })
    )
    const result = await lifecycle.run({ runId: 'capability-mismatch', plan: plan() })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('STALE_CONTEXT')
    expect(execute).not.toHaveBeenCalled()
    expect(discoverCapabilities).toHaveBeenCalledTimes(1)
  })

  it('fails closed when capability discovery is malformed', async () => {
    const execute = vi.fn(() => ({ changed: true }))
    const lifecycle = createHostAdapterLifecycle(
      options({ discoverCapabilities: () => ({ host: 'figma' }), execute })
    )
    const result = await lifecycle.run({ runId: 'capability-failure', plan: plan() })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('CAPABILITY_DISCOVERY_FAILED')
    expect(execute).not.toHaveBeenCalled()
  })

  it('fails closed when a native adapter requires a missing capability descriptor', async () => {
    const execute = vi.fn(() => ({ changed: true }))
    const lifecycle = createHostAdapterLifecycle(
      options({ requireCapabilityDiscovery: true, execute })
    )
    const result = await lifecycle.run({ runId: 'capability-required', plan: plan() })
    expect(result.status).toBe('failed')
    expect(result.error).toEqual({ code: 'CAPABILITY_DISCOVERY_FAILED', retryable: false })
    expect(execute).not.toHaveBeenCalled()
    expect(() => lifecycle.validatePlan(plan(), context())).toThrow('CAPABILITY_DISCOVERY_FAILED')
  })

  it('reports stable compatibility errors before generic schema parsing', async () => {
    const lifecycle = createHostAdapterLifecycle(options())
    const unsupportedContext = { ...context(), version: 2 }
    expect(() => lifecycle.validatePlan(plan(), unsupportedContext)).toThrow(
      'UNSUPPORTED_CONTEXT_PROTOCOL'
    )
    const unsupportedPlan = { ...plan(), schemaVersion: 3 }
    expect(() => lifecycle.validatePlan(unsupportedPlan, context())).toThrow(
      'UNSUPPORTED_PLAN_SCHEMA'
    )
    const result = await lifecycle.run({
      runId: 'unsupported-context',
      plan: plan(),
      context: unsupportedContext
    })
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'UNSUPPORTED_CONTEXT_PROTOCOL', retryable: false }
    })

    // A lifecycle run may receive no context and therefore has to parse the
    // plan before it can capture one. Explicit schema drift must still retain
    // its stable compatibility code rather than collapsing to INVALID_PLAN.
    const unsupportedPlanResult = await lifecycle.run({
      runId: 'unsupported-plan-without-context',
      plan: { schemaVersion: 3 }
    })
    expect(unsupportedPlanResult).toMatchObject({
      status: 'failed',
      error: { code: 'UNSUPPORTED_PLAN_SCHEMA', retryable: false }
    })

    const invalidPlanResult = await lifecycle.run({
      runId: 'invalid-plan-without-context',
      plan: { kind: 'host-plan' }
    })
    expect(invalidPlanResult).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_PLAN', retryable: false }
    })
  })

  it('parses context, validates adapter identity, and records every stage', async () => {
    const lifecycle = createHostAdapterLifecycle(options())
    const result = await lifecycle.run({ runId: 'run-1', plan: plan() })
    expect(result.status).toBe('completed')
    expect(result.readback?.steps[0].observation).toBe('requested')
    expect(result.progress.map((entry) => entry.stage)).toEqual([
      'validating',
      'preparing',
      'executing',
      'readback',
      'terminal'
    ])
    expect(result.progress.every((entry) => entry.total === plan().steps.length)).toBe(true)
    expect(hostAdapterLifecycleResultSchema.parse(result)).toEqual(result)
  })

  it('fails closed on host or adapter-version mismatch', async () => {
    const lifecycle = createHostAdapterLifecycle(options())
    const stale = await lifecycle.run({
      runId: 'stale',
      plan: plan(),
      context: context('different')
    })
    expect(stale.status).toBe('failed')
    expect(stale.error?.code).toBe('STALE_CONTEXT')
    expect(() => lifecycle.validatePlan(plan(), { ...context(), host: 'photoshop' })).toThrow(
      'STALE_CONTEXT'
    )
  })

  it('reports a known adapter-family mismatch instead of collapsing to INVALID_PLAN', async () => {
    const execute = vi.fn(() => ({ changed: true }))
    const lifecycle = createHostAdapterLifecycle(
      options({
        adapterVersion: 'photoshop-uxp-native-1',
        captureContext: () => context('photoshop-uxp-native-1'),
        execute
      })
    )
    const result = await lifecycle.run({ runId: 'adapter-family-mismatch', plan: plan() })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('ADAPTER_HOST_MISMATCH')
    expect(execute).not.toHaveBeenCalled()
  })

  it('normalizes explicitly advertised host precision before execution', () => {
    const photoshopContext: HostContext = {
      ...context(),
      host: 'photoshop',
      execution: {
        ...context().execution!,
        supports: ['node.opacity'],
        opacityEncoding: 'uint8'
      },
      nodes: [{ ...context().nodes[0], type: 'layer', commands: ['node.opacity'], opacity: 0.5 }]
    }
    const lifecycle = createHostAdapterLifecycle({
      ...options(),
      host: 'photoshop',
      captureContext: () => photoshopContext
    })
    const normalized = lifecycle.validatePlan(
      {
        schemaVersion: 2,
        kind: 'host-plan',
        captureId,
        steps: [{ command: 'node.opacity', targetId: '1:2', opacity: 0.123 }]
      },
      photoshopContext
    )
    expect(normalized.steps[0]).toMatchObject({
      command: 'node.opacity',
      opacity: Math.round(0.123 * 255) / 255
    })
  })

  it('does not overwrite an active or completed run with a duplicate id', async () => {
    let resolveExecute!: (value: { changed: boolean }) => void
    const execute = vi.fn(
      () => new Promise<{ changed: boolean }>((resolve) => (resolveExecute = resolve))
    )
    const lifecycle = createHostAdapterLifecycle(options({ execute }))
    const active = lifecycle.run({ runId: 'same', plan: plan() })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    const duplicate = await lifecycle.run({ runId: 'same', plan: plan() })
    expect(duplicate.error?.code).toBe('CONCURRENT_RUN')
    expect(duplicate.progress.at(-1)?.stage).toBe('terminal')
    resolveExecute({ changed: true })
    expect((await active).status).toBe('completed')
    expect((await lifecycle.run({ runId: 'same', plan: plan() })).error?.code).toBe(
      'CONCURRENT_RUN'
    )
  })

  it('rejects overlapping native runs and releases the slot after settlement', async () => {
    let resolveExecute!: (value: { changed: boolean }) => void
    let executions = 0
    const execute = vi.fn(() => {
      executions += 1
      return executions === 1
        ? new Promise<{ changed: boolean }>((resolve) => (resolveExecute = resolve))
        : { changed: true }
    })
    const lifecycle = createHostAdapterLifecycle(options({ execute }))
    const active = lifecycle.run({ runId: 'active-run', plan: plan() })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))

    const blocked = await lifecycle.run({ runId: 'blocked-run', plan: plan() })
    expect(blocked).toMatchObject({
      status: 'failed',
      error: { code: 'CONCURRENT_RUN', retryable: false }
    })
    expect(execute).toHaveBeenCalledTimes(1)

    resolveExecute({ changed: true })
    await expect(active).resolves.toMatchObject({ status: 'completed' })
    await expect(lifecycle.run({ runId: 'blocked-run', plan: plan() })).resolves.toMatchObject({
      status: 'completed'
    })
  })

  it('accepts an explicitly bounded concurrency override', async () => {
    const execute = vi.fn(({ runId }: { runId: string }) => ({ changed: runId.length > 0 }))
    const lifecycle = createHostAdapterLifecycle(options({ execute, maxConcurrentRuns: 2 }))
    await expect(
      Promise.all([
        lifecycle.run({ runId: 'parallel-a', plan: plan() }),
        lifecycle.run({ runId: 'parallel-b', plan: plan() })
      ])
    ).resolves.toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'completed' })
    ])
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('bounds replay tombstones after old terminal metadata is pruned', async () => {
    const lifecycle = createHostAdapterLifecycle(options())
    // The lifecycle retains only a bounded tombstone window. Drive enough
    // completed runs to evict the oldest ID, then ensure a newly submitted
    // old ID is accepted once and still rejected as a duplicate immediately
    // afterwards.
    const runCount = 4096 + 256 + 1
    for (let index = 0; index < runCount; index += 1) {
      await expect(
        lifecycle.run({ runId: `bounded-${index}`, plan: plan() })
      ).resolves.toMatchObject({
        status: 'completed'
      })
    }
    await expect(lifecycle.run({ runId: 'bounded-0', plan: plan() })).resolves.toMatchObject({
      status: 'completed'
    })
    await expect(lifecycle.run({ runId: 'bounded-0', plan: plan() })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'CONCURRENT_RUN' }
    })
    expect(lifecycle.diagnostics().runs.length).toBeLessThanOrEqual(256)
  }, 20_000)

  it('cancels during execute and ignores a late execution result', async () => {
    let resolveExecute!: (value: { changed: boolean }) => void
    const execute = vi.fn(
      () => new Promise<{ changed: boolean }>((resolve) => (resolveExecute = resolve))
    )
    const lifecycle = createHostAdapterLifecycle(options({ execute }))
    const running = lifecycle.run({ runId: 'cancel-me', plan: plan() })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    await expect(lifecycle.cancel('cancel-me')).resolves.toBe(true)
    resolveExecute({ changed: true })
    const result = await running
    expect(result.status).toBe('cancelled')
    expect(result.error?.code).toBe('CANCELLED')
    expect(result.readback).toBeUndefined()
  })

  it('fails closed when the caller signal is already cancelled', async () => {
    const cancel = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const execute = vi.fn(() => ({ changed: true }))
    const lifecycle = createHostAdapterLifecycle(options({ cancel, execute }))
    const result = await lifecycle.run({
      runId: 'already-cancelled',
      plan: plan(),
      signal: controller.signal
    })
    expect(result.status).toBe('cancelled')
    expect(result.error?.code).toBe('CANCELLED')
    expect(execute).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledWith('already-cancelled', controller.signal)
  })

  it('keeps the lifecycle usable in host VMs without AbortController', async () => {
    const original = globalThis.AbortController
    vi.stubGlobal('AbortController', undefined)
    try {
      const lifecycle = createHostAdapterLifecycle(options())
      const result = await lifecycle.run({ runId: 'no-abort-controller', plan: plan() })
      expect(result.status).toBe('completed')
    } finally {
      vi.stubGlobal('AbortController', original)
    }
  })

  it('turns capture failures into a terminal validation failure without execution', async () => {
    const execute = vi.fn(() => ({ changed: true }))
    const lifecycle = createHostAdapterLifecycle(
      options({
        captureContext: () => {
          throw new Error('capture unavailable')
        },
        execute
      })
    )
    const result = await lifecycle.run({ runId: 'capture-failure', plan: plan() })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('INVALID_PLAN')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a capture callback that returns another host or capture identity', () => {
    const lifecycle = createHostAdapterLifecycle(
      options({ captureContext: () => ({ ...context(), captureId: 'b'.repeat(32) }) })
    )
    expect(() => lifecycle.captureContext(captureId)).toThrow('STALE_CONTEXT')
  })

  it('does not run later stages after preparation or execution failures', async () => {
    const prepared = createHostAdapterLifecycle(
      options({ prepareResources: () => Promise.reject(new Error('prepare')) })
    )
    const prepareResult = await prepared.run({ runId: 'prepare-failure', plan: plan() })
    expect(prepareResult.error?.code).toBe('PREPARE_FAILED')
    expect(prepareResult.progress.map((entry) => entry.stage)).toEqual([
      'validating',
      'preparing',
      'terminal'
    ])

    const executed = createHostAdapterLifecycle(
      options({ execute: () => Promise.reject(new Error('execute')) })
    )
    const executeResult = await executed.run({ runId: 'execute-failure', plan: plan() })
    expect(executeResult.error?.code).toBe('EXECUTE_FAILED')
    expect(executeResult.progress.at(-1)?.stage).toBe('terminal')
  })

  it('rejects malformed readback and never reports completion', async () => {
    const lifecycle = createHostAdapterLifecycle(options({ readback: () => ({}) }))
    const result = await lifecycle.run({ runId: 'bad-readback', plan: plan() })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('READBACK_FAILED')
  })

  it('keeps diagnostics bounded to metadata and rejects backwards transitions', () => {
    expect(canTransitionHostAdapterLifecycle('executing', 'preparing')).toBe(false)
    expect(() =>
      hostAdapterLifecycleTransitionSchema.parse({ from: 'executing', to: 'preparing' })
    ).toThrow()
    const lifecycle = createHostAdapterLifecycle(options())
    const diagnostics = lifecycle.diagnostics()
    expect(diagnostics).not.toHaveProperty('plan')
    expect(diagnostics).not.toHaveProperty('execution')
    expect(diagnostics.activeRunIds).toEqual([])
    expect(hostAdapterLifecycleDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics)
  })

  it('rejects progress that claims more completed work than the plan total', () => {
    expect(() =>
      hostAdapterLifecycleResultSchema.parse({
        runId: 'bad-progress',
        status: 'failed',
        stage: 'terminal',
        progress: [{ stage: 'terminal', completed: 2, total: 1, timestamp: 1 }],
        error: { code: 'EXECUTE_FAILED', retryable: true }
      })
    ).toThrow()
  })

  it('keeps terminal progress monotonic when an adapter reports a late lower value', async () => {
    const lifecycle = createHostAdapterLifecycle(
      options({
        execute: ({ onProgress }) => {
          onProgress?.(1, 1)
          onProgress?.(0, 1)
          return { changed: true }
        }
      })
    )
    const result = await lifecycle.run({ runId: 'monotonic-progress', plan: plan() })
    expect(result.status).toBe('completed')
    expect(result.progress.map((entry) => entry.completed)).toEqual([0, 0, 0, 1, 1, 1, 1])
  })

  it('rejects malformed run IDs before creating a run record', async () => {
    const lifecycle = createHostAdapterLifecycle(options())
    await expect(lifecycle.run({ runId: 'bad id', plan: plan() })).rejects.toThrow('INVALID_RUN_ID')
    expect(lifecycle.diagnostics().runs).toEqual([])
  })
})
