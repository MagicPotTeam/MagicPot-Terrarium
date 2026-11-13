import type { ThreadProcessControl } from './agentThreadProcessHost'
import Ajv from 'ajv'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { THREAD_NOTEBOOK_READ_NAMES, THREAD_SCRIPT_TOOL_DEFINITIONS, threadNotebookNamespace } from './agentThreadScriptSchemas'

const validators = new Map(THREAD_SCRIPT_TOOL_DEFINITIONS.map((tool) => [tool.name, new Ajv({ strict: false, ownProperties: true }).compile(tool.inputSchema)]))
export type ThreadScriptInvocation = { name: string; input: Record<string, unknown>; route: AgentRouteLike; conversationId: string; namespace: string; workspaceRoot: string; signal: AbortSignal; assertLive(): void; onOwned?(control: ThreadProcessControl): void; onStarted?(control: ThreadProcessControl): void; background?: boolean }
export function createAgentThreadScriptTools(options: {
  route: AgentRouteLike; conversationId: string; signal: AbortSignal
  enabled(): boolean; assertInvocation(name: string): void; assertLive(): void
  execute?: (input: ThreadScriptInvocation) => Promise<unknown>
}): AssistantRunToolProvider {
  const route = Object.freeze(normalizeAgentRoute(options.route))
  const routeKey = getAgentSessionKey(route)
  const namespace = threadNotebookNamespace(routeKey, options.conversationId)
  const reads = new Set<string>(THREAD_NOTEBOOK_READ_NAMES)
  const exposed = THREAD_SCRIPT_TOOL_DEFINITIONS.filter((tool) => reads.has(tool.name) || options.enabled())
  const names = new Set(exposed.map((tool) => tool.name))
  let calls = 0, writes = 0, executions = 0
  return {
    listTools: () => structuredClone(exposed),
    async callTool(name, args, context) {
      const signal = AbortSignal.any([options.signal, ...(context.signal ? [context.signal] : [])])
      const assertLive = () => { signal.throwIfAborted(); options.assertLive(); options.assertInvocation(name); if (!reads.has(name) && !options.enabled()) throw new Error('Python/Notebook mutations are disabled in settings.') }
      assertLive()
      if (!names.has(name) || getAgentSessionKey(context.route) !== routeKey) throw new Error('Script tool is outside this Agent thread.')
      if (!context.workspaceRootDir) throw new Error('Script tools require the main-owned thread workspace.')
      const input = structuredClone(args)
      if (!validators.get(name)?.(input)) throw new Error('Invalid bounded Python/Notebook arguments.')
      if (++calls > 12 || (!reads.has(name) && ++writes > 4) || (['python.execute', 'notebook.run'].includes(name) && ++executions > 2)) throw new Error('Per-request Python/Notebook tool budget exhausted.')
      const invoke = options.execute ?? (await import('./agentThreadScriptHost')).executeAgentThreadScript
      assertLive()
      const output = await invoke({ name, input, route, conversationId: options.conversationId, namespace, workspaceRoot: context.workspaceRootDir, signal, assertLive })
      assertLive()
      return { content: JSON.stringify(output) }
    }
  }
}
