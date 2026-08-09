export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface SessionRoute {
  channel: string
  scopeType: 'dm' | 'group' | 'channel' | 'thread' | 'topic' | (string & {})
  scopeId: string
}

export interface GraphV1Node {
  nodeId: string
  kind: string
  name: string
  description: string
  [key: string]: JsonValue | undefined
}
export interface GraphV1Definition {
  graphId: string
  name: string
  description: string
  version: string
  tags: string[]
  nodes: GraphV1Node[]
  channels: Array<Record<string, JsonValue>>
  outputs: Array<Record<string, JsonValue>>
  entryNodeIds: string[]
  metadata?: Record<string, JsonValue>
}
export interface GraphV2Port {
  portId: string
  name: string
  direction: 'input' | 'output'
  role: string
  valueType: { kind: string; schemaRef?: string; mediaType?: string }
  required?: boolean
  multiple?: boolean
  defaultValue?: JsonValue
}
export interface GraphV2Node {
  nodeId: string
  name: string
  description: string
  kind: string
  position: { x: number; y: number }
  inputs: GraphV2Port[]
  outputs: GraphV2Port[]
  config: Record<string, JsonValue>
  metadata?: Record<string, JsonValue>
  subgraphRef?: {
    graphId: string
    version: string
    inputMappings: Record<string, string>
    outputMappings: Record<string, string>
  }
}
export interface GraphDefinitionV2 {
  kind: 'magic-agent.graph-definition.v2-draft'
  graphMode: 'design'
  schemaVersion: '2.0.0'
  graphId: string
  name: string
  description: string
  version: string
  tags: string[]
  nodes: GraphV2Node[]
  edges: Array<{
    edgeId: string
    kind: string
    source: { nodeId: string; portId: string }
    target: { nodeId: string; portId: string }
    label?: string
    metadata?: Record<string, JsonValue>
  }>
  variables: Array<{
    variableId: string
    name: string
    scope: string
    valueType: { kind: string; schemaRef?: string; mediaType?: string }
    required?: boolean
    defaultValue?: JsonValue
    description?: string
    sensitive?: boolean
  }>
  outputs: Array<{
    outputId: string
    name: string
    description: string
    source: { nodeId: string; portId: string }
    metadata?: Record<string, JsonValue>
  }>
  entryNodeIds: string[]
  metadata?: Record<string, JsonValue>
  legacySnapshot: GraphV1Definition
}
export interface GraphV2SaveRequest {
  graph: GraphDefinitionV2
  route: SessionRoute
  replace?: boolean
}
export interface GraphV2SaveResult {
  graph: GraphV1Definition
  definitionV2: GraphDefinitionV2
}
export interface GraphV2GetRequest {
  graphId: string
  route: SessionRoute
}
export interface GraphV2GetResult {
  definitionV2?: GraphDefinitionV2
}
export interface GraphV2PublishedGetRequest extends GraphV2GetRequest {
  version: string
}
export interface GraphV2PublishResult {
  definitionV2: GraphDefinitionV2
}
export interface GraphV2ListPublishedResult {
  definitionsV2: GraphDefinitionV2[]
}
export interface GraphV2NodeDescriptor {
  kind: string
  category:
    | 'Control'
    | 'Agent'
    | 'Communication'
    | 'Automation'
    | 'LLM'
    | 'Tool'
    | 'MCP'
    | 'Memory'
    | 'Coding'
    | 'ComfyUI'
    | 'Reusable subgraph'
  title: string
  description: string
  executable: boolean
  disabledReason?: string
  execution:
    | {
        mode: 'legacy-runtime'
        legacyKind: 'input' | 'condition' | 'merge' | 'output' | 'agent' | 'tool'
      }
    | { mode: 'subgraph-runtime' }
    | {
        mode: 'tool-runtime'
        toolName: string
        inputField?: string
        configToolNameField?: string
      }
    | { mode: 'unsupported'; reason: string }
  configSchema: Record<string, JsonValue>
  defaultConfig: Record<string, JsonValue>
  defaultInputs: GraphV2Port[]
  defaultOutputs: GraphV2Port[]
}
export interface GraphV2NodeRegistryResult {
  descriptors: GraphV2NodeDescriptor[]
}
export interface SessionExportRequest {
  sourceRoute: SessionRoute
  format: 'markdown' | 'html' | 'jsonl'
}
export interface SessionAvailability {
  status: 'available' | 'unavailable'
  reason?: string
}
export interface SessionExportResult {
  format: 'markdown' | 'html' | 'jsonl'
  mimeType: string
  filename: string
  body: string
  availability: Record<string, SessionAvailability>
}
export interface SessionDiffRequest {
  leftRoute: SessionRoute
  rightRoute: SessionRoute
}
export interface SessionDiffResult {
  schemaVersion: 1
  leftSessionKey: string
  rightSessionKey: string
  relationship: {
    relationship:
      | 'same'
      | 'left-forked-from-right'
      | 'right-forked-from-left'
      | 'related-forks'
      | 'unrelated'
    commonSourceSessionKey?: string
  }
  dimensions: Record<
    string,
    {
      classification: 'equal' | 'changed' | 'left-only' | 'right-only' | 'unavailable'
      leftAvailable: boolean
      rightAvailable: boolean
      leftCount?: number
      rightCount?: number
    }
  >
  timeline: Array<{
    side: 'left' | 'right' | 'both'
    at: number
    kind: string
    left?: JsonValue
    right?: JsonValue
  }>
  sideBySide: Array<{
    index: number
    left?: JsonValue
    right?: JsonValue
    classification: 'equal' | 'changed' | 'left-only' | 'right-only'
  }>
}

