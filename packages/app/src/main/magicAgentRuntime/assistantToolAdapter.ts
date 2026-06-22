import type { AssistantToolRegistry } from '../assistantRuntime/toolRegistry'
import type { MagicAgentToolRegistration } from './types'

export type AssistantToolAdapterContextFactory = (
  context: MagicAgentToolRegistration extends { handler: infer Handler }
    ? Handler extends (args: Record<string, unknown>, context: infer ToolContext) => unknown
      ? ToolContext
      : never
    : never
) => Parameters<AssistantToolRegistry['callTool']>[2]

export const createAssistantToolRegistryAdapter = (
  assistantRegistry: Pick<AssistantToolRegistry, 'listTools' | 'callTool'>,
  createContext: AssistantToolAdapterContextFactory
): MagicAgentToolRegistration[] => {
  return assistantRegistry.listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    metadata: {
      source: 'assistantRuntime'
    },
    handler: async (args, context) =>
      assistantRegistry.callTool(tool.name, args, createContext(context))
  }))
}
