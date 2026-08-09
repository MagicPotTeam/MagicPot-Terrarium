# magicpot-agent-sdk

Dependency-free Python SDK for MagicAgent Platform 2.0. Version 2.0.0 supports Python 3.10+ and uses only the standard library at runtime.

```sh
python -m pip install "magicpot-agent-sdk>=2.0,<3"
```

```python
import os
from magicpot_agent_sdk import AgentRunRequest, HttpAgentTransport, MagicAgentClient

client = MagicAgentClient(HttpAgentTransport(
    "http://127.0.0.1:3000",
    token=os.environ.get("MAGICPOT_AGENT_TOKEN"),
))
result = client.run(AgentRunRequest("example", {"prompt": "hello"}))
```

Attach streams are incremental and closable. The async client bridges the blocking
stdlib HTTP stream through worker threads, so it does not block the event loop:

```python
from magicpot_agent_sdk import AsyncMagicAgentClient, HttpAgentTransport

client = AsyncMagicAgentClient(HttpAgentTransport("http://127.0.0.1:3000", token))
events = client.attach_graph_run(run_id, route, after_event_id="event-10")
try:
    async for event in events:
        if event["kind"] in {"run.completed", "run.failed", "run.cancelled"}:
            break
finally:
    await events.aclose()
```

The public package exports clients, contracts, HTTP and memory transports, tool/node definitions, protocol parsers, policy helpers, and `__version__`. See [`../../docs/magic-agent-platform-2.md`](../../docs/magic-agent-platform-2.md) for the API and security guide.
