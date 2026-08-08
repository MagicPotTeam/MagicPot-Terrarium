import asyncio
import json
import threading
import time
import unittest
from unittest.mock import patch

from magicpot_agent_sdk import (
    SessionRoute,
    SessionForkRequest,
    SessionForkResult,
    SessionForkLineage,
    SessionForkCounts,
    GraphRunControlRequest,
    GraphRunRequest,
    GraphNodeExecution,
    GraphRunCancelRequest,
    AgentTeamCreateRequest,
    AgentTeamAddMemberRequest,
    AgentTeamRemoveRequest,
    AgentTeamRemoveMemberRequest,
    AgentTeamMemberReplacement,
    AgentTeamReplaceRequest,
    AgentTeamLifecycleRequest,
    AgentTeamStartRequest,
    AgentConfigCreateRequest,
    AgentConfigActivateRequest,
    AgentConfigRollbackRequest,
    AgentConfigStageRequest,
    AgentInstanceCreateChildRequest,
    AgentInstanceCreateRootRequest,
    AgentInstancePauseResumeRequest,
    AgentInstanceReplaceRequest,
    AgentInstanceRemoveRequest,
    AgentInstanceStartRequest,
    AgentRunRequest,
    RuntimeChannelAcknowledgeRequest,
    RuntimeChannelClaimRequest,
    RuntimeChannelPublishRequest,
    RuntimeChannelCreateRequest,
    RuntimeChannelJoinRequest,
    RuntimeChannelLeaveRequest,
    RuntimeChannelUnwireRequest,
    RuntimeChannelWireRequest,
    HttpAgentTransport,
    MagicAgentClient,
    AsyncMagicAgentClient,
    MemoryAgentTransport,
    DriveRetryDeliveryRequest,
    DriveSetLinksRequest,
    DriveTransferRequest,
    DriveCreateRequest,
    DriveProgressRequest,
    DriveTransitionRequest,
    TriggerControlRequest,
    TriggerEmitRequest,
    TriggerManualFireRequest,
    PolicyDecision,
    PolicyEffect,
    PolicyRequest,
    PolicyRule,
    ToolDefinition,
    NodeDefinition,
    assert_policy_allowed,
    define_node,
    define_tool,
    evaluate_policy,
    parse_magic_agent_command,
)


