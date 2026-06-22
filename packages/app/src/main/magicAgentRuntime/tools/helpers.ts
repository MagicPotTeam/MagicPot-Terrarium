import type {
  MagicAgentCreativeToolAdapter,
  MagicAgentCreativeToolCategory,
  MagicAgentCreativeToolContext,
  MagicAgentCreativeToolDefinition,
  MagicAgentCreativeToolDependency,
  MagicAgentCreativeToolDependencies,
  MagicAgentCreativeToolPermissionLevel,
  MagicAgentCreativeToolResult
} from './types'

type ToolSpec = {
  name: string
  category: MagicAgentCreativeToolCategory
  description: string
  inputSchema?: Record<string, unknown>
  dependency?: keyof MagicAgentCreativeToolDependencies
  permissionLevel?: MagicAgentCreativeToolPermissionLevel
  requiresConfirmation?: boolean
  disabledByDefault?: boolean
}

export const objectSchema = (
  properties: Record<string, unknown> = {},
  required?: string[],
  additionalProperties = true
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required?.length ? { required } : {}),
  ...(additionalProperties === false ? { additionalProperties: false } : {})
})

export const statusSchema = objectSchema()

export const optionalPathOrUrlSchema = objectSchema({
  path: {
    type: 'string'
  },
  url: {
    type: 'string'
  }
})

const missingDependencyReason = (dependency?: keyof MagicAgentCreativeToolDependencies): string =>
  dependency
    ? `Dependency "${dependency}" is not registered in this MagicAgent runtime.`
    : 'This MagicAgent tool is a status placeholder; no runtime adapter is registered.'

const toolPermissionDefaults = (tool: ToolSpec) => ({
  permissionLevel: tool.permissionLevel || ('read' as const),
  requiresConfirmation: tool.requiresConfirmation === true,
  disabledByDefault: tool.disabledByDefault === true
})

const createDefinition = (tool: ToolSpec): MagicAgentCreativeToolDefinition => ({
  name: tool.name,
  category: tool.category,
  description: tool.description,
  inputSchema: tool.inputSchema || objectSchema(),
  status: 'unavailable',
  ...toolPermissionDefaults(tool),
  unavailableReason: missingDependencyReason(tool.dependency)
})

export const unavailableResult = (
  tool: Pick<MagicAgentCreativeToolDefinition, 'name' | 'category' | 'unavailableReason'>,
  data?: Record<string, unknown>
): MagicAgentCreativeToolResult => ({
  ok: false,
  toolName: tool.name,
  category: tool.category,
  status: 'unavailable',
  unavailableReason: tool.unavailableReason || 'Tool dependency is unavailable.',
  ...(data ? { data } : {})
})

export const dependencyErrorResult = (
  tool: Pick<MagicAgentCreativeToolDefinition, 'name' | 'category'>,
  error: unknown
): MagicAgentCreativeToolResult => ({
  ok: false,
  toolName: tool.name,
  category: tool.category,
  status: 'available',
  error: error instanceof Error ? error.message : String(error)
})

export const permissionDeniedResult = (
  tool: Pick<MagicAgentCreativeToolDefinition, 'name' | 'category'>
): MagicAgentCreativeToolResult => ({
  ok: false,
  toolName: tool.name,
  category: tool.category,
  status: 'available',
  permissionDenied: true,
  error: `${tool.name} is disabled by default and requires trusted main-process confirmation before MagicAgent can execute it.`
})

export const okResult = (
  tool: Pick<MagicAgentCreativeToolDefinition, 'name' | 'category'>,
  data: unknown
): MagicAgentCreativeToolResult => ({
  ok: true,
  toolName: tool.name,
  category: tool.category,
  status: 'available',
  data
})

export const createAdapter = (toolSpecs: ToolSpec[]): MagicAgentCreativeToolAdapter => ({
  definitions(): MagicAgentCreativeToolDefinition[] {
    return toolSpecs.map(createDefinition)
  },

  async callTool(name, args, context) {
    const tool = toolSpecs.find((item) => item.name === name)
    if (!tool) {
      return null
    }

    const definition = createDefinition(tool)

    if (!tool.dependency) {
      return unavailableResult(definition)
    }

    if (definition.requiresConfirmation || definition.disabledByDefault) {
      return permissionDeniedResult(definition)
    }

    const dependency = context?.dependencies?.[tool.dependency] as
      | MagicAgentCreativeToolDependency
      | undefined
    if (!dependency) {
      return unavailableResult(definition)
    }

    try {
      return okResult(definition, await dependency(args, context))
    } catch (error) {
      return dependencyErrorResult(definition, error)
    }
  }
})
