import asyncio
import unittest

import magicpot_agent_sdk as sdk
from magicpot_agent_sdk.client import AsyncMagicAgentClient, MagicAgentClient


class SyncTransport:
    def __init__(self):
        self.calls = []

    def request(self, method, payload):
        self.calls.append((method, payload))
        return {"method": method}


class AsyncTransport:
    def __init__(self):
        self.calls = []

    async def request(self, method, payload):
        self.calls.append((method, payload))
        return {"method": method}


route = sdk.SessionRoute("generic", "dm", "owner")
scope = sdk.SemanticMemoryScope("session", route)
CASES = [
    ("search_semantic_memory", sdk.SemanticMemorySearchRequest("alpha", (scope,), "hybrid", "local", 3, ("private",), .2, .8, 12), "memory.search"),
    ("inspect_semantic_memory", sdk.SemanticMemoryInspectRequest("m1", route), "memory.inspect"),
    ("delete_semantic_memory", sdk.SemanticMemoryInspectRequest("m1", route), "memory.delete"),
    ("set_semantic_memory_disabled", sdk.SemanticMemorySetDisabledRequest("m1", route, True), "memory.setDisabled"),
    ("set_semantic_memory_visibility", sdk.SemanticMemorySetVisibilityRequest("m1", route, "workspace"), "memory.setVisibility"),
    ("clear_semantic_memory_scope", sdk.SemanticMemoryClearScopeRequest(scope), "memory.clearScope"),
    ("rebuild_semantic_memory", sdk.SemanticMemoryRebuildRequest(route, "local", "job", 2), "memory.rebuild"),
    ("ingest_session_memory", sdk.SemanticMemoryIngestSessionRequest(route, "local"), "memory.ingestSession"),
    ("ingest_semantic_memory_scope", sdk.SemanticMemoryIngestScopeRequest(sdk.SemanticMemoryScope("workspace", source_route=route, id="workspace-1"), "local"), "memory.ingestScope"),
    ("link_semantic_memory_agent_session", sdk.SemanticMemoryAgentSessionRequest("agent-1", route), "memory.linkAgentSession"),
    ("unlink_semantic_memory_agent_session", sdk.SemanticMemoryAgentSessionRequest("agent-1", route), "memory.unlinkAgentSession"),
]


class SemanticMemoryTest(unittest.TestCase):
    def test_sync_methods_serialize_without_actor(self):
        transport = SyncTransport()
        client = MagicAgentClient(transport)
        for name, request, method in CASES:
            self.assertEqual(getattr(client, name)(request), {"method": method})
        self.assertEqual([call[0] for call in transport.calls], [case[2] for case in CASES])
        self.assertTrue(all("actor" not in payload for _, payload in transport.calls))
        search = transport.calls[0][1]
        self.assertEqual(search, {"query": "alpha", "scopes": [{"kind": "session", "route": {"channel": "generic", "scopeType": "dm", "scopeId": "owner"}}], "mode": "hybrid", "providerId": "local", "limit": 3, "visibility": ["private"], "lexicalWeight": .2, "semanticWeight": .8, "now": 12})
        self.assertEqual(client.list_semantic_memory_agent_sessions("agent-1"), {"method": "memory.listAgentSessions"})
        self.assertEqual(transport.calls[-1], ("memory.listAgentSessions", {"agentId": "agent-1"}))

    def test_async_methods_and_exports(self):
        async def run():
            transport = AsyncTransport()
            client = AsyncMagicAgentClient(transport)
            for name, request, method in CASES:
                self.assertEqual(await getattr(client, name)(request), {"method": method})
            self.assertEqual([call[0] for call in transport.calls], [case[2] for case in CASES])
            await client.list_semantic_memory_agent_sessions("agent-1")
            self.assertEqual(transport.calls[-1], ("memory.listAgentSessions", {"agentId": "agent-1"}))
        asyncio.run(run())
        for name in ("SemanticMemoryScope", "SemanticMemorySearchRequest", "SemanticMemoryInspectRequest", "SemanticMemorySetDisabledRequest", "SemanticMemorySetVisibilityRequest", "SemanticMemoryClearScopeRequest", "SemanticMemoryRebuildRequest", "SemanticMemoryIngestSessionRequest", "SemanticMemoryIngestScopeRequest", "SemanticMemoryAgentSessionRequest"):
            self.assertIn(name, sdk.__all__)
            self.assertIsNotNone(getattr(sdk, name))
