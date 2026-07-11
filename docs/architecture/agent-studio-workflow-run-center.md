# Agent Studio Workflow Run Center

## Scope

Agent Studio's Workflow Run Center is the renderer-facing control surface for MagicAgent graph discovery and graph runs. It lives in `packages/app/src/renderer/src/pages/AgentStudioPage/AgentStudioPage.tsx` and is a UI client over the typed IPC service `svcMagicAgentPlatform`.

The renderer must not import main-process runtime modules, mutate graph runtime state directly, or gain filesystem/subprocess privileges for graph execution. MagicAgent Platform v1.5 keeps Agent Studio as an orchestration shell: the main process owns the graph catalog, user graph persistence, package graph inspection, permission preflight, run/event persistence, and route-authorized watch streams.

## Product role

The page is an observable graph catalog and run console for MagicAgent Platform v1.5:

- read platform status plus agent, tool, graph, and package inventory;
- browse a graph catalog that includes built-in graphs, user-persisted graphs, and installed package graph templates;
- show source/read-only/runnable/forkable state before enabling run or fork actions;
- select a runnable graph and submit a prompt;
- run main-process permission preflight before node/tool execution;
- inspect active and historical run status, outputs, channel records, persisted events, errors, and history;
- inspect immutable `graphSnapshot` and `permissionSnapshot` values captured at run start;
- stream active run updates with `watchGraphRun` as `snapshot -> event* -> closed`;
- manually refresh history or the selected Run Detail view;
- request best-effort cancellation for pending/running runs.

## IPC boundary

| UI action | IPC method | Contract |
| --- | --- | --- |
| Initial load | `getStatus`, `listAgents`, `listTools`, `listGraphs`, `listPackages` | Feature-flagged catalog/status reads. `listGraphs` is the graph catalog view, not a renderer-owned cache. |
| Inspect graph | `inspectGraph` | Reads the full graph definition and source metadata for catalog/detail/fork preview. |
| Fork package graph | `inspectGraph`, then `createGraph` | Copies a read-only package graph template into the user graph store with a new user-owned id and fork metadata. |
| History refresh | `listGraphRuns` | Route-scoped, optionally filtered by selected graph, bounded by `limit = 50`, backed by persisted run records. |
| Run graph | `runGraph` | Sends a generated `runId`, selected `graphId`, trimmed input, route, optional `outputIds`, and `metadata.source`; main process resolves the graph, preflights permissions, persists snapshots, then executes. |
| View/refresh run | `getGraphRun` | Route-scoped lookup of persisted run detail; missing or wrong-route runs are shown as errors. |
| Watch run | `watchGraphRun` | Server-streaming `snapshot -> event* -> closed` for one route-scoped run. The snapshot comes from persisted run state when available. |
| Cancel run | `cancelGraphRun` | Best-effort request for non-terminal runs. |

All Agent Studio run-state calls use this fixed route:

```ts
{ channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' }
```

The main service authorizes the renderer frame against the trusted Agent Studio route binding before deriving the session identity. Listing, lookup, watching, and cancellation are filtered by the derived `sessionKey`; `runId` is not treated as a secret, so wrong-route watch/lookups must behave like missing runs rather than exposing another route's prompt, graph snapshot, permission snapshot, node output, metadata, or stream events.

## Graph catalog behavior

Agent Studio renders graph selection from the platform graph catalog. Catalog rows should carry enough state to avoid renderer guesses:

- **Built-in graphs**: bundled with the app, read-only, runnable by default, and optionally forkable for customization.
- **User graphs**: created or forked by the user, persisted by the main process, writable through graph IPC, runnable after preflight, and retained across app restarts.
- **Package graphs**: installed package contributions, read-only templates, not directly runnable by the graph runtime, and forkable into a user graph.

The Run button is enabled only for runnable graph catalog entries. Package graph cards expose Inspect/Fork controls and should explain that forking creates a user-owned copy; package graph definitions themselves remain immutable. Fork metadata should preserve provenance (`sourcePackageId`, contribution id, package version, source graph id, fork time) without exposing local package paths.

## Preflight permissions

Before graph execution schedules any node or invokes any tool, the main process performs permission preflight against the selected graph and route. Preflight resolves the graph from the catalog, expands requested objectives/output ids, identifies required agents/tools, applies explicit `allowedToolNames`, checks tool permission levels and disabled/confirmation flags, rejects non-runnable package graph templates, and records allow/deny reasons.

The result is persisted as `permissionSnapshot` on the run. The renderer may display it, but it must not compute or override permission decisions. A denied preflight must fail closed before node/tool execution and still leave enough persisted run/audit detail for Run Detail diagnostics. Runtime tool invocation remains separately authorized; `permissionSnapshot` is audit evidence, not a reusable approval token for tools outside the preflight scope.

## Run/event persistence and snapshots

Run Center history and Run Detail are backed by main-process persistence. `watchGraphRun` is an acceleration path for active runs, not the source of truth. A persisted run record should include:

- run id, graph id, status, route/session key, input, timings, error, and metadata;
- node records, channel records, outputs, and ordered events with monotonic per-run sequence values;
- immutable `graphSnapshot`: the validated graph definition as executed or denied, including source/fork metadata and without local package paths/secrets;
- immutable `permissionSnapshot`: the preflight decisions used for the run, including policy ids/reasons and requested output/tool scope.

