import { AssistantRoute } from '../assistantRuntime/types'
import {
  AgentCapabilityDescriptor,
  AgentCapabilityRegistry,
  AgentMasterRunSpec,
  AgentOrchestrationEvent,
  AgentOrchestrationRun,
  AgentRunStatus,
  AgentSubagentRunSpec,
  AgentSessionIdentity,
  AgentToolDefinition,
  AgentToolInvoker,
  AgentToolInvocationRequest,
  AgentToolInvocationResult,
  AgentToolRegistration,
  buildAgentSessionIdentity,
  createAgentToolInvocationResult,
  normalizeAgentRoute,
  throwIfAborted
} from '@shared/agent'

type SessionRegistration = {
  identity: AgentSessionIdentity
  source: 'assistant' | 'mcp' | 'bot' | 'kernel'
}

export type AgentKernelRetentionPolicy = {
  maxEvents?: number
  maxTerminalRuns?: number
  maxInactiveSessions?: number
}

type ResolvedAgentKernelRetentionPolicy = Required<AgentKernelRetentionPolicy>

export const DEFAULT_AGENT_KERNEL_RETENTION_POLICY: Readonly<ResolvedAgentKernelRetentionPolicy> = {
  maxEvents: 10_000,
  maxTerminalRuns: 1_000,
  maxInactiveSessions: 1_000
}

const now = (): number => Date.now()

const normalizeRunStatus = (status?: AgentRunStatus): AgentRunStatus => status || 'pending'

