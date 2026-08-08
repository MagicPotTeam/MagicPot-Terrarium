from __future__ import annotations

import asyncio
import inspect
from typing import AsyncIterator

from .contracts import (
    AgentTeamCreateRequest,
    AgentTeamAddMemberRequest,
    AgentTeamRemoveRequest,
    AgentTeamRemoveMemberRequest,
    AgentTeamReplaceRequest,
    AgentTeamLifecycleRequest,
    AgentTeamStartRequest,
    AgentConfigActivateRequest,
    AgentConfigRollbackRequest,
    AgentConfigCreateRequest,
    AgentConfigVersionResult,
    AgentConfigStageRequest,
    AgentInstanceCreateChildRequest,
    AgentInstanceCreateRootRequest,
    AgentInstancePauseResumeRequest,
    AgentInstanceReplaceRequest,
    AgentInstanceRemoveRequest,
    AgentInstanceResource,
    AgentInstanceStartRequest,
    AgentInstanceStopRequest,
    AgentRunRequest,
    AgentRunResult,
    AgentTransport,
    AsyncAgentTransport,
    DriveCreateRequest,
    DriveProgressRequest,
    DriveResource,
    DriveTransitionRequest,
    DriveRetryDeliveryRequest,
    GraphV2GetRequest,
    GraphV2NodeDescriptor,
    GraphV2NodeExecutionDescriptor,
    GraphV2NodePortDescriptor,
    GraphV2NodeRegistryResult,
    GraphV2PublishedGetRequest,
    GraphV2SaveRequest,
    DriveTransferRequest,
    DriveSetLinksRequest,
    GraphRunCancelRequest,
    GraphRunCancelResult,
    GraphRunRequest,
    GraphRunControlRequest,
    GraphRunPauseResult,
    GraphRunResumeResult,
    GraphRunPendingInputMutationRequest,
    GraphRunInjectPendingInputRequest,
    GraphRunEditPendingInputRequest,
    GraphRunPendingInputMutationResult,
    RuntimeChannelAcknowledgeRequest,
    RuntimeChannelPublishRequest,
    RuntimeChannelPublishResult,
    RuntimeChannelClaimRequest,
    RuntimeChannelDelivery,
    RuntimeChannelCreateRequest,
    RuntimeChannelJoinRequest,
    RuntimeChannelLeaveRequest,
    RuntimeChannelUnwireRequest,
    RuntimeChannelWireRequest,
    RuntimeChannelWireResource,
    RuntimeChannelResource,
    SessionForkCounts,
    SessionForkLineage,
    SessionForkRequest,
    SessionForkResult,
    SessionExportRequest,
    SessionExportResult,
    SessionDiffRequest,
    SessionDiffResult,
    SemanticMemoryScope,
    SemanticMemorySearchRequest,
    SemanticMemoryInspectRequest,
    SemanticMemorySetDisabledRequest,
    SemanticMemorySetVisibilityRequest,
    SemanticMemoryClearScopeRequest,
    SemanticMemoryRebuildRequest,
    SemanticMemoryIngestSessionRequest,
    SemanticMemoryIngestScopeRequest,
    SemanticMemoryAgentSessionRequest,
    TriggerControlRequest,
    TriggerCreateRequest,
    TriggerEmitRequest,
    TriggerManualFireRequest,
    TriggerResource,
    TriggerUpdateRequest,
 )


def _session_route_payload(route):
    return {"channel": route.channel, "scopeType": route.scope_type, "scopeId": route.scope_id}


def _memory_scope_payload(scope: SemanticMemoryScope):
    if scope.kind == "session":
        return {"kind": "session", "route": _session_route_payload(scope.route)}
    if scope.kind == "session-set":
        return {"kind": "session-set", "routes": [_session_route_payload(route) for route in scope.routes]}
    return {"kind": scope.kind, "id": scope.id, "sourceRoute": _session_route_payload(scope.source_route)}


def _memory_payload(request):
    if isinstance(request, SemanticMemorySearchRequest):
        value = {"query": request.query, "scopes": [_memory_scope_payload(scope) for scope in request.scopes], "mode": request.mode}
        if request.provider_id is not None: value["providerId"] = request.provider_id
        if request.limit is not None: value["limit"] = request.limit
        if request.visibility is not None: value["visibility"] = list(request.visibility)
        if request.lexical_weight is not None: value["lexicalWeight"] = request.lexical_weight
        if request.semantic_weight is not None: value["semanticWeight"] = request.semantic_weight
        if request.now is not None: value["now"] = request.now
        return value
    if isinstance(request, SemanticMemoryClearScopeRequest): return {"scope": _memory_scope_payload(request.scope)}
    if isinstance(request, SemanticMemoryIngestScopeRequest):
        value = {"scope": _memory_scope_payload(request.scope)}
        if request.provider_id is not None: value["providerId"] = request.provider_id
        return value
    if isinstance(request, SemanticMemoryAgentSessionRequest):
        return {"agentId": request.agent_id, "sourceRoute": _session_route_payload(request.source_route)}
    value = {"sourceRoute": _session_route_payload(request.source_route)}
    if hasattr(request, "id"): value["id"] = request.id
    if isinstance(request, SemanticMemorySetDisabledRequest): value["disabled"] = request.disabled
    if isinstance(request, SemanticMemorySetVisibilityRequest): value["visibility"] = request.visibility
    if isinstance(request, SemanticMemoryRebuildRequest):
        value["providerId"] = request.provider_id
        if request.job_id is not None: value["jobId"] = request.job_id
        if request.batch_size is not None: value["batchSize"] = request.batch_size
    if isinstance(request, SemanticMemoryIngestSessionRequest) and request.provider_id is not None: value["providerId"] = request.provider_id
    return value


def _graph_v2_node_port(value) -> GraphV2NodePortDescriptor:
    return GraphV2NodePortDescriptor(
        port_id=str(value["portId"]),
        name=str(value["name"]),
        direction=str(value["direction"]),
        role=str(value["role"]),
        value_type=value["valueType"],
        required=value.get("required"),
        multiple=value.get("multiple"),
    )


def _graph_v2_node_registry_result(value) -> GraphV2NodeRegistryResult:
    descriptors = []
    for item in value["descriptors"]:
        execution = item["execution"]
        descriptors.append(GraphV2NodeDescriptor(
            kind=str(item["kind"]),
            category=str(item["category"]),
            title=str(item["title"]),
            description=str(item["description"]),
            executable=bool(item["executable"]),
            execution=GraphV2NodeExecutionDescriptor(
                mode=str(execution["mode"]),
                legacy_kind=execution.get("legacyKind"),
                reason=execution.get("reason"),
                tool_name=execution.get("toolName"),
                input_field=execution.get("inputField"),
                config_tool_name_field=execution.get("configToolNameField"),
            ),
            config_schema=item["configSchema"],
            default_config=item["defaultConfig"],
            default_inputs=tuple(_graph_v2_node_port(port) for port in item["defaultInputs"]),
            default_outputs=tuple(_graph_v2_node_port(port) for port in item["defaultOutputs"]),
            disabled_reason=item.get("disabledReason"),
        ))
    return GraphV2NodeRegistryResult(tuple(descriptors))


def _session_export_payload(request: SessionExportRequest):
    return {"sourceRoute": _session_route_payload(request.source_route), "format": request.format}


