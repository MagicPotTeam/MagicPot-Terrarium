# MagicAgent Graph Architecture

## Scope

The MagicAgent graph is the execution and lineage model used to relate sessions, runs, tasks, tools, artifacts, workflows, and subagents. It is not a standalone graph database. It is a set of typed records stored by the assistant runtime and shared agent contracts so MagicPot can inspect, replay, resume, audit, and expose agent work.

## Graph concepts

```text
Workspace
  |
  +-- Session route / sessionKey
        |
        +-- Run records
        |     |
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

## Session roots

Every graph starts with a normalized route and session identity. The route binds a run to a user-visible context such as a chat, group, thread, canvas session, or future topic. The generated `sessionKey` is used by:

- assistant session persistence;
- kernel session registration;
- tool audit actors such as `assistant:<sessionKey>`;
- MCP negotiated session ownership;
- workspace and task-group summaries.

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

Inspection tools such as `run.trace`, `run.lineage`, `run.replay`, `workflow.inspect`, and `workflow.resume` read this graph from `AssistantSessionStore`.

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
- `cancelGraphRun`

The service registers that route with `AgentKernel`, derives a `sessionKey`, and stores the normalized route/session identity on each `MagicAgentGraphRunRecord`. Run listing, run lookup, and cancellation are filtered by `sessionKey` for product flows, so honest callers only see or affect runs for the route they use. This route filter is not, by itself, a renderer authorization boundary because renderer IPC currently supplies the route value; preventing a compromised or arbitrary renderer caller from selecting another known route would require main/preload to bind caller identity or window context to allowed routes. Read-only catalog operations such as `listGraphs` and `inspectGraph` remain non-mutating graph catalog reads.

Graph-specific events are recorded through the kernel's supported event vocabulary (`run.*`) with `metadata.graphEventType` carrying values such as `graph.completed` or `graph.cancelled`. This keeps audit events type-safe while preserving graph-level detail.

## Artifacts and replay

LLM replies can include attachments. The execution adapter converts response attachments into artifact references with:

- artifact id;
- originating run id and trace id;
- kind, URL, MIME type, file name, and size;
- source (`reply`);
- execution metadata.

Replay tools derive compact replay bundles from run traces, lineage, project traces, rules, and event summaries. The goal is deterministic diagnosis and handoff: an operator or follow-up agent can understand what happened without rerunning the original workflow blindly.

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
- kernel events such as `run.created`, `run.started`, `run.completed`, `step.*`, `capability.registered`, and `tool.invoked`;
- MCP audit entries for permission and transport-visible actions;
- task-group progress and quality-gate transitions.

Use events for timeline/replay views; use run records for durable state and resumption decisions.

## Design rules

1. Keep graph identifiers stable and opaque; do not encode secrets or raw paths into ids.
2. Preserve `rootRunId`, `parentRunId`, and `resumeSourceRunId` when creating derived runs.
3. Record important state transitions as events in addition to updating state records.
4. Keep read/replay tools redacted by default.
5. Treat graph state as main-process data; renderer code should request it through typed IPC/runtime tools.
6. Before adding new graph fields, update shared contracts and inspection/replay tools together.
