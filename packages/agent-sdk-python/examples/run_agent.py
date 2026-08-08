import os
import sys

from magicpot_agent_sdk import AgentRunRequest, HttpAgentTransport, MagicAgentClient

base_url = os.environ.get("MAGICPOT_SDK_URL")
token = os.environ.get("MAGICPOT_SDK_TOKEN")
if not base_url or not token:
    raise RuntimeError("Set MAGICPOT_SDK_URL and MAGICPOT_SDK_TOKEN.")

client = MagicAgentClient(HttpAgentTransport(base_url, token))
result = client.run(
    AgentRunRequest(
        os.environ.get("MAGICPOT_AGENT_ID", "default"),
        {"prompt": " ".join(sys.argv[1:]) or "Hello from the Python SDK"},
    )
)
print(result)
