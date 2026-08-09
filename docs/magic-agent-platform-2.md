# MagicAgent Platform 2.0

This is the authoritative GA guide for the Platform 2.0 runtime and the independent TypeScript and Python SDKs. Package version **2.0.0** targets runtime protocol **2.x**. The SDK HTTP boundary is `POST /v2/sdk/<method>`; normal calls return JSON and `graphRun.attach` returns newline-delimited JSON (NDJSON).

## Architecture and runtime model

```text
TypeScript/Python SDK or renderer
  -> authenticated SDK HTTP gateway / typed IPC
  -> main-process MagicAgent service adapter
  -> Platform 2 production runtime
       -> policy + approvals
       -> command services
       -> resource, event, snapshot, and approval stores
       -> graph/agent/team/channel/drive/trigger runtimes
       -> Tool Hosts
  -> bounded response or ordered public events
```

Production wiring lives in `packages/app/src/main/magicAgentPlatform2/productionRuntime.ts`. The SDK gateway and HTTP boundary are `packages/app/src/main/api/magicAgentSdkGateway.ts` and `packages/app/src/main/api/magicAgentSdkHttpServer.ts`. Public contracts are mirrored by `packages/agent-sdk-typescript/src/contracts.ts` and `packages/agent-sdk-python/src/magicpot_agent_sdk/contracts.py`.

### Command, resource, and event semantics

Commands carry intent. Mutating commands use idempotency keys and, where applicable, expected revisions; do not retry with a new key after an ambiguous response. A successful command updates a revisioned resource and appends events through `packages/app/src/main/magicAgentPlatform2/persistence/eventStore.ts`. Events are ordered evidence, not commands to replay blindly. Graph-run attachment accepts `afterEventId`, allowing a consumer to reconnect without intentionally rereading an entire stream. Close or abort streams when a terminal event (`run.completed`, `run.failed`, or `run.cancelled`) is observed.

Actors and route identity are derived at the trusted gateway. SDK request DTOs are intentionally actor-free. Callers must not add actor identity and must not treat a run id, resource id, or approval id as authorization.

## SDK API reference

The complete signatures are the generated TypeScript declarations and Python public imports. The stable high-level surfaces are:

| Area | TypeScript | Python | Gateway method families |
| --- | --- | --- | --- |
| Run | `MagicAgentClient.run`, `cancel` | `run`, `cancel` | `agent.run`, `agent.cancel` |
| Graph steering | `attachGraphRun`, pause/resume/cancel, pending-input methods | matching snake_case methods | `graphRun.*` |
| Sessions | export, diff, fork | matching snake_case methods | `session.*` |
| Memory | search, inspect, ingest, rebuild, visibility/admin | matching snake_case methods | `memory.*` |
| Agents/config | list/get/create/start/stop/pause/resume/replace/remove, config version lifecycle | matching snake_case methods | `agentInstance.*` |
| Teams | create/member/lifecycle operations | matching snake_case methods | `team.*` |
| Channels | channel membership, wires, publish/claim/acknowledge | matching snake_case methods | `channel.*` |
| Drives | create/transition/retry/transfer/link/progress | matching snake_case methods | `drive.*` |
| Triggers | create/update/control/emit/manual fire | matching snake_case methods | `trigger.*` |

TypeScript additionally exports command/event envelope parsers, policy request factories and evaluators, version constants, `defineTool`/`defineNode` contracts, `HttpAgentTransport`, and `MemoryAgentTransport`. Python exports sync and async clients, protocol parsers, policy helpers, tool/node definitions, both transports, and `__version__`.

Errors from non-2xx HTTP responses become `Error` in TypeScript and `RuntimeError` in Python. Treat response and event payloads as bounded public projections; internal actor, secret, filesystem, and approval-token data are not part of the SDK contract.

## Package usage

### TypeScript

```sh
npm add @magicpot/agent-sdk@^2.0.0
```

