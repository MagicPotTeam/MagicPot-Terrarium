/** Bundled creative-adapter declarations only; no live readiness, registration or execution grant. */
export type BundledCreativeCategory = 'comfyui' | 'qapp' | 'canvas' | 'image' | 'video' | 'model' | 'asset' | 'projectTrace' | 'mcp' | 'terminal'
export type BundledCreativeDeclaration = Readonly<{ name: string; category: BundledCreativeCategory; description: string }>

// One metadata owner: the real MAIN adapters and the optional manual renderer preview consume these same records.
const declarations = {
  'comfyui.status': { name: 'comfyui.status', category: 'comfyui', description: 'Return ComfyUI runtime availability and connection status for MagicAgent.' },
  'comfyui.queue': { name: 'comfyui.queue', category: 'comfyui', description: 'Return the current ComfyUI queue snapshot when a ComfyUI adapter is registered.' },
  'comfyui.workflow.submit': { name: 'comfyui.workflow.submit', category: 'comfyui', description: 'Submit an explicit ComfyUI API workflow, saved quick-app workflow, or configured workflow JSON file. Returns a submitted task ID, not completed output. Requires trusted user approval.' },
  'qapp.list': { name: 'qapp.list', category: 'qapp', description: 'List available QApps through a registered QApp adapter.' },
  'qapp.get': { name: 'qapp.get', category: 'qapp', description: 'Read one QApp configuration by key through a registered QApp adapter.' },
  'canvas.status': { name: 'canvas.status', category: 'canvas', description: 'Inspect a saved project canvas by absolute path, or list saved canvases in configured project directories. Unsaved renderer state is not included.' },
  'canvas.export': { name: 'canvas.export', category: 'canvas', description: 'Export a saved canvas JSON snapshot into a new .json file in a configured project/output directory. Refuses overwrite. PNG/WebP rendering remains in the canvas UI. Requires trusted user approval.' },
  'image.inspect': { name: 'image.inspect', category: 'image', description: 'Inspect a configured local image file: verified file signature, size, modified time, and dimensions when available. Does not fetch remote URLs.' },
  'image.create': { name: 'image.create', category: 'image', description: 'Submit an image-generation ComfyUI API workflow or saved quick-app/workflow file. A workflow is required; plain text alone is not converted into one. Returns a submitted task ID, not a completed image. Requires trusted user approval.' },
  'video.inspect': { name: 'video.inspect', category: 'video', description: 'Inspect a configured local video file: container signature, size and modified time. Does not probe duration/codecs or fetch remote URLs.' },
  'video.create': { name: 'video.create', category: 'video', description: 'Submit a video-generation ComfyUI API workflow or saved quick-app/workflow file. A workflow is required; plain text alone is not converted into one. Returns a submitted task ID, not a completed video. Requires trusted user approval.' },
  'model.list': { name: 'model.list', category: 'model', description: 'List creative model assets through a registered model browser adapter.' },
  'model.inspect': { name: 'model.inspect', category: 'model', description: 'Inspect one model by path or name through a registered model adapter.' },
  'model.status': { name: 'model.status', category: 'model', description: 'Report which configured local model directories exist. This does not claim that a model is loaded into memory.' },
  'asset.list': { name: 'asset.list', category: 'asset', description: 'List bounded local image, video or audio assets inside configured project, output and managed-media directories.' },
  'asset.import': { name: 'asset.import', category: 'asset', description: 'Import a verified local media file from a configured project/output/media/model directory into managed media storage. Does not fetch remote URLs. Requires trusted user approval.' },
  'project.trace.list': { name: 'project.trace.list', category: 'projectTrace', description: 'List project trace summaries through a registered project trace adapter.' },
  'project.trace.read': { name: 'project.trace.read', category: 'projectTrace', description: 'Read one project trace document through a registered project trace adapter.' },
  'mcp.status': { name: 'mcp.status', category: 'mcp', description: 'Return MCP client/server status through a registered MCP adapter.' },
  'mcp.tool.call': { name: 'mcp.tool.call', category: 'mcp', description: 'Call a discovered MCP tool through a registered MCP adapter.' },
  'terminal.run': { name: 'terminal.run', category: 'terminal', description: 'Thin wrapper for running an explicitly enabled, policy-controlled terminal command adapter.' }
} as const satisfies Record<string, BundledCreativeDeclaration>
for (const row of Object.values(declarations)) Object.freeze(row)
export const bundledCreativeDeclarations = Object.freeze(declarations)
