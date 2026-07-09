# MagicAgent Graph Architecture

## Scope

The MagicAgent graph is the execution, catalog, and lineage model used to relate sessions, graph definitions, runs, tasks, tools, artifacts, workflows, and subagents. It is not a standalone graph database. It is a set of typed records owned by the main process so MagicPot can inspect, replay, resume, audit, expose, and persist agent work.

MagicAgent Platform v1.5 adds three durable graph concepts to the existing runtime model:

1. a graph catalog spanning built-in graphs, user-persisted graphs, and package graph templates;
2. immutable per-run `graphSnapshot` and `permissionSnapshot` records;
3. persisted run and event history used by Agent Studio Run Detail.

## Graph concepts

```text
Workspace
  |
  +-- Graph catalog
  |     |
  |     +-- Built-in graph definitions (read-only, runnable)
  |     +-- User graph definitions (persisted, editable/fork targets)
  |     +-- Package graph templates (read-only, forkable, not directly runnable)
  |
  +-- Session route / sessionKey
        |
        +-- Run records
        |     |
        |     +-- graphSnapshot
        |     +-- permissionSnapshot
        |     +-- parent/root/resume relationships
        |     +-- task-group quality gates
        |     +-- tool calls
        |     +-- artifact ids
        |
        +-- Event log
        |
        +-- Artifacts
        |     |
        |     +-- lineage references
        |
        +-- Workspace context
              +-- memory, pinned context, reusable context files
```

At the shared agent layer, orchestration records use similar primitives:

- `AgentOrchestrationRun` for master or subagent runs.
- `AgentOrchestrationStep` for dependency-aware work items.
- `AgentOrchestrationEvent` for run, step, capability, and tool events.
- `AgentMasterRunSpec` and `AgentSubagentRunSpec` for requested work.

## Graph catalog

The graph catalog is the authoritative list returned to renderer clients by `svcMagicAgentPlatform.listGraphs`. It is assembled in the main process from these sources:

| Source | Ownership | Mutability | Runnable | Forkable | Persistence |
| --- | --- | --- | --- | --- | --- |
| Built-in graph | MagicPot app bundle | Read-only | Yes | Optional | App version |
| User graph | Current user/workspace | Writable through graph IPC | Yes, after preflight | Not needed | User graph store |
| Package graph | Installed MagicAgent package contribution | Read-only template | No in v1.5 | Yes | Package store |

Catalog list items should include stable ids, display metadata, counts, tags, source/provenance, and booleans such as `builtIn`, `readOnly`, `runnable`, and `forkable`. Renderer code must not infer mutability from naming conventions or package ids.

### Built-in graphs

Built-in graphs are loaded from bundled shared definitions and validated before use. They are read-only and may change when the app updates. Runs capture a `graphSnapshot`, so historical Run Detail remains accurate if a built-in graph is revised later.

### User graphs

User graphs are created directly or by forking a package/built-in graph. They are persisted by the main process and survive app restarts. User graph ids are stable and opaque; user graph records should keep provenance metadata for forks but must not expose local package paths or app installation paths.

A graph created by forking should preserve:

- source graph id and version;
- source type (`builtin` or `package`);
- package id/name/version and contribution id when applicable;
- fork timestamp and creator route/session metadata when available.

### Package graph templates

MagicAgent package graph contributions are catalog templates. They are validated during package scan/install and can be inspected in Agent Studio, but they are read-only and not directly executable by MagicAgent GraphRuntime in v1.5. To run one, the user forks it into the user graph store. The fork is a deep copy with a new user-owned graph id and explicit provenance metadata.

Package graph templates may disappear or change when a package is uninstalled or upgraded. Existing runs remain inspectable because the run owns its `graphSnapshot`.

## Session roots

Every graph run starts with a normalized route and session identity. The route binds a run to a user-visible context such as a chat, group, thread, canvas session, Agent Studio, or future topic. The generated `sessionKey` is used by:

- assistant session persistence;
- kernel session registration;
- tool audit actors such as `assistant:<sessionKey>`;
- MCP negotiated session ownership;
- workspace and task-group summaries;
- graph run/event persistence and route-scoped Run Detail lookups.

## Run graph

Assistant run records form a lineage graph rather than a flat log. A run can include:

- `runId`: unique run id.
- `rootRunId`: root workflow/run id.
- `parentRunId`: parent run for nested or delegated work.
- `resumeSourceRunId`: failed/cancelled run that a resume/retry continues.
- `resumeAttempt` and `resumeMode`: retry metadata.
- `runOrigin`: new, resumed, task-group, or related origin.
- `executionMode`, `executionHistorySize`, `executionTraceLabel`: execution/debug metadata.
- `taskGroup`: workflow/task-group status and quality gate state.
- `lineage`: artifact/workspace/task-group references.
- `graphSnapshot`: immutable graph definition used for this run.
- `permissionSnapshot`: immutable preflight permission result used for this run.

Inspection tools such as `run.trace`, `run.lineage`, `run.replay`, `workflow.inspect`, and `workflow.resume` read this graph from main-process stores.

## Preflight and snapshots

Graph execution is a two-step boundary:

```text
runGraph request
  -> authorize trusted route
  -> resolve catalog graph
  -> reject non-runnable package templates
  -> build objective plan for requested outputs
  -> preflight required agents/tools/permissions
  -> persist run with graphSnapshot + permissionSnapshot
  -> execute nodes and append events
```

`graphSnapshot` is a deep, redacted copy of the validated graph as it existed at run start. It is used by replay, Run Detail, event interpretation, and audit displays. It must not be replaced by a later `inspectGraph` result.

`permissionSnapshot` captures preflight decisions, including requested outputs, required nodes/channels/tools, allowed and denied capabilities, policy ids, reasons, and the route/session context. It explains why a run was allowed or denied but is not a capability token. Each runtime tool invocation still passes through the normal authorization path.

Denied preflight should fail closed before node execution, persist a failed/permission-denied run record, and append events explaining the denial.

## Task groups and quality gates

Task groups are workflow-level nodes within the run graph. Tools such as `task.group.start`, `task.group.progress`, `task.group.approve`, `task.group.export`, `task.group.cancel`, and `task.group.resume` mutate task-group state through the assistant runtime.

A task group can carry a quality gate with:

- a stable gate id;
- status such as pending, passing, or failed;
- updated timestamp;
- summary text;
- individual checks tied to task-group actions.

This gives long-running agent workflows an explicit checkpoint and approval/export lifecycle without requiring the renderer to own privileged state transitions.

## Subagent orchestration graph

The shared subagent orchestrator supports dependency-aware task execution:

```text
Orchestrated run
  +-- task A
  +-- task B depends on A
  +-- task C depends on A
  +-- task D depends on B and C
```

Each task records:

- id, label, task text;
- ownership scopes used to prevent conflicting parallel work;
- dependencies;
- attempts and max attempts;
- status, timestamps, result text, and error;
- checkpoint and quality-gate result;
- messages exchanged with the subagent.

The orchestrator selects runnable tasks whose dependencies have completed. It batches tasks up to configured parallelism while avoiding conflicting ownership scopes. Failed tasks can retry until attempts are exhausted. Aborted runs are cancelled and remain inspectable.

## Kernel orchestration records

`AgentKernel` also has a generic orchestration record model for master/subagent runs. It can create run records, normalize status, record events, invoke tools, and expose event snapshots. This is the stable core model for future graph-backed orchestration beyond the assistant runtime's current session store.

MagicAgent Platform graph execution is route-scoped. Renderer-facing requests that mutate graph definitions or operate on run state must include an explicit route:

- `createGraph`
- `runGraph`
- `listGraphRuns`
- `getGraphRun`
- `watchGraphRun`
- `cancelGraphRun`

The service authorizes the route against a trusted binding, registers that route with `AgentKernel`, derives a `sessionKey`, and stores the normalized route/session identity on each run record. Run listing, run lookup, watching, and cancellation are filtered by `sessionKey`, so callers only see or affect runs for their authorized route. Read-only catalog operations such as `listGraphs` and `inspectGraph` remain non-mutating graph catalog reads, but they still execute through the same typed IPC and feature-flag boundary.