```ts
import { HttpAgentTransport, MagicAgentClient } from '@magicpot/agent-sdk'

const client = new MagicAgentClient(new HttpAgentTransport({
  baseUrl: 'http://127.0.0.1:3000',
  token: process.env.MAGICPOT_AGENT_TOKEN
}))

const result = await client.run({
  agentId: 'assistant',
  input: { prompt: 'Summarize the current workspace' }
})
```

The package is ESM. Node.js 18+ supplies the required web APIs. The package root is the public import path; consumers must not import `dist/*` internals.

### Python

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
result = client.run(AgentRunRequest(
    "assistant", {"prompt": "Summarize the current workspace"}
))
```

Python 3.10+ is required. Runtime transport dependencies are standard-library only. Use `AsyncMagicAgentClient` when integrating with an event loop; close attached streams explicitly.

## Compatibility matrix

| Component | GA version | Compatible boundary |
| --- | ---: | --- |
| TypeScript package `@magicpot/agent-sdk` | 2.0.0 | Runtime protocol major 2; Node.js 18+ or equivalent web APIs |
| Python package `magicpot-agent-sdk` | 2.0.0 | Runtime protocol major 2; Python 3.10+ |
| HTTP SDK gateway | `/v2/sdk/*` | JSON request/response; NDJSON stream for attachment |
| Graph schema | 2.0.0 | Platform 2 graph definitions |
| Session storage | 1.0.0 | Migrated by main-process persistence boundaries |
| Package manifest | 1.0.0 | Validated package data; not executable trust |

Patch and minor SDK updates within major 2 must preserve the documented public imports and runtime protocol major. A runtime protocol major other than 2 requires explicit negotiation or a matching SDK major.

## Migration to 2.0 GA

1. Replace prerelease constraints (`0.1.0-alpha.1` / `0.1.0a1`) with the stable `2.0.0` major range.
2. Import only from `@magicpot/agent-sdk` or `magicpot_agent_sdk`; remove deep imports and copied contract definitions.
3. Use `/v2/sdk/<method>`, bearer authentication, and JSON payloads. Do not send actor fields.
4. Give every mutation a stable idempotency key. Supply expected revisions and approval metadata when required by the request type.
5. Replace polling-only graph clients with `attachGraphRun` / `attach_graph_run`; persist `eventId` as the reconnect cursor and close streams.
6. Handle policy denial, approval-required, revision conflict, and unavailable/degraded results as normal outcomes rather than bypassing them.
7. Recompile TypeScript and run Python compile/import tests; pre-GA generated artifacts are not a compatibility guarantee.

## Security, Policy, and Tool Host guide

Policy is enforced in the main process, not in SDK convenience code. `packages/app/src/main/magicAgentPlatform2/policy/` persists decisions and approval grants; `packages/app/src/shared/magicAgentPlatform2/policy.ts` defines canonical policy contracts. High-risk effects may be denied, constrained, or require a grant. Grants are bound evidence with use counts, expiry and request digest semantics; they are not bearer credentials to log, copy between actors, or reuse for changed input.

Tool Hosts in `packages/app/src/main/magicAgentPlatform2/toolHost/` are privileged boundaries for terminal commands, background jobs, files, Git, Python, and notebooks. They validate inputs, canonicalize allowed roots, authorize before effects, apply time/output/resource confinement where supported, consume execution permits, and emit audit evidence. Keep `shell:false`-style argument boundaries, never broaden allowed roots from model input, and never expose a Tool Host directly to a renderer or SDK caller. Platform `runAgent` must not make internal terminal diagnostics callable without the trusted approval chain.

Operational requirements:

- Bind bearer tokens outside source control and rotate them as credentials.
- Keep the SDK server on an explicitly configured interface; loopback is the safe default.
- Treat model, package, MCP, graph, event, and tool output as untrusted input.
- Redact secrets and host paths from events, exports, audit metadata, and errors.
- Preserve route isolation for list/get/watch/cancel and return not-found semantics across routes.
- Back up event/snapshot stores through the production persistence API; do not edit SQLite files manually.

See also the deeper process-boundary threat model in [`architecture/magic-agent-security.md`](architecture/magic-agent-security.md).
