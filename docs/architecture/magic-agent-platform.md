# MagicAgent Platform Architecture

## Scope

MagicAgent is the agent layer inside MagicPot. It connects chat sessions, assistant execution, tool catalogs, MCP capabilities, app discovery, and workflow lineage into one local agent platform. This document describes the public architecture visible in `packages/app/src/main`, `packages/app/src/shared/agent`, and related shared contracts.

MagicAgent is not a separate process. It is a main-process platform that serves renderer chat/canvas UI through typed IPC and exposes selected capabilities to MCP clients.

## Goals

- Give every assistant interaction a stable session identity, route, run record, and audit trail.
- Let MagicPot built-ins, Quick Apps, custom skills, MCP servers, and future apps appear through a common capability model.
- Keep privileged work in the main process while the renderer remains a UI client.
- Support both direct chat responses and explicit tool-driven agent workflows.
- Make agent execution observable through runs, events, artifacts, app catalog snapshots, MCP health, and audit entries.

## Runtime topology

```text
Renderer UI
  ChatPage / AgentWorkspace / canvas surfaces
        |
        | typed IPC: svcLLMProxy, svcState, svcQApp, ...
        v
Main process
  LLM proxy server / AssistantRuntime
        |
        +-- AssistantExecutionAdapter
        |     |
        |     +-- LLM provider chat call
        |     +-- /tool command dispatch
        |
        +-- AssistantToolRegistry
        |     +-- built-in session/workspace/run tools
        |     +-- MCP client tool aliases
        |
        +-- AgentKernel
        |     +-- session registry
        |     +-- capability registry
        |     +-- tool invocation wrapper
        |     +-- orchestration run/event records
        |
        +-- MagicPot MCP Platform
        |     +-- app/capability catalog sources
        |     +-- permission policy
        |     +-- audit trail
        |     +-- stdio and streamable HTTP transport status
        |
        +-- AssistantSessionStore / workspace files
              +-- messages, runs, events, artifacts, workspace context
```

## Main components

| Component | Primary files | Responsibility |
| --- | --- | --- |
| Shared agent contracts | `packages/app/src/shared/agent/*` | Capability descriptors, session identity, tool invocation records, orchestration records, MCP platform types. |
| Assistant runtime | `packages/app/src/main/assistantRuntime/runtime.ts` | Owns chat sessions, queues, run records, resume/retry behavior, events, artifacts, task groups, and workspace state. |
| Execution adapter | `packages/app/src/main/assistantRuntime/executionAdapter.ts` | Converts an inbound assistant request into either an LLM chat call or a tool invocation through the kernel. |
| Assistant tool registry | `packages/app/src/main/assistantRuntime/toolRegistry.ts` | Defines built-in MagicAgent tools and includes live MCP client tool aliases. |
| Agent kernel | `packages/app/src/main/agentKernel/agentKernel.ts` | Registers sessions, capabilities, tools, and normalized tool invocation results. |
| Tool bridge | `packages/app/src/main/agentKernel/toolBridge.ts` | Syncs assistant tools into the kernel and routes tool calls through MCP platform permission/audit gates. |
| MCP platform runtime | `packages/app/src/main/mcp/platform/runtime.ts` | Builds MCP capability sources, owns platform permissions, tracks MCP sessions/transports, and records audit entries. |
| App catalog | `packages/app/src/shared/app/catalog.ts` | Produces the unified MagicPot app catalog for core tools, Quick App helpers, custom skills, and configured MCP servers. |

## Session and route model

MagicAgent uses a route to bind activity to a user-visible context:

```ts
{
  channel: string,
  scopeType: 'dm' | 'group' | 'channel' | 'thread' | 'topic',
  scopeId: string,
  threadId?: string,
  senderId?: string,
  senderName?: string
}
```

The shared session identity builder normalizes a route into a `sessionKey` such as:

```text
<channel>:<scopeType>:<scopeId>[:thread:<threadId>]
```

The same route shape is used by chat, canvas-scoped agents, MCP sessions, workspace context, tool permission checks, and run lineage. This lets a tool invocation be traced back to a concrete user context instead of being treated as a global action.

## Execution flow

### Normal chat response

```text
Renderer sends chat message
  -> svcLLMProxy / LLM proxy server
  -> AssistantRuntime prepares session, context, run record, and event log
  -> AssistantExecutionAdapter calls configured LLM provider
  -> response attachments become artifacts
  -> AssistantSessionStore persists message, run, event, artifact lineage
  -> renderer receives assistant response
```

### Explicit tool response

MagicAgent currently treats `/tool <name> <json>` as an explicit tool invocation path.

```text
Renderer sends /tool command
  -> AssistantExecutionAdapter parses tool name and args
  -> skill-level allowlist check, if present
  -> syncAssistantToolsWithAgentKernel
  -> AgentKernel registers current assistant tools as capabilities
  -> MCP platform permission check
  -> AgentKernel.invokeTool
  -> AssistantToolRegistry.callTool or MCP client alias
  -> normalized tool result + audit entry + run event
```

### MCP-facing discovery

The MCP platform exposes platform inspection surfaces and app/tool catalog snapshots:

```text
MagicPot configuration + runtime status
  -> buildMagicPotAppCatalogSnapshot
  -> MCP platform managed sources
  -> platform.health / platform.audit.list / capability resources
  -> optional stdio or streamable HTTP MCP clients
```

## Capability model

MagicAgent capabilities are normalized descriptors with:

- `capabilityId`: stable unique id, for example `chat.tool.session.summary`.
- `name`: human/tool-facing name.
- `kind`: `tool`, `resource`, `prompt`, `session`, or `orchestrator`.
- `scope`: `global`, `session`, `workspace`, or `route`.
- `transport`: `internal`, `stdio`, `http`, or `mcp`.
- Optional JSON schemas and metadata.

Assistant tools are session-scoped and registered as both internal and MCP-visible capabilities. MCP platform sources then merge platform inspection, app catalog, assistant tool catalog, and kernel capability sources.

## State and observability

MagicAgent records state at several layers:

- **Assistant sessions**: messages, runs, event log, artifacts, workspace/task-group summaries.
- **Kernel events**: capability registration, tool invocation, and orchestration events.
- **MCP platform health**: lifecycle state, transport status, source/session/tool/resource/prompt counts.
- **MCP audit entries**: actor, action, target, allow/deny/observe decision, policy id, route metadata.
- **Workspace context**: reusable context, pinned context, memory preview, and workspace metadata files.

## Extension boundaries

New MagicAgent integrations should prefer existing seams:

1. Add shared types first under `packages/app/src/shared`.
2. Add privileged behavior in main-process services or runtime modules.
3. Register user-facing tools through `AssistantToolRegistry` or MCP client configuration.
4. Register catalog-visible app capabilities through the app catalog/MCP platform source path.
5. Keep renderer changes as UI wiring over typed IPC, not direct filesystem/process access.

## Non-goals

- MagicAgent does not grant renderer code direct Node.js, filesystem, or subprocess access.
- MagicAgent does not make all tools globally available; skills and canvas routes can restrict tools.
- MagicAgent does not replace ComfyUI or Quick Apps; it orchestrates and exposes their capabilities where appropriate.