export interface SessionForkRequest {
  sourceRoute: SessionRoute
  sourceEventId: string
  targetRoute: SessionRoute
  idempotencyKey: string
}
export interface SessionForkResult {
  targetSessionKey: string
  lineage: {
    sourceSessionKey: string
    sourceEventId: string
    sourceRunId: string
    forkedAt: number
  }
  warning: string
  counts: { messages: number; runs: number; events: number; artifacts: number }
}

export type SemanticMemorySearchMode = 'lexical' | 'semantic' | 'hybrid'
export type SemanticMemoryVisibility = 'private' | 'workspace' | 'shared'
export type SemanticMemoryPublicScope =
  | { kind: 'session'; route: SessionRoute }
  | { kind: 'session-set'; routes: SessionRoute[] }
  | { kind: 'agent' | 'workspace' | 'drive'; id: string; sourceRoute: SessionRoute }
export interface SemanticMemoryProvenance {
  sourceKind: string
  sourceId: string
  sourceSessionKey?: string
  sourceEventId?: string
  sourceRunId?: string
  sourceArtifactId?: string
  contentHash: string
  recordedAt?: number
}
export interface SemanticMemoryRecord {
  id: string
  scope: { kind: string; id: string; sessionIds?: string[] }
  importance: number
  lifetime: 'session' | 'durable' | 'custom'
  expiresAt?: number
  visibility: SemanticMemoryVisibility
  disabled: boolean
  sensitive: boolean
  redacted: boolean
  preview: string
  provenance: SemanticMemoryProvenance
  createdAt: number
  updatedAt: number
}
export interface SemanticMemorySearchRequest {
  query: string
  scopes: SemanticMemoryPublicScope[]
  visibility?: SemanticMemoryVisibility[]
  mode?: SemanticMemorySearchMode
  limit?: number
  lexicalWeight?: number
  semanticWeight?: number
  providerId?: string
  now?: number
}
export interface SemanticMemorySearchHit {
  memory: SemanticMemoryRecord
  score: number
  lexicalScore: number
  semanticScore?: number
}
export interface SemanticMemorySearchResult {
  hits: SemanticMemorySearchHit[]
  requestedMode: SemanticMemorySearchMode
  effectiveMode: SemanticMemorySearchMode
  degraded: boolean
  degradationReason?: string
}
export interface SemanticMemoryInspectRequest {
  id: string
  sourceRoute: SessionRoute
}
export interface SemanticMemoryInspectResult {
  memory?: SemanticMemoryRecord
}
export type SemanticMemoryDeleteRequest = SemanticMemoryInspectRequest
export interface SemanticMemorySetDisabledRequest extends SemanticMemoryInspectRequest {
  disabled: boolean
}
export interface SemanticMemorySetVisibilityRequest extends SemanticMemoryInspectRequest {
  visibility: SemanticMemoryVisibility
}
export interface SemanticMemoryClearScopeRequest {
  scope: SemanticMemoryPublicScope
}
export interface SemanticMemoryAdminResult {
  affected: number
}
export interface SemanticMemoryRebuildRequest {
  sourceRoute: SessionRoute
  providerId: string
  jobId?: string
  batchSize?: number
}
export interface SemanticMemoryRebuildJob {
  id: string
  providerId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  cursor?: string
  processed: number
  error?: string
  createdAt: number
  updatedAt: number
}
export interface SemanticMemoryIngestSessionRequest {
  sourceRoute: SessionRoute
  providerId?: string
}
export interface SemanticMemoryIngestScopeRequest {
  scope: SemanticMemoryPublicScope
  providerId?: string
}
export interface SemanticMemoryAgentSessionRequest {
  agentId: string
  sourceRoute: SessionRoute
}
export interface SemanticMemoryAgentSessionLink {
  agentId: string
  sessionId: string
  createdAt: number
}
export interface SemanticMemoryIngestResult {
  discovered: number
  upserted: number
}

