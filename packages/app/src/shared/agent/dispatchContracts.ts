export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type AgentProvenance = {
  source: string
  requestedBy?: string
  channel?: string
  traceId?: string
}

export type AgentDispatchContext = {
  correlationId?: string
  sessionId?: string
  agentId?: string
  provenance?: AgentProvenance
}

export type AgentEvent<TPayload extends JsonValue = JsonValue> = AgentDispatchContext & {
  eventId: string
  type: string
  payload: TPayload
  createdAt: number
}

export type AgentAction<TPayload extends JsonValue = JsonValue> = AgentDispatchContext & {
  actionId: string
  type: string
  payload: TPayload
}

export type JsonObject = { [key: string]: JsonValue }

export type ToolInvokePayload = {
  invocationId: string
  toolName: string
  args: JsonObject
  requestedAt: number
  idempotencyKey: string
}
export type ToolInvokeAction = AgentAction<ToolInvokePayload> & { type: 'tool.invoke' }

export type ToolResultPayload = {
  invocationId: string
  toolName: string
  ok: boolean
  content?: string
  metadata?: JsonObject
  error?: { message: string; code?: string }
  startedAt: number
  finishedAt: number
  durationMs: number
}
export type ToolResultAction = AgentAction<ToolResultPayload> & { type: 'tool.result' }

export type ReplyEmitPayload<TResponse extends JsonValue = JsonValue> = { response: TResponse }
export type ReplyEmitAction<TResponse extends JsonValue = JsonValue> = AgentAction<
  ReplyEmitPayload<TResponse>
> & { type: 'reply.emit' }

export type DriveProgressEvidence = {
  kind: 'session' | 'run' | 'artifact' | 'url' | 'text'
  ref: string
  digest?: string
}
export type DriveProgressPayload = {
  driveId: string
  expectedRevision: number
  summary: string
  evidence: DriveProgressEvidence[]
  reportedAt: number
  idempotencyKey: string
}
export type DriveProgressAction = AgentAction<DriveProgressPayload> & { type: 'drive.progress' }

export type MessagePublishPayload = {
  channelId: string
  publisherMemberId: string
  messageId: string
  payload: JsonValue
  priority: number
  publishedAt: number
  expiresAt?: number
  expectedChannelRevision: number
  idempotencyKey: string
}
export type MessagePublishAction = AgentAction<MessagePublishPayload> & {
  type: 'message.publish'
}

type ChildStartInstance = {
  id: string
  name: string
  definitionId: string
  ownerId?: string
  configVersion: string
  pendingConfigVersion?: string
  previousConfigVersion?: string
  configActivatedAt?: number
  limits: {
    maxChildren: number
    maxDepth: number
    maxConcurrency: number
    maxRuntimeMs: number
    allowedToolNames: string[]
    workspaceRoots: string[]
  }
  runtimeTopologyAttribution?: JsonValue
}

export type ChildStartPayload = {
  parentInstanceId: string
  parentExpectedRevision: number
  child: ChildStartInstance
  createdAt: number
  idempotencyKey: string
}
export type ChildStartAction = AgentAction<ChildStartPayload> & { type: 'child.start' }

export const createReplyEmitAction = <TResponse extends JsonValue>(
  action: Omit<ReplyEmitAction<TResponse>, 'type'>
): ReplyEmitAction<TResponse> => ({ ...action, type: 'reply.emit' })

export const createDriveProgressAction = (
  action: Omit<DriveProgressAction, 'type'>
): DriveProgressAction => ({ ...action, type: 'drive.progress' })

export const createMessagePublishAction = (
  action: Omit<MessagePublishAction, 'type'>
): MessagePublishAction => ({ ...action, type: 'message.publish' })

export const createChildStartAction = (
  action: Omit<ChildStartAction, 'type'>
): ChildStartAction => ({ ...action, type: 'child.start' })

const assertJsonObject: (value: unknown, label: string) => asserts value is JsonObject = (
  value,
  label
) => {
  if (!isJsonValue(value) || Array.isArray(value) || value === null) {
    throw new TypeError(`${label} must be a JSON object.`)
  }
}

export const createToolInvokeAction = (
  action: Omit<ToolInvokeAction, 'type'>
): ToolInvokeAction => {
  assertJsonObject(action.payload.args, 'Tool invocation args')
  return { ...action, type: 'tool.invoke' }
}

export const createToolResultAction = (
  action: Omit<ToolResultAction, 'type'>
): ToolResultAction => {
  if (action.payload.metadata !== undefined) {
    assertJsonObject(action.payload.metadata, 'Tool result metadata')
  }
  return { ...action, type: 'tool.result' }
}

export type AgentActionHandlerContext = {
  signal: AbortSignal
}

export type AgentActionHandler = (
  event: AgentEvent,
  context: AgentActionHandlerContext
) => AsyncIterable<AgentAction>

export const actionsFromArray = (
  actions: readonly AgentAction[] | Promise<readonly AgentAction[]>
): AsyncIterable<AgentAction> => ({
  async *[Symbol.asyncIterator]() {
    yield* await actions
  }
})

export const isJsonValue = (value: unknown, seen = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false

  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((entry) => isJsonValue(entry, seen))
  seen.delete(value)
  return valid
}
