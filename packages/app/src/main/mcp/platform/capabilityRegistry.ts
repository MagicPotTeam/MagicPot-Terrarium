import {
  type McpAuditEntry,
  type McpCapabilityBundle,
  type McpCapabilityKind,
  type McpCapabilitySource,
  type McpHealthSnapshot,
  type McpNegotiationSnapshot,
  type McpPermissionContext,
  type McpPermissionDecision,
  type McpSessionRecord
} from '@shared/agent/mcpPlatform'

const MCP_PROTOCOL_VERSION = '2025-03-26'

const cloneBundle = (bundle: McpCapabilityBundle): McpCapabilityBundle => ({
  tools: bundle.tools.map((tool) => ({ ...tool })),
  resources: bundle.resources.map((resource) => ({ ...resource })),
  prompts: bundle.prompts.map((prompt) => ({ ...prompt }))
})

const cloneSource = (source: McpCapabilitySource): McpCapabilitySource => ({
  ...source,
  bundle: cloneBundle(source.bundle),
  metadata: source.metadata ? { ...source.metadata } : undefined
})

const cloneSession = (session: McpSessionRecord): McpSessionRecord => ({
  ...session,
  route: session.route ? { ...session.route } : undefined,
  metadata: session.metadata ? { ...session.metadata } : undefined
})

const cloneAuditEntry = (entry: McpAuditEntry): McpAuditEntry => ({
  ...entry,
  metadata: entry.metadata ? { ...entry.metadata } : undefined
})

const capabilityKey = (kind: McpCapabilityKind, name: string): string => `${kind}:${name}`

export class McpCapabilityRegistry {
  private readonly sources = new Map<string, McpCapabilitySource>()
  private readonly sessions = new Map<string, McpSessionRecord>()
  private readonly auditLog: McpAuditEntry[] = []

  constructor(
    private readonly options: {
      name: string
      version: string
    }
  ) {}

  registerSource(source: McpCapabilitySource): void {
    this.sources.set(source.id, cloneSource(source))
  }

  removeSource(sourceId: string): void {
    this.sources.delete(sourceId)
  }

  listSources(): McpCapabilitySource[] {
    return [...this.sources.values()].map(cloneSource)
  }

  registerSession(session: McpSessionRecord): void {
    this.sessions.set(session.sessionId, cloneSession(session))
  }

  updateSession(sessionId: string, patch: Partial<McpSessionRecord>): void {
    const existing = this.sessions.get(sessionId)
    if (!existing) return

    this.sessions.set(sessionId, {
      ...existing,
      ...patch,
      route: patch.route ? { ...patch.route } : existing.route,
      metadata: patch.metadata ? { ...patch.metadata } : existing.metadata,
      updatedAt: patch.updatedAt || new Date().toISOString()
    })
  }

  closeSession(sessionId: string): void {
    const existing = this.sessions.get(sessionId)
    if (!existing) return
    this.sessions.set(sessionId, {
      ...existing,
      state: 'closed',
      updatedAt: new Date().toISOString()
    })
  }

  listSessions(): McpSessionRecord[] {
    return [...this.sessions.values()].map(cloneSession)
  }

  listCapabilities(): McpCapabilityBundle {
    const seenTools = new Set<string>()
    const seenResources = new Set<string>()
    const seenPrompts = new Set<string>()
    const bundle: McpCapabilityBundle = {
      tools: [],
      resources: [],
      prompts: []
    }

    for (const source of this.sources.values()) {
      for (const tool of source.bundle.tools) {
        const key = capabilityKey('tool', tool.name)
        if (seenTools.has(key)) continue
        seenTools.add(key)
        bundle.tools.push({ ...tool })
      }

      for (const resource of source.bundle.resources) {
        const key = capabilityKey('resource', resource.uri)
        if (seenResources.has(key)) continue
        seenResources.add(key)
        bundle.resources.push({ ...resource })
      }

      for (const prompt of source.bundle.prompts) {
        const key = capabilityKey('prompt', prompt.name)
        if (seenPrompts.has(key)) continue
        seenPrompts.add(key)
        bundle.prompts.push({ ...prompt })
      }
    }

    return bundle
  }

  negotiate(client?: McpNegotiationSnapshot['client']): McpNegotiationSnapshot {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      client,
      server: {
        name: this.options.name,
        version: this.options.version,
        capabilities: {
          tools: this.listCapabilities().tools.length > 0,
          resources: this.listCapabilities().resources.length > 0,
          prompts: this.listCapabilities().prompts.length > 0,
          logging: true,
          health: true
        }
      }
    }
  }

  appendAudit(entry: McpAuditEntry): void {
    this.auditLog.push(cloneAuditEntry(entry))
  }

  listAuditEntries(): McpAuditEntry[] {
    return this.auditLog.map(cloneAuditEntry)
  }

  getLastAuditAt(): string | undefined {
    return this.auditLog.at(-1)?.at
  }

  snapshotHealth(
    state: McpHealthSnapshot['state'],
    transports: McpHealthSnapshot['transports']
  ): McpHealthSnapshot {
    const capabilities = this.listCapabilities()
    return {
      state,
      version: this.options.version,
      transports,
      counts: {
        sources: this.sources.size,
        sessions: this.sessions.size,
        tools: capabilities.tools.length,
        resources: capabilities.resources.length,
        prompts: capabilities.prompts.length
      },
      ...(this.getLastAuditAt() ? { lastAuditAt: this.getLastAuditAt() } : {})
    }
  }

  snapshot() {
    return {
      sources: this.listSources(),
      sessions: this.listSessions(),
      capabilities: this.listCapabilities(),
      audits: this.listAuditEntries()
    }
  }

  checkPermission(
    context: McpPermissionContext,
    policy?: (context: McpPermissionContext) => McpPermissionDecision
  ): McpPermissionDecision {
    if (policy) {
      return policy(context)
    }

    if (context.action.startsWith('read:')) {
      return { allowed: true, policyId: 'default-read-only' }
    }

    if (context.target.startsWith('magicpot://mcp/platform/')) {
      return { allowed: true, policyId: 'platform-inspection' }
    }

    return {
      allowed: false,
      reason: 'No permission policy was configured for this action.',
      policyId: 'default-deny'
    }
  }
}