export interface AgentInstanceLimits {
  maxChildren: number
  maxDepth: number
  maxConcurrency: number
  maxRuntimeMs: number
  allowedToolNames: string[]
  workspaceRoots: string[]
}
export interface AgentTeamState {
  id: string
  name: string
  ownerId: string
  members: Array<{
    memberId: string
    agentInstanceId: string
    role: 'leader' | 'member'
    joinedAt: number
    addedBy: { kind: string; id: string }
  }>
  createdAt: number
  createdBy: { kind: string; id: string }
}
export interface AgentTeamResource {
  id: string
  revision: number
  state: AgentTeamState
  createdAt: number
  updatedAt: number
}
export interface AgentTeamCreateRequest {
  team: { id: string; name: string; createdAt: number }
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentTeamAddMemberRequest {
  teamId: string
  expectedRevision: number
  member: { memberId: string; agentInstanceId: string; role: 'leader' | 'member'; joinedAt: number }
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentTeamRemoveRequest {
  teamId: string
  expectedRevision: number
  removedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentTeamRemoveMemberRequest {
  teamId: string
  expectedRevision: number
  memberId: string
  removedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentTeamReplaceRequest {
  teamId: string
  expectedRevision: number
  replacements: Array<{
    memberId: string
    definitionId: string
    name: string
    configVersion: string
    replacedAt: number
  }>
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentTeamLifecycleRequest {
  teamId: string
  expectedRevision: number
  idempotencyKey: string
}
export interface AgentTeamStartRequest extends AgentTeamLifecycleRequest {
  request: AgentRunRequest
}
export interface AgentTeamLifecycleResult {
  id: string
  revision: number
  teamId: string
  teamRevision: number
  action: 'start' | 'pause' | 'resume' | 'stop' | 'replace'
  status: 'completed' | 'partial' | 'failed'
  outcomes: Array<{
    memberId: string
    agentInstanceId: string
    status: 'completed' | 'failed'
    error?: string
  }>
  startedAt: number
  completedAt?: number
}

export interface AgentInstanceState {
  id: string
  name: string
  definitionId: string
  ownerId?: string
  parentInstanceId?: string
  depth: number
  configVersion: string
  status: 'created' | 'running' | 'paused' | 'stopped' | 'removed'
  limits: AgentInstanceLimits
}
export interface AgentInstanceResource<State extends JsonValue = AgentInstanceState & JsonValue> {
  id: string
  revision: number
  state: State
  createdAt: number
  updatedAt: number
}
export interface AgentInstanceCreateRootRequest {
  instance: AgentInstanceState
  createdAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentInstanceCreateChildRequest {
  parentInstanceId: string
  parentExpectedRevision: number
  instance: Omit<AgentInstanceState, 'parentInstanceId' | 'depth' | 'status'>
  createdAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentConfigContent {
  version: string
  definitionId: string
  model: { profileId: string }
  systemPrompt: string
  inference: { temperature?: number; maxTokens?: number; maxToolIterations?: number }
  tools: { allowedToolNames: string[] }
  memory: {
    allowHistory: boolean
    contextMessageLimit: number
    scope: 'instance' | 'session' | 'workspace'
  }
  policy: { policyIds: string[]; workspaceRoots: string[] }
  channels: { channelIds: string[] }
  budgets: { maxRuntimeMs: number; maxTurns?: number; maxTokens?: number; maxToolCalls?: number }
  createdAt: number
}
export interface AgentConfigCreateRequest {
  config: AgentConfigContent
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentConfigVersionResult {
  version: string
  definitionId: string
  contentDigest: string
  createdAt: number
}
export interface AgentConfigStageRequest {
  instanceId: string
  expectedRevision: number
  configVersion: string
  stagedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentConfigActivateRequest {
  instanceId: string
  expectedRevision: number
  activatedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentConfigRollbackRequest {
  instanceId: string
  expectedRevision: number
  rolledBackAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentInstancePauseResumeRequest {
  instanceId: string
  expectedRevision: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentInstanceStartRequest {
  instanceId: string
  expectedRevision: number
  request: AgentRunRequest
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentInstanceStopRequest {
  instanceId: string
  expectedRevision: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentInstanceReplaceRequest {
  instanceId: string
  expectedRevision: number
  definitionId: string
  name: string
  configVersion: string
  replacedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface AgentInstanceRemoveRequest {
  instanceId: string
  expectedRevision: number
  removedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}

export interface RuntimeChannelMember {
  memberId: string
  agentInstanceId?: string
  graphTargetId?: string
  graphWakeRequest?: {
    graphId: string
    route: { channel: string; scopeType: string; scopeId: string }
  }
  role: 'producer' | 'consumer' | 'producer-consumer'
  joinedAt: number
}
export interface RuntimeChannelState {
  id: string
  name: string
  mode: 'point-to-point' | 'queue' | 'broadcast'
  capacity: number
  members: RuntimeChannelMember[]
}
export interface RuntimeChannelResource {
  id: string
  revision: number
  state: RuntimeChannelState
  createdAt: number
  updatedAt: number
}

export interface RuntimeChannelCreateRequest {
  channel: {
    id: string
    name: string
    mode: 'point-to-point' | 'queue' | 'broadcast'
    capacity: number
  }
  createdAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface RuntimeChannelJoinRequest {
  channelId: string
  expectedRevision: number
  member: {
    memberId: string
    agentInstanceId: string
    role: 'producer' | 'consumer' | 'producer-consumer'
    joinedAt: number
  }
  joinedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface RuntimeChannelLeaveRequest {
  channelId: string
  expectedRevision: number
  memberId: string
  leftAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}

export interface RuntimeChannelWireResource {
  id: string
  revision: number
  state: {
    id: string
    sourceChannelId: string
    targetChannelId: string
    targetPublisherMemberId: string
    enabled: boolean
    createdAt: number
    maxHops: number
  }
  createdAt: number
  updatedAt: number
}

export interface RuntimeChannelWireRequest {
  wire: RuntimeChannelWireResource['state']
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface RuntimeChannelUnwireRequest {
  wireId: string
  expectedRevision: number
  removedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}

export interface RuntimeChannelPublishRequest {
  message: {
    id: string
    channelId: string
    publisherMemberId: string
    payload: JsonValue
    priority: number
    publishedAt: number
    expiresAt?: number
  }
  expectedChannelRevision: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface RuntimeChannelPublishResult {
  messageId: string
  revision: number
  channelId: string
  status: string
}
export interface RuntimeChannelClaimRequest {
  messageId: string
  expectedRevision: number
  consumerMemberId: string
  claimedAt: number
  leaseMs: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface RuntimeChannelAcknowledgeRequest {
  messageId: string
  expectedRevision: number
  consumerMemberId: string
  acknowledgedAt: number
  token: string
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}
export interface RuntimeChannelDelivery {
  messageId: string
  revision: number
  channelId: string
  consumerMemberId: string
  claimToken?: string
  leaseExpiresAt?: number
  acknowledgedAt?: number
}

export interface AgentIdentity {
  kind: 'user' | 'agent' | 'service' | 'sdk'
  id: string
}

export interface AgentToolDefinition<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue
> {
  name: string
  description: string
  inputSchema: Record<string, JsonValue>
  outputSchema?: Record<string, JsonValue>
  effects?: readonly string[]
  invoke(input: Input, context: AgentToolContext): Promise<Output>
}

export interface AgentToolContext {
  requestId: string
  actor: AgentIdentity
  sessionId?: string
  signal?: AbortSignal
}

export interface AgentNodeDefinition<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue
> {
  type: string
  version: string
  inputSchema: Record<string, JsonValue>
  outputSchema: Record<string, JsonValue>
  run(input: Input, context: AgentNodeContext): Promise<Output>
}

export interface AgentNodeContext extends AgentToolContext {
  graphId?: string
  nodeId?: string
}

export interface DriveResource<
  State extends JsonValue = JsonValue
> extends TriggerResource<State> {}
export interface DriveCreateRequest {
  drive: JsonValue
  createdAt: number
  idempotencyKey: string
}
export interface DriveTransitionRequest {
  driveId: string
  expectedRevision: number
  status: string
  transitionedAt: number
  idempotencyKey: string
  reason?: string
}
export interface DriveRetryDeliveryRequest {
  driveId: string
  expectedRevision: number
  retryAt: number
  idempotencyKey: string
}
export interface DriveTransferRequest {
  driveId: string
  expectedRevision: number
  ownerId?: string
  assigneeId?: string
  transferredAt: number
  idempotencyKey: string
}
export interface DriveSetLinksRequest {
  driveId: string
  expectedRevision: number
  links: readonly JsonValue[]
  updatedAt: number
  idempotencyKey: string
}
export interface DriveProgressRequest {
  driveId: string
  expectedRevision: number
  summary: string
  evidence: readonly JsonValue[]
  reportedAt: number
  idempotencyKey: string
}

export interface TriggerResource<State extends JsonValue = JsonValue> {
  id: string
  revision: number
  state: State
  createdAt: number
  updatedAt: number
}

export interface TriggerControlRequest {
  triggerId: string
  expectedTriggerRevision: number
  idempotencyKey: string
  requestedAt: number
}

export interface TriggerCreateRequest {
  trigger: JsonValue
  schedule: JsonValue
  nextFireAt: number
  createdAt: number
  idempotencyKey: string
}

export interface TriggerUpdateRequest extends TriggerControlRequest {
  patch: { title?: string; enabled?: boolean; config?: Record<string, JsonValue> }
}

export interface TriggerEmitRequest {
  source: 'sdk' | 'custom'
  eventId: string
  eventName: string
  emittedAt: number
  payloadDigest?: string
}

export interface TriggerManualFireRequest extends TriggerControlRequest {
  occurrenceId: string
  scheduledAt?: number
  payloadDigest?: string
}

export interface AgentRunRequest<Input extends JsonValue = JsonValue> {
  agentId: string
  input: Input
  sessionId?: string
  idempotencyKey?: string
}

export interface AgentRunResult<Output extends JsonValue = JsonValue> {
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  output?: Output
  error?: { code: string; message: string }
}

export interface GraphRunRoute {
  channel: string
  scopeType: string
  scopeId: string
}
export interface GraphRunControlRequest {
  runId: string
  route: GraphRunRoute
}
export type GraphNodeExecution =
  | { mode: 'single-node'; nodeId: string; inputs: Record<string, JsonValue> }
  | {
      mode: 'run-from-node'
      nodeId: string
      inputs?: Record<string, JsonValue>
      priorRunId?: string
    }
export interface GraphRunRequest {
  graphId: string
  input: string
  route: GraphRunRoute
  runId?: string
  outputIds?: string[]
  nodeExecution?: GraphNodeExecution
  allowedToolNames?: string[] | null
  metadata?: Record<string, JsonValue>
}
export interface GraphRunResult extends Record<string, JsonValue> {
  runId: string
  graphId: string
  status: string
}
export interface GraphRunPendingInputMutationRequest extends GraphRunControlRequest {
  pendingInputId: string
  expectedRevision: number
}
export interface GraphRunInjectPendingInputRequest extends GraphRunPendingInputMutationRequest {
  value: string
}
export interface GraphRunEditPendingInputRequest extends GraphRunInjectPendingInputRequest {
  idempotencyKey: string
}
export interface GraphRunPendingInputMutationResult {
  runId: string
  pendingInputId: string
  revision: number
  status: 'awaiting' | 'submitted' | 'consumed' | 'cancelled'
  replayed?: boolean
}

export interface GraphRunCancelRequest extends GraphRunControlRequest {
  reason?: string
}
export interface GraphRunPauseResult {
  runId: string
  paused: boolean
  status?: string
  error?: string
}
export interface GraphRunResumeResult {
  runId: string
  resumed: boolean
  status?: string
  error?: string
}
export interface GraphRunCancelResult {
  runId: string
  cancelled: boolean
  status?: string
  error?: string
}

export interface GraphRunAttachRequest {
  runId: string
  route: GraphRunRoute
  afterEventId?: string
}
export interface MagicAgentGraphRunPublicEvent {
  eventId: string
  runId: string
  sequence: number
  kind: string
  timestamp: number
  payload: Readonly<Record<string, JsonValue>>
}
