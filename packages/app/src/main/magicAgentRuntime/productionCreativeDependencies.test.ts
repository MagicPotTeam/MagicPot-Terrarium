import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Config } from '@shared/config/config'
import {
  createProductionCreativeToolDependencies,
  type ProductionCreativeDirectories,
  type ProductionCreativeToolPorts
} from './productionCreativeDependencies'

// The repository's node-test setup uses memfs. These containment and file-identity
// cases intentionally exercise the real filesystem, including Windows junctions.
vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('fs/promises')
vi.unmock('node:fs/promises')

const prompt = { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'studio' } } }
const png = () => {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(64, 16)
  bytes.writeUInt32BE(32, 20)
  return bytes
}

describe('production creative dependencies', () => {
  let root = ''
  let directories: ProductionCreativeDirectories
  let ports: ProductionCreativeToolPorts
  const submitted = vi.fn(async () => ({ prompt_id: 'task-123' }))
  const imported = vi.fn(
    async () => ({ reference: { kind: 'managed' }, localMediaUrl: 'managed:asset' }) as never
  )
  const called = vi.fn(async () => ({ content: 'external result', metadata: {} }))

  beforeEach(async () => {
    vi.clearAllMocks()
    root = ''
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'magicpot-creative-dependencies-'))
    )
    directories = {
      projects: [path.join(root, 'projects'), path.join(root, 'autosave')],
      output: path.join(root, 'output'),
      workflow: path.join(root, 'workflows'),
      media: path.join(root, 'media'),
      models: { checkpoints: path.join(root, 'models'), loras: path.join(root, 'missing-loras') }
    }
    await Promise.all(
      [
        ...directories.projects,
        directories.output,
        directories.workflow,
        directories.media,
        directories.models.checkpoints
      ].map((directory) => fs.mkdir(directory))
    )
    ports = {
      getConfig: vi.fn(() => ({}) as Config),
      getDirectories: vi.fn(() => directories),
      comfy: vi.fn(() => ({
        getQueue: async () => ({ queue_running: [], queue_pending: [] }),
        submitWorkflow: submitted
      })),
      probeComfy: vi.fn(async () => ({ origin: 'http://127.0.0.1:8188', nodeTypeCount: 3 })),
      qapp: vi.fn(() => ({
        listQAppCfgs: async () => ({
          qApps: [
            {
              key: 'folder',
              name: 'Folder',
              isDirectory: true,
              isBuiltin: false,
              children: [
                { key: 'folder/first', name: 'First', isBuiltin: false },
                { key: 'folder/second', name: 'Second', isBuiltin: false }
              ]
            }
          ]
        }),
        getQAppCfg: async () => ({ cfg: {} as never, workflow: prompt })
      })),
      media: vi.fn(() => ({ importFile: imported })),
      traces: vi.fn(() => ({
        listProjectTraces: async () => ({ traces: [] }),
        readProjectTraceDocument: async () => ({ trace: null })
      })),
      mcp: vi.fn(() => ({
        listConnections: () => [],
        listToolsSnapshot: () => [
          { name: 'external.search', description: 'Search', inputSchema: {} }
        ],
        callToolByAlias: called
      }))
    }
  })

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
    root = ''
  })

  it('constructs all 20 exposed dependencies without service or filesystem initialization', () => {
    const deps = createProductionCreativeToolDependencies(ports)
    expect(Object.keys(deps)).toHaveLength(20)
    expect(deps.modelStatus).toBeTypeOf('function')
    expect(deps.terminalRun).toBeUndefined()
    for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled()
  })

  it('reports an actual Comfy probe and reports disconnection rather than success', async () => {
    const deps = createProductionCreativeToolDependencies(ports)
    await expect(deps.comfyStatus!({})).resolves.toMatchObject({
      connected: true,
      nodeTypeCount: 3
    })
    ports.probeComfy = vi.fn(async () => {
      throw new Error('connection refused')
    })
    await expect(createProductionCreativeToolDependencies(ports).comfyStatus!({})).resolves.toEqual(
      { connected: false, error: 'connection refused' }
    )
  })

  it('submits an explicit workflow once and returns a submission receipt with trusted session identity', async () => {
    const deps = createProductionCreativeToolDependencies(ports)
    const result = await deps.imageCreate!(
      { workflow: prompt, clientId: 'untrusted', sessionKey: 'forged' },
      { sessionKey: 'trusted-session' }
    )
    expect(result).toEqual({
      status: 'submitted',
      taskId: 'task-123',
      promptId: 'task-123',
      requestedOutputKind: 'image'
    })
    expect(submitted).toHaveBeenCalledExactlyOnceWith({ prompt, sessionKey: 'trusted-session' })
    expect(result).not.toHaveProperty('imageUrl')
  })

  it('loads a saved quick-app executable workflow for video submission', async () => {
    await createProductionCreativeToolDependencies(ports).videoCreate!({ qAppKey: 'folder/video' })
    expect(submitted).toHaveBeenCalledExactlyOnceWith({ prompt, qAppKey: 'folder/video' })
  })

  it('loads configured workflow JSON by relative ID and refuses traversal', async () => {
    await fs.writeFile(path.join(directories.workflow, 'example.json'), JSON.stringify(prompt))
    const deps = createProductionCreativeToolDependencies(ports)
    await deps.comfySubmitWorkflow!({ workflowId: 'example' })
    expect(submitted).toHaveBeenCalledExactlyOnceWith({ prompt })
    await expect(deps.comfySubmitWorkflow!({ workflowId: '../outside' })).rejects.toThrow(
      'traversal'
    )
    expect(submitted).toHaveBeenCalledTimes(1)
  })

  it.each([
    { prompt: 'draw a picture' },
    { workflow: { nodes: [], links: [] } },
    { workflow: { '1': { inputs: {} } } },
    {}
  ])('rejects non-executable workflow arguments without submission: %j', async (args) => {
    await expect(
      createProductionCreativeToolDependencies(ports).comfySubmitWorkflow!(args)
    ).rejects.toThrow(/API|class_type/u)
    expect(submitted).not.toHaveBeenCalled()
  })

  it('does not retry ambiguous submission errors', async () => {
    submitted.mockRejectedValueOnce(new Error('submission acknowledgement lost'))
    await expect(
      createProductionCreativeToolDependencies(ports).imageCreate!({ workflow: prompt })
    ).rejects.toThrow('acknowledgement lost')
    expect(submitted).toHaveBeenCalledTimes(1)
  })

  it('checks cancellation before creating a submission service', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      createProductionCreativeToolDependencies(ports).imageCreate!(
        { workflow: prompt },
        { signal: controller.signal }
      )
    ).rejects.toThrow('cancelled')
    expect(ports.comfy).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
  })

  it('lists quick-app leaves with an explicit result limit', async () => {
    await expect(
      createProductionCreativeToolDependencies(ports).qappList!({ limit: 1 })
    ).resolves.toEqual({
      qApps: [{ key: 'folder/first', name: 'First', isBuiltin: false }],
      truncated: true
    })
  })

  it('inspects bounded media bytes without returning binary content', async () => {
    const source = path.join(directories.output, 'image.png')
    await fs.writeFile(source, png())
    const result = await createProductionCreativeToolDependencies(ports).imageInspect!({
      path: source
    })
    expect(result).toMatchObject({ mimeType: 'image/png', width: 64, height: 32, sizeBytes: 24 })
    expect(result).not.toHaveProperty('data')
  })

  it('rejects an outside file and URL rather than reading or downloading them', async () => {
    const outside = path.join(root, 'outside.png')
    await fs.writeFile(outside, png())
    const deps = createProductionCreativeToolDependencies(ports)
    await expect(deps.imageInspect!({ path: outside })).rejects.toThrow('outside')
    await expect(deps.imageInspect!({ url: 'https://example.com/image.png' })).rejects.toThrow(
      'Remote URLs'
    )
  })

  it('does not follow a project-directory junction outside configured roots', async () => {
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.png'), png())
    const linked = path.join(directories.projects[0], 'linked')
    await fs.symlink(outside, linked, 'junction')
    const deps = createProductionCreativeToolDependencies(ports)
    await expect(deps.imageInspect!({ path: path.join(linked, 'secret.png') })).rejects.toThrow(
      'outside'
    )
    expect(await deps.assetList!({})).toMatchObject({ files: [] })
  })

  it('lists model files within configured directories and rejects ambiguous names', async () => {
    await fs.writeFile(path.join(directories.models.checkpoints, 'model.safetensors'), 'model')
    await fs.mkdir(path.join(directories.models.checkpoints, 'nested'))
    await fs.writeFile(
      path.join(directories.models.checkpoints, 'nested', 'model.safetensors'),
      'other'
    )
    await fs.writeFile(path.join(directories.models.checkpoints, 'ignore.txt'), 'not a model')
    const deps = createProductionCreativeToolDependencies(ports)
    expect(await deps.modelList!({ type: 'checkpoints', limit: 1 })).toMatchObject({
      truncated: true,
      files: [expect.objectContaining({ filename: 'model.safetensors' })]
    })
    await expect(deps.modelInspect!({ name: 'model.safetensors' })).rejects.toThrow('ambiguous')
    expect(
      await deps.modelInspect!({
        path: path.join(directories.models.checkpoints, 'model.safetensors')
      })
    ).toMatchObject({ format: 'safetensors', sizeBytes: 5 })
    expect(await deps.modelStatus!({})).toMatchObject({
      availableDirectoryCount: 1,
      scope: 'local-model-files'
    })
  })

  it('reports saved canvas status and exports JSON without overwrite', async () => {
    const source = path.join(directories.projects[0], 'project.mpcanvas')
    const destination = path.join(directories.output, 'export.json')
    await fs.writeFile(source, JSON.stringify({ nodes: [{ id: 'a' }] }))
    const deps = createProductionCreativeToolDependencies(ports)
    expect(await deps.canvasStatus!({ path: source })).toMatchObject({
      scope: 'saved-project',
      nodeCount: 1
    })
    await deps.canvasExport!({ path: source, outputPath: destination, format: 'json' })
    expect(JSON.parse(await fs.readFile(destination, 'utf8'))).toEqual({ nodes: [{ id: 'a' }] })
    await expect(
      deps.canvasExport!({ path: source, outputPath: destination })
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(
      deps.canvasExport!({ path: source, outputPath: path.join(root, 'outside.json') })
    ).rejects.toThrow('outside')
    await expect(
      deps.canvasExport!({ path: source, outputPath: destination, format: 'png' })
    ).rejects.toThrow('canvas UI')
  })

  it('rejects oversized canvas content before parsing or writing', async () => {
    const source = path.join(directories.projects[0], 'large.mpcanvas')
    await fs.writeFile(source, Buffer.alloc(4 * 1024 * 1024 + 1))
    await expect(
      createProductionCreativeToolDependencies(ports).canvasStatus!({ path: source })
    ).rejects.toThrow('byte tool limit')
  })

  it('imports verified media through the managed-media service', async () => {
    const source = path.join(directories.output, 'image.png')
    await fs.writeFile(source, png())
    await createProductionCreativeToolDependencies(ports).assetImport!({
      path: source,
      kind: 'image'
    })
    expect(imported).toHaveBeenCalledExactlyOnceWith({
      sourcePath: pathToFileURL(source).href,
      mimeType: 'image/png',
      originalFileName: 'image.png'
    })
  })

  it('rejects media signature mismatch and remote imports before dispatch', async () => {
    const source = path.join(directories.output, 'image.png')
    await fs.writeFile(source, png())
    const deps = createProductionCreativeToolDependencies(ports)
    await expect(deps.assetImport!({ path: source, kind: 'video' })).rejects.toThrow('signature')
    await expect(deps.assetImport!({ url: 'http://127.0.0.1/private' })).rejects.toThrow(
      'Remote URL'
    )
    expect(imported).not.toHaveBeenCalled()
  })

  it('reports video metadata without inventing duration', async () => {
    const source = path.join(directories.output, 'clip.mp4')
    const data = Buffer.alloc(16)
    data.write('ftyp', 4, 'ascii')
    data.write('isom', 8, 'ascii')
    await fs.writeFile(source, data)
    const result = await createProductionCreativeToolDependencies(ports).videoInspect!({
      path: source
    })
    expect(result).toMatchObject({ mimeType: 'video/mp4', durationAvailable: false })
    expect(result).not.toHaveProperty('duration')
  })

  it('keeps MCP calls behind the existing discovered-alias dispatcher and preserves errors', async () => {
    const deps = createProductionCreativeToolDependencies(ports)
    await deps.mcpCallTool!({ toolName: 'external.search', args: { query: 'example' } })
    expect(called).toHaveBeenCalledWith('external.search', { query: 'example' }, undefined)
    await expect(deps.mcpCallTool!({ toolName: 'unknown' })).rejects.toThrow('not connected')
    called.mockResolvedValueOnce({ content: 'provider error', metadata: { isError: true } })
    await expect(deps.mcpCallTool!({ toolName: 'external.search' })).rejects.toThrow(
      'provider error'
    )
  })

  it('rejects forged project paths and traversing trace IDs before service calls', async () => {
    const deps = createProductionCreativeToolDependencies(ports)
    await expect(
      deps.projectTraceList!({ project: { projectId: 'x', projectRootDir: root } })
    ).rejects.toThrow('outside')
    await expect(deps.projectTraceList!({ project: { projectId: '../secret' } })).rejects.toThrow(
      'traversal'
    )
    await expect(
      deps.projectTraceRead!({ project: { projectId: 'x' }, traceId: '../secret' })
    ).rejects.toThrow('traversal')
    expect(ports.traces).not.toHaveBeenCalled()
  })
})