class SdkTest(unittest.TestCase):
    def test_graph_node_execution_serializes_exactly(self):
        transport = MemoryAgentTransport(
            lambda method, payload: {"runId": "node-run", "graphId": "graph-1", "status": "completed"}
        )
        client = MagicAgentClient(transport)
        route = {"channel": "sdk", "scopeType": "dm", "scopeId": "graph"}
        client.run_graph(
            GraphRunRequest(
                "graph-1",
                "explicit",
                route,
                node_execution=GraphNodeExecution(
                    "single-node", "writer", inputs={"input": "explicit"}
                ),
            )
        )
        client.run_graph(
            GraphRunRequest(
                "graph-1",
                "continue",
                route,
                node_execution=GraphNodeExecution(
                    "run-from-node", "writer", prior_run_id="run-prior"
                ),
            )
        )
        self.assertEqual(
            transport.requests,
            [
                (
                    "graph.run",
                    {
                        "graphId": "graph-1",
                        "input": "explicit",
                        "route": route,
                        "nodeExecution": {
                            "mode": "single-node",
                            "nodeId": "writer",
                            "inputs": {"input": "explicit"},
                        },
                    },
                ),
                (
                    "graph.run",
                    {
                        "graphId": "graph-1",
                        "input": "continue",
                        "route": route,
                        "nodeExecution": {
                            "mode": "run-from-node",
                            "nodeId": "writer",
                            "priorRunId": "run-prior",
                        },
                    },
                ),
            ],
        )

    def test_graph_v2_node_registry_parity(self):
        descriptors = [
            {
                "kind": "condition",
                "category": "Control",
                "title": "Condition",
                "description": "Production condition.",
                "executable": True,
                "execution": {"mode": "legacy-runtime", "legacyKind": "condition"},
                "configSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {},
                },
                "defaultConfig": {"operator": "equals"},
                "defaultInputs": [
                    {
                        "portId": "value",
                        "name": "Value",
                        "direction": "input",
                        "role": "data",
                        "valueType": {"kind": "string"},
                        "required": True,
                        "multiple": False,
                    }
                ],
                "defaultOutputs": [],
            }
        ]
        transport = MemoryAgentTransport(lambda method, payload: {"descriptors": descriptors})

        result = MagicAgentClient(transport).list_graph_v2_node_registry()

        self.assertEqual(result.descriptors[0].kind, "condition")
        self.assertEqual(result.descriptors[0].execution.legacy_kind, "condition")
        self.assertEqual(result.descriptors[0].default_config, {"operator": "equals"})
        self.assertEqual(result.descriptors[0].default_inputs[0].port_id, "value")
        self.assertEqual(
            transport.requests, [("graph.v2.nodeRegistry.list", {})]
        )

        empty_transport = MemoryAgentTransport(
            lambda method, payload: {"descriptors": []}
        )
        self.assertEqual(
            MagicAgentClient(empty_transport).list_graph_v2_node_registry().descriptors,
            (),
        )

        class AsyncTransport:
            def __init__(self):
                self.requests = []

            async def request(self, method, payload):
                self.requests.append((method, payload))
                return {"descriptors": descriptors}

        async def run():
            async_transport = AsyncTransport()
            async_result = await AsyncMagicAgentClient(
                async_transport
            ).list_graph_v2_node_registry()
            self.assertEqual(async_result, result)
            self.assertEqual(async_transport.requests, transport.requests)

        asyncio.run(run())

    def test_typed_sync_and_async_session_fork(self):
        response = {
            "targetSessionKey": "generic:dm:target",
            "lineage": {"sourceSessionKey": "generic:dm:source", "sourceEventId": "event-2", "sourceRunId": "run-1", "forkedAt": 123},
            "warning": "External side effects are not rolled back.",
            "counts": {"messages": 2, "runs": 1, "events": 3, "artifacts": 1},
        }
        request = SessionForkRequest(SessionRoute("generic", "dm", "source"), "event-2", SessionRoute("generic", "dm", "target"), "fork-1")
        sync_transport = MemoryAgentTransport(lambda method, payload: response)
        sync_result: SessionForkResult = MagicAgentClient(sync_transport).fork_session_at_event(request)
        self.assertIsInstance(sync_result.lineage, SessionForkLineage)
        self.assertIsInstance(sync_result.counts, SessionForkCounts)
        self.assertEqual(sync_result.target_session_key, "generic:dm:target")
        self.assertEqual(sync_transport.requests, [("session.fork", {"sourceRoute": {"channel": "generic", "scopeType": "dm", "scopeId": "source"}, "sourceEventId": "event-2", "targetRoute": {"channel": "generic", "scopeType": "dm", "scopeId": "target"}, "idempotencyKey": "fork-1"})])
        self.assertNotIn("actor", json.dumps(sync_transport.requests))

        class AsyncTransport:
            def __init__(self):
                self.requests = []

            async def request(self, method, payload):
                self.requests.append((method, payload))
                return response

        async def run():
            transport = AsyncTransport()
            result: SessionForkResult = await AsyncMagicAgentClient(transport).fork_session_at_event(request)
            self.assertEqual(result.counts.events, 3)
            self.assertEqual(transport.requests, sync_transport.requests)

        asyncio.run(run())

    def test_independent_client(self):
        transport = MemoryAgentTransport(lambda method, payload: {"runId": method, "status": "completed", "output": payload})
        result = MagicAgentClient(transport).run(AgentRunRequest("example", {"prompt": "hello"}))
        self.assertEqual(result.run_id, "agent.run")
        self.assertEqual(len(transport.requests), 1)

    def test_runtime_channel_read_methods(self):
        resource = {"id": "channel", "revision": 1, "state": {"id": "channel", "name": "Channel", "mode": "queue", "capacity": 2, "members": []}, "createdAt": 1, "updatedAt": 2}
        transport = MemoryAgentTransport(lambda method, payload: {"channels": [resource]} if method == "channel.list" else {"channel": resource})
        client = MagicAgentClient(transport)
        self.assertEqual(client.list_runtime_channels()[0].id, "channel")
        self.assertEqual(client.get_runtime_channel("channel").state["mode"], "queue")
        self.assertEqual(transport.requests, [("channel.list", {}), ("channel.get", {"channelId": "channel"})])

    def test_runtime_channel_membership_methods(self):
        channel = {"id": "channel", "revision": 1, "state": {"id": "channel", "name": "Channel", "mode": "queue", "capacity": 2, "members": []}, "createdAt": 1, "updatedAt": 2}
        transport = MemoryAgentTransport(lambda method, payload: {"channel": channel})
        client = MagicAgentClient(transport)
        member = {"memberId": "member", "agentInstanceId": "agent", "role": "consumer", "joinedAt": 1}
        client.join_runtime_channel(RuntimeChannelJoinRequest("channel", 0, member, 1, "join"))
        client.leave_runtime_channel(RuntimeChannelLeaveRequest("channel", 1, "member", 2, "leave"))
        self.assertNotIn("actor", json.dumps(transport.requests))
        self.assertEqual([value[0] for value in transport.requests], ["channel.join", "channel.leave"])

    def test_runtime_channel_wire_read_methods(self):
        wire = {"id": "wire", "revision": 1, "state": {"id": "wire", "sourceChannelId": "source", "targetChannelId": "target",
            "targetPublisherMemberId": "publisher", "enabled": True, "createdAt": 1, "maxHops": 4}, "createdAt": 1, "updatedAt": 2}
        transport = MemoryAgentTransport(lambda method, payload: {"wires": [wire]} if method == "channel.wire.list" else {"wire": wire})
        client = MagicAgentClient(transport)
        self.assertEqual(client.list_runtime_channel_wires()[0].id, "wire")
        self.assertEqual(client.get_runtime_channel_wire("wire").state["maxHops"], 4)
        self.assertEqual(transport.requests, [("channel.wire.list", {}), ("channel.wire.get", {"wireId": "wire"})])

    def test_runtime_channel_wire_mutation_methods(self):
        wire = {"id": "wire", "revision": 0, "state": {"id": "wire", "sourceChannelId": "source", "targetChannelId": "target",
            "targetPublisherMemberId": "publisher", "enabled": True, "createdAt": 1, "maxHops": 4}, "createdAt": 1, "updatedAt": 1}
        transport = MemoryAgentTransport(lambda method, payload: {"wire": wire})
        client = MagicAgentClient(transport)
        client.wire_runtime_channel(RuntimeChannelWireRequest(wire["state"], "wire"))
        client.unwire_runtime_channel(RuntimeChannelUnwireRequest("wire", 0, 2, "unwire"))
        self.assertNotIn("actor", json.dumps(transport.requests))
        self.assertEqual([value[0] for value in transport.requests], ["channel.wire", "channel.unwire"])

    def test_runtime_channel_delivery_methods(self):
        transport = MemoryAgentTransport(lambda method, payload: {"messageId": "message", "revision": 1 if method == "channel.claim" else 2,
            "channelId": "channel", "consumerMemberId": "consumer", **({"claimToken": "token", "leaseExpiresAt": 100} if method == "channel.claim" else {"acknowledgedAt": 20})})
        client = MagicAgentClient(transport)
        claimed = client.claim_runtime_channel_message(RuntimeChannelClaimRequest("message", 0, "consumer", 10, 100, "claim"))
        acknowledged = client.acknowledge_runtime_channel_message(RuntimeChannelAcknowledgeRequest("message", claimed.revision, "consumer", 20, claimed.claim_token, "ack"))
        self.assertEqual(acknowledged.acknowledged_at, 20)
        self.assertNotIn("actor", json.dumps(transport.requests))

    def test_runtime_channel_publish(self):
        transport = MemoryAgentTransport(lambda method, payload: {
            "messageId": "message", "revision": 1, "channelId": "channel", "status": "published"})
        client = MagicAgentClient(transport)
        result = client.publish_runtime_channel_message(RuntimeChannelPublishRequest(
            {"id": "message", "channelId": "channel", "publisherMemberId": "producer",
             "payload": {"text": "hello"}, "priority": 1, "publishedAt": 2}, 1, "publish", "grant", 0))
        self.assertEqual(result.status, "published")
        serialized = json.dumps(transport.requests[0]); self.assertIn("grant", serialized); self.assertNotIn("actor", serialized)

    def test_runtime_channel_create(self):
        resource = {"id": "channel", "revision": 0, "state": {"mode": "queue"}, "createdAt": 1, "updatedAt": 1}
        transport = MemoryAgentTransport(lambda method, payload: {"channel": resource})
        client = MagicAgentClient(transport)
        client.create_runtime_channel(RuntimeChannelCreateRequest(
            {"id": "channel", "name": "Channel", "mode": "queue", "capacity": 5}, 1, "create", "grant", 0))
        self.assertEqual(transport.requests[0][0], "channel.create")
        serialized = json.dumps(transport.requests[0]); self.assertIn("grant", serialized); self.assertNotIn("actor", serialized)

    def test_graph_run_steering_methods(self):
        transport = MemoryAgentTransport(lambda method, payload: {"runId": "run", "paused": method == "graphRun.pause", "resumed": method == "graphRun.resume", "cancelled": method == "graphRun.cancel"})
        client = MagicAgentClient(transport)
        route = {"channel": "sdk", "scopeType": "run", "scopeId": "run"}
        client.pause_graph_run(GraphRunControlRequest("run", route))
        client.resume_graph_run(GraphRunControlRequest("run", route))
        client.cancel_graph_run(GraphRunCancelRequest("run", route, "stop"))
        self.assertEqual([item[0] for item in transport.requests], ["graphRun.pause", "graphRun.resume", "graphRun.cancel"])
        self.assertNotIn("actor", json.dumps(transport.requests))

    def test_agent_pause_resume_methods(self):
        resource = {"id": "instance", "revision": 2, "state": {"status": "paused"}, "createdAt": 1, "updatedAt": 2}
        transport = MemoryAgentTransport(lambda method, payload: {"instance": resource})
        client = MagicAgentClient(transport)
        client.pause_agent_instance(AgentInstancePauseResumeRequest("instance", 1, "pause"))
        client.resume_agent_instance(AgentInstancePauseResumeRequest("instance", 2, "resume"))
        self.assertEqual([request[0] for request in transport.requests], ["agentInstance.pause", "agentInstance.resume"])
        self.assertNotIn("actor", json.dumps(transport.requests))

    def test_create_remove_approval_metadata(self):
        resource = {"id": "root", "revision": 0, "state": {"status": "created"}, "createdAt": 1, "updatedAt": 1}
        transport = MemoryAgentTransport(lambda method, payload: {"instance": resource})
        client = MagicAgentClient(transport)
        client.create_root_agent_instance(AgentInstanceCreateRootRequest({"id": "root"}, 1, "root", "create-grant", 0))
        client.create_child_agent_instance(AgentInstanceCreateChildRequest("root", 0, {"id": "child"}, 2, "child", "child-grant", 1))
        client.remove_agent_instance(AgentInstanceRemoveRequest("root", 0, 3, "remove", "remove-grant", 2))
        serialized = json.dumps(transport.requests)
        self.assertIn("create-grant", serialized); self.assertIn("expectedGrantUseCount", serialized)
        self.assertNotIn("actor", serialized)

    def test_team_methods(self):
        transport = MemoryAgentTransport(lambda method, payload: {"id": "team", "revision": 0, "state": {"id": "team"}, "createdAt": 1, "updatedAt": 1})
        client = MagicAgentClient(transport)
        client.create_team(AgentTeamCreateRequest({"id": "team", "name": "Team", "createdAt": 1}, "create", "grant", 0))
        client.add_team_member(AgentTeamAddMemberRequest("team", 0, {"memberId": "m", "agentInstanceId": "agent", "role": "leader", "joinedAt": 2}, "add"))
        client.remove_team_member(AgentTeamRemoveMemberRequest("team", 1, "m", 3, "remove-member"))
        client.remove_team(AgentTeamRemoveRequest("team", 2, 4, "remove"))
        client.replace_team(AgentTeamReplaceRequest("team", 2,
            [AgentTeamMemberReplacement("member", "new", "New", "v2", 5)], "replace"))
        client.start_team(AgentTeamStartRequest("team", 2, "start", {"agentId": "agent", "text": "run"}))
        client.pause_team(AgentTeamLifecycleRequest("team", 2, "pause"))
        client.resume_team(AgentTeamLifecycleRequest("team", 2, "resume"))
        client.stop_team(AgentTeamLifecycleRequest("team", 2, "stop"))
        serialized = json.dumps(transport.requests)
        self.assertEqual([r[0] for r in transport.requests], ["team.create", "team.member.add", "team.member.remove", "team.remove", "team.replace", "team.start", "team.pause", "team.resume", "team.stop"])
        self.assertIn("grantId", serialized); self.assertNotIn("actor", serialized); self.assertNotIn("addedBy", serialized)

    def test_agent_replace_method(self):
        resource = {"id": "instance", "revision": 1, "state": {"definitionId": "new", "configVersion": "v2"}, "createdAt": 1, "updatedAt": 2}
        transport = MemoryAgentTransport(lambda method, payload: resource); client = MagicAgentClient(transport)
        client.replace_agent_instance(AgentInstanceReplaceRequest("instance", 0, "new", "New", "v2", 2, "replace", "grant", 0))
        serialized = json.dumps(transport.requests[0]); self.assertEqual(transport.requests[0][0], "agentInstance.replace")
        self.assertIn("grantId", serialized); self.assertNotIn("actor", serialized)

    def test_agent_config_version_methods(self):
        resource = {"id": "instance", "revision": 1, "state": {"configVersion": "v2"}, "createdAt": 1, "updatedAt": 2}
        transport = MemoryAgentTransport(lambda method, payload: {
            "version": "v2", "definitionId": "definition", "contentDigest": "a" * 64, "createdAt": 1
        } if method == "agentInstance.config.create" else {"instance": resource})
        client = MagicAgentClient(transport)
        client.create_agent_config_version(AgentConfigCreateRequest({
            "version": "v2", "definitionId": "definition", "model": {"profileId": "model"},
            "systemPrompt": "safe", "inference": {}, "tools": {"allowedToolNames": []},
            "memory": {"allowHistory": False, "contextMessageLimit": 1, "scope": "instance"},
            "policy": {"policyIds": [], "workspaceRoots": []}, "channels": {"channelIds": []},
            "budgets": {"maxRuntimeMs": 100}, "createdAt": 1
        }, "create", "grant", 0))
        client.stage_agent_config(AgentConfigStageRequest("instance", 0, "v2", 1, "stage"))
        client.activate_agent_config(AgentConfigActivateRequest("instance", 1, 2, "activate"))
        client.rollback_agent_config(AgentConfigRollbackRequest("instance", 2, 3, "rollback"))
        serialized = json.dumps(transport.requests)
        self.assertNotIn("actor", serialized); self.assertNotIn("createdBy", serialized); self.assertNotIn("contentDigest", serialized)
        self.assertIn("grant", serialized); self.assertIn("expectedGrantUseCount", serialized)

    def test_trigger_convenience_methods(self):
        def handler(method, payload):
            if method == "agentInstance.list":
                return {"instances": [{"id": "instance-1", "revision": 0, "state": {"status": "created"}, "createdAt": 1, "updatedAt": 1}]}
            if method.startswith("agentInstance."):
                return {"instance": {"id": "instance-1", "revision": 1, "state": {"status": "running"}, "createdAt": 1, "updatedAt": 2}}
            if method == "drive.list":
                return {"drives": []}
            if method == "drive.create":
                return {"drive": {"id": "drive-1", "revision": 0, "state": payload["drive"], "createdAt": 1, "updatedAt": 1}}
            if method in ("drive.transfer", "drive.setLinks", "drive.retryDelivery"):
                return {"drive": {"id": "drive-1", "revision": 1, "state": payload, "createdAt": 1, "updatedAt": 2}}
            if method == "trigger.list":
                return {"triggers": []}
            if method == "trigger.emit":
                return {"enqueued": 1}
            key = "occurrence" if method == "trigger.manualFire" else "trigger"
            return {
                key: {
                    "id": method,
                    "revision": 0,
                    "state": payload,
                    "createdAt": 1,
                    "updatedAt": 1,
                }
            }

        transport = MemoryAgentTransport(handler)
        client = MagicAgentClient(transport)
        self.assertEqual(client.list_agent_instances()[0].id, "instance-1")
        started = client.start_agent_instance(AgentInstanceStartRequest(
            "instance-1", 0,
            {"agentId": "agent-1", "input": {"prompt": "work"}}, "start", "grant-1", 0,
        ))
        self.assertEqual(started.revision, 1)
        self.assertEqual(transport.requests[-1], ("agentInstance.start", {
            "instanceId": "instance-1", "expectedRevision": 0,
            "request": {"agentId": "agent-1", "input": {"prompt": "work"}},
            "idempotencyKey": "start", "grantId": "grant-1", "expectedGrantUseCount": 0,
        }))
        self.assertEqual(client.list_drives(), [])
        self.assertEqual(
            client.create_drive(DriveCreateRequest({"id": "drive-1"}, 1, "create")).id,
            "drive-1",
        )
        self.assertEqual(
            client.transfer_drive(DriveTransferRequest("drive-1", 0, 2, "transfer", assignee_id="agent-2")).revision,
            1,
        )
        self.assertEqual(
            client.set_drive_links(DriveSetLinksRequest("drive-1", 1, [], 3, "links")).revision,
            1,
        )
        self.assertEqual(
            client.retry_drive_delivery(DriveRetryDeliveryRequest("drive-1", 2, 4, "retry")).revision,
            1,
        )
        self.assertEqual(transport.requests[-1], (
            "drive.retryDelivery",
            {"driveId": "drive-1", "expectedRevision": 2, "retryAt": 4, "idempotencyKey": "retry"},
        ))
        self.assertEqual(client.list_triggers(), ())
        client.enable_trigger(TriggerControlRequest("one", 0, "enable", 1))
        self.assertEqual(
            client.emit_trigger_event(TriggerEmitRequest("sdk", "event-1", "order.created", 1)),
            1,
        )
        occurrence = client.manual_fire_trigger(
            TriggerManualFireRequest("one", 0, "manual", 1, "occurrence")
        )
        self.assertEqual(occurrence.id, "trigger.manualFire")
        self.assertEqual(
            [request[0] for request in transport.requests],
            ["agentInstance.list", "agentInstance.start", "drive.list", "drive.create", "drive.transfer", "drive.setLinks", "drive.retryDelivery", "trigger.list", "trigger.enable", "trigger.emit", "trigger.manualFire"],
        )

    def test_http_transport_uses_production_sdk_boundary(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self):
                return json.dumps({"runId": "http-run", "status": "completed"}).encode()

        with patch("magicpot_agent_sdk.http_transport.urlopen", return_value=Response()) as mocked:
            result = MagicAgentClient(HttpAgentTransport("https://magicpot.invalid", "token")).run(
                AgentRunRequest("example", {})
            )
        self.assertEqual(result.run_id, "http-run")
        request = mocked.call_args.args[0]
        self.assertEqual(request.full_url, "https://magicpot.invalid/v2/sdk/agent.run")
        self.assertEqual(request.headers["Authorization"], "Bearer token")

    def test_http_stream_is_incremental_and_closable(self):
        class Response:
            def __init__(self):
                self.lines = iter([b'{"eventId":"one"}\n', b'{"eventId":"two"}\n'])
                self.closed = False

            def __iter__(self):
                return self

            def __next__(self):
                return next(self.lines)

            def close(self):
                self.closed = True

        response = Response()
        with patch("magicpot_agent_sdk.http_transport.urlopen", return_value=response):
            stream = HttpAgentTransport("https://magicpot.invalid").stream("graphRun.attach", {})
            self.assertEqual(next(stream)["eventId"], "one")
            self.assertFalse(response.closed)
            stream.close()
        self.assertTrue(response.closed)

    def test_async_attach_yields_incrementally_and_serializes_cursor(self):
        class Stream:
            def __init__(self):
                self.index = 0
                self.release_second = threading.Event()
                self.closed = False

            def __iter__(self): return self

            def __next__(self):
                self.index += 1
                if self.index == 1:
                    return {"eventId": "one"}
                if self.index == 2:
                    self.release_second.wait(1)
                    return {"eventId": "two"}
                raise StopIteration

            def close(self):
                self.closed = True
                self.release_second.set()

        class Transport:
            def __init__(self):
                self.iterator = Stream()
                self.call = None

            def stream(self, method, payload):
                self.call = (method, payload)
                return self.iterator

        async def run():
            transport = Transport()
            events = AsyncMagicAgentClient(transport).attach_graph_run(
                "run", {"channel": "sdk", "scopeType": "run", "scopeId": "run"}, "event-0"
            )
            self.assertEqual((await anext(events))["eventId"], "one")
            self.assertEqual(transport.iterator.index, 1)
            self.assertEqual(transport.call[1]["afterEventId"], "event-0")
            transport.iterator.release_second.set()
            self.assertEqual((await anext(events))["eventId"], "two")
            await events.aclose()
            self.assertTrue(transport.iterator.closed)

        asyncio.run(run())

    def test_async_attach_keeps_event_loop_progressing_and_propagates_errors(self):
        class Stream:
            def __init__(self):
                self.calls = 0
                self.closed = False

            def __iter__(self): return self

            def __next__(self):
                self.calls += 1
                if self.calls == 1:
                    time.sleep(0.08)
                    return {"eventId": "one"}
                raise ValueError("bad ndjson")

            def close(self): self.closed = True

        class Transport:
            def __init__(self): self.iterator = Stream()
            def stream(self, _method, _payload): return self.iterator

        async def run():
            transport = Transport()
            events = AsyncMagicAgentClient(transport).attach_graph_run("run", {})
            progress = 0

            async def ticker():
                nonlocal progress
                for _ in range(4):
                    await asyncio.sleep(0.01)
                    progress += 1

            first, _ = await asyncio.gather(anext(events), ticker())
            self.assertEqual(first["eventId"], "one")
            self.assertEqual(progress, 4)
            with self.assertRaisesRegex(ValueError, "bad ndjson"):
                await anext(events)
            self.assertTrue(transport.iterator.closed)

        asyncio.run(run())

    def test_async_attach_cancellation_closes_underlying_iterator(self):
        class Stream:
            def __init__(self):
                self.closed = threading.Event()

            def __iter__(self): return self

            def __next__(self):
                self.closed.wait(1)
                raise StopIteration

            def close(self): self.closed.set()

        class Transport:
            def __init__(self): self.iterator = Stream()
            def stream(self, _method, _payload): return self.iterator

        async def run():
            transport = Transport()
            events = AsyncMagicAgentClient(transport).attach_graph_run("run", {})
            task = asyncio.create_task(anext(events))
            await asyncio.sleep(0.02)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(transport.iterator.closed.wait(0.1))

        asyncio.run(run())

    def test_canonical_policy_and_protocol_contracts(self):
        request = PolicyRequest(
            "request-1",
            {"kind": "sdk", "id": "python-consumer"},
            {"kind": "sdk", "id": "external"},
            "terminal.execute",
            {"kind": "tool", "id": "terminal.run"},
            {},
            (PolicyEffect("process.execute", "high"),),
        )
        decision = evaluate_policy(
            request,
            [PolicyRule("deny-terminal", 10, "deny", "blocked", actions=("terminal.execute",))],
            evaluated_at=1,
            policy_version="test",
        )
        self.assertEqual(decision.effect, "deny")
        self.assertEqual(decision.matched_rule_ids, ("deny-terminal",))
        parsed = parse_magic_agent_command(
            {
                "id": "command-1",
                "type": "agent.run",
                "protocolVersion": "2.0.0",
                "createdAt": 1,
                "payload": {},
                "envelopeKind": "command",
                "actor": {"kind": "sdk", "id": "python-consumer"},
                "idempotencyKey": "command-1",
            }
        )
        self.assertTrue(parsed.ok)

    def test_tool_and_node_registration_contracts(self):
        tool = define_tool(ToolDefinition("example.tool", "Example", {"type": "object"}), lambda value, context: value)
        node = define_node(
            NodeDefinition("example.node", "1.0.0", {"type": "object"}, {"type": "object"}),
            lambda value, context: value,
        )
        self.assertEqual(tool.definition.name, "example.tool")
        self.assertEqual(node.definition.type, "example.node")

    def test_policy_fails_closed(self):
        with self.assertRaises(PermissionError):
            assert_policy_allowed(PolicyDecision("deny", "blocked"))


if __name__ == "__main__":
    unittest.main()
