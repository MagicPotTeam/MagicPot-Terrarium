import { AssistantRoute } from '../assistantRuntime/types'
import {
  AgentAction,
  AgentActionHandler,
  AgentCapabilityDescriptor,
  AgentCapabilityRegistry,
  AgentEvent,
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
  isJsonValue,
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
  maxDispatchResults?: number
}

type ResolvedAgentKernelRetentionPolicy = Required<AgentKernelRetentionPolicy>

export const DEFAULT_AGENT_KERNEL_RETENTION_POLICY: Readonly<ResolvedAgentKernelRetentionPolicy> = {
  maxEvents: 10_000,
  maxTerminalRuns: 1_000,
  maxInactiveSessions: 1_000,
  maxDispatchResults: 1_000
}

type DispatchRecord = {
  eventFingerprint: string
  actions: AgentAction[]
  actionFingerprints: Map<string, string>
  controller: AbortController
  waiters: Set<() => void>
  activeSubscribers: number
  started: boolean
  completed: boolean
  error?: unknown
}

const now = (): number => Date.now()

const cloneJsonCompatible = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

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

const RAW_TOOL_INVOCATION_TOKEN = Symbol('magicpot.agentKernel.rawToolInvocation')
let enforceRawToolInvocationGateway = true

export const setAgentKernelRawInvocationGuardForTest = (enabled: boolean): void => {
  enforceRawToolInvocationGateway = enabled
}

