# Agent Studio Workflow Run Center

## Scope

Agent Studio's Workflow Run Center is the renderer-facing control surface for MagicAgent graph runs. It lives in `packages/app/src/renderer/src/pages/AgentStudioPage/AgentStudioPage.tsx` and is a UI client over the typed IPC service `svcMagicAgentPlatform`.

The renderer must not import main-process runtime modules, mutate graph runtime state directly, or gain filesystem/subprocess privileges for graph execution.

## Product role

The page is an observable graph-run console for MagicAgent Platform v1:

- read platform status plus agent, tool, graph, and package inventory;
- select a graph and submit a prompt;
- inspect active run status, outputs, channel records, errors, and history;
- manually refresh history or the active run;
- request best-effort cancellation for pending/running runs.

This is an orchestration shell. The current main-process graph runtime builds run, channel, and output records; it is not exposed as a renderer-side streaming multi-agent scheduler.

## IPC boundary

| UI action | IPC method | Contract |
| --- | --- | --- |
| Initial load | `getStatus`, `listAgents`, `listTools`, `listGraphs`, `listPackages` | Catalog/status reads. |
| History refresh | `listGraphRuns` | Route-scoped and filtered by selected graph. |
| Run graph | `runGraph` | Sends trimmed input and `metadata.source = "agent-studio"`. |
| View/refresh run | `getGraphRun` | Route-scoped lookup; missing runs are shown as errors. |
| Cancel run | `cancelGraphRun` | Best-effort request for non-terminal runs. |

All run-state calls use this fixed route:

```ts
{ channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' }
```

The main service derives the session identity from that route. Listing, lookup, and cancellation are filtered by session identity for honest callers and product flows, but the route value is still supplied by renderer IPC. Treat this as run-state partitioning, not a complete authorization boundary; stronger isolation would require binding caller identity or window context to the allowed route in main/preload.

## Feature flag behavior

`svcMagicAgentPlatform.getStatus({})` gates the page with `MAGICPOT_MAGICAGENT_PLATFORM`. When disabled, the UI displays `Set MAGICPOT_MAGICAGENT_PLATFORM=1 to enable Agent Studio actions.`, skips catalog/history calls, disables graph run controls, and clears active run/history state.

## UI lifecycle

```text
Render page
  -> getStatus
  -> if disabled: show flag guidance and stop
  -> list inventory and choose the first graph by default
  -> listGraphRuns({ route, graphId })
  -> show newest run as active

Run Graph
  -> trim prompt
  -> runGraph({ graphId, input, route, metadata: { source: 'agent-studio' } })
  -> set returned run active
  -> refresh route-scoped history

View / Refresh / Cancel
  -> getGraphRun({ runId, route }) for inspection
  -> cancelGraphRun({ runId, route, reason: 'Cancelled from Agent Studio' }) for non-terminal runs
  -> refresh active run and history after cancellation
```

History is sorted by `updatedAt` descending with `createdAt` as a tie breaker. `completed`, `failed`, and `cancelled` are terminal statuses; only non-terminal runs render cancel actions.

## Test coverage

`packages/app/src/renderer/src/pages/AgentStudioPage/AgentStudioPage.test.tsx` mocks `@renderer/utils/windowUtils` and verifies the UI/API contract without exporting internals. It covers disabled-flag behavior, enabled initial load, route-scoped history, graph switching, prompt trimming, missing run lookup, and cancellation payloads.

Recommended focused validation:

```bash
npm run typecheck:web
npm run lint:renderer
npx vitest run --config config/vitest/vitest.web.config.mjs packages/app/src/renderer/src/pages/AgentStudioPage/AgentStudioPage.test.tsx --pool=forks --maxWorkers=1
npm run check:text-encoding
```

## Non-goals

- No automatic polling or streaming events in v1.
- No graph definition editing.
- No shared IPC, preload, or main runtime contract changes.
- No direct renderer access to MagicAgent runtime internals.
