from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol

JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]


@dataclass(frozen=True)
class SessionRoute:
    channel: str
    scope_type: str
    scope_id: str


@dataclass(frozen=True)
class GraphV2SaveRequest:
    graph: Mapping[str, JsonValue]
    route: SessionRoute
    replace: bool | None = None


@dataclass(frozen=True)
class GraphV2GetRequest:
    graph_id: str
    route: SessionRoute


@dataclass(frozen=True)
class GraphV2PublishedGetRequest:
    graph_id: str
    route: SessionRoute
    version: str


@dataclass(frozen=True)
class GraphV2PublishResult:
    definition_v2: Mapping[str, JsonValue]


@dataclass(frozen=True)
class GraphV2ListPublishedResult:
    definitions_v2: tuple[Mapping[str, JsonValue], ...]


GraphV2NodeCategory = str


@dataclass(frozen=True)
class GraphV2NodePortDescriptor:
    port_id: str
    name: str
    direction: str
    role: str
    value_type: Mapping[str, JsonValue]
    required: bool | None = None
    multiple: bool | None = None


@dataclass(frozen=True)
class GraphV2NodeExecutionDescriptor:
    mode: str
    legacy_kind: str | None = None
    reason: str | None = None
    tool_name: str | None = None
    input_field: str | None = None
    config_tool_name_field: str | None = None


@dataclass(frozen=True)
class GraphV2NodeDescriptor:
    kind: str
    category: GraphV2NodeCategory
    title: str
    description: str
    executable: bool
    execution: GraphV2NodeExecutionDescriptor
    config_schema: Mapping[str, JsonValue]
    default_config: Mapping[str, JsonValue]
    default_inputs: tuple[GraphV2NodePortDescriptor, ...]
    default_outputs: tuple[GraphV2NodePortDescriptor, ...]
    disabled_reason: str | None = None


@dataclass(frozen=True)
class GraphV2NodeRegistryResult:
    descriptors: tuple[GraphV2NodeDescriptor, ...]


@dataclass(frozen=True)
class SessionExportRequest:
    source_route: SessionRoute
    format: str


@dataclass(frozen=True)
class SessionExportResult:
    format: str
    mime_type: str
    filename: str
    body: str
    availability: Mapping[str, JsonValue]


@dataclass(frozen=True)
class SessionDiffRequest:
    left_route: SessionRoute
    right_route: SessionRoute


@dataclass(frozen=True)
class SessionDiffResult:
    schema_version: int
    left_session_key: str
    right_session_key: str
    relationship: Mapping[str, JsonValue]
    dimensions: Mapping[str, JsonValue]
    timeline: list[JsonValue]
    side_by_side: list[JsonValue]


@dataclass(frozen=True)
class SessionForkRequest:
    source_route: SessionRoute
    source_event_id: str
    target_route: SessionRoute
    idempotency_key: str


@dataclass(frozen=True)
class SessionForkLineage:
    source_session_key: str
    source_event_id: str
    source_run_id: str
    forked_at: float


@dataclass(frozen=True)
class SessionForkCounts:
    messages: int
    runs: int
    events: int
    artifacts: int


@dataclass(frozen=True)
class SessionForkResult:
    target_session_key: str
    lineage: SessionForkLineage
    warning: str
    counts: SessionForkCounts


@dataclass(frozen=True)
class SemanticMemoryPublicProvenance:
    source_kind: str
    source_id: str
    content_hash: str
    source_session_key: str | None = None
    source_event_id: str | None = None
    source_run_id: str | None = None
    source_artifact_id: str | None = None
    recorded_at: float | None = None


@dataclass(frozen=True)
class SemanticMemoryPublicRecord:
    id: str
    scope: Mapping[str, JsonValue]
    importance: float
    lifetime: str
    visibility: str
    disabled: bool
    sensitive: bool
    redacted: bool
    preview: str
    provenance: SemanticMemoryPublicProvenance
    created_at: float
    updated_at: float
    expires_at: float | None = None


@dataclass(frozen=True)
class SemanticMemoryScope:
    kind: str
    route: SessionRoute | None = None
    routes: tuple[SessionRoute, ...] = ()
    id: str | None = None
    source_route: SessionRoute | None = None


@dataclass(frozen=True)
class SemanticMemorySearchRequest:
    query: str
    scopes: tuple[SemanticMemoryScope, ...]
    mode: str = "lexical"
    provider_id: str | None = None
    limit: int | None = None
    visibility: tuple[str, ...] | None = None
    lexical_weight: float | None = None
    semantic_weight: float | None = None
    now: float | None = None


@dataclass(frozen=True)
class SemanticMemoryInspectRequest:
    id: str
    source_route: SessionRoute