Graph-specific events are recorded through the kernel's supported event vocabulary (`run.*` and `step.*`) with `metadata.graphEventType` carrying values such as `graph.completed` or `graph.cancelled`. This keeps audit events type-safe while preserving graph-level detail.

### Output objective execution

`runGraph.outputIds` is an execution-goal selector, not only a response filter. When `outputIds` is supplied, GraphRuntime builds an objective plan from the requested outputs, walks the required inbound channels/nodes, and executes only the planned subgraph. Nodes outside the requested objective are marked `skipped` with outside-objective metadata, and their channels are not emitted. Required-channel failures on non-goal branches do not fail the requested output. When `outputIds` is omitted, all graph outputs remain requested and the runtime executes the full graph as before.

The selected objective set is part of `permissionSnapshot` so Run Detail can explain why nodes were executed or skipped.

## Run and event persistence

Graph runs and graph events are durable state, not only in-memory stream messages. Persistence should support:

- route-scoped `listGraphRuns` ordered by `updatedAt` descending with `createdAt` tie breaker;
- route-scoped `getGraphRun` for Run Detail;
- active `watchGraphRun` streams that begin with a snapshot and continue with ordered events;
- restart-safe history for terminal runs;
- bounded retention per session/route according to runtime policy;
- redaction of local paths, secrets, and package-store internals.

Event records should carry a monotonic per-run `sequence`, type, message, timestamp, optional node/channel/output ids, and metadata. Use events for timeline/replay views; use run records for durable state and resumption decisions.

## Artifacts and replay

LLM replies can include attachments. The execution adapter converts response attachments into artifact references with:

- artifact id;
- originating run id and trace id;
- kind, URL, MIME type, file name, and size;
- source (`reply`);
- execution metadata.

Replay tools derive compact replay bundles from run traces, lineage, project traces, rules, graph snapshots, permission snapshots, and event summaries. The goal is deterministic diagnosis and handoff: an operator or follow-up agent can understand what happened without rerunning the original workflow blindly.

## Project trace integration

Project trace tools bridge UI/project behavior into MagicAgent graph inspection:

- `project.trace.list` lists redacted traces for a project.
- `project.trace.read` reads a single redacted trace document.
- `project.trace.references` returns compact references for selected traces.
- `project.trace.replay` builds a replay bundle from trace content and rules.
- `project.trace.verify` compares runtime event summaries against trace rules.

These tools are intentionally read-oriented and redacted so graph inspection can be shared with agents without exposing raw project state unnecessarily.

## Graph events

Events make the graph observable and auditable. Important event families include:

- assistant run progress, tool, completion, failure, and cancellation events;
- graph runtime events such as `graph.started`, `node.started`, `tool.invoked`, `channel.message`, `output.created`, `graph.completed`, `graph.failed`, and `graph.cancelled`;
- preflight events for permission allow/deny decisions;
- kernel events such as `run.created`, `run.started`, `run.completed`, `step.*`, `capability.registered`, and `tool.invoked`;
- MCP audit entries for permission and transport-visible actions;
- task-group progress and quality-gate transitions.

Persist graph runtime events with the run so Run Detail and replay views do not depend on a live stream.

## Design rules

1. Keep graph identifiers stable and opaque; do not encode secrets or raw paths into ids.
2. Preserve `rootRunId`, `parentRunId`, and `resumeSourceRunId` when creating derived runs.
3. Record important state transitions as events in addition to updating state records.
4. Capture immutable `graphSnapshot` and `permissionSnapshot` before execution begins.
5. Keep read/replay tools redacted by default.
6. Treat graph state as main-process data; renderer code should request it through typed IPC/runtime tools.
7. Package graph templates are read-only; fork them into user graphs before execution or editing.
8. Before adding new graph fields, update shared contracts, persistence, inspection/replay tools, and Run Detail docs together.
