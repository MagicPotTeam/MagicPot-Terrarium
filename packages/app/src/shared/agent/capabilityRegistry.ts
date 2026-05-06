export type AgentCapabilityKind = 'tool' | 'resource' | 'prompt' | 'session' | 'orchestrator'

export type AgentCapabilityTransport = 'internal' | 'stdio' | 'http' | 'mcp'

export type AgentCapabilityDescriptor = {
  capabilityId: string
  name: string
  kind: AgentCapabilityKind
  description: string
  version: string
  scope: 'global' | 'session' | 'workspace' | 'route'
  transport: AgentCapabilityTransport[]
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type AgentCapabilityListOptions = {
  kind?: AgentCapabilityKind
  scope?: AgentCapabilityDescriptor['scope']
}

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

const normalizeTransport = (transport?: AgentCapabilityTransport[]): AgentCapabilityTransport[] => {
  if (!Array.isArray(transport) || transport.length === 0) {
    return ['internal']
  }

  return [...new Set(transport.filter((item): item is AgentCapabilityTransport => Boolean(item)))]
}

export const normalizeAgentCapabilityDescriptor = (
  descriptor: AgentCapabilityDescriptor
): AgentCapabilityDescriptor => ({
  capabilityId: cleanString(descriptor.capabilityId) || cleanString(descriptor.name) || 'unknown',
  name: cleanString(descriptor.name) || cleanString(descriptor.capabilityId) || 'unknown',
  kind: descriptor.kind,
  description: cleanString(descriptor.description) || '',
  version: cleanString(descriptor.version) || '0.0.0',
  scope: descriptor.scope,
  transport: normalizeTransport(descriptor.transport),
  ...(descriptor.inputSchema ? { inputSchema: descriptor.inputSchema } : {}),
  ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
  ...(descriptor.metadata ? { metadata: descriptor.metadata } : {})
})

export class AgentCapabilityRegistry {
  private readonly capabilities = new Map<string, AgentCapabilityDescriptor>()

  register(descriptor: AgentCapabilityDescriptor): AgentCapabilityDescriptor {
    const normalized = normalizeAgentCapabilityDescriptor(descriptor)
    this.capabilities.set(normalized.capabilityId, normalized)
    return normalized
  }

  registerMany(descriptors: AgentCapabilityDescriptor[]): AgentCapabilityDescriptor[] {
    return descriptors.map((descriptor) => this.register(descriptor))
  }

  get(capabilityId: string): AgentCapabilityDescriptor | undefined {
    return this.capabilities.get(String(capabilityId || '').trim())
  }

  has(capabilityId: string): boolean {
    return this.capabilities.has(String(capabilityId || '').trim())
  }

  remove(capabilityId: string): boolean {
    return this.capabilities.delete(String(capabilityId || '').trim())
  }

  list(options?: AgentCapabilityListOptions): AgentCapabilityDescriptor[] {
    return [...this.capabilities.values()].filter((descriptor) => {
      if (options?.kind && descriptor.kind !== options.kind) {
        return false
      }
      if (options?.scope && descriptor.scope !== options.scope) {
        return false
      }
      return true
    })
  }

  snapshot(): AgentCapabilityDescriptor[] {
    return this.list()
  }

  clear(): void {
    this.capabilities.clear()
  }
}
