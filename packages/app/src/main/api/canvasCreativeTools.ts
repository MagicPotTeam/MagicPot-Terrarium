import Ajv from 'ajv'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type { AssistantRoute, AssistantRunToolProvider } from '../assistantRuntime/types'
import { createProductionCreativeToolDependencies } from '../magicAgentRuntime/productionCreativeDependencies'
import { createMagicAgentCreativeToolRegistry } from '../magicAgentRuntime/tools/registry'
import type { MagicAgentCreativeToolDependencies } from '../magicAgentRuntime/tools/types'

// Deliberate desktop-thread surface, not every tool the platform happens to register.
// In particular, terminal, MCP dispatch and cross-session project traces are not admitted here.
export const CANVAS_CREATIVE_TOOL_NAMES = [
  'comfyui.status',
  'comfyui.queue',
  'comfyui.workflow.submit',
  'qapp.list',
  'qapp.get',
  'canvas.status',
  'canvas.export',
  'image.inspect',
  'image.create',
  'video.inspect',
  'video.create',
  'model.list',
  'model.inspect',
  'model.status',
  'asset.list',
  'asset.import'
] as const

/** Main-owned, request-scoped adapter. No serialized flag can construct its admission callback.
 * Calls still pass through AssistantExecutionAdapter's durable intent/result journal.
 */
export function createCanvasCreativeToolProvider(options: {
  route: AgentRouteLike
  assertInvocation: (name: string) => void
  dependencies?: Partial<MagicAgentCreativeToolDependencies>
}): AssistantRunToolProvider {
  const route = Object.freeze(normalizeAgentRoute(options.route)) as AssistantRoute
  const sessionKey = getAgentSessionKey(route)
  const dependencies = Object.freeze({
    ...(options.dependencies ?? createProductionCreativeToolDependencies())
  })
  const registry = createMagicAgentCreativeToolRegistry()
  const allowed = new Set<string>(CANVAS_CREATIVE_TOOL_NAMES)
  const definitions = registry
    .listTools({ dependencies })
    .filter((tool) => allowed.has(tool.name) && tool.status === 'available')
  // Trusted, bundled schemas only. Never coerce or silently remove model arguments.
  const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true })
  const validators = new Map(
    definitions.map((tool) => [tool.name, ajv.compile(tool.inputSchema)])
  )
  return {
    listTools: () =>
      definitions.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema: structuredClone(inputSchema)
      })),
    async callTool(name, args, context) {
      context.signal?.throwIfAborted()
      if (getAgentSessionKey(context.route) !== sessionKey || !validators.has(name)) {
        throw new Error('Creative tool is outside the authorized Agent thread.')
      }
      options.assertInvocation(name)
      const serialized = JSON.stringify(args)
      if (Buffer.byteLength(serialized, 'utf8') > 512 * 1024)
        throw new Error('Creative tool arguments exceed the byte limit.')
      const snapshot = JSON.parse(serialized) as Record<string, unknown>
      if (!validators.get(name)!(snapshot))
        throw new Error(`Invalid arguments for Agent tool "${name}".`)
      const result = await registry.dispatch(name, snapshot, {
        dependencies,
        route,
        sessionKey,
        signal: context.signal,
        authorizeMutation: async (request) => {
          context.signal?.throwIfAborted()
          options.assertInvocation(name)
          const { requestCreativeToolApproval } = await import(
            '../magicAgentRuntime/creativeToolApproval'
          )
          await requestCreativeToolApproval({ ...request, route, signal: context.signal })
          context.signal?.throwIfAborted()
          // Approval can outlive its renderer or request. Recheck before any side effect.
          options.assertInvocation(name)
        }
      })
      if (!result.ok)
        throw new Error(result.error || result.unavailableReason || 'Creative tool failed.')
      return {
        content: JSON.stringify(result.data ?? null),
        metadata: { source: 'canvas-creative-tool', toolName: name }
      }
    }
  }
}
