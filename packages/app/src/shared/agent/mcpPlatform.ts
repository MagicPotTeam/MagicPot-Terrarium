export type McpTransportKind = 'stdio' | 'streamable-http'

export type McpLifecycleState = 'created' | 'initializing' | 'ready' | 'degraded' | 'stopped'

export type McpCapabilityKind = 'tool' | 'resource' | 'prompt'

export type McpCapabilityScope = 'session' | 'workspace' | 'global'

export type McpAnnotationHints = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

export type McpToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: McpAnnotationHints
  version?: string
}

export type McpResourceDescriptor = {
  uri: string
  name: string
  description?: string
  mimeType?: string
  version?: string
}

export type McpPromptDescriptor = {
  name: string
  description?: string
  argsSchema?: Record<string, unknown>
  version?: string
}

export type McpCapabilityBundle = {
  tools: McpToolDescriptor[]
  resources: McpResourceDescriptor[]
  prompts: McpPromptDescriptor[]
}

export type McpCapabilitySource = {
  id: string
  label: string
  scope: McpCapabilityScope
  version: string
  sessionId?: string
  bundle: McpCapabilityBundle
  metadata?: Record<string, unknown>
}

export type McpSessionState = 'created' | 'active' | 'idle' | 'closed'

export type McpSessionRecord = {
  sessionId: string
  createdAt: string
  updatedAt: string
  state: McpSessionState
  route?: {
    channel: string
    scopeType: string
    scopeId: string
    threadId?: string
  }
  owner?: string
  metadata?: Record<string, unknown>
}

export type McpPermissionContext = {
  actor: string
  action: string
  target: string
  transport: McpTransportKind
  sessionId?: string
  metadata?: Record<string, unknown>
}

export type McpPermissionDecision = {
  allowed: boolean
  reason?: string
  policyId?: string
}

export type McpAuditDecision = 'allow' | 'deny' | 'observe'

export type McpAuditEntry = {
  id: string
  at: string
  actor: string
  action: string
  target: string
  decision: McpAuditDecision
  reason?: string
  metadata?: Record<string, unknown>
}

export type McpTransportStatus = 'idle' | 'starting' | 'ready' | 'stopped' | 'error'

export type McpTransportSnapshot = {
  kind: McpTransportKind
  status: McpTransportStatus
  endpoint?: string
  sessionId?: string
  lastError?: string
}

export type McpHealthSnapshot = {
  state: McpLifecycleState
  version: string
  transports: McpTransportSnapshot[]
  counts: {
    sources: number
    sessions: number
    tools: number
    resources: number
    prompts: number
  }
  lastAuditAt?: string
}

export type McpNegotiationSnapshot = {
  protocolVersion: string
  client?: {
    name?: string
    version?: string
    capabilities?: string[]
  }
  server: {
    name: string
    version: string
    capabilities: {
      tools: boolean
      resources: boolean
      prompts: boolean
      logging: boolean
      health: boolean
    }
  }
}