def _session_diff_payload(request: SessionDiffRequest):
    return {"leftRoute": _session_route_payload(request.left_route), "rightRoute": _session_route_payload(request.right_route)}


def _session_export_result(value) -> SessionExportResult:
    return SessionExportResult(str(value["format"]), str(value["mimeType"]), str(value["filename"]), str(value["body"]), value["availability"])


def _session_diff_result(value) -> SessionDiffResult:
    return SessionDiffResult(int(value["schemaVersion"]), str(value["leftSessionKey"]), str(value["rightSessionKey"]), value["relationship"], value["dimensions"], value["timeline"], value["sideBySide"])


def _session_fork_payload(request: SessionForkRequest):
    return {"sourceRoute": _session_route_payload(request.source_route),
        "sourceEventId": request.source_event_id, "targetRoute": _session_route_payload(request.target_route),
        "idempotencyKey": request.idempotency_key}


def _session_fork_result(value) -> SessionForkResult:
    lineage, counts = value["lineage"], value["counts"]
    return SessionForkResult(str(value["targetSessionKey"]), SessionForkLineage(
        str(lineage["sourceSessionKey"]), str(lineage["sourceEventId"]),
        str(lineage["sourceRunId"]), float(lineage["forkedAt"])), str(value["warning"]),
        SessionForkCounts(int(counts["messages"]), int(counts["runs"]),
            int(counts["events"]), int(counts["artifacts"])))


def _team_replace_payload(request: AgentTeamReplaceRequest):
    return {key: value for key, value in {
        "teamId": request.team_id, "expectedRevision": request.expected_revision,
        "replacements": [{"memberId": item.member_id, "definitionId": item.definition_id,
            "name": item.name, "configVersion": item.config_version, "replacedAt": item.replaced_at}
            for item in request.replacements], "idempotencyKey": request.idempotency_key,
        "grantId": request.grant_id, "expectedGrantUseCount": request.expected_grant_use_count
    }.items() if value is not None}


def _team_lifecycle_payload(request):
    values = {"teamId": request.team_id, "expectedRevision": request.expected_revision,
        "idempotencyKey": request.idempotency_key}
    if isinstance(request, AgentTeamStartRequest):
        values["request"] = request.request
    return values


def _channel_publish_payload(request: RuntimeChannelPublishRequest):
    return {key: value for key, value in {"message": request.message,
        "expectedChannelRevision": request.expected_channel_revision,
        "idempotencyKey": request.idempotency_key, "grantId": request.grant_id,
        "expectedGrantUseCount": request.expected_grant_use_count}.items() if value is not None}


def _channel_create_payload(request: RuntimeChannelCreateRequest):
    return {key: value for key, value in {"channel": request.channel, "createdAt": request.created_at,
        "idempotencyKey": request.idempotency_key, "grantId": request.grant_id,
        "expectedGrantUseCount": request.expected_grant_use_count}.items() if value is not None}


def _agent_instance_create_payload(request):
    values = {"instance": request.instance, "createdAt": request.created_at,
        "idempotencyKey": request.idempotency_key, "grantId": request.grant_id,
        "expectedGrantUseCount": request.expected_grant_use_count}
    if isinstance(request, AgentInstanceCreateChildRequest):
        values.update({"parentInstanceId": request.parent_instance_id,
            "parentExpectedRevision": request.parent_expected_revision})
    return {key: value for key, value in values.items() if value is not None}


def _pause_resume_payload(request: AgentInstancePauseResumeRequest):
    return {key: value for key, value in {"instanceId": request.instance_id,
        "expectedRevision": request.expected_revision, "idempotencyKey": request.idempotency_key,
        "grantId": request.grant_id, "expectedGrantUseCount": request.expected_grant_use_count}.items() if value is not None}


def _team_payload(request):
    if isinstance(request, AgentTeamCreateRequest):
        value = {"team": request.team, "idempotencyKey": request.idempotency_key}
    elif isinstance(request, AgentTeamAddMemberRequest):
        value = {"teamId": request.team_id, "expectedRevision": request.expected_revision, "member": request.member,
                 "idempotencyKey": request.idempotency_key}
    elif isinstance(request, AgentTeamRemoveRequest):
        value = {"teamId": request.team_id, "expectedRevision": request.expected_revision,
                 "removedAt": request.removed_at, "idempotencyKey": request.idempotency_key}
    else:
        value = {"teamId": request.team_id, "expectedRevision": request.expected_revision, "memberId": request.member_id,
                 "removedAt": request.removed_at, "idempotencyKey": request.idempotency_key}
    if request.grant_id is not None: value["grantId"] = request.grant_id
    if request.expected_grant_use_count is not None: value["expectedGrantUseCount"] = request.expected_grant_use_count
    return value


def _config_create_payload(request: AgentConfigCreateRequest):
    value = {"config": request.config, "idempotencyKey": request.idempotency_key}
    if request.grant_id is not None: value["grantId"] = request.grant_id
    if request.expected_grant_use_count is not None: value["expectedGrantUseCount"] = request.expected_grant_use_count
    return value


def _config_result(value):
    return AgentConfigVersionResult(value["version"], value["definitionId"], value["contentDigest"], value["createdAt"])


def _config_payload(request):
    values = {"instanceId": request.instance_id, "expectedRevision": request.expected_revision,
        "idempotencyKey": request.idempotency_key, "grantId": request.grant_id,
        "expectedGrantUseCount": request.expected_grant_use_count}
    if isinstance(request, AgentConfigStageRequest):
        values.update({"configVersion": request.config_version, "stagedAt": request.staged_at})
    elif isinstance(request, AgentConfigActivateRequest):
        values["activatedAt"] = request.activated_at
    else:
        values["rolledBackAt"] = request.rolled_back_at
    return {key: value for key, value in values.items() if value is not None}


def _graph_run_payload(request: GraphRunRequest):
    payload = {
        "graphId": request.graph_id,
        "input": request.input,
        "route": request.route,
    }
    if request.run_id is not None:
        payload["runId"] = request.run_id
    if request.output_ids:
        payload["outputIds"] = list(request.output_ids)
    if request.node_execution is not None:
        execution = {
            "mode": request.node_execution.mode,
            "nodeId": request.node_execution.node_id,
        }
        if request.node_execution.inputs is not None:
            execution["inputs"] = dict(request.node_execution.inputs)
        if request.node_execution.prior_run_id is not None:
            execution["priorRunId"] = request.node_execution.prior_run_id
        payload["nodeExecution"] = execution
    if request.allowed_tool_names is not None:
        payload["allowedToolNames"] = list(request.allowed_tool_names)
    if request.metadata is not None:
        payload["metadata"] = dict(request.metadata)
    return payload


def _run_payload(request: AgentRunRequest):
    payload = {"agentId": request.agent_id, "input": request.input}
    if request.session_id is not None:
        payload["sessionId"] = request.session_id
    if request.idempotency_key is not None:
        payload["idempotencyKey"] = request.idempotency_key
    return payload


def _drive_resource(value: object) -> DriveResource:
    trigger = _trigger_resource(value)
    return DriveResource(trigger.id, trigger.revision, trigger.state, trigger.created_at, trigger.updated_at)


def _drive_create_payload(request: DriveCreateRequest):
    return {"drive": request.drive, "createdAt": request.created_at, "idempotencyKey": request.idempotency_key}


