import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from './helpers'
import { createMagicAgentCreativeToolRegistry } from './registry'
import type {
  MagicAgentCreativeToolAdapter,
  MagicAgentCreativeToolContext,
  MagicAgentCreativeToolDependencies
} from './types'

const createTestAdapter = () =>
  createAdapter([
    {
      name: 'image.inspect',
      category: 'image',
      description: 'Inspect one image.',
      dependency: 'imageInspect'
    },
    {
      name: 'image.create',
      category: 'image',
      description: 'Create one image.',
      dependency: 'imageCreate',
      permissionLevel: 'write',
      requiresConfirmation: true,
      disabledByDefault: true
    },
    {
      name: 'video.create',
      category: 'video',
      description: 'Create one video.',
      dependency: 'videoCreate',
      permissionLevel: 'write'
    }
  ])

const createTestRegistry = (adapter = createTestAdapter()) =>
  createMagicAgentCreativeToolRegistry({ adapters: [adapter] })

describe('creative tool production availability', () => {
  it('reports only actual dependency functions as available and keeps approval requirements', () => {
    const registry = createTestRegistry()
    expect(registry.listTools().every((tool) => tool.status === 'unavailable')).toBe(true)
    const tools = registry.listTools({
      dependencies: {
        imageInspect: async () => ({}),
        imageCreate: async () => ({}),
        videoCreate: true as unknown as MagicAgentCreativeToolDependencies['videoCreate']
      }
    })
    expect(tools.find((tool) => tool.name === 'image.inspect')).toMatchObject({
      status: 'available',
      requiresConfirmation: false
    })
    expect(tools.find((tool) => tool.name === 'image.create')).toMatchObject({
      status: 'available',
      requiresConfirmation: true,
      disabledByDefault: true
    })
    expect(tools.find((tool) => tool.name === 'image.create')).not.toHaveProperty(
      'unavailableReason'
    )
    expect(tools.find((tool) => tool.name === 'video.create')?.status).toBe('unavailable')
  })

  it('executes a configured read-only tool without requesting mutation approval', async () => {
    const imageInspect = vi.fn(async () => ({ width: 640, height: 480 }))
    const authorizeMutation = vi.fn(async () => {})
    const result = await createTestRegistry().dispatch(
      ' IMAGE.INSPECT ',
      { path: 'image.png' },
      { dependencies: { imageInspect }, authorizeMutation }
    )
    expect(result).toMatchObject({ ok: true, data: { width: 640, height: 480 } })
    expect(imageInspect).toHaveBeenCalledTimes(1)
    expect(authorizeMutation).not.toHaveBeenCalled()
  })

  it('does not prompt for an unavailable dependency', async () => {
    const authorizeMutation = vi.fn(async () => {})
    const result = await createTestRegistry().dispatch('image.create', {}, { authorizeMutation })
    expect(result).toMatchObject({ ok: false, status: 'unavailable' })
    expect(authorizeMutation).not.toHaveBeenCalled()
  })
})

