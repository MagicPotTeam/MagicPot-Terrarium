# Agent Studio Workflow Run Center

## Scope

Agent Studio's Workflow Run Center is the renderer-facing control surface for MagicAgent graph runs. It lives in `packages/app/src/renderer/src/pages/AgentStudioPage/AgentStudioPage.tsx` and is a UI client over the typed IPC service `svcMagicAgentPlatform`.

The renderer must not import main-process runtime modules, mutate graph runtime state directly, or gain filesystem/subprocess privileges for graph execution.

## Product role

The page is an observable graph-run console for MagicAgent Platform v1:

- read platform status plus agent, tool, graph, and package inventory;
- select a graph and submit a prompt;
- inspect active run status, outputs, channel records, errors, and history;
- stream active run updates with `watchGraphRun` as `snapshot -> event* -> closed`;
- manually refresh history or the active run;
- request best-effort cancellation for pending/running runs.

This is an orchestration shell. The main-process graph runtime owns run execution, channel/output records, and the route-authorized watch stream; the renderer only consumes typed IPC events and never touches runtime internals directly.

## IPC boundary

| UI action        | IPC method                                                           | Contract                                                               |
| ---------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Initial load     | `getStatus`, `listAgents`, `listTools`, `listGraphs`, `listPackages` | Catalog/status reads.                                                  |
| History refresh  | `listGraphRuns`                                                      | Route-scoped, filtered by selected graph, and bounded by `limit = 50`. |
| Run graph        | `runGraph`                                                           | Sends a generated `runId`, trimmed input, and `metadata.source`.         |
| View/refresh run | `getGraphRun`                                                        | Route-scoped lookup; missing runs are shown as errors.                   |
| Watch run        | `watchGraphRun`                                                      | Server-streaming `snapshot -> event* -> closed` for one route-scoped run. |
| Cancel run       | `cancelGraphRun`                                                     | Best-effort request for non-terminal runs.                               |

All run-state calls use this fixed route:

```ts
{ channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' }
```

The main service authorizes the renderer frame against the trusted Agent Studio route binding before deriving the session identity. Listing, lookup, watching, and cancellation are filtered by the derived `sessionKey`; `runId` is not treated as a secret, so wrong-route watch/lookups must behave like missing runs rather than exposing another route's prompt, node output, metadata, or stream events.

## Feature flag behavior

`svcMagicAgentPlatform.getStatus({})` gates the page with `MAGICPOT_MAGICAGENT_PLATFORM`. When disabled, the UI displays `Set MAGICPOT_MAGICAGENT_PLATFORM=1 to enable Agent Studio actions.`, skips catalog/history calls, disables graph run controls, and clears active run/history state. The main-process service is expected to fail closed before touching graph runtime, kernel, or package-store dependencies when this flag is off.

## UI lifecycle

```text
Render page
  -> getStatus
  -> if disabled: show flag guidance and stop
  -> list inventory and choose the first graph by default
  -> listGraphRuns({ route, graphId, limit: 50 })
  -> show newest run as active

Run Graph
  -> trim prompt
  -> create a client runId
  -> start watchGraphRun({ runId, route }) with an abort receiver
  -> runGraph({ runId, graphId, input, route, metadata: { source: 'agent-studio' } })
  -> apply streamed snapshot/event/closed records and the returned final run
  -> refresh route-scoped history

View / Refresh / Cancel
  -> getGraphRun({ runId, route }) for inspection
  -> cancelGraphRun({ runId, route, reason: 'Cancelled from Agent Studio' }) for non-terminal runs
  -> refresh active run and history after cancellation
```

History requests are bounded to 50 runs at the IPC boundary. The runtime returns route-scoped runs sorted by `updatedAt` descending with `createdAt` as a tie breaker; the renderer keeps the same sort as a display guard. `completed`, `failed`, and `cancelled` are terminal statuses; only non-terminal runs render cancel actions. Unmounting, switching graphs, or replacing the active run aborts the watcher only; it does not cancel the graph run. Explicit cancellation remains `cancelGraphRun`.

## Test coverage

`packages/app/src/renderer/src/pages/AgentStudioPage/AgentStudioPage.test.tsx` mocks `@renderer/utils/windowUtils` and verifies the UI/API contract without exporting internals. It covers disabled-flag behavior, enabled initial load, route-scoped history, graph switching, prompt trimming, generated run ids for stream subscription, missing run lookup, and cancellation payloads.

Main-process hardening tests also cover service fail-closed behavior when `MAGICPOT_MAGICAGENT_PLATFORM` is disabled, route/session partitioning, bounded graph-run history, stream watcher cleanup, and deterministic stream sequencing across `svcMagicAgentPlatformImpl.test.ts` and `MagicAgentGraphRuntime.test.ts`. Shared API validator coverage in `packages/app/src/shared/api/index.test.ts` rejects invalid `listGraphRuns.limit` and malformed `watchGraphRun` stream payloads before IPC dispatch.

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

- No graph definition editing.
- No ad hoc IPC transport changes; `watchGraphRun` uses the existing typed `serverStreaming` service shape.
- No direct renderer access to MagicAgent runtime internals.
