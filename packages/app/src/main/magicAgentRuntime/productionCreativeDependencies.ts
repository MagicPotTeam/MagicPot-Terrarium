import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Config } from '@shared/config/config'
import type { ComfySvc, SubmitWorkflowReq } from '@shared/api/svcComfy'
import type { QAppSvc } from '@shared/api/svcQApp'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import type { ProjectTraceSvc } from '@shared/api/svcProjectTrace'
import type { ProjectTraceProjectRef } from '@shared/projectTrace'
import type { Workflow } from '@shared/comfy/types'
import type { McpClientManager } from '../mcp/clientManager'
import type {
  MagicAgentCreativeToolContext,
  MagicAgentCreativeToolDependencies
} from './tools/types'

const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_HEADER_BYTES = 64 * 1024
const MAX_SCAN_ENTRIES = 5_000
const MAX_SCAN_DIRECTORIES = 256
const MAX_SCAN_DEPTH = 6
const SCAN_TIMEOUT_MS = 5_000
const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg', '.m4a'])

export type ProductionCreativeDirectories = {
  projects: string[]
  output: string
  workflow: string
  media: string
  models: Record<string, string>
}

/** Lazy service ports keep discovery free of I/O and make submissions testable without ComfyUI. */
export type ProductionCreativeToolPorts = {
  getConfig: () => Config | Promise<Config>
  getDirectories: (
    config: Config
  ) => ProductionCreativeDirectories | Promise<ProductionCreativeDirectories>
  comfy: () =>
    | Pick<ComfySvc, 'getQueue' | 'submitWorkflow'>
    | Promise<Pick<ComfySvc, 'getQueue' | 'submitWorkflow'>>
  probeComfy: (
    config: Config,
    signal: AbortSignal
  ) => Promise<{ origin: string; nodeTypeCount: number }>
  qapp: () =>
    | Pick<QAppSvc, 'listQAppCfgs' | 'getQAppCfg'>
    | Promise<Pick<QAppSvc, 'listQAppCfgs' | 'getQAppCfg'>>
  media: () => Pick<ManagedMediaSvc, 'importFile'> | Promise<Pick<ManagedMediaSvc, 'importFile'>>
  traces: () =>
    | Pick<ProjectTraceSvc, 'listProjectTraces' | 'readProjectTraceDocument'>
    | Promise<Pick<ProjectTraceSvc, 'listProjectTraces' | 'readProjectTraceDocument'>>
  mcp: () =>
    | Pick<McpClientManager, 'listConnections' | 'listToolsSnapshot' | 'callToolByAlias'>
    | Promise<Pick<McpClientManager, 'listConnections' | 'listToolsSnapshot' | 'callToolByAlias'>>
}

const defaults: ProductionCreativeToolPorts = {
  getConfig: async () => (await import('../config/config')).getConfig(),
  getDirectories: async (config) => {
    const [
      { ConfigUtils },
      { getBuildEnv },
      { getCurrentUserDataDirectoryState },
      { getChatMediaDir }
    ] = await Promise.all([
      import('@shared/config/configUtils'),
      import('../config/buildEnv'),
      import('../config/userDataDirectory'),
      import('../llmProxy/chatMediaDir')
    ])
    const utils = new ConfigUtils(config, getBuildEnv(), path)
    const storage = getCurrentUserDataDirectoryState()
    return {
      projects: [storage.projectRoot, storage.autoSaveRoot],
      output: utils.getOutputDir(),
      workflow: utils.getWorkflowDir(),
      media: getChatMediaDir(),
      models: {
        checkpoints: utils.getCheckpointsDir(),
        loras: utils.getLoraDir(),
        clip: utils.getClipDir(),
        vae: utils.getVAEDir(),
        controlnet: utils.getControlnetDir(),
        diffusion_models: utils.getDiffusionModelsDir(),
        unet: utils.getUNetDir(),
        upscale_models: utils.getUpscaleModelsDir()
      }
    }
  },
  comfy: async () => new (await import('../api/svcComfyImpl')).ComfySvcImpl(),
  probeComfy: async (config, signal) => {
    const [{ ComfyHttpCli }, { ConfigUtils }, { getBuildEnv }] = await Promise.all([
      import('../comfy/http'),
      import('@shared/config/configUtils'),
      import('../config/buildEnv')
    ])
    const origin = new ConfigUtils(config, getBuildEnv(), path).getComfyUIOrigin()
    const info = await new ComfyHttpCli(config).objectInfo(signal)
    return { origin, nodeTypeCount: Object.keys(info).length }
  },
  qapp: async () => new (await import('../api/svcQAppImpl')).QAppSvcImpl(),
  media: async () => new (await import('../api/svcManagedMediaImpl')).ManagedMediaSvcImpl(),
  traces: async () => new (await import('../api/svcProjectTraceImpl')).ProjectTraceSvcImpl(),
  mcp: async () => (await import('../mcp/runtime')).getMcpClientManager()
}

