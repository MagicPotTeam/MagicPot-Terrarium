import { DEFAULT_MAGIC_AGENT_ID, type MagicAgentDefinition } from './types'

const cleanString = (value?: string | null): string => String(value || '').trim()

export const createDefaultMagicAgent = (): MagicAgentDefinition => ({
  id: DEFAULT_MAGIC_AGENT_ID,
  name: 'MagicPot Default Chat',
  description: 'Default MagicPot chat agent with tool-call support.',
  systemPrompt:
    'You are MagicPot default chat. Answer directly when possible. When a registered tool is needed, request it through the tool-call interface and use tool results to produce the final answer.',
  toolNames: null,
  maxToolIterations: 4
})

export class MagicAgentRegistry {
  private readonly agents = new Map<string, MagicAgentDefinition>()

  constructor(options?: { includeDefaultAgent?: boolean }) {
    if (options?.includeDefaultAgent !== false) {
      this.register(createDefaultMagicAgent())
    }
  }

  register(definition: MagicAgentDefinition): MagicAgentDefinition {
    const id = cleanString(definition.id)
    if (!id) {
      throw new Error('Agent id is required.')
    }

    const normalized: MagicAgentDefinition = {
      ...definition,
      id,
      name: cleanString(definition.name) || id,
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.systemPrompt ? { systemPrompt: definition.systemPrompt } : {}),
      ...(definition.toolNames !== undefined ? { toolNames: definition.toolNames } : {}),
      ...(Number.isFinite(definition.maxToolIterations)
        ? { maxToolIterations: Math.max(0, Math.trunc(Number(definition.maxToolIterations))) }
        : {}),
      ...(definition.profileId ? { profileId: definition.profileId } : {})
    }
    this.agents.set(id, normalized)
    return normalized
  }

  get(agentId: string): MagicAgentDefinition | undefined {
    return this.agents.get(cleanString(agentId))
  }

  list(): MagicAgentDefinition[] {
    return [...this.agents.values()]
  }

  unregister(agentId: string): boolean {
    return this.agents.delete(cleanString(agentId))
  }

  clear(): void {
    this.agents.clear()
  }
}