def _drive_transition_payload(request: DriveTransitionRequest):
    payload = {"driveId": request.drive_id, "expectedRevision": request.expected_revision, "status": request.status,
               "transitionedAt": request.transitioned_at, "idempotencyKey": request.idempotency_key}
    if request.reason is not None:
        payload["reason"] = request.reason
    return payload


def _drive_transfer_payload(request: DriveTransferRequest):
    payload = {"driveId": request.drive_id, "expectedRevision": request.expected_revision, "transferredAt": request.transferred_at, "idempotencyKey": request.idempotency_key}
    if request.owner_id is not None: payload["ownerId"] = request.owner_id
    if request.assignee_id is not None: payload["assigneeId"] = request.assignee_id
    return payload

def _drive_set_links_payload(request: DriveSetLinksRequest):
    return {"driveId": request.drive_id, "expectedRevision": request.expected_revision, "links": request.links, "updatedAt": request.updated_at, "idempotencyKey": request.idempotency_key}


def _drive_progress_payload(request: DriveProgressRequest):
    return {"driveId": request.drive_id, "expectedRevision": request.expected_revision, "summary": request.summary,
            "evidence": request.evidence, "reportedAt": request.reported_at, "idempotencyKey": request.idempotency_key}


def _trigger_resource(value: object) -> TriggerResource:
    if not isinstance(value, dict):
        raise TypeError("Trigger resource must be an object")
    return TriggerResource(
        id=str(value["id"]),
        revision=int(value["revision"]),
        state=value.get("state"),
        created_at=float(value["createdAt"]),
        updated_at=float(value["updatedAt"]),
    )


def _control_payload(request: TriggerControlRequest):
    return {
        "triggerId": request.trigger_id,
        "expectedTriggerRevision": request.expected_trigger_revision,
        "idempotencyKey": request.idempotency_key,
        "requestedAt": request.requested_at,
    }


def _create_payload(request: TriggerCreateRequest):
    return {
        "trigger": request.trigger,
        "schedule": request.schedule,
        "nextFireAt": request.next_fire_at,
        "createdAt": request.created_at,
        "idempotencyKey": request.idempotency_key,
    }


def _update_payload(request: TriggerUpdateRequest):
    return {**_control_payload(request), "patch": request.patch}


def _emit_payload(request: TriggerEmitRequest):
    payload = {
        "source": request.source,
        "eventId": request.event_id,
        "eventName": request.event_name,
        "emittedAt": request.emitted_at,
    }
    if request.payload_digest is not None:
        payload["payloadDigest"] = request.payload_digest
    return payload


def _manual_payload(request: TriggerManualFireRequest):
    payload = {**_control_payload(request), "occurrenceId": request.occurrence_id}
    if request.scheduled_at is not None:
        payload["scheduledAt"] = request.scheduled_at
    if request.payload_digest is not None:
        payload["payloadDigest"] = request.payload_digest
    return payload


def _drive_retry_delivery_payload(request: DriveRetryDeliveryRequest):
    return {
        "driveId": request.drive_id,
        "expectedRevision": request.expected_revision,
        "retryAt": request.retry_at,
        "idempotencyKey": request.idempotency_key,
    }


def _runtime_channel(value) -> RuntimeChannelResource:
    return RuntimeChannelResource(value["id"], value["revision"], value["state"], value["createdAt"], value["updatedAt"])


def _runtime_channel_wire(value) -> RuntimeChannelWireResource:
    return RuntimeChannelWireResource(value["id"], value["revision"], value["state"], value["createdAt"], value["updatedAt"])


def _membership_payload(request):
    if isinstance(request, RuntimeChannelJoinRequest):
        values = {"channelId": request.channel_id, "expectedRevision": request.expected_revision, "member": request.member,
            "joinedAt": request.joined_at, "idempotencyKey": request.idempotency_key,
            "grantId": request.grant_id, "expectedGrantUseCount": request.expected_grant_use_count}
    else:
        values = {"channelId": request.channel_id, "expectedRevision": request.expected_revision, "memberId": request.member_id,
            "leftAt": request.left_at, "idempotencyKey": request.idempotency_key,
            "grantId": request.grant_id, "expectedGrantUseCount": request.expected_grant_use_count}
    return {key: value for key, value in values.items() if value is not None}


def _wire_payload(request):
    if isinstance(request, RuntimeChannelWireRequest):
        values = {"wire": request.wire, "idempotencyKey": request.idempotency_key,
            "grantId": request.grant_id, "expectedGrantUseCount": request.expected_grant_use_count}
    else:
        values = {"wireId": request.wire_id, "expectedRevision": request.expected_revision, "removedAt": request.removed_at,
            "idempotencyKey": request.idempotency_key, "grantId": request.grant_id, "expectedGrantUseCount": request.expected_grant_use_count}
    return {key: value for key, value in values.items() if value is not None}


def _runtime_channel_delivery(value) -> RuntimeChannelDelivery:
    return RuntimeChannelDelivery(value["messageId"], value["revision"], value["channelId"], value["consumerMemberId"],
        value.get("claimToken"), value.get("leaseExpiresAt"), value.get("acknowledgedAt"))


def _delivery_payload(request):
    values = {
        "messageId": request.message_id,
        "expectedRevision": request.expected_revision,
        "consumerMemberId": request.consumer_member_id,
        "idempotencyKey": request.idempotency_key,
        **({"claimedAt": request.claimed_at, "leaseMs": request.lease_ms} if isinstance(request, RuntimeChannelClaimRequest)
           else {"acknowledgedAt": request.acknowledged_at, "token": request.token}),
        "grantId": request.grant_id,
        "expectedGrantUseCount": request.expected_grant_use_count,
    }
    return {key: value for key, value in values.items() if value is not None}


def _agent_instance(value) -> AgentInstanceResource:
    return AgentInstanceResource(value["id"], value["revision"], value["state"], value["createdAt"], value["updatedAt"])


def _instance_mutation_payload(request):
    payload = {
        key: value
        for key, value in {
            "instanceId": getattr(request, "instance_id", None),
            "expectedRevision": getattr(request, "expected_revision", None),
            "request": getattr(request, "request", None),
            "idempotencyKey": getattr(request, "idempotency_key", None),
            "grantId": getattr(request, "grant_id", None),
            "expectedGrantUseCount": getattr(request, "expected_grant_use_count", None),
            "removedAt": getattr(request, "removed_at", None),
        }.items()
        if value is not None
    }
    return payload


def _pending_input_payload(request):
    payload = {"runId": request.run_id, "route": request.route,
        "pendingInputId": request.pending_input_id, "expectedRevision": request.expected_revision}
    if hasattr(request, "value"): payload["value"] = request.value
    if hasattr(request, "idempotency_key"): payload["idempotencyKey"] = request.idempotency_key
    return payload


def _pending_input_result(value):
    return GraphRunPendingInputMutationResult(str(value["runId"]), str(value["pendingInputId"]),
        int(value["revision"]), str(value["status"]), value.get("replayed"))


def _next_stream_value(iterator):
    try:
        return True, next(iterator)
    except StopIteration:
        return False, None


