import { throwIfAborted } from '@shared/agent'
import type {
  MagicAgentToolContext,
  MagicAgentToolDefinition,
  MagicAgentToolHandler,
  MagicAgentToolRegistration,
  MagicAgentToolResult
} from './types'

const cleanToolName = (value?: string | null): string => String(value || '').trim()

const normalizeSchema = (schema?: Record<string, unknown>): Record<string, unknown> =>
  schema || { type: 'object', properties: {} }

export class MagicAgentToolRegistry {
  private readonly tools = new Map<string, MagicAgentToolRegistration>()

  register(registration: MagicAgentToolRegistration): MagicAgentToolDefinition {
    const name = cleanToolName(registration.name)
    if (!name) {
      throw new Error('Tool name is required.')
    }

    const normalized: MagicAgentToolRegistration = {
      ...registration,
      name,
      description: registration.description || '',
      inputSchema: normalizeSchema(registration.inputSchema)
    }
    this.tools.set(name, normalized)
    return this.toDefinition(normalized)
  }

  registerMany(registrations: MagicAgentToolRegistration[]): MagicAgentToolDefinition[] {
    return registrations.map((registration) => this.register(registration))
  }

  unregister(name: string): boolean {
    return this.tools.delete(cleanToolName(name))
  }

  get(name: string): MagicAgentToolDefinition | undefined {
    const registration = this.tools.get(cleanToolName(name))
    return registration ? this.toDefinition(registration) : undefined
  }

  list(): MagicAgentToolDefinition[] {
    return [...this.tools.values()].map((registration) => this.toDefinition(registration))
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    context: MagicAgentToolContext
  ): Promise<MagicAgentToolResult> {
    throwIfAborted(context.signal)
    const normalizedName = cleanToolName(name)
    const registration = this.tools.get(normalizedName)
    if (!registration) {
      throw new Error(`Unknown tool: ${name}`)
    }

    const result = await registration.handler(args || {}, context)
    throwIfAborted(context.signal)
    return {
      content: String(result?.content || ''),
      ...(result?.metadata ? { metadata: result.metadata } : {})
    }
  }

  clear(): void {
    this.tools.clear()
  }

  private toDefinition(registration: {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    metadata?: Record<string, unknown>
    handler?: MagicAgentToolHandler
  }): MagicAgentToolDefinition {
    return {
      name: registration.name,
      description: registration.description,
      inputSchema: registration.inputSchema,
      ...(registration.metadata ? { metadata: registration.metadata } : {})
    }
  }
}