@dataclass(frozen=True)
class SemanticMemorySetDisabledRequest(SemanticMemoryInspectRequest):
    disabled: bool = False


@dataclass(frozen=True)
class SemanticMemorySetVisibilityRequest(SemanticMemoryInspectRequest):
    visibility: str = "private"


@dataclass(frozen=True)
class SemanticMemoryClearScopeRequest:
    scope: SemanticMemoryScope


@dataclass(frozen=True)
class SemanticMemoryRebuildRequest:
    source_route: SessionRoute
    provider_id: str
    job_id: str | None = None
    batch_size: int | None = None


@dataclass(frozen=True)
class SemanticMemoryIngestSessionRequest:
    source_route: SessionRoute
    provider_id: str | None = None


@dataclass(frozen=True)
class SemanticMemoryIngestScopeRequest:
    scope: SemanticMemoryScope
    provider_id: str | None = None


@dataclass(frozen=True)
class SemanticMemoryAgentSessionRequest:
    agent_id: str
    source_route: SessionRoute


@dataclass(frozen=True)
class RuntimeChannelResource:
    id: str
    revision: int
    state: JsonValue
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class RuntimeChannelCreateRequest:
    channel: JsonValue
    created_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class RuntimeChannelJoinRequest:
    channel_id: str
    expected_revision: int
    member: JsonValue
    joined_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class RuntimeChannelLeaveRequest:
    channel_id: str
    expected_revision: int
    member_id: str
    left_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class RuntimeChannelWireResource:
    id: str
    revision: int
    state: JsonValue
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class RuntimeChannelWireRequest:
    wire: JsonValue
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class RuntimeChannelUnwireRequest:
    wire_id: str
    expected_revision: int
    removed_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class RuntimeChannelPublishRequest:
    message: JsonValue
    expected_channel_revision: int
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class RuntimeChannelPublishResult:
    message_id: str
    revision: int
    channel_id: str
    status: str


@dataclass(frozen=True)
class RuntimeChannelClaimRequest:
    message_id: str
    expected_revision: int
    consumer_member_id: str
    claimed_at: float
    lease_ms: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class RuntimeChannelAcknowledgeRequest:
    message_id: str
    expected_revision: int
    consumer_member_id: str
    acknowledged_at: float
    token: str
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class RuntimeChannelDelivery:
    message_id: str
    revision: int
    channel_id: str
    consumer_member_id: str
    claim_token: str | None = None
    lease_expires_at: float | None = None
    acknowledged_at: float | None = None


@dataclass(frozen=True)
class AgentInstanceResource:
    id: str
    revision: int
    state: JsonValue
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class AgentTeamCreateRequest:
    team: JsonValue
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None

@dataclass(frozen=True)
class AgentTeamAddMemberRequest:
    team_id: str
    expected_revision: int
    member: JsonValue
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None

@dataclass(frozen=True)
class AgentTeamRemoveRequest:
    team_id: str
    expected_revision: int
    removed_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentTeamRemoveMemberRequest:
    team_id: str
    expected_revision: int
    member_id: str
    removed_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentTeamMemberReplacement:
    member_id: str
    definition_id: str
    name: str
    config_version: str
    replaced_at: float


@dataclass(frozen=True)
class AgentTeamReplaceRequest:
    team_id: str
    expected_revision: int
    replacements: list[AgentTeamMemberReplacement]
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentTeamLifecycleRequest:
    team_id: str
    expected_revision: int
    idempotency_key: str


@dataclass(frozen=True)
class AgentTeamStartRequest(AgentTeamLifecycleRequest):
    request: JsonValue


@dataclass(frozen=True)
class AgentTeamLifecycleResult:
    id: str
    revision: int
    team_id: str
    team_revision: int
    action: str
    status: str
    outcomes: JsonValue
    started_at: float
    completed_at: float | None = None


@dataclass(frozen=True)
class AgentInstanceCreateRootRequest:
    instance: JsonValue
    created_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentInstanceCreateChildRequest:
    parent_instance_id: str
    parent_expected_revision: int
    instance: JsonValue
    created_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentConfigCreateRequest:
    config: JsonValue
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentConfigVersionResult:
    version: str
    definition_id: str
    content_digest: str
    created_at: float


@dataclass(frozen=True)
class AgentConfigStageRequest:
    instance_id: str
    expected_revision: int
    config_version: str
    staged_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentConfigActivateRequest:
    instance_id: str
    expected_revision: int
    activated_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentConfigRollbackRequest:
    instance_id: str
    expected_revision: int
    rolled_back_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentInstancePauseResumeRequest:
    instance_id: str
    expected_revision: int
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentInstanceStartRequest:
    instance_id: str
    expected_revision: int
    request: JsonValue
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentInstanceStopRequest:
    instance_id: str
    expected_revision: int
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentInstanceReplaceRequest:
    instance_id: str
    expected_revision: int
    definition_id: str
    name: str
    config_version: str
    replaced_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class AgentInstanceRemoveRequest:
    instance_id: str
    expected_revision: int
    removed_at: float
    idempotency_key: str
    grant_id: str | None = None
    expected_grant_use_count: int | None = None