class MagicAgentClient:
    def __init__(self, transport: AgentTransport):
        self._transport = transport

    def save_graph_v2(self, request: GraphV2SaveRequest):
        payload = {
            "graph": dict(request.graph),
            "route": {"channel": request.route.channel, "scopeType": request.route.scope_type, "scopeId": request.route.scope_id},
        }
        if request.replace is not None:
            payload["replace"] = request.replace
        return self._transport.request("graph.v2.save", payload)

    def get_graph_v2(self, request: GraphV2GetRequest):
        return self._transport.request("graph.v2.get", {
            "graphId": request.graph_id,
            "route": {"channel": request.route.channel, "scopeType": request.route.scope_type, "scopeId": request.route.scope_id},
        })

    def publish_graph_v2(self, request: GraphV2GetRequest):
        return self._transport.request("graph.v2.publish", {
            "graphId": request.graph_id,
            "route": _session_route_payload(request.route),
        })

    def get_published_graph_v2(self, request: GraphV2PublishedGetRequest):
        return self._transport.request("graph.v2.published.get", {
            "graphId": request.graph_id,
            "route": _session_route_payload(request.route),
            "version": request.version,
        })

    def list_published_graphs_v2(self, request: GraphV2GetRequest):
        return self._transport.request("graph.v2.published.list", {
            "graphId": request.graph_id,
            "route": _session_route_payload(request.route),
        })

    def list_graph_v2_node_registry(self) -> GraphV2NodeRegistryResult:
        return _graph_v2_node_registry_result(
            self._transport.request("graph.v2.nodeRegistry.list", {})
        )

    def search_semantic_memory(self, request: SemanticMemorySearchRequest): return self._transport.request("memory.search", _memory_payload(request))
    def inspect_semantic_memory(self, request: SemanticMemoryInspectRequest): return self._transport.request("memory.inspect", _memory_payload(request))
    def delete_semantic_memory(self, request: SemanticMemoryInspectRequest): return self._transport.request("memory.delete", _memory_payload(request))
    def set_semantic_memory_disabled(self, request: SemanticMemorySetDisabledRequest): return self._transport.request("memory.setDisabled", _memory_payload(request))
    def set_semantic_memory_visibility(self, request: SemanticMemorySetVisibilityRequest): return self._transport.request("memory.setVisibility", _memory_payload(request))
    def clear_semantic_memory_scope(self, request: SemanticMemoryClearScopeRequest): return self._transport.request("memory.clearScope", _memory_payload(request))
    def rebuild_semantic_memory(self, request: SemanticMemoryRebuildRequest): return self._transport.request("memory.rebuild", _memory_payload(request))
    def ingest_session_memory(self, request: SemanticMemoryIngestSessionRequest): return self._transport.request("memory.ingestSession", _memory_payload(request))
    def ingest_semantic_memory_scope(self, request: SemanticMemoryIngestScopeRequest): return self._transport.request("memory.ingestScope", _memory_payload(request))
    def link_semantic_memory_agent_session(self, request: SemanticMemoryAgentSessionRequest): return self._transport.request("memory.linkAgentSession", _memory_payload(request))
    def unlink_semantic_memory_agent_session(self, request: SemanticMemoryAgentSessionRequest): return self._transport.request("memory.unlinkAgentSession", _memory_payload(request))
    def list_semantic_memory_agent_sessions(self, agent_id: str): return self._transport.request("memory.listAgentSessions", {"agentId": agent_id})

    def export_session(self, request: SessionExportRequest) -> SessionExportResult:
        return _session_export_result(self._transport.request("session.export", _session_export_payload(request)))

    def diff_sessions(self, request: SessionDiffRequest) -> SessionDiffResult:
        return _session_diff_result(self._transport.request("session.diff", _session_diff_payload(request)))

    def fork_session_at_event(self, request: SessionForkRequest) -> SessionForkResult:
        return _session_fork_result(self._transport.request("session.fork", _session_fork_payload(request)))

    def inject_pending_input(self, request: GraphRunInjectPendingInputRequest) -> GraphRunPendingInputMutationResult:
        return _pending_input_result(self._transport.request("graphRun.input.inject", _pending_input_payload(request)))

    def edit_pending_input(self, request: GraphRunEditPendingInputRequest) -> GraphRunPendingInputMutationResult:
        return _pending_input_result(self._transport.request("graphRun.input.edit", _pending_input_payload(request)))

    def cancel_pending_input(self, request: GraphRunPendingInputMutationRequest) -> GraphRunPendingInputMutationResult:
        return _pending_input_result(self._transport.request("graphRun.input.cancel", _pending_input_payload(request)))

    def run_graph(self, request: GraphRunRequest):
        return self._transport.request("graph.run", _graph_run_payload(request))

    def pause_graph_run(self, request: GraphRunControlRequest) -> GraphRunPauseResult:
        value = self._transport.request("graphRun.pause", {"runId": request.run_id, "route": request.route})
        return GraphRunPauseResult(str(value["runId"]), bool(value["paused"]), value.get("status"), value.get("error"))

    def resume_graph_run(self, request: GraphRunControlRequest) -> GraphRunResumeResult:
        value = self._transport.request("graphRun.resume", {"runId": request.run_id, "route": request.route})
        return GraphRunResumeResult(str(value["runId"]), bool(value["resumed"]), value.get("status"), value.get("error"))

    def cancel_graph_run(self, request: GraphRunCancelRequest) -> GraphRunCancelResult:
        payload = {"runId": request.run_id, "route": request.route}
        if request.reason is not None: payload["reason"] = request.reason
        value = self._transport.request("graphRun.cancel", payload)
        return GraphRunCancelResult(str(value["runId"]), bool(value["cancelled"]), value.get("status"), value.get("error"))

    def attach_graph_run(self, run_id: str, route: dict[str, str], after_event_id: str | None = None):
        payload = {"runId": run_id, "route": route}
        if after_event_id is not None: payload["afterEventId"] = after_event_id
        stream = getattr(self._transport, "stream", None)
        if stream is None: raise RuntimeError("This transport does not support streaming.")
        return stream("graphRun.attach", payload)

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        value = self._transport.request("agent.run", _run_payload(request))
        if not isinstance(value, dict):
            raise TypeError("agent.run response must be an object")
        return AgentRunResult(
            run_id=str(value["runId"]),
            status=str(value["status"]),
            output=value.get("output"),
            error=value.get("error"),
        )

    def list_runtime_channels(self) -> list[RuntimeChannelResource]:
        return [_runtime_channel(value) for value in self._transport.request("channel.list", {})["channels"]]

    def get_runtime_channel(self, channel_id: str) -> RuntimeChannelResource | None:
        value = self._transport.request("channel.get", {"channelId": channel_id}).get("channel")
        return _runtime_channel(value) if value is not None else None

    def create_runtime_channel(self, request: RuntimeChannelCreateRequest) -> RuntimeChannelResource:
        return _runtime_channel(self._transport.request("channel.create", _channel_create_payload(request))["channel"])

    def join_runtime_channel(self, request: RuntimeChannelJoinRequest) -> RuntimeChannelResource:
        return _runtime_channel(self._transport.request("channel.join", _membership_payload(request))["channel"])

    def leave_runtime_channel(self, request: RuntimeChannelLeaveRequest) -> RuntimeChannelResource:
        return _runtime_channel(self._transport.request("channel.leave", _membership_payload(request))["channel"])

    def list_runtime_channel_wires(self) -> list[RuntimeChannelWireResource]:
        return [_runtime_channel_wire(value) for value in self._transport.request("channel.wire.list", {})["wires"]]

    def get_runtime_channel_wire(self, wire_id: str) -> RuntimeChannelWireResource | None:
        value = self._transport.request("channel.wire.get", {"wireId": wire_id}).get("wire")
        return _runtime_channel_wire(value) if value is not None else None

    def wire_runtime_channel(self, request: RuntimeChannelWireRequest) -> RuntimeChannelWireResource:
        return _runtime_channel_wire(self._transport.request("channel.wire", _wire_payload(request))["wire"])

    def unwire_runtime_channel(self, request: RuntimeChannelUnwireRequest) -> RuntimeChannelWireResource:
        return _runtime_channel_wire(self._transport.request("channel.unwire", _wire_payload(request))["wire"])

    def publish_runtime_channel_message(self, request: RuntimeChannelPublishRequest) -> RuntimeChannelPublishResult:
        value = self._transport.request("channel.publish", _channel_publish_payload(request))
        return RuntimeChannelPublishResult(value["messageId"], value["revision"], value["channelId"], value["status"])

    def claim_runtime_channel_message(self, request: RuntimeChannelClaimRequest) -> RuntimeChannelDelivery:
        return _runtime_channel_delivery(self._transport.request("channel.claim", _delivery_payload(request)))

    def acknowledge_runtime_channel_message(self, request: RuntimeChannelAcknowledgeRequest) -> RuntimeChannelDelivery:
        return _runtime_channel_delivery(self._transport.request("channel.ack", _delivery_payload(request)))

    def list_agent_instances(self) -> list[AgentInstanceResource]:
        return [_agent_instance(item) for item in self._transport.request("agentInstance.list", {})["instances"]]

    def get_agent_instance(self, instance_id: str) -> AgentInstanceResource | None:
        value = self._transport.request("agentInstance.get", {"instanceId": instance_id}).get("instance")
        return None if value is None else _agent_instance(value)

    def create_team(self, request: AgentTeamCreateRequest) -> JsonValue:
        return self._transport.request("team.create", _team_payload(request))

    def add_team_member(self, request: AgentTeamAddMemberRequest) -> JsonValue:
        return self._transport.request("team.member.add", _team_payload(request))

    def remove_team(self, request: AgentTeamRemoveRequest) -> JsonValue:
        return self._transport.request("team.remove", _team_payload(request))

    def remove_team_member(self, request: AgentTeamRemoveMemberRequest) -> JsonValue:
        return self._transport.request("team.member.remove", _team_payload(request))

    def replace_team(self, request: AgentTeamReplaceRequest) -> JsonValue:
        return self._transport.request("team.replace", _team_replace_payload(request))

    def start_team(self, request: AgentTeamStartRequest) -> JsonValue:
        return self._transport.request("team.start", _team_lifecycle_payload(request))

    def pause_team(self, request: AgentTeamLifecycleRequest) -> JsonValue:
        return self._transport.request("team.pause", _team_lifecycle_payload(request))

    def resume_team(self, request: AgentTeamLifecycleRequest) -> JsonValue:
        return self._transport.request("team.resume", _team_lifecycle_payload(request))

    def stop_team(self, request: AgentTeamLifecycleRequest) -> JsonValue:
        return self._transport.request("team.stop", _team_lifecycle_payload(request))

    def create_root_agent_instance(self, request: AgentInstanceCreateRootRequest) -> AgentInstanceResource:
        value = self._transport.request("agentInstance.createRoot", _agent_instance_create_payload(request))
        return _agent_instance(value["instance"])

    def create_child_agent_instance(self, request: AgentInstanceCreateChildRequest) -> AgentInstanceResource:
        value = self._transport.request("agentInstance.createChild", _agent_instance_create_payload(request))
        return _agent_instance(value["instance"])

    def pause_agent_instance(self, request: AgentInstancePauseResumeRequest) -> AgentInstanceResource:
        return _agent_instance(self._transport.request("agentInstance.pause", _pause_resume_payload(request))["instance"])

    def resume_agent_instance(self, request: AgentInstancePauseResumeRequest) -> AgentInstanceResource:
        return _agent_instance(self._transport.request("agentInstance.resume", _pause_resume_payload(request))["instance"])

    def create_agent_config_version(self, request: AgentConfigCreateRequest) -> AgentConfigVersionResult:
        return _config_result(self._transport.request("agentInstance.config.create", _config_create_payload(request)))

    def stage_agent_config(self, request: AgentConfigStageRequest) -> AgentInstanceResource:
        return _agent_instance(self._transport.request("agentInstance.config.stage", _config_payload(request))["instance"])

    def activate_agent_config(self, request: AgentConfigActivateRequest) -> AgentInstanceResource:
        return _agent_instance(self._transport.request("agentInstance.config.activate", _config_payload(request))["instance"])

    def rollback_agent_config(self, request: AgentConfigRollbackRequest) -> AgentInstanceResource:
        return _agent_instance(self._transport.request("agentInstance.config.rollback", _config_payload(request))["instance"])

    def start_agent_instance(self, request: AgentInstanceStartRequest) -> AgentInstanceResource:
        return _agent_instance(self._transport.request("agentInstance.start", _instance_mutation_payload(request))["instance"])

    def stop_agent_instance(self, request: AgentInstanceStopRequest) -> AgentInstanceResource:
        return _agent_instance(self._transport.request("agentInstance.stop", _instance_mutation_payload(request))["instance"])

    def replace_agent_instance(self, request: AgentInstanceReplaceRequest) -> AgentInstanceResource:
        value = self._transport.request("agentInstance.replace", {"instanceId": request.instance_id,
            "expectedRevision": request.expected_revision, "definitionId": request.definition_id, "name": request.name,
            "configVersion": request.config_version, "replacedAt": request.replaced_at, "idempotencyKey": request.idempotency_key,
            **({"grantId": request.grant_id} if request.grant_id is not None else {}),
            **({"expectedGrantUseCount": request.expected_grant_use_count} if request.expected_grant_use_count is not None else {})})
        return _agent_instance(value)

    def remove_agent_instance(self, request: AgentInstanceRemoveRequest) -> AgentInstanceResource:
        return _agent_instance(self._transport.request("agentInstance.remove", _instance_mutation_payload(request))["instance"])

    def list_drives(self) -> list[DriveResource]:
        value = self._transport.request("drive.list", {})
        return [_drive_resource(item) for item in value["drives"]]

    def get_drive(self, drive_id: str) -> DriveResource | None:
        value = self._transport.request("drive.get", {"driveId": drive_id})
        return None if value.get("drive") is None else _drive_resource(value["drive"])

    def create_drive(self, request: DriveCreateRequest) -> DriveResource:
        return _drive_resource(self._transport.request("drive.create", _drive_create_payload(request))["drive"])

    def transition_drive(self, request: DriveTransitionRequest) -> DriveResource:
        return _drive_resource(self._transport.request("drive.transition", _drive_transition_payload(request))["drive"])

    def retry_drive_delivery(self, request: DriveRetryDeliveryRequest) -> DriveResource:
        return _drive_resource(
            self._transport.request("drive.retryDelivery", _drive_retry_delivery_payload(request))["drive"]
        )

    def transfer_drive(self, request: DriveTransferRequest) -> DriveResource:
        return _drive_resource(self._transport.request("drive.transfer", _drive_transfer_payload(request))["drive"])

    def set_drive_links(self, request: DriveSetLinksRequest) -> DriveResource:
        return _drive_resource(self._transport.request("drive.setLinks", _drive_set_links_payload(request))["drive"])

    def report_drive_progress(self, request: DriveProgressRequest) -> DriveResource:
        return _drive_resource(self._transport.request("drive.reportProgress", _drive_progress_payload(request))["drive"])

    def list_triggers(self) -> tuple[TriggerResource, ...]:
        value = self._transport.request("trigger.list", {})
        if not isinstance(value, dict) or not isinstance(value.get("triggers"), list):
            raise TypeError("trigger.list response must contain triggers")
        return tuple(_trigger_resource(item) for item in value["triggers"])

    def get_trigger(self, trigger_id: str) -> TriggerResource | None:
        value = self._transport.request("trigger.get", {"triggerId": trigger_id})
        if not isinstance(value, dict):
            raise TypeError("trigger.get response must be an object")
        return None if value.get("trigger") is None else _trigger_resource(value["trigger"])

    def create_trigger(self, request: TriggerCreateRequest) -> TriggerResource:
        return self._trigger_mutation("trigger.create", _create_payload(request))

    def update_trigger(self, request: TriggerUpdateRequest) -> TriggerResource:
        return self._trigger_mutation("trigger.update", _update_payload(request))

    def enable_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return self._trigger_mutation("trigger.enable", _control_payload(request))

    def disable_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return self._trigger_mutation("trigger.disable", _control_payload(request))

    def pause_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return self._trigger_mutation("trigger.pause", _control_payload(request))

    def resume_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return self._trigger_mutation("trigger.resume", _control_payload(request))

    def retry_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return self._trigger_mutation("trigger.retry", _control_payload(request))

    def emit_trigger_event(self, request: TriggerEmitRequest) -> int:
        value = self._transport.request("trigger.emit", _emit_payload(request))
        if not isinstance(value, dict) or not isinstance(value.get("enqueued"), int):
            raise TypeError("trigger.emit response must contain enqueued")
        return value["enqueued"]

    def manual_fire_trigger(self, request: TriggerManualFireRequest) -> TriggerResource:
        value = self._transport.request("trigger.manualFire", _manual_payload(request))
        if not isinstance(value, dict):
            raise TypeError("trigger.manualFire response must be an object")
        return _trigger_resource(value["occurrence"])

    def _trigger_mutation(self, method: str, payload: dict) -> TriggerResource:
        value = self._transport.request(method, payload)
        if not isinstance(value, dict):
            raise TypeError(f"{method} response must be an object")
        return _trigger_resource(value["trigger"])

    def cancel(self, run_id: str) -> None:
        self._transport.request("agent.cancel", {"runId": run_id})