export class AgentKernel {
  private readonly capabilities = new AgentCapabilityRegistry()
  private readonly toolRegistrations = new Map<string, AgentToolRegistration>()
  private readonly sessions = new Map<string, SessionRegistration>()
  private readonly runs = new Map<string, AgentOrchestrationRun>()
  private readonly events: AgentOrchestrationEvent[] = []
  private readonly actionHandlers = new Map<string, AgentActionHandler>()
  private readonly dispatchRecords = new Map<string, DispatchRecord>()
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
      ),
      maxDispatchResults: normalizeRetentionLimit(
        retention.maxDispatchResults,
        DEFAULT_AGENT_KERNEL_RETENTION_POLICY.maxDispatchResults
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

  registerActionHandler(type: string, handler: AgentActionHandler): () => void {
    const normalizedType = String(type || '').trim()
    if (!normalizedType) throw new Error('Agent action handler type is required.')
    if (this.actionHandlers.has(normalizedType)) {
      throw new Error(`An Agent action handler is already registered for "${normalizedType}".`)
    }
    this.actionHandlers.set(normalizedType, handler)
    return () => {
      if (this.actionHandlers.get(normalizedType) === handler)
        this.actionHandlers.delete(normalizedType)
    }
  }

  dispatch(event: AgentEvent, signal?: AbortSignal): AsyncIterable<AgentAction> {
    this.validateEvent(event)
    throwIfAborted(signal)
    const eventSnapshot = cloneJsonCompatible(event)
    const eventFingerprint = JSON.stringify(eventSnapshot)
    return {
      [Symbol.asyncIterator]: () =>
        this.iterateDispatch(eventSnapshot, eventFingerprint, signal)[Symbol.asyncIterator]()
    }
  }

  private async *iterateDispatch(
    eventSnapshot: AgentEvent,
    eventFingerprint: string,
    signal?: AbortSignal
  ): AsyncIterable<AgentAction> {
    let record = this.dispatchRecords.get(eventSnapshot.eventId)
    if (record && record.eventFingerprint !== eventFingerprint) {
      throw new Error(
        `Conflicting Agent event already exists for eventId "${eventSnapshot.eventId}".`
      )
    }
    if (!record) {
      const handler = this.actionHandlers.get(eventSnapshot.type)
      if (!handler) {
        throw new Error(`No Agent action handler has been registered for "${eventSnapshot.type}".`)
      }
      record = {
        eventFingerprint,
        actions: [],
        actionFingerprints: new Map(),
        controller: new AbortController(),
        waiters: new Set(),
        activeSubscribers: 0,
        started: false,
        completed: false
      }
      this.dispatchRecords.set(eventSnapshot.eventId, record)
    }
    if (!record.started) {
      const handler = this.actionHandlers.get(eventSnapshot.type)
      if (!handler) {
        this.dispatchRecords.delete(eventSnapshot.eventId)
        throw new Error(`No Agent action handler has been registered for "${eventSnapshot.type}".`)
      }
      record.started = true
      this.startDispatch(eventSnapshot, handler, record)
    }
    yield* this.subscribeToDispatch(record, signal)
  }

  private validateEvent(event: AgentEvent): void {
    if (!event || typeof event !== 'object') throw new TypeError('Agent event is required.')
    if (!String(event.eventId || '').trim()) throw new TypeError('Agent event eventId is required.')
    if (!String(event.type || '').trim()) throw new TypeError('Agent event type is required.')
    if (!Number.isFinite(event.createdAt) || event.createdAt < 0) {
      throw new TypeError(
        `Agent event "${event.eventId}" createdAt must be finite and nonnegative.`
      )
    }
    if (!isJsonValue(event.payload)) {
      throw new TypeError(`Agent event "${event.eventId}" payload must be JSON serializable.`)
    }
    if (event.provenance !== undefined && !isJsonValue(event.provenance)) {
      throw new TypeError(`Agent event "${event.eventId}" provenance must be JSON serializable.`)
    }
    for (const [name, value] of [
      ['correlationId', event.correlationId],
      ['sessionId', event.sessionId],
      ['agentId', event.agentId],
      ['provenance.source', event.provenance?.source]
    ] as const) {
      if (value !== undefined && !String(value).trim()) {
        throw new TypeError(`Agent event ${name} must be non-empty when provided.`)
      }
    }
  }

  private validateAction(action: AgentAction): void {
    if (!action || typeof action !== 'object') throw new TypeError('Agent action is required.')
    if (!String(action.actionId || '').trim())
      throw new TypeError('Agent action actionId is required.')
    if (!String(action.type || '').trim()) throw new TypeError('Agent action type is required.')
    if (!isJsonValue(action.payload)) {
      throw new TypeError(`Agent action "${action.actionId}" payload must be JSON serializable.`)
    }
    if (action.provenance !== undefined && !isJsonValue(action.provenance)) {
      throw new TypeError(`Agent action "${action.actionId}" provenance must be JSON serializable.`)
    }
  }

  private startDispatch(
    event: AgentEvent,
    handler: AgentActionHandler,
    record: DispatchRecord
  ): void {
    void (async () => {
      try {
        const output = handler(cloneJsonCompatible(event), { signal: record.controller.signal })
        if (!output || typeof output[Symbol.asyncIterator] !== 'function') {
          throw new TypeError(
            `Agent action handler for "${event.type}" must return an AsyncIterable.`
          )
        }
        for await (const action of output) {
          throwIfAborted(record.controller.signal)
          this.validateAction(action)
          const actionSnapshot = cloneJsonCompatible(action)
          const fingerprint = JSON.stringify(actionSnapshot)
          const existing = record.actionFingerprints.get(actionSnapshot.actionId)
          if (existing !== undefined) {
            if (existing !== fingerprint) {
              throw new Error(
                `Conflicting Agent action already exists for actionId "${actionSnapshot.actionId}" in event "${event.eventId}".`
              )
            }
            continue
          }
          record.actionFingerprints.set(actionSnapshot.actionId, fingerprint)
          record.actions.push(actionSnapshot)
          this.notifyDispatchWaiters(record)
        }
      } catch (error) {
        record.error = error
      } finally {
        record.completed = true
        this.notifyDispatchWaiters(record)
        this.deleteRetryableDispatchRecord(event.eventId, record)
        this.pruneDispatchRecords()
      }
    })()
  }

  private subscribeToDispatch(
    record: DispatchRecord,
    signal?: AbortSignal
  ): AsyncIterable<AgentAction> {
    const deleteRetryableRecord = (): void => this.deleteRetryableDispatchRecordByReference(record)
    const pruneDispatchRecords = (): void => this.pruneDispatchRecords()
    return {
      [Symbol.asyncIterator]: async function* () {
        let index = 0
        const abort = (): void => {
          const waiters = [...record.waiters]
          record.waiters.clear()
          waiters.forEach((resolve) => resolve())
        }
        record.activeSubscribers += 1
        signal?.addEventListener('abort', abort, { once: true })
        try {
          while (true) {
            throwIfAborted(signal)
            while (index < record.actions.length) {
              yield cloneJsonCompatible(record.actions[index++])
            }
            if (record.completed) {
              if (record.error !== undefined) throw record.error
              return
            }
            await new Promise<void>((resolve) => record.waiters.add(resolve))
          }
        } finally {
          signal?.removeEventListener('abort', abort)
          record.activeSubscribers -= 1
          if (!record.completed && record.activeSubscribers === 0) {
            record.controller.abort(signal?.reason)
          }
          if (record.completed && record.error !== undefined && record.activeSubscribers === 0) {
            deleteRetryableRecord()
          }
          if (record.completed && record.activeSubscribers === 0) pruneDispatchRecords()
        }
      }
    }
  }

  private deleteRetryableDispatchRecord(eventId: string, record: DispatchRecord): void {
    if (
      record.completed &&
      record.error !== undefined &&
      record.activeSubscribers === 0 &&
      this.dispatchRecords.get(eventId) === record
    ) {
      this.dispatchRecords.delete(eventId)
    }
  }

  private deleteRetryableDispatchRecordByReference(record: DispatchRecord): void {
    for (const [eventId, candidate] of this.dispatchRecords) {
      if (candidate === record) {
        this.deleteRetryableDispatchRecord(eventId, record)
        return
      }
    }
  }

  private notifyDispatchWaiters(record: DispatchRecord): void {
    const waiters = [...record.waiters]
    record.waiters.clear()
    waiters.forEach((resolve) => resolve())
  }

  private pruneDispatchRecords(): void {
    const completed = [...this.dispatchRecords.entries()].filter(
      ([, record]) => record.completed && record.activeSubscribers === 0
    )
    const overflow = completed.length - this.retention.maxDispatchResults
    for (let index = 0; index < overflow; index += 1) {
      this.dispatchRecords.delete(completed[index][0])
    }
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
    invoker?: AgentToolInvoker,
    rawInvocationToken?: symbol
  ): Promise<AgentToolInvocationResult> {
    if (
      enforceRawToolInvocationGateway &&
      this === getAgentKernel() &&
      rawInvocationToken !== RAW_TOOL_INVOCATION_TOKEN
    ) {
      throw new Error('AgentKernel raw tool invocation must use an authorized production gateway.')
    }
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

  async invokeAuthorizedTool(
    request: AgentToolInvocationRequest,
    invoker?: AgentToolInvoker
  ): Promise<AgentToolInvocationResult> {
    return this.invokeTool(request, invoker, RAW_TOOL_INVOCATION_TOKEN)
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
    this.actionHandlers.clear()
    for (const record of this.dispatchRecords.values()) {
      record.controller.abort('Kernel cleared.')
      this.notifyDispatchWaiters(record)
    }
    this.dispatchRecords.clear()
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