const isTerminalRunStatus = (status: AgentRunStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled'

const normalizeRetentionLimit = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback

const mergeSessionIdentity = (
  current: AgentSessionIdentity,
  next: AgentSessionIdentity
): AgentSessionIdentity => ({
  ...current,
  ...next,
  ...(next.threadId
    ? { threadId: next.threadId }
    : current.threadId
      ? { threadId: current.threadId }
      : {}),
  ...(next.senderId
    ? { senderId: next.senderId }
    : current.senderId
      ? { senderId: current.senderId }
      : {}),
  ...(next.senderName
    ? { senderName: next.senderName }
    : current.senderName
      ? { senderName: current.senderName }
      : {}),
  ...(next.workspaceId
    ? { workspaceId: next.workspaceId }
    : current.workspaceId
      ? { workspaceId: current.workspaceId }
      : {}),
  aliases: [...new Set([next.sessionKey, ...current.aliases, ...next.aliases])],
  createdAt: current.createdAt,
  updatedAt: Math.max(current.updatedAt, next.updatedAt)
})

export class AgentKernel {
  private readonly capabilities = new AgentCapabilityRegistry()
  private readonly toolRegistrations = new Map<string, AgentToolRegistration>()
  private readonly sessions = new Map<string, SessionRegistration>()
  private readonly runs = new Map<string, AgentOrchestrationRun>()
  private readonly events: AgentOrchestrationEvent[] = []
  private readonly retention: ResolvedAgentKernelRetentionPolicy

  constructor(retention: AgentKernelRetentionPolicy = {}) {
    this.retention = {
      maxEvents: normalizeRetentionLimit(
        retention.maxEvents,
        DEFAULT_AGENT_KERNEL_RETENTION_POLICY.maxEvents
      ),
      maxTerminalRuns: normalizeRetentionLimit(
        retention.maxTerminalRuns,
        DEFAULT_AGENT_KERNEL_RETENTION_POLICY.maxTerminalRuns
      ),
      maxInactiveSessions: normalizeRetentionLimit(
        retention.maxInactiveSessions,
        DEFAULT_AGENT_KERNEL_RETENTION_POLICY.maxInactiveSessions
      )
    }
  }

  registerSession(
    route: AssistantRoute,
    options?: {
      workspaceId?: string
      aliases?: string[]
      source?: SessionRegistration['source']
    }
  ): AgentSessionIdentity {
    const identity = buildAgentSessionIdentity(normalizeAgentRoute(route), {
      workspaceId: options?.workspaceId,
      aliases: options?.aliases,
      createdAt: now(),
      updatedAt: now()
    })
    const existing = this.sessions.get(identity.sessionKey)
    const mergedIdentity = existing ? mergeSessionIdentity(existing.identity, identity) : identity

    this.sessions.set(mergedIdentity.sessionKey, {
      identity: mergedIdentity,
      source: options?.source || existing?.source || 'assistant'
    })
    this.pruneInactiveSessions(new Set([mergedIdentity.sessionKey]))

    return mergedIdentity
  }

  getSession(sessionKey: string): AgentSessionIdentity | undefined {
    return this.sessions.get(String(sessionKey || '').trim())?.identity
  }

  listSessions(): AgentSessionIdentity[] {
    return [...this.sessions.values()].map((record) => record.identity)
  }

  registerCapability(descriptor: AgentCapabilityDescriptor): AgentCapabilityDescriptor {
    const registered = this.capabilities.register(descriptor)
    this.appendEvent({
      eventId: crypto.randomUUID(),
      runId: 'kernel',
      sessionKey: registered.capabilityId,
      type: 'capability.registered',
      message: `Capability registered: ${registered.name}`,
      createdAt: now(),
      metadata: {
        capabilityId: registered.capabilityId,
        kind: registered.kind,
        scope: registered.scope,
        transport: registered.transport
      }
    })
    return registered
  }

  registerCapabilities(descriptors: AgentCapabilityDescriptor[]): AgentCapabilityDescriptor[] {
    return descriptors.map((descriptor) => this.registerCapability(descriptor))
  }

  listCapabilities(): AgentCapabilityDescriptor[] {
    return this.capabilities.snapshot()
  }

  removeCapability(capabilityId: string): boolean {
    const normalizedCapabilityId = String(capabilityId || '').trim()
    if (!normalizedCapabilityId) return false

    for (const [toolName, registration] of this.toolRegistrations.entries()) {
      if (
        registration.tool.capabilityId === normalizedCapabilityId ||
        toolName === normalizedCapabilityId
      ) {
        this.toolRegistrations.delete(toolName)
      }
    }

    return this.capabilities.remove(normalizedCapabilityId)
  }

  registerTool(registration: AgentToolRegistration): AgentToolDefinition {
    const toolName =
      registration.tool.toolName || registration.tool.name || registration.tool.capabilityId
    const normalizedTool: AgentToolDefinition = {
      ...registration.tool,
      toolName,
      kind: 'tool'
    }
    this.registerCapability(normalizedTool)
    this.toolRegistrations.set(toolName, {
      tool: normalizedTool,
      invoker: registration.invoker
    })
    return normalizedTool
  }

  registerTools(registrations: AgentToolRegistration[]): AgentToolDefinition[] {
    return registrations.map((registration) => this.registerTool(registration))
  }

  getTool(toolName: string): AgentToolRegistration | undefined {
    return this.toolRegistrations.get(String(toolName || '').trim())
  }

  async invokeTool(
    request: AgentToolInvocationRequest,
    invoker?: AgentToolInvoker
  ): Promise<AgentToolInvocationResult> {
    throwIfAborted(request.signal)

    const session =
      this.getSession(request.session.sessionKey) ||
      this.registerSession(request.session.route as AssistantRoute, {
        workspaceId: request.session.workspaceId,
        aliases: request.session.aliases,
        source:
          request.source === 'mcp'
            ? 'mcp'
            : request.source === 'bot'
              ? 'bot'
              : request.source === 'assistant'
                ? 'assistant'
                : 'kernel'
      })

    const registration = this.getTool(request.toolName)
    const resolvedInvoker = invoker || registration?.invoker
    if (!resolvedInvoker) {
      throw new Error(`No tool invoker has been registered for "${request.toolName}".`)
    }

    const invocationId = request.invocationId || crypto.randomUUID()
    const startedAt = now()
    const result = await resolvedInvoker({
      ...request,
      invocationId,
      session,
      capabilityId: request.capabilityId || registration?.tool.capabilityId,
      source: request.source || 'kernel'
    })
    throwIfAborted(request.signal)
    const finishedAt = now()
    const normalized = createAgentToolInvocationResult(
      {
        ...request,
        invocationId,
        session,
        capabilityId: request.capabilityId || registration?.tool.capabilityId,
        source: request.source || 'kernel'
      },
      result
    )

    normalized.startedAt = startedAt
    normalized.finishedAt = finishedAt
    normalized.durationMs = Math.max(0, finishedAt - startedAt)
    this.appendEvent({
      eventId: crypto.randomUUID(),
      runId: request.traceLabel || invocationId,
      sessionKey: session.sessionKey,
      type: 'tool.invoked',
      message: `Tool invoked: ${request.toolName}`,
      createdAt: finishedAt,
      metadata: {
        invocationId,
        toolName: request.toolName,
        capabilityId: normalized.capabilityId,
        ok: normalized.ok,
        source: request.source || 'kernel'
      }
    })
    return normalized
  }

  createMasterRun(spec: AgentMasterRunSpec): AgentOrchestrationRun {
    return this.createRun('master', spec)
  }

  createSubagentRun(spec: AgentSubagentRunSpec): AgentOrchestrationRun {
    return this.createRun('subagent', spec)
  }

  getRun(runId: string): AgentOrchestrationRun | undefined {
    return this.runs.get(String(runId || '').trim())
  }

  listRuns(sessionKey?: string): AgentOrchestrationRun[] {
    return [...this.runs.values()].filter(
      (run) => !sessionKey || run.session.sessionKey === sessionKey
    )
  }

  recordEvent(
    event: Omit<AgentOrchestrationEvent, 'eventId' | 'createdAt'>
  ): AgentOrchestrationEvent {
    const recorded: AgentOrchestrationEvent = {
      ...event,
      eventId: crypto.randomUUID(),
      createdAt: now()
    }
    this.appendEvent(recorded)
    return recorded
  }

  listEvents(sessionKey?: string): AgentOrchestrationEvent[] {
    return [...this.events].filter((event) => !sessionKey || event.sessionKey === sessionKey)
  }

  updateRun(
    runId: string,
    updates: Partial<AgentOrchestrationRun>
  ): AgentOrchestrationRun | undefined {
    const run = this.getRun(runId)
    if (!run) return undefined
    const next = {
      ...run,
      ...updates,
      updatedAt: now(),
      status: normalizeRunStatus(updates.status || run.status)
    }
    this.runs.set(run.runId, next)
    if (isTerminalRunStatus(next.status)) {
      this.pruneTerminalRuns()
      this.pruneInactiveSessions()
    }
    return next
  }

  clear(): void {
    this.capabilities.clear()
    this.toolRegistrations.clear()
    this.sessions.clear()
    this.runs.clear()
    this.events.length = 0
  }

  private appendEvent(event: AgentOrchestrationEvent): void {
    this.events.push(event)
    const overflow = this.events.length - this.retention.maxEvents
    if (overflow > 0) this.events.splice(0, overflow)
  }

  private pruneTerminalRuns(): void {
    const terminalRuns = [...this.runs.values()]
      .filter((run) => isTerminalRunStatus(run.status))
      .sort((left, right) => left.updatedAt - right.updatedAt)
    const overflow = terminalRuns.length - this.retention.maxTerminalRuns

    for (let index = 0; index < overflow; index += 1) {
      this.runs.delete(terminalRuns[index].runId)
    }
  }

  private pruneInactiveSessions(preservedSessionKeys: ReadonlySet<string> = new Set()): void {
    const activeSessionKeys = new Set(
      [...this.runs.values()]
        .filter((run) => !isTerminalRunStatus(run.status))
        .map((run) => run.session.sessionKey)
    )
    const inactiveSessions = [...this.sessions.values()].filter(
      (record) => !activeSessionKeys.has(record.identity.sessionKey)
    )
    const removableSessions = inactiveSessions
      .filter((record) => !preservedSessionKeys.has(record.identity.sessionKey))
      .sort((left, right) => left.identity.updatedAt - right.identity.updatedAt)
    const overflow = inactiveSessions.length - this.retention.maxInactiveSessions

    for (let index = 0; index < Math.min(overflow, removableSessions.length); index += 1) {
      this.sessions.delete(removableSessions[index].identity.sessionKey)
    }
  }

  private createRun(
    kind: AgentOrchestrationRun['kind'],
    spec: AgentMasterRunSpec & Partial<AgentSubagentRunSpec>
  ): AgentOrchestrationRun {
    const existingSession = this.sessions.get(spec.session.sessionKey)
    const session = existingSession?.identity || spec.session
    this.sessions.set(session.sessionKey, {
      identity: session,
      source: existingSession?.source || 'kernel'
    })

    const run: AgentOrchestrationRun = {
      runId: crypto.randomUUID(),
      kind,
      session,
      goal: spec.goal,
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
      ...(spec.label ? { label: spec.label } : {}),
      ...(spec.modelName ? { modelName: spec.modelName } : {}),
      ...(spec.requestedBy ? { requestedBy: spec.requestedBy } : {}),
      parallelism: Math.max(1, Math.trunc(spec.parallelism || 1)),
      steps: [],
      ...(kind === 'subagent' && spec.masterRunId ? { masterRunId: spec.masterRunId } : {}),
      ...(kind === 'subagent' && spec.parentRunId ? { parentRunId: spec.parentRunId } : {}),
      ...(spec.metadata ? { metadata: spec.metadata } : {})
    }

    this.runs.set(run.runId, run)
    this.pruneInactiveSessions()
    this.recordEvent({
      runId: run.runId,
      sessionKey: run.session.sessionKey,
      type: 'run.created',
      message: `${kind} run created`,
      metadata: {
        kind,
        goal: run.goal,
        parallelism: run.parallelism
      }
    })
    return run
  }
}

let kernelSingleton: AgentKernel | null = null

export const getAgentKernel = (): AgentKernel => {
  if (!kernelSingleton) {
    kernelSingleton = new AgentKernel()
  }
  return kernelSingleton
}