class AsyncMagicAgentClient:
    def __init__(self, transport: AsyncAgentTransport):
        self._transport = transport

    async def save_graph_v2(self, request: GraphV2SaveRequest):
        payload = {
            "graph": dict(request.graph),
            "route": {"channel": request.route.channel, "scopeType": request.route.scope_type, "scopeId": request.route.scope_id},
        }
        if request.replace is not None:
            payload["replace"] = request.replace
        return await self._transport.request("graph.v2.save", payload)

    async def get_graph_v2(self, request: GraphV2GetRequest):
        return await self._transport.request("graph.v2.get", {
            "graphId": request.graph_id,
            "route": {"channel": request.route.channel, "scopeType": request.route.scope_type, "scopeId": request.route.scope_id},
        })

    async def publish_graph_v2(self, request: GraphV2GetRequest):
        return await self._transport.request("graph.v2.publish", {
            "graphId": request.graph_id,
            "route": _session_route_payload(request.route),
        })

    async def get_published_graph_v2(self, request: GraphV2PublishedGetRequest):
        return await self._transport.request("graph.v2.published.get", {
            "graphId": request.graph_id,
            "route": _session_route_payload(request.route),
            "version": request.version,
        })

    async def list_published_graphs_v2(self, request: GraphV2GetRequest):
        return await self._transport.request("graph.v2.published.list", {
            "graphId": request.graph_id,
            "route": _session_route_payload(request.route),
        })

    async def list_graph_v2_node_registry(self) -> GraphV2NodeRegistryResult:
        return _graph_v2_node_registry_result(
            await self._transport.request("graph.v2.nodeRegistry.list", {})
        )

    async def _memory_request(self, method, request):
        call = self._transport.request
        return await call(method, _memory_payload(request)) if inspect.iscoroutinefunction(call) else await asyncio.to_thread(call, method, _memory_payload(request))

    async def search_semantic_memory(self, request: SemanticMemorySearchRequest): return await self._memory_request("memory.search", request)
    async def inspect_semantic_memory(self, request: SemanticMemoryInspectRequest): return await self._memory_request("memory.inspect", request)
    async def delete_semantic_memory(self, request: SemanticMemoryInspectRequest): return await self._memory_request("memory.delete", request)
    async def set_semantic_memory_disabled(self, request: SemanticMemorySetDisabledRequest): return await self._memory_request("memory.setDisabled", request)
    async def set_semantic_memory_visibility(self, request: SemanticMemorySetVisibilityRequest): return await self._memory_request("memory.setVisibility", request)
    async def clear_semantic_memory_scope(self, request: SemanticMemoryClearScopeRequest): return await self._memory_request("memory.clearScope", request)
    async def rebuild_semantic_memory(self, request: SemanticMemoryRebuildRequest): return await self._memory_request("memory.rebuild", request)
    async def ingest_session_memory(self, request: SemanticMemoryIngestSessionRequest): return await self._memory_request("memory.ingestSession", request)
    async def ingest_semantic_memory_scope(self, request: SemanticMemoryIngestScopeRequest): return await self._memory_request("memory.ingestScope", request)
    async def link_semantic_memory_agent_session(self, request: SemanticMemoryAgentSessionRequest): return await self._memory_request("memory.linkAgentSession", request)
    async def unlink_semantic_memory_agent_session(self, request: SemanticMemoryAgentSessionRequest): return await self._memory_request("memory.unlinkAgentSession", request)
    async def list_semantic_memory_agent_sessions(self, agent_id: str): return await self._transport.request("memory.listAgentSessions", {"agentId": agent_id})

    async def export_session(self, request: SessionExportRequest) -> SessionExportResult:
        value = await self._transport.request("session.export", _session_export_payload(request)) if inspect.iscoroutinefunction(self._transport.request) else await asyncio.to_thread(self._transport.request, "session.export", _session_export_payload(request))
        return _session_export_result(value)

    async def diff_sessions(self, request: SessionDiffRequest) -> SessionDiffResult:
        value = await self._transport.request("session.diff", _session_diff_payload(request)) if inspect.iscoroutinefunction(self._transport.request) else await asyncio.to_thread(self._transport.request, "session.diff", _session_diff_payload(request))
        return _session_diff_result(value)

    async def fork_session_at_event(self, request: SessionForkRequest) -> SessionForkResult:
        if inspect.iscoroutinefunction(self._transport.request):
            value = await self._transport.request("session.fork", _session_fork_payload(request))
        else:
            value = await asyncio.to_thread(
                self._transport.request, "session.fork", _session_fork_payload(request)
            )
        return _session_fork_result(value)

    async def run_graph(self, request: GraphRunRequest):
        call = self._transport.request
        payload = _graph_run_payload(request)
        if inspect.iscoroutinefunction(call):
            return await call("graph.run", payload)
        return await asyncio.to_thread(call, "graph.run", payload)

    async def attach_graph_run(
        self,
        run_id: str,
        route: dict[str, str],
        after_event_id: str | None = None,
    ) -> AsyncIterator[JsonValue]:
        payload: dict[str, JsonValue] = {"runId": run_id, "route": route}
        if after_event_id is not None:
            payload["afterEventId"] = after_event_id
        stream = getattr(self._transport, "stream", None)
        if stream is None:
            raise RuntimeError("This transport does not support streaming.")

        iterator = await asyncio.to_thread(stream, "graphRun.attach", payload)
        try:
            while True:
                has_value, value = await asyncio.to_thread(_next_stream_value, iterator)
                if not has_value:
                    return
                yield value
        finally:
            close = getattr(iterator, "close", None)
            if close is not None:
                result = close()
                if inspect.isawaitable(result):
                    await result

    async def list_runtime_channels(self) -> list[RuntimeChannelResource]:
        return [_runtime_channel(value) for value in (await self._transport.request("channel.list", {}))["channels"]]

    async def get_runtime_channel(self, channel_id: str) -> RuntimeChannelResource | None:
        value = (await self._transport.request("channel.get", {"channelId": channel_id})).get("channel")
        return _runtime_channel(value) if value is not None else None

    async def create_runtime_channel(self, request: RuntimeChannelCreateRequest) -> RuntimeChannelResource:
        return _runtime_channel((await self._transport.request("channel.create", _channel_create_payload(request)))["channel"])

    async def join_runtime_channel(self, request: RuntimeChannelJoinRequest) -> RuntimeChannelResource:
        return _runtime_channel((await self._transport.request("channel.join", _membership_payload(request)))["channel"])

    async def leave_runtime_channel(self, request: RuntimeChannelLeaveRequest) -> RuntimeChannelResource:
        return _runtime_channel((await self._transport.request("channel.leave", _membership_payload(request)))["channel"])

    async def list_runtime_channel_wires(self) -> list[RuntimeChannelWireResource]:
        return [_runtime_channel_wire(value) for value in (await self._transport.request("channel.wire.list", {}))["wires"]]

    async def get_runtime_channel_wire(self, wire_id: str) -> RuntimeChannelWireResource | None:
        value = (await self._transport.request("channel.wire.get", {"wireId": wire_id})).get("wire")
        return _runtime_channel_wire(value) if value is not None else None

    async def wire_runtime_channel(self, request: RuntimeChannelWireRequest) -> RuntimeChannelWireResource:
        return _runtime_channel_wire((await self._transport.request("channel.wire", _wire_payload(request)))["wire"])

    async def unwire_runtime_channel(self, request: RuntimeChannelUnwireRequest) -> RuntimeChannelWireResource:
        return _runtime_channel_wire((await self._transport.request("channel.unwire", _wire_payload(request)))["wire"])

    async def publish_runtime_channel_message(self, request: RuntimeChannelPublishRequest) -> RuntimeChannelPublishResult:
        value = await self._transport.request("channel.publish", _channel_publish_payload(request))
        return RuntimeChannelPublishResult(value["messageId"], value["revision"], value["channelId"], value["status"])

    async def claim_runtime_channel_message(self, request: RuntimeChannelClaimRequest) -> RuntimeChannelDelivery:
        return _runtime_channel_delivery(await self._transport.request("channel.claim", _delivery_payload(request)))

    async def acknowledge_runtime_channel_message(self, request: RuntimeChannelAcknowledgeRequest) -> RuntimeChannelDelivery:
        return _runtime_channel_delivery(await self._transport.request("channel.ack", _delivery_payload(request)))

    async def list_agent_instances(self) -> list[AgentInstanceResource]:
        return [_agent_instance(item) for item in (await self._transport.request("agentInstance.list", {}))["instances"]]

    async def get_agent_instance(self, instance_id: str) -> AgentInstanceResource | None:
        value = (await self._transport.request("agentInstance.get", {"instanceId": instance_id})).get("instance")
        return None if value is None else _agent_instance(value)

    async def create_team(self, request: AgentTeamCreateRequest) -> JsonValue:
        return await self._transport.request("team.create", _team_payload(request))

    async def add_team_member(self, request: AgentTeamAddMemberRequest) -> JsonValue:
        return await self._transport.request("team.member.add", _team_payload(request))

    async def remove_team(self, request: AgentTeamRemoveRequest) -> JsonValue:
        return await self._transport.request("team.remove", _team_payload(request))

    async def remove_team_member(self, request: AgentTeamRemoveMemberRequest) -> JsonValue:
        return await self._transport.request("team.member.remove", _team_payload(request))

    async def replace_team(self, request: AgentTeamReplaceRequest) -> JsonValue:
        return await self._transport.request("team.replace", _team_replace_payload(request))

    async def start_team(self, request: AgentTeamStartRequest) -> JsonValue:
        return await self._transport.request("team.start", _team_lifecycle_payload(request))

    async def pause_team(self, request: AgentTeamLifecycleRequest) -> JsonValue:
        return await self._transport.request("team.pause", _team_lifecycle_payload(request))

    async def resume_team(self, request: AgentTeamLifecycleRequest) -> JsonValue:
        return await self._transport.request("team.resume", _team_lifecycle_payload(request))

    async def stop_team(self, request: AgentTeamLifecycleRequest) -> JsonValue:
        return await self._transport.request("team.stop", _team_lifecycle_payload(request))

    async def create_root_agent_instance(self, request: AgentInstanceCreateRootRequest) -> AgentInstanceResource:
        value = await self._transport.request("agentInstance.createRoot", _agent_instance_create_payload(request))
        return _agent_instance(value["instance"])

    async def create_child_agent_instance(self, request: AgentInstanceCreateChildRequest) -> AgentInstanceResource:
        value = await self._transport.request("agentInstance.createChild", _agent_instance_create_payload(request))
        return _agent_instance(value["instance"])

    async def pause_agent_instance(self, request: AgentInstancePauseResumeRequest) -> AgentInstanceResource:
        return _agent_instance((await self._transport.request("agentInstance.pause", _pause_resume_payload(request)))["instance"])

    async def resume_agent_instance(self, request: AgentInstancePauseResumeRequest) -> AgentInstanceResource:
        return _agent_instance((await self._transport.request("agentInstance.resume", _pause_resume_payload(request)))["instance"])

    async def create_agent_config_version(self, request: AgentConfigCreateRequest) -> AgentConfigVersionResult:
        return _config_result(await self._transport.request("agentInstance.config.create", _config_create_payload(request)))

    async def stage_agent_config(self, request: AgentConfigStageRequest) -> AgentInstanceResource:
        return _agent_instance((await self._transport.request("agentInstance.config.stage", _config_payload(request)))["instance"])

    async def activate_agent_config(self, request: AgentConfigActivateRequest) -> AgentInstanceResource:
        return _agent_instance((await self._transport.request("agentInstance.config.activate", _config_payload(request)))["instance"])

    async def rollback_agent_config(self, request: AgentConfigRollbackRequest) -> AgentInstanceResource:
        return _agent_instance((await self._transport.request("agentInstance.config.rollback", _config_payload(request)))["instance"])

    async def start_agent_instance(self, request: AgentInstanceStartRequest) -> AgentInstanceResource:
        return _agent_instance((await self._transport.request("agentInstance.start", _instance_mutation_payload(request)))["instance"])

    async def stop_agent_instance(self, request: AgentInstanceStopRequest) -> AgentInstanceResource:
        return _agent_instance((await self._transport.request("agentInstance.stop", _instance_mutation_payload(request)))["instance"])

    async def replace_agent_instance(self, request: AgentInstanceReplaceRequest) -> AgentInstanceResource:
        value = await self._transport.request("agentInstance.replace", {"instanceId": request.instance_id,
            "expectedRevision": request.expected_revision, "definitionId": request.definition_id, "name": request.name,
            "configVersion": request.config_version, "replacedAt": request.replaced_at, "idempotencyKey": request.idempotency_key,
            **({"grantId": request.grant_id} if request.grant_id is not None else {}),
            **({"expectedGrantUseCount": request.expected_grant_use_count} if request.expected_grant_use_count is not None else {})})
        return _agent_instance(value)

    async def remove_agent_instance(self, request: AgentInstanceRemoveRequest) -> AgentInstanceResource:
        return _agent_instance((await self._transport.request("agentInstance.remove", _instance_mutation_payload(request)))["instance"])

    async def list_drives(self) -> list[DriveResource]:
        value = await self._transport.request("drive.list", {})
        return [_drive_resource(item) for item in value["drives"]]

    async def get_drive(self, drive_id: str) -> DriveResource | None:
        value = await self._transport.request("drive.get", {"driveId": drive_id})
        return None if value.get("drive") is None else _drive_resource(value["drive"])

    async def create_drive(self, request: DriveCreateRequest) -> DriveResource:
        return _drive_resource((await self._transport.request("drive.create", _drive_create_payload(request)))["drive"])

    async def transition_drive(self, request: DriveTransitionRequest) -> DriveResource:
        return _drive_resource((await self._transport.request("drive.transition", _drive_transition_payload(request)))["drive"])

    async def retry_drive_delivery(self, request: DriveRetryDeliveryRequest) -> DriveResource:
        return _drive_resource(
            (await self._transport.request("drive.retryDelivery", _drive_retry_delivery_payload(request)))["drive"]
        )

    async def transfer_drive(self, request: DriveTransferRequest) -> DriveResource:
        return _drive_resource((await self._transport.request("drive.transfer", _drive_transfer_payload(request)))["drive"])

    async def set_drive_links(self, request: DriveSetLinksRequest) -> DriveResource:
        return _drive_resource((await self._transport.request("drive.setLinks", _drive_set_links_payload(request)))["drive"])

    async def report_drive_progress(self, request: DriveProgressRequest) -> DriveResource:
        return _drive_resource((await self._transport.request("drive.reportProgress", _drive_progress_payload(request)))["drive"])

    async def list_triggers(self) -> tuple[TriggerResource, ...]:
        value = await self._transport.request("trigger.list", {})
        if not isinstance(value, dict) or not isinstance(value.get("triggers"), list):
            raise TypeError("trigger.list response must contain triggers")
        return tuple(_trigger_resource(item) for item in value["triggers"])

    async def get_trigger(self, trigger_id: str) -> TriggerResource | None:
        value = await self._transport.request("trigger.get", {"triggerId": trigger_id})
        if not isinstance(value, dict):
            raise TypeError("trigger.get response must be an object")
        return None if value.get("trigger") is None else _trigger_resource(value["trigger"])

    async def create_trigger(self, request: TriggerCreateRequest) -> TriggerResource:
        return await self._trigger_mutation("trigger.create", _create_payload(request))

    async def update_trigger(self, request: TriggerUpdateRequest) -> TriggerResource:
        return await self._trigger_mutation("trigger.update", _update_payload(request))

    async def enable_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return await self._trigger_mutation("trigger.enable", _control_payload(request))

    async def disable_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return await self._trigger_mutation("trigger.disable", _control_payload(request))

    async def pause_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return await self._trigger_mutation("trigger.pause", _control_payload(request))

    async def resume_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return await self._trigger_mutation("trigger.resume", _control_payload(request))

    async def retry_trigger(self, request: TriggerControlRequest) -> TriggerResource:
        return await self._trigger_mutation("trigger.retry", _control_payload(request))

    async def emit_trigger_event(self, request: TriggerEmitRequest) -> int:
        value = await self._transport.request("trigger.emit", _emit_payload(request))
        if not isinstance(value, dict) or not isinstance(value.get("enqueued"), int):
            raise TypeError("trigger.emit response must contain enqueued")
        return value["enqueued"]

    async def manual_fire_trigger(self, request: TriggerManualFireRequest) -> TriggerResource:
        value = await self._transport.request("trigger.manualFire", _manual_payload(request))
        if not isinstance(value, dict):
            raise TypeError("trigger.manualFire response must be an object")
        return _trigger_resource(value["occurrence"])

    async def _trigger_mutation(self, method: str, payload: dict) -> TriggerResource:
        value = await self._transport.request(method, payload)
        if not isinstance(value, dict):
            raise TypeError(f"{method} response must be an object")
        return _trigger_resource(value["trigger"])

    async def inject_pending_input(self, request: GraphRunInjectPendingInputRequest) -> GraphRunPendingInputMutationResult:
        return _pending_input_result(await self._transport.request("graphRun.input.inject", _pending_input_payload(request)))

    async def edit_pending_input(self, request: GraphRunEditPendingInputRequest) -> GraphRunPendingInputMutationResult:
        return _pending_input_result(await self._transport.request("graphRun.input.edit", _pending_input_payload(request)))

    async def cancel_pending_input(self, request: GraphRunPendingInputMutationRequest) -> GraphRunPendingInputMutationResult:
        return _pending_input_result(await self._transport.request("graphRun.input.cancel", _pending_input_payload(request)))

    async def pause_graph_run(self, request: GraphRunControlRequest) -> GraphRunPauseResult:
        value = await self._transport.request("graphRun.pause", {"runId": request.run_id, "route": request.route})
        return GraphRunPauseResult(str(value["runId"]), bool(value["paused"]), value.get("status"), value.get("error"))

    async def resume_graph_run(self, request: GraphRunControlRequest) -> GraphRunResumeResult:
        value = await self._transport.request("graphRun.resume", {"runId": request.run_id, "route": request.route})
        return GraphRunResumeResult(str(value["runId"]), bool(value["resumed"]), value.get("status"), value.get("error"))

    async def cancel_graph_run(self, request: GraphRunCancelRequest) -> GraphRunCancelResult:
        payload = {"runId": request.run_id, "route": request.route}
        if request.reason is not None: payload["reason"] = request.reason
        value = await self._transport.request("graphRun.cancel", payload)
        return GraphRunCancelResult(str(value["runId"]), bool(value["cancelled"]), value.get("status"), value.get("error"))

    async def run(self, request: AgentRunRequest) -> AgentRunResult:
        value = await self._transport.request("agent.run", _run_payload(request))
        if not isinstance(value, dict):
            raise TypeError("agent.run response must be an object")
        return AgentRunResult(
            run_id=str(value["runId"]),
            status=str(value["status"]),
            output=value.get("output"),
            error=value.get("error"),
        )
