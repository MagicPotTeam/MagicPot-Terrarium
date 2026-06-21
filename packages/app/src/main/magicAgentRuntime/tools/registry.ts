import { assetToolAdapter } from './asset'
import { canvasToolAdapter } from './canvas'
import { comfyUiToolAdapter } from './comfyui'
import { imageToolAdapter } from './image'
import { mcpToolAdapter } from './mcp'
import { modelToolAdapter } from './model'
import { projectTraceToolAdapter } from './projectTrace'
import { qAppToolAdapter } from './qapp'
import { terminalToolAdapter } from './terminal'
import { videoToolAdapter } from './video'
import { permissionDeniedResult } from './helpers'
import type {
  MagicAgentCreativeToolAdapter,
  MagicAgentCreativeToolContext,
  MagicAgentCreativeToolDefinition,
  MagicAgentCreativeToolResult
} from './types'

export type MagicAgentCreativeToolRegistryOptions = {
  adapters?: MagicAgentCreativeToolAdapter[]
}

const defaultAdapters: MagicAgentCreativeToolAdapter[] = [
  comfyUiToolAdapter,
  qAppToolAdapter,
  canvasToolAdapter,
  imageToolAdapter,
  videoToolAdapter,
  modelToolAdapter,
  assetToolAdapter,
  projectTraceToolAdapter,
  mcpToolAdapter,
  terminalToolAdapter
]

const normalizeToolName = (name: string): string =>
  String(name || '')
    .trim()
    .toLowerCase()

const cloneToolDefinition = (
  definition: MagicAgentCreativeToolDefinition
): MagicAgentCreativeToolDefinition => ({
  ...definition,
  inputSchema: { ...definition.inputSchema }
})

export class MagicAgentCreativeToolRegistry {
  private readonly adapters: MagicAgentCreativeToolAdapter[]

  constructor(options: MagicAgentCreativeToolRegistryOptions = {}) {
    this.adapters = options.adapters || defaultAdapters
  }

  listTools(): MagicAgentCreativeToolDefinition[] {
    return this.adapters.flatMap((adapter) => adapter.definitions()).map(cloneToolDefinition)
  }

  async dispatch(
    name: string,
    args: Record<string, unknown> = {},
    context?: MagicAgentCreativeToolContext
  ): Promise<MagicAgentCreativeToolResult> {
    const requestedName = normalizeToolName(name)
    const definition = this.listTools().find(
      (tool) => normalizeToolName(tool.name) === requestedName
    )

    if (!definition) {
      return {
        ok: false,
        toolName: name,
        category: 'asset',
        status: 'unavailable',
        unavailableReason: `Unknown MagicAgent creative tool: ${name}`
      }
    }

    if (definition.requiresConfirmation || definition.disabledByDefault) {
      return permissionDeniedResult(definition)
    }

    for (const adapter of this.adapters) {
      const result = await adapter.callTool(definition.name, args || {}, context)
      if (result) {
        return result
      }
    }

    return {
      ok: false,
      toolName: definition.name,
      category: definition.category,
      status: 'unavailable',
      unavailableReason: definition.unavailableReason || 'No MagicAgent adapter accepted this tool.'
    }
  }
}

export const createMagicAgentCreativeToolRegistry = (
  options?: MagicAgentCreativeToolRegistryOptions
): MagicAgentCreativeToolRegistry => new MagicAgentCreativeToolRegistry(options)