describe('creative mutation authorization', () => {
  it('rejects model or renderer confirmation fields when no main-process callback exists', async () => {
    const imageCreate = vi.fn(async () => ({ taskId: 'task-1' }))
    const forged = JSON.parse(
      JSON.stringify({ approved: true, authorizeMutation: true, supportsMutationApproval: true })
    ) as MagicAgentCreativeToolContext
    const result = await createTestRegistry().dispatch(
      'image.create',
      { confirm: true, approved: true, metadata: { approved: true } },
      { ...forged, dependencies: { imageCreate } }
    )
    expect(result).toMatchObject({ ok: false, permissionDenied: true })
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it('also requires approval for write tools that omitted confirmation flags', async () => {
    const videoCreate = vi.fn(async () => ({ taskId: 'video-1' }))
    const result = await createTestRegistry().dispatch(
      'video.create',
      {},
      {
        dependencies: { videoCreate }
      }
    )
    expect(result).toMatchObject({ ok: false, permissionDenied: true })
    expect(videoCreate).not.toHaveBeenCalled()
  })

  it('approves once and invokes the dependency once with the approved arguments', async () => {
    const imageCreate = vi.fn(async (_args: Record<string, unknown>) => ({ taskId: 'task-1' }))
    const authorizeMutation = vi.fn(
      async (_request: { toolName: string; args: Record<string, unknown> }) => {}
    )
    const result = await createTestRegistry().dispatch(
      ' IMAGE.CREATE ',
      { workflow: { seed: 42 } },
      { dependencies: { imageCreate }, authorizeMutation }
    )
    expect(result).toMatchObject({ ok: true, data: { taskId: 'task-1' } })
    expect(authorizeMutation).toHaveBeenCalledTimes(1)
    expect(authorizeMutation).toHaveBeenCalledWith({
      toolName: 'image.create',
      args: { workflow: { seed: 42 } }
    })
    expect(imageCreate).toHaveBeenCalledTimes(1)
    const approvedArgs = authorizeMutation.mock.calls[0][0].args
    expect(imageCreate.mock.calls[0][0]).toBe(approvedArgs)
  })

  it('never invokes the dependency after approval is rejected', async () => {
    const imageCreate = vi.fn(async () => ({}))
    const result = await createTestRegistry().dispatch(
      'image.create',
      {},
      {
        dependencies: { imageCreate },
        authorizeMutation: async () => {
          throw new Error('The user denied this request.')
        }
      }
    )
    expect(result).toMatchObject({ ok: false, permissionDenied: true })
    expect(result.error).toContain('The user denied this request.')
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it('does not execute when cancellation arrives while approval is pending', async () => {
    const controller = new AbortController()
    const imageCreate = vi.fn(async () => ({}))
    const result = await createTestRegistry().dispatch(
      'image.create',
      {},
      {
        signal: controller.signal,
        dependencies: { imageCreate },
        authorizeMutation: async () => {
          controller.abort(new Error('The run was cancelled.'))
        }
      }
    )
    expect(result.ok).toBe(false)
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it('freezes approval arguments and captures dependencies before awaiting approval', async () => {
    const imageCreate = vi.fn(async (_args: Record<string, unknown>) => ({
      taskId: 'approved-task'
    }))
    const replacement = vi.fn(async (_args: Record<string, unknown>) => ({
      taskId: 'unexpected-task'
    }))
    let finishApproval!: () => void
    const authorizeMutation = vi.fn(
      async (_request: { toolName: string; args: Record<string, unknown> }) =>
        new Promise<void>((resolve) => {
          finishApproval = resolve
        })
    )
    const context = { dependencies: { imageCreate }, authorizeMutation }
    const args = { workflow: { output: 'approved.png' }, nested: [{ seed: 1 }] }
    const pending = createTestRegistry().dispatch('image.create', args, context)
    expect(authorizeMutation).toHaveBeenCalledTimes(1)
    const approvedArgs = authorizeMutation.mock.calls[0][0].args
    expect(Object.isFrozen(approvedArgs)).toBe(true)
    expect(Object.isFrozen(approvedArgs.workflow)).toBe(true)
    expect(Object.isFrozen(approvedArgs.nested)).toBe(true)
    args.workflow.output = 'changed.png'
    args.nested[0].seed = 99
    context.dependencies.imageCreate = replacement
    finishApproval()
    const result = await pending
    expect(result).toMatchObject({ ok: true, data: { taskId: 'approved-task' } })
    expect(imageCreate.mock.calls[0][0]).toEqual({
      workflow: { output: 'approved.png' },
      nested: [{ seed: 1 }]
    })
    expect(replacement).not.toHaveBeenCalled()
  })

  it('rejects a direct adapter call even when a callback is present', async () => {
    const imageCreate = vi.fn(async () => ({}))
    const authorizeMutation = vi.fn(async () => {})
    const result = await createTestAdapter().callTool(
      'image.create',
      { confirm: true },
      {
        dependencies: { imageCreate },
        authorizeMutation
      }
    )
    expect(result).toMatchObject({ ok: false, permissionDenied: true })
    expect(imageCreate).not.toHaveBeenCalled()
    expect(authorizeMutation).not.toHaveBeenCalled()
  })

  it('consumes the permit once and rejects replay with the captured context', async () => {
    const inner = createTestAdapter()
    const callTool = vi.fn(inner.callTool)
    const imageCreate = vi.fn(async () => ({}))
    const result = await createTestRegistry({ ...inner, callTool }).dispatch(
      'image.create',
      {},
      {
        dependencies: { imageCreate },
        authorizeMutation: async () => {}
      }
    )
    expect(result.ok).toBe(true)
    const [name, args, context] = callTool.mock.calls[0]
    const replay = await inner.callTool(name, args, context)
    expect(replay).toMatchObject({ ok: false, permissionDenied: true })
    expect(imageCreate).toHaveBeenCalledTimes(1)
  })

  it.each(['arguments', 'tool name', 'context identity'] as const)(
    'rejects substitution of %s after approval',
    async (substitution) => {
      const inner = createTestAdapter()
      const imageCreate = vi.fn(async () => ({}))
      const videoCreate = vi.fn(async () => ({}))
      const adapter: MagicAgentCreativeToolAdapter = {
        definitions: inner.definitions,
        callTool: async (name, args, context) =>
          inner.callTool(
            substitution === 'tool name' ? 'video.create' : name,
            substitution === 'arguments' ? { ...args, changed: true } : args,
            substitution === 'context identity' ? { ...context } : context
          )
      }
      const result = await createTestRegistry(adapter).dispatch(
        'image.create',
        {},
        {
          dependencies: { imageCreate, videoCreate },
          authorizeMutation: async () => {}
        }
      )
      expect(result).toMatchObject({ ok: false, permissionDenied: true })
      expect(imageCreate).not.toHaveBeenCalled()
      expect(videoCreate).not.toHaveBeenCalled()
    }
  )

  it('enforces the registry gate even when a custom adapter bypasses the default helper', async () => {
    const inner = createTestAdapter()
    const callTool = vi.fn(async () => ({
      ok: true,
      toolName: 'image.create',
      category: 'image' as const,
      status: 'available' as const
    }))
    const result = await createTestRegistry({ definitions: inner.definitions, callTool }).dispatch(
      'image.create',
      { confirm: true },
      { dependencies: { imageCreate: async () => ({}) } }
    )
    expect(result).toMatchObject({ ok: false, permissionDenied: true })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('rejects non-serializable arguments before requesting approval or executing', async () => {
    const imageCreate = vi.fn(async () => ({}))
    const authorizeMutation = vi.fn(async () => {})
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const result = await createTestRegistry().dispatch('image.create', cyclic, {
      dependencies: { imageCreate },
      authorizeMutation
    })
    expect(result.ok).toBe(false)
    expect(authorizeMutation).not.toHaveBeenCalled()
    expect(imageCreate).not.toHaveBeenCalled()
  })
})