`graphSnapshot` is the Run Detail source for historical runs even if a user graph is edited later, a package is upgraded/uninstalled, or a built-in graph changes in a later app build. `permissionSnapshot` explains why a run was allowed or denied at the time it started.

## Feature flag behavior

`svcMagicAgentPlatform.getStatus({})` gates the page with `MAGICPOT_MAGICAGENT_PLATFORM`. When disabled, the UI displays `Set MAGICPOT_MAGICAGENT_PLATFORM=1 to enable Agent Studio actions.`, skips catalog/history calls, disables graph run controls, and clears active run/history state. The main-process service is expected to fail closed before touching graph runtime, kernel, package-store, graph-store, or run-store dependencies when this flag is off.

## UI lifecycle

```text
Render page
  -> getStatus
  -> if disabled: show flag guidance and stop
  -> list inventory and graph catalog
  -> choose first runnable graph by default, otherwise show inspect/fork-only state
  -> listGraphRuns({ route, graphId, limit: 50 })
  -> show newest route-scoped run in Run Detail

Inspect / Fork graph
  -> inspectGraph({ graphId })
  -> for package graph: createGraph({ route, graph: forkedUserGraph, replace: false })
  -> refresh graph catalog and select forked user graph

Run Graph
  -> trim prompt
  -> create a client runId
  -> start watchGraphRun({ runId, route }) with an abort receiver
  -> runGraph({ runId, graphId, input, route, metadata: { source: 'agent-studio' } })
  -> main process persists graphSnapshot + permissionSnapshot before execution
  -> apply streamed snapshot/event/closed records and the returned final run
  -> refresh route-scoped history and Run Detail from persisted state

View / Refresh / Cancel
  -> getGraphRun({ runId, route }) for Run Detail inspection
  -> cancelGraphRun({ runId, route, reason: 'Cancelled from Agent Studio' }) for non-terminal runs
  -> refresh active run and history after cancellation
```

History requests are bounded to 50 runs at the IPC boundary. The runtime returns route-scoped runs sorted by `updatedAt` descending with `createdAt` as a tie breaker; the renderer keeps the same sort as a display guard. `completed`, `failed`, and `cancelled` are terminal statuses; only non-terminal runs render cancel actions. Unmounting, switching graphs, or replacing the active run aborts the watcher only; it does not cancel the graph run. Explicit cancellation remains `cancelGraphRun`.

## Run Detail UI

Run Detail is the durable inspection view for the selected run. It should display:

- header: run id, graph name/version/source from `graphSnapshot`, status, timing, route/session summary, and error/cancel actions;
- prompt/input and selected output objectives;
- node timeline with status, inputs/outputs/errors, and skipped/outside-objective metadata;
- outputs and channel records in execution order;
- event timeline with sequence, type, timestamp, node/channel/output ids, and messages;
- `graphSnapshot` and `permissionSnapshot` panels for audit/replay;
- metadata with local-path and secret redaction preserved from the main-process response.

The detail view must continue to work for historical runs without re-inspecting the current graph catalog. If a catalog graph is missing, modified, or removed, Run Detail labels the snapshot as historical and uses the persisted `graphSnapshot`.

## Stage E test plan

Recommended automated coverage:

- disabled flag: no graph/package/run store calls, all run/fork controls disabled;
- graph catalog: built-in/user/package rows render source, read-only, runnable, and forkable states correctly;
- package graph behavior: direct run is disabled/denied, fork calls `inspectGraph` then `createGraph`, forked user graph becomes runnable;
- user graph persistence: created/forked graphs survive service/page reload and remain separated from package templates;
- preflight: allowed runs persist `permissionSnapshot`; denied runs do not invoke tools and show denial reasons in Run Detail;
- snapshots: `graphSnapshot` is deep-copied at run start and remains unchanged after graph edits/package uninstall;
- run/event persistence: `listGraphRuns`, `getGraphRun`, and `watchGraphRun` agree on status/events after refresh and restart;
- route isolation: wrong-route list/get/watch/cancel cannot expose run detail, events, `graphSnapshot`, or `permissionSnapshot`;
- Run Detail UI: renders outputs, channels, event timeline, snapshots, cancellation state, missing-run errors, and stream close behavior.

Recommended focused validation:

```bash
npm run typecheck:node
npm run typecheck:web
npm run lint:main
npm run lint:renderer
npm run lint:shared
npx vitest run --config config/vitest/vitest.node.config.mjs packages/app/src/shared/api/index.test.ts packages/app/src/main/api/svcMagicAgentPlatformImpl.test.ts packages/app/src/main/magicAgentRuntime/graph/MagicAgentGraphRuntime.test.ts --pool=forks --maxWorkers=1
npx vitest run --config config/vitest/vitest.web.config.mjs packages/app/src/renderer/src/pages/AgentStudioPage/AgentStudioPage.test.tsx --pool=forks --maxWorkers=1
npm run check:text-encoding
```

## Non-goals

- No direct renderer access to MagicAgent runtime, graph store, run store, package store, filesystem, or subprocess internals.
- No direct mutation or execution of package graph templates; users fork templates into user graphs first.
- No ad hoc IPC transport changes; `watchGraphRun` uses the existing typed `serverStreaming` service shape.
- No renderer-side permission decisions; preflight and tool authorization stay in the main process.
