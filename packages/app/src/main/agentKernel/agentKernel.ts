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

const now = (): number => Date.now()

const normalizeRunStatus = (status?: AgentRunStatus): AgentRunStatus => status || 'pending'

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
    this.events.push({
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
    this.events.push({
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
    this.events.push(recorded)
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
    return next
  }

  clear(): void {
    this.capabilities.clear()
    this.toolRegistrations.clear()
    this.sessions.clear()
    this.runs.clear()
    this.events.length = 0
  }

  private createRun(
    kind: AgentOrchestrationRun['kind'],
    spec: AgentMasterRunSpec & Partial<AgentSubagentRunSpec>
  ): AgentOrchestrationRun {
    const session = this.sessions.get(spec.session.sessionKey)?.identity || spec.session
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
