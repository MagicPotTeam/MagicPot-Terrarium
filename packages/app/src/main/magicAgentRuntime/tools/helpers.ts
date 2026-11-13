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

const createDefinition = (
  tool: ToolSpec,
  context?: MagicAgentCreativeToolContext
): MagicAgentCreativeToolDefinition => {
  const available =
    Boolean(tool.dependency) && typeof context?.dependencies?.[tool.dependency!] === 'function'
  return {
    name: tool.name,
    category: tool.category,
    description: tool.description,
    inputSchema: tool.inputSchema || objectSchema(),
    status: available ? 'available' : 'unavailable',
    ...toolPermissionDefaults(tool),
    ...(available ? {} : { unavailableReason: missingDependencyReason(tool.dependency) })
  }
}

export const requiresCreativeMutationAuthorization = (
  tool: Pick<
    MagicAgentCreativeToolDefinition,
    'permissionLevel' | 'requiresConfirmation' | 'disabledByDefault'
  >
): boolean => tool.permissionLevel !== 'read' || tool.requiresConfirmation || tool.disabledByDefault

type CreativeMutationPermit = {
  toolName: string
  args: Record<string, unknown>
  fingerprint: string
}

// Object identity keeps approval authority out of serializable renderer/model payloads.
const creativeMutationPermits = new WeakMap<MagicAgentCreativeToolContext, CreativeMutationPermit>()

const freezeJsonValue = (value: unknown): void => {
  if (!value || typeof value !== 'object') return
  for (const child of Object.values(value)) freezeJsonValue(child)
  Object.freeze(value)
}

const snapshotArguments = (args: Record<string, unknown>): Record<string, unknown> => {
  const snapshot: unknown = JSON.parse(JSON.stringify(args))
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Creative tool arguments must be a JSON object.')
  }
  freezeJsonValue(snapshot)
  return snapshot as Record<string, unknown>
}

type PreparedCreativeToolDispatch =
  | {
      prepared: true
      args: Record<string, unknown>
      context: MagicAgentCreativeToolContext
    }
  | { prepared: false; result: MagicAgentCreativeToolResult }

/** Approval and execution share an immutable argument snapshot and a one-use context. */
export const prepareCreativeToolDispatch = async (
  tool: MagicAgentCreativeToolDefinition,
  args: Record<string, unknown>,
  context?: MagicAgentCreativeToolContext
): Promise<PreparedCreativeToolDispatch> => {
  let snapshot: Record<string, unknown>
  try {
    snapshot = snapshotArguments(args)
    context?.signal?.throwIfAborted()
  } catch (error) {
    return { prepared: false, result: dependencyErrorResult(tool, error) }
  }
  const dispatchContext: MagicAgentCreativeToolContext = Object.freeze({
    ...context,
    ...(context?.route ? { route: Object.freeze({ ...context.route }) } : {}),
    ...(context?.dependencies ? { dependencies: Object.freeze({ ...context.dependencies }) } : {})
  })
  if (requiresCreativeMutationAuthorization(tool)) {
    if (typeof dispatchContext.authorizeMutation !== 'function') {
      return { prepared: false, result: permissionDeniedResult(tool) }
    }
    try {
      await dispatchContext.authorizeMutation(
        Object.freeze({ toolName: tool.name, args: snapshot })
      )
      dispatchContext.signal?.throwIfAborted()
    } catch (error) {
      return {
        prepared: false,
        result: {
          ...permissionDeniedResult(tool),
          error: `Creative tool approval was not granted: ${
            error instanceof Error ? error.message : String(error)
          }`
        }
      }
    }
    creativeMutationPermits.set(dispatchContext, {
      toolName: tool.name,
      args: snapshot,
      fingerprint: JSON.stringify(snapshot)
    })
  }
  return { prepared: true, args: snapshot, context: dispatchContext }
}

export const revokeCreativeToolDispatch = (context: MagicAgentCreativeToolContext): void => {
  creativeMutationPermits.delete(context)
}

const consumeCreativeMutationPermit = (
  toolName: string,
  args: Record<string, unknown>,
  context?: MagicAgentCreativeToolContext
): boolean => {
  if (!context) return false
  const permit = creativeMutationPermits.get(context)
  creativeMutationPermits.delete(context)
  return Boolean(
    permit &&
    permit.toolName === toolName &&
    permit.args === args &&
    permit.fingerprint === JSON.stringify(args)
  )
}

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
  definitions(context): MagicAgentCreativeToolDefinition[] {
    return toolSpecs.map((tool) => createDefinition(tool, context))
  },

  async callTool(name, args, context) {
    const tool = toolSpecs.find((item) => item.name === name)
    if (!tool) {
      return null
    }

    const definition = createDefinition(tool, context)

    if (!tool.dependency) {
      return unavailableResult(definition)
    }

    if (
      requiresCreativeMutationAuthorization(definition) &&
      !consumeCreativeMutationPermit(definition.name, args, context)
    ) {
      return permissionDeniedResult(definition)
    }

    const dependency = context?.dependencies?.[tool.dependency] as
      MagicAgentCreativeToolDependency | undefined
    if (typeof dependency !== 'function') {
      return unavailableResult(definition)
    }

    try {
      context?.signal?.throwIfAborted()
      return okResult(definition, await dependency(args, context))
    } catch (error) {
      return dependencyErrorResult(definition, error)
    }
  }
})