const checkAbort = (context?: MagicAgentCreativeToolContext): void =>
  context?.signal?.throwIfAborted()
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const parseJson = (data: Buffer): unknown =>
  JSON.parse(data.toString('utf8').replace(/^\uFEFF/u, ''))

function string(value: unknown, field: string, optional = false): string {
  if (optional && (value === undefined || value === null || value === '')) return ''
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4_096 ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted field values.
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error(`${field} must be a non-empty string without control characters.`)
  return value.trim()
}

function limit(value: unknown, maximum = 200): number {
  if (value === undefined) return Math.min(50, maximum)
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
    throw new Error(`limit must be an integer from 1 to ${maximum}.`)
  return Number(value)
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

function localPath(value: unknown, field = 'path'): string {
  const requested = string(value, field)
  if (
    !path.isAbsolute(requested) ||
    /^(?:\\\\|\/\/)/u.test(requested) ||
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(requested)
  )
    throw new Error(
      `${field} must be an absolute local filesystem path; URLs and network paths are not supported.`
    )
  return path.resolve(requested)
}

async function roots(values: readonly string[]): Promise<string[]> {
  const canonical: string[] = []
  for (const value of [...new Set(values.filter(Boolean))]) {
    if (!path.isAbsolute(value)) continue
    try {
      const resolved = await fs.realpath(value)
      if ((await fs.stat(resolved)).isDirectory()) canonical.push(resolved)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return [...new Set(canonical)]
}

async function authorizedPath(
  value: unknown,
  allowed: readonly string[],
  directory = false
): Promise<string> {
  const requested = localPath(value)
  const canonical = await fs.realpath(requested)
  const allowedRoots = await roots(allowed)
  if (!allowedRoots.some((root) => inside(root, canonical)))
    throw new Error('Path is outside the configured project, output, media or model directories.')
  const stats = await fs.stat(canonical)
  if (directory ? !stats.isDirectory() : !stats.isFile())
    throw new Error(directory ? 'Expected a directory.' : 'Expected a regular file.')
  return canonical
}

async function readSource(
  value: unknown,
  allowed: readonly string[],
  maxBytes: number,
  context?: MagicAgentCreativeToolContext,
  headerOnly = false
) {
  checkAbort(context)
  const canonical = await authorizedPath(value, allowed)
  const initial = await fs.stat(canonical)
  const handle = await fs.open(canonical, 'r')
  try {
    const stats = await handle.stat()
    if (
      !stats.isFile() ||
      stats.dev !== initial.dev ||
      stats.ino !== initial.ino ||
      (await fs.realpath(canonical)) !== canonical
    )
      throw new Error('File changed while preparing the read; retry with a stable file.')
    if (!headerOnly && stats.size > maxBytes)
      throw new Error(`File exceeds the ${maxBytes}-byte tool limit.`)
    const data = Buffer.alloc(Math.min(stats.size, maxBytes))
    let total = 0
    while (total < data.length) {
      checkAbort(context)
      const { bytesRead } = await handle.read(
        data,
        total,
        Math.min(64 * 1024, data.length - total),
        total
      )
      if (!bytesRead) break
      total += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || total !== data.length)
      throw new Error('File changed while being read; retry with a stable file.')
    checkAbort(context)
    return {
      path: canonical,
      filename: path.basename(canonical),
      sizeBytes: stats.size,
      lastModifiedMs: stats.mtimeMs,
      data
    }
  } finally {
    await handle.close()
  }
}

type ListedFile = { path: string; filename: string; sizeBytes: number; lastModifiedMs: number }

async function scan(
  values: readonly string[],
  accept: (filename: string) => boolean,
  count: number,
  context?: MagicAgentCreativeToolContext
) {
  const allowed = await roots(values)
  const pending = allowed.map((directory) => ({ directory, depth: 0 }))
  const files: ListedFile[] = []
  const visited = new Set<string>()
  const deadline = Date.now() + SCAN_TIMEOUT_MS
  let entries = 0
  let truncated = false
  while (pending.length) {
    checkAbort(context)
    if (
      entries >= MAX_SCAN_ENTRIES ||
      visited.size >= MAX_SCAN_DIRECTORIES ||
      Date.now() >= deadline
    ) {
      truncated = true
      break
    }
    const item = pending.shift()!
    const canonical = await fs.realpath(item.directory)
    if (visited.has(canonical) || !allowed.some((root) => inside(root, canonical))) continue
    visited.add(canonical)
    const directory = await fs.opendir(canonical)
    for await (const entry of directory) {
      checkAbort(context)
      if (++entries > MAX_SCAN_ENTRIES || Date.now() >= deadline) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(canonical, entry.name)
      if (entry.isDirectory()) {
        if (item.depth < MAX_SCAN_DEPTH)
          pending.push({ directory: fullPath, depth: item.depth + 1 })
        else truncated = true
      } else if (entry.isFile() && accept(entry.name)) {
        const verified = await authorizedPath(fullPath, allowed)
        const stats = await fs.stat(verified)
        files.push({
          path: verified,
          filename: entry.name,
          sizeBytes: stats.size,
          lastModifiedMs: stats.mtimeMs
        })
        if (files.length >= count) {
          truncated = true
          break
        }
      }
    }
    if (files.length >= count) break
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { files, truncated, scannedEntries: entries, roots: allowed }
}

function mediaMetadata(data: Buffer): {
  kind: 'image' | 'video' | 'audio'
  mimeType: string
  width?: number
  height?: number
} {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return {
      kind: 'image',
      mimeType: 'image/png',
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20)
    }
  if (data.length >= 10 && /^GIF8[79]a$/u.test(data.subarray(0, 6).toString('ascii')))
    return {
      kind: 'image',
      mimeType: 'image/gif',
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8)
    }
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF') {
    const type = data.subarray(8, 12).toString('ascii')
    if (type === 'WEBP') return { kind: 'image', mimeType: 'image/webp' }
    if (type === 'AVI ') return { kind: 'video', mimeType: 'video/x-msvideo' }
    if (type === 'WAVE') return { kind: 'audio', mimeType: 'audio/wav' }
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return { kind: 'image', mimeType: 'image/jpeg' }
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp')
    return {
      kind: 'video',
      mimeType: data.subarray(8, 12).toString('ascii') === 'qt  ' ? 'video/quicktime' : 'video/mp4'
    }
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return {
      kind: 'video',
      mimeType: data.includes(Buffer.from('webm')) ? 'video/webm' : 'video/x-matroska'
    }
  if (data.length >= 4 && data.subarray(0, 4).toString('ascii') === 'OggS')
    return { kind: 'audio', mimeType: 'audio/ogg' }
  if (
    data.length >= 3 &&
    (data.subarray(0, 3).toString('ascii') === 'ID3' ||
      (data[0] === 0xff && (data[1] & 0xe0) === 0xe0))
  )
    return { kind: 'audio', mimeType: 'audio/mpeg' }
  throw new Error('The file has no supported image, video or audio signature.')
}

function executableWorkflow(value: unknown): Workflow {
  if (!isRecord(value) || !Object.keys(value).length || Object.keys(value).length > 2_000)
    throw new Error('Provide a non-empty ComfyUI API prompt object (at most 2000 nodes).')
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JSON_BYTES)
    throw new Error('Workflow exceeds the tool payload limit.')
  for (const [id, node] of Object.entries(value)) {
    if (
      !id ||
      !isRecord(node) ||
      typeof node.class_type !== 'string' ||
      !node.class_type.trim() ||
      !isRecord(node.inputs)
    )
      throw new Error(
        'Expected ComfyUI API format: every node needs class_type and inputs. A frontend nodes/links graph is not an API prompt.'
      )
  }
  return structuredClone(value) as Workflow
}

function safeRelativeId(value: unknown, field: string): string {
  const id = string(value, field)
  if (
    path.isAbsolute(id) ||
    /[:\\]/u.test(id) ||
    id.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`${field} must be a relative identifier without traversal.`)
  return id
}

/** All mutating handlers require the registry's trusted one-shot approval before dispatch. */
export function createProductionCreativeToolDependencies(
  overrides: Partial<ProductionCreativeToolPorts> = {}
): Partial<MagicAgentCreativeToolDependencies> {
  const ports = { ...defaults, ...overrides }
  const settings = async (context?: MagicAgentCreativeToolContext) => {
    checkAbort(context)
    const config = context?.config ?? (await ports.getConfig())
    return { config, directories: await ports.getDirectories(config) }
  }
  const readableRoots = (directories: ProductionCreativeDirectories) => [
    ...directories.projects,
    directories.output,
    directories.media,
    ...Object.values(directories.models)
  ]
  const project = async (
    value: unknown,
    context?: MagicAgentCreativeToolContext
  ): Promise<ProjectTraceProjectRef> => {
    if (!isRecord(value)) throw new Error('project is required.')
    const projectId = safeRelativeId(value.projectId, 'project.projectId')
    if (projectId.includes('/')) throw new Error('projectId must be a single identifier.')
    const result: ProjectTraceProjectRef = { projectId }
    if (value.projectName !== undefined)
      result.projectName = string(value.projectName, 'project.projectName')
    if (value.projectStorageDirName !== undefined) {
      const directory = safeRelativeId(value.projectStorageDirName, 'project.projectStorageDirName')
      if (directory.includes('/'))
        throw new Error('projectStorageDirName must be a single directory name.')
      result.projectStorageDirName = directory
    }
    if (value.projectRootDir !== undefined) {
      const { directories } = await settings(context)
      result.projectRootDir = await authorizedPath(value.projectRootDir, directories.projects, true)
    }
    return result
  }
  const submit = async (
    args: Record<string, unknown>,
    context?: MagicAgentCreativeToolContext,
    requestedOutputKind?: 'image' | 'video'
  ) => {
    checkAbort(context)
    let workflow: unknown = args.workflow ?? args.prompt
    const qAppKey = args.qAppKey === undefined ? '' : safeRelativeId(args.qAppKey, 'qAppKey')
    if (workflow === undefined && qAppKey)
      workflow = (await (await ports.qapp()).getQAppCfg({ key: qAppKey })).workflow
    if (workflow === undefined && args.workflowId !== undefined) {
      const { directories } = await settings(context)
      if (!directories.workflow) throw new Error('No workflow directory is configured.')
      const id = safeRelativeId(args.workflowId, 'workflowId')
      const filename = path.extname(id) ? id : `${id}.json`
      const source = await readSource(
        path.join(directories.workflow, filename),
        [directories.workflow],
        MAX_JSON_BYTES,
        context
      )
      workflow = parseJson(source.data)
    }
    const prompt = executableWorkflow(workflow)
    checkAbort(context)
    const request: SubmitWorkflowReq = {
      prompt,
      ...(qAppKey ? { qAppKey } : {}),
      ...(context?.sessionKey ? { sessionKey: context.sessionKey } : {})
    }
    const service = await ports.comfy()
    checkAbort(context)
    const response = await service.submitWorkflow(request)
    if (!response.prompt_id) throw new Error('ComfyUI submission returned no task identifier.')
    // A submission receipt is not a completed image/video. Never resubmit automatically.
    return {
      status: 'submitted',
      taskId: response.prompt_id,
      promptId: response.prompt_id,
      ...(requestedOutputKind ? { requestedOutputKind } : {})
    }
  }
  const inspectMedia = async (
    args: Record<string, unknown>,
    context: MagicAgentCreativeToolContext | undefined,
    kind: 'image' | 'video'
  ) => {
    if (args.url !== undefined)
      throw new Error(
        'Remote URLs are not supported; provide a local path inside a configured directory.'
      )
    const { directories } = await settings(context)
    const { data, ...file } = await readSource(
      args.path,
      readableRoots(directories),
      MAX_HEADER_BYTES,
      context,
      true
    )
    const metadata = mediaMetadata(data)
    if (metadata.kind !== kind) throw new Error(`The file is not a supported ${kind}.`)
    return {
      ...file,
      ...metadata,
      ...(kind === 'video'
        ? {
            durationAvailable: false,
            note: 'Container and filesystem metadata only; duration and codec details were not probed.'
          }
        : {})
    }
  }
  return {
    comfyStatus: async (_args, context) => {
      checkAbort(context)
      const config = context?.config ?? (await ports.getConfig())
      const timeout = AbortSignal.timeout(5_000)
      const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout
      try {
        const info = await ports.probeComfy(config, signal)
        checkAbort(context)
        return { connected: true, ...info }
      } catch (error) {
        checkAbort(context)
        return { connected: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    comfyQueue: async (_args, context) => {
      checkAbort(context)
      const result = await (await ports.comfy()).getQueue({})
      checkAbort(context)
      return { scope: 'magicpot', ...result }
    },
    comfySubmitWorkflow: submit,
    imageCreate: (args, context) => submit(args, context, 'image'),
    videoCreate: (args, context) => submit(args, context, 'video'),
    qappList: async (args, context) => {
      checkAbort(context)
      const result = await (await ports.qapp()).listQAppCfgs({})
      const maximum = limit(args.limit)
      const flatten = (
        items: typeof result.qApps,
        target: { key: string; name: string; isBuiltin: boolean }[] = []
      ) => {
        for (const item of items) {
          if (target.length > maximum) break
          if (item.children) flatten(item.children, target)
          if (!item.isDirectory && !item.isHidden)
            target.push({ key: item.key, name: item.name, isBuiltin: item.isBuiltin })
        }
        return target
      }
      const items = flatten(result.qApps)
      checkAbort(context)
      return { qApps: items.slice(0, maximum), truncated: items.length > maximum }
    },
    qappGet: async (args, context) => {
      checkAbort(context)
      const result = await (await ports.qapp()).getQAppCfg({ key: safeRelativeId(args.key, 'key') })
      checkAbort(context)
      return result
    },
    canvasStatus: async (args, context) => {
      const { directories } = await settings(context)
      if (args.path === undefined) {
        const listed = await scan(
          directories.projects,
          (name) => name.endsWith('.mpcanvas'),
          limit(args.limit),
          context
        )
        return {
          ...listed,
          scope: 'saved-projects',
          note: 'Saved canvas files only; unsaved renderer state is not included.'
        }
      }
      const { data, ...file } = await readSource(
        args.path,
        directories.projects,
        MAX_JSON_BYTES,
        context
      )
      const document = parseJson(data)
      if (!isRecord(document)) throw new Error('Canvas file must contain a JSON object.')
      return {
        ...file,
        scope: 'saved-project',
        topLevelKeys: Object.keys(document),
        ...(Array.isArray(document.nodes) ? { nodeCount: document.nodes.length } : {})
      }
    },
    canvasExport: async (args, context) => {
      if (args.format !== undefined && args.format !== 'json')
        throw new Error(
          'Agent Studio exports saved canvas JSON. Use the canvas UI for PNG/WebP rendering.'
        )
      const { directories } = await settings(context)
      const source = await readSource(args.path, directories.projects, MAX_JSON_BYTES, context)
      const document = parseJson(source.data)
      if (!isRecord(document)) throw new Error('Canvas file must contain a JSON object.')
      const target = localPath(args.outputPath, 'outputPath')
      if (path.extname(target).toLowerCase() !== '.json')
        throw new Error('outputPath must end in .json.')
      const parent = await authorizedPath(
        path.dirname(target),
        [...directories.projects, directories.output],
        true
      )
      const destination = path.join(parent, path.basename(target))
      checkAbort(context)
      const handle = await fs.open(destination, 'wx')
      try {
        await handle.writeFile(JSON.stringify(document, null, 2), 'utf8')
      } finally {
        await handle.close()
      }
      return { format: 'json', sourcePath: source.path, path: destination, scope: 'saved-project' }
    },
    imageInspect: (args, context) => inspectMedia(args, context, 'image'),
    videoInspect: (args, context) => inspectMedia(args, context, 'video'),
    modelList: async (args, context) => {
      const { directories } = await settings(context)
      const type = string(args.type, 'type', true)
      if (type && !Object.prototype.hasOwnProperty.call(directories.models, type))
        throw new Error(`Unknown model type. Choose ${Object.keys(directories.models).join(', ')}.`)
      return scan(
        type ? [directories.models[type]] : Object.values(directories.models),
        (name) => MODEL_EXTENSIONS.has(path.extname(name).toLowerCase()),
        limit(args.limit),
        context
      )
    },
    modelInspect: async (args, context) => {
      const { directories } = await settings(context)
      let target = args.path
      if (target === undefined) {
        const name = string(args.name, 'name')
        const found = await scan(
          Object.values(directories.models),
          (filename) => filename === name,
          2,
          context
        )
        if (found.files.length !== 1)
          throw new Error(
            found.files.length
              ? 'Model name is ambiguous; supply its exact path.'
              : 'Model not found in the bounded configured-directory scan; supply its exact path.'
          )
        target = found.files[0].path
      }
      const canonical = await authorizedPath(target, Object.values(directories.models))
      if (!MODEL_EXTENSIONS.has(path.extname(canonical).toLowerCase()))
        throw new Error('Unsupported model file extension.')
      const stats = await fs.stat(canonical)
      checkAbort(context)
      return {
        path: canonical,
        filename: path.basename(canonical),
        format: path.extname(canonical).slice(1),
        sizeBytes: stats.size,
        lastModifiedMs: stats.mtimeMs
      }
    },
    modelStatus: async (_args, context) => {
      const { directories } = await settings(context)
      const items = await Promise.all(
        Object.entries(directories.models).map(async ([type, directory]) => ({
          type,
          path: directory,
          configured: Boolean(directory),
          available: (await roots([directory])).length > 0
        }))
      )
      return {
        directories: items,
        availableDirectoryCount: items.filter((item) => item.available).length,
        scope: 'local-model-files'
      }
    },
    assetList: async (args, context) => {
      const { directories } = await settings(context)
      const kind = string(args.kind, 'kind', true)
      if (kind && !['image', 'video', 'audio'].includes(kind))
        throw new Error('kind must be image, video or audio.')
      const selected =
        kind === 'image'
          ? IMAGE_EXTENSIONS
          : kind === 'video'
            ? VIDEO_EXTENSIONS
            : kind === 'audio'
              ? AUDIO_EXTENSIONS
              : new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])
      return scan(
        [...directories.projects, directories.output, directories.media],
        (name) => selected.has(path.extname(name).toLowerCase()),
        limit(args.limit),
        context
      )
    },
    assetImport: async (args, context) => {
      if (args.url !== undefined)
        throw new Error('Remote URL imports are not supported. Provide a local file path.')
      const { directories } = await settings(context)
      const source = await readSource(
        args.path,
        readableRoots(directories),
        MAX_HEADER_BYTES,
        context,
        true
      )
      const metadata = mediaMetadata(source.data)
      if (args.kind !== undefined && args.kind !== metadata.kind)
        throw new Error('Requested asset kind does not match the file signature.')
      checkAbort(context)
      const service = await ports.media()
      checkAbort(context)
      return service.importFile({
        sourcePath: pathToFileURL(source.path).href,
        mimeType: metadata.mimeType,
        originalFileName: source.filename
      })
    },
    projectTraceList: async (args, context) => {
      const reference = await project(args.project, context)
      checkAbort(context)
      const result = await (await ports.traces()).listProjectTraces({ project: reference })
      const maximum = limit(args.limit, 100)
      return { traces: result.traces.slice(0, maximum), truncated: result.traces.length > maximum }
    },
    projectTraceRead: async (args, context) => {
      const reference = await project(args.project, context)
      const traceId = safeRelativeId(args.traceId, 'traceId')
      if (traceId.includes('/')) throw new Error('traceId must be a single identifier.')
      checkAbort(context)
      return (await ports.traces()).readProjectTraceDocument({ project: reference, traceId })
    },
    mcpStatus: async (_args, context) => {
      checkAbort(context)
      const manager = await ports.mcp()
      return {
        connections: manager.listConnections(),
        tools: manager
          .listToolsSnapshot()
          .map((tool) => ({ name: tool.name, description: tool.description }))
      }
    },
    mcpCallTool: async (args, context) => {
      const name = string(args.toolName, 'toolName')
      if (args.args !== undefined && !isRecord(args.args))
        throw new Error('args must be an object.')
      checkAbort(context)
      const manager = await ports.mcp()
      if (
        !manager.listToolsSnapshot().some((tool) => tool.name.toLowerCase() === name.toLowerCase())
      )
        throw new Error(`MCP tool is not connected: ${name}`)
      const result = await manager.callToolByAlias(
        name,
        isRecord(args.args) ? args.args : {},
        context?.signal
      )
      if (!result) throw new Error(`MCP tool is not connected: ${name}`)
      if (result.metadata?.isError) throw new Error(`MCP tool failed: ${result.content}`)
      return result
    }
  }
}