@dataclass(frozen=True)
class DriveResource:
    id: str
    revision: int
    state: JsonValue
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class DriveCreateRequest:
    drive: JsonValue
    created_at: float
    idempotency_key: str


@dataclass(frozen=True)
class DriveTransitionRequest:
    drive_id: str
    expected_revision: int
    status: str
    transitioned_at: float
    idempotency_key: str
    reason: str | None = None


@dataclass(frozen=True)
class DriveRetryDeliveryRequest:
    drive_id: str
    expected_revision: int
    retry_at: float
    idempotency_key: str


@dataclass(frozen=True)
class DriveTransferRequest:
    drive_id: str
    expected_revision: int
    transferred_at: float
    idempotency_key: str
    owner_id: str | None = None
    assignee_id: str | None = None


@dataclass(frozen=True)
class DriveSetLinksRequest:
    drive_id: str
    expected_revision: int
    links: list[JsonValue]
    updated_at: float
    idempotency_key: str


@dataclass(frozen=True)
class DriveProgressRequest:
    drive_id: str
    expected_revision: int
    summary: str
    evidence: list[JsonValue]
    reported_at: float
    idempotency_key: str


@dataclass(frozen=True)
class TriggerResource:
    id: str
    revision: int
    state: JsonValue
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class TriggerControlRequest:
    trigger_id: str
    expected_trigger_revision: int
    idempotency_key: str
    requested_at: float


@dataclass(frozen=True)
class TriggerCreateRequest:
    trigger: JsonValue
    schedule: JsonValue
    next_fire_at: float
    created_at: float
    idempotency_key: str


@dataclass(frozen=True)
class TriggerUpdateRequest(TriggerControlRequest):
    patch: dict[str, JsonValue]


@dataclass(frozen=True)
class TriggerEmitRequest:
    source: str
    event_id: str
    event_name: str
    emitted_at: float
    payload_digest: str | None = None


@dataclass(frozen=True)
class TriggerManualFireRequest(TriggerControlRequest):
    occurrence_id: str
    scheduled_at: float | None = None
    payload_digest: str | None = None


@dataclass(frozen=True)
class AgentRunRequest:
    agent_id: str
    input: JsonValue
    session_id: str | None = None
    idempotency_key: str | None = None


@dataclass(frozen=True)
class AgentRunResult:
    run_id: str
    status: str
    output: JsonValue = None
    error: Mapping[str, str] | None = None


class AgentTransport(Protocol):
    def request(self, method: str, payload: JsonValue) -> JsonValue: ...


class AsyncAgentTransport(Protocol):
    async def request(self, method: str, payload: JsonValue) -> JsonValue: ...

@dataclass(frozen=True)
class GraphRunControlRequest:
    run_id: str
    route: Mapping[str, str]


@dataclass(frozen=True)
class GraphNodeExecution:
    mode: str
    node_id: str
    inputs: Mapping[str, JsonValue] | None = None
    prior_run_id: str | None = None


@dataclass(frozen=True)
class GraphRunRequest:
    graph_id: str
    input: str
    route: Mapping[str, str]
    run_id: str | None = None
    output_ids: tuple[str, ...] = ()
    node_execution: GraphNodeExecution | None = None
    allowed_tool_names: tuple[str, ...] | None = None
    metadata: Mapping[str, JsonValue] | None = None


@dataclass(frozen=True)
class GraphRunPendingInputMutationRequest(GraphRunControlRequest):
    pending_input_id: str
    expected_revision: int
    idempotency_key: str


@dataclass(frozen=True)
class GraphRunInjectPendingInputRequest(GraphRunPendingInputMutationRequest):
    value: str


GraphRunEditPendingInputRequest = GraphRunInjectPendingInputRequest


@dataclass(frozen=True)
class GraphRunPendingInputMutationResult:
    run_id: str
    pending_input_id: str
    revision: int
    status: str
    replayed: bool | None = None


@dataclass(frozen=True)
class GraphRunCancelRequest(GraphRunControlRequest):
    reason: str | None = None


@dataclass(frozen=True)
class GraphRunPauseResult:
    run_id: str
    paused: bool
    status: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class GraphRunResumeResult:
    run_id: str
    resumed: bool
    status: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class GraphRunCancelResult:
    run_id: str
    cancelled: bool
    status: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class GraphRunAttachRequest:
    run_id: str
    route: Mapping[str, str]
    after_event_id: str | None = None
