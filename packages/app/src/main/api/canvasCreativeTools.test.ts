import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvasCreativeToolProvider, CANVAS_CREATIVE_TOOL_NAMES } from './canvasCreativeTools'

const { approve } = vi.hoisted(() => ({ approve: vi.fn(async (): Promise<void> => undefined) }))
vi.mock('../magicAgentRuntime/creativeToolApproval', () => ({ requestCreativeToolApproval: approve }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const context = () => ({ route, runId: 'owned-run', toolCallId: 'owned-call' })
afterEach(() => vi.clearAllMocks())

describe('request-owned Agent thread creative tools', () => {
  it('discovers only implemented, deliberately admitted tools without calling services', () => {
    const comfyStatus = vi.fn()
    const provider = createCanvasCreativeToolProvider({
      route,
      assertInvocation: vi.fn(),
      dependencies: { comfyStatus, mcpCallTool: vi.fn(), terminalRun: vi.fn() }
    })
    expect(provider.listTools().map((tool) => tool.name)).toEqual(['comfyui.status'])
    expect(comfyStatus).not.toHaveBeenCalled()
    expect(CANVAS_CREATIVE_TOOL_NAMES).not.toContain('terminal.run')
    expect(CANVAS_CREATIVE_TOOL_NAMES).not.toContain('mcp.tool.call')
  })

  it('returns real read results with the main-owned route, without requesting mutation approval', async () => {
    const comfyStatus = vi.fn(async () => ({ connected: true, nodeTypeCount: 12 }))
    const assertInvocation = vi.fn()
    const provider = createCanvasCreativeToolProvider({ route, assertInvocation, dependencies: { comfyStatus } })
    expect(await provider.callTool('comfyui.status', {}, context())).toMatchObject({
      content: JSON.stringify({ connected: true, nodeTypeCount: 12 })
    })
    expect(comfyStatus).toHaveBeenCalledWith({}, expect.objectContaining({ route }))
    expect(assertInvocation).toHaveBeenCalledWith('comfyui.status')
    expect(approve).not.toHaveBeenCalled()
  })

  it('waits for one-shot approval before submitting and returns a submission receipt, not completed media', async () => {
    const imageCreate = vi.fn(async () => ({ status: 'submitted', taskId: 'task-a' }))
    let release!: () => void
    approve.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const provider = createCanvasCreativeToolProvider({ route, assertInvocation: vi.fn(), dependencies: { imageCreate } })
    const result = provider.callTool('image.create', { qAppKey: 'saved-workflow' }, context())
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce())
    expect(imageCreate).not.toHaveBeenCalled()
    release()
    expect(await result).toMatchObject({ content: '{"status":"submitted","taskId":"task-a"}' })
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'image.create', args: { qAppKey: 'saved-workflow' }, route
    }))
    expect(imageCreate).toHaveBeenCalledOnce()
  })

  it.each(['denied', 'cancelled', 'renderer-closed'])('does not execute after approval is %s', async (kind) => {
    const imageCreate = vi.fn()
    const controller = new AbortController()
    let active = true
    approve.mockImplementationOnce(async () => {
      if (kind === 'denied') throw new Error('User denied')
      if (kind === 'cancelled') controller.abort()
      if (kind === 'renderer-closed') active = false
    })
    const provider = createCanvasCreativeToolProvider({ route, dependencies: { imageCreate }, assertInvocation: () => {
      if (!active) throw new Error('Renderer closed')
    } })
    await expect(provider.callTool('image.create', { qAppKey: 'saved' }, { ...context(), signal: controller.signal })).rejects.toThrow()
    expect(imageCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['comfyui.workflow.submit', 'comfySubmitWorkflow', { qAppKey: 'saved' }],
    ['image.create', 'imageCreate', { qAppKey: 'saved' }],
    ['video.create', 'videoCreate', { qAppKey: 'saved' }],
    ['canvas.export', 'canvasExport', { path: 'source.mpcanvas', outputPath: 'export.json' }],
    ['asset.import', 'assetImport', { path: 'image.png' }]
  ] as const)('never executes %s when its user approval is denied', async (name, dependency, args) => {
    const effect = vi.fn()
    approve.mockRejectedValueOnce(new Error('User denied'))
    const provider = createCanvasCreativeToolProvider({ route, assertInvocation: vi.fn(), dependencies: { [dependency]: effect } })
    await expect(provider.callTool(name, args, context())).rejects.toThrow('User denied')
    expect(approve).toHaveBeenCalledOnce()
    expect(effect).not.toHaveBeenCalled()
  })

  it('rejects foreign threads and tools before touching any service or approval', async () => {
    const imageCreate = vi.fn()
    const provider = createCanvasCreativeToolProvider({ route, assertInvocation: vi.fn(), dependencies: { imageCreate } })
    await expect(provider.callTool('image.create', {}, { ...context(), route: { ...route, threadId: 'other' } })).rejects.toThrow('authorized Agent thread')
    await expect(provider.callTool('mcp.tool.call', {}, context())).rejects.toThrow('authorized Agent thread')
    expect(imageCreate).not.toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
  })

  it.each([
    { prompt: 'plain text is not a workflow' },
    { qAppKey: 'saved', confirm: true },
    { workflowId: 123 }
  ])('rejects invalid arguments before approval: %j', async (args) => {
    const imageCreate = vi.fn()
    const provider = createCanvasCreativeToolProvider({ route, assertInvocation: vi.fn(), dependencies: { imageCreate } })
    await expect(provider.callTool('image.create', args, context())).rejects.toThrow('Invalid arguments')
    expect(imageCreate).not.toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
  })

  it('does not let a caller mutate schemas or approved arguments', async () => {
    const imageCreate = vi.fn(async () => ({ status: 'submitted' }))
    const provider = createCanvasCreativeToolProvider({ route, assertInvocation: vi.fn(), dependencies: { imageCreate } })
    const definition = provider.listTools()[0]
    definition.inputSchema.properties = {}
    definition.inputSchema.additionalProperties = true
    const args = { qAppKey: 'original' }
    approve.mockImplementationOnce(async () => { args.qAppKey = 'changed' })
    await provider.callTool('image.create', args, context())
    expect(imageCreate).toHaveBeenCalledWith({ qAppKey: 'original' }, expect.anything())
    await expect(provider.callTool('image.create', { confirm: true }, context())).rejects.toThrow('Invalid arguments')
  })

  it('propagates service errors instead of reporting a successful tool receipt', async () => {
    const provider = createCanvasCreativeToolProvider({ route, assertInvocation: vi.fn(), dependencies: {
      comfyStatus: async () => { throw new Error('Service unavailable') }
    } })
    await expect(provider.callTool('comfyui.status', {}, context())).rejects.toThrow('Service unavailable')
  })

  it('rejects cancelled and oversized calls without invoking services', async () => {
    const comfyStatus = vi.fn()
    const provider = createCanvasCreativeToolProvider({ route, assertInvocation: vi.fn(), dependencies: { comfyStatus } })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.callTool('comfyui.status', {}, { ...context(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(provider.callTool('comfyui.status', { padding: 'x'.repeat(512 * 1024) }, context())).rejects.toThrow('byte limit')
    expect(comfyStatus).not.toHaveBeenCalled()
  })
})
