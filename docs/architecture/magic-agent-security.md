# MagicAgent Security Architecture

## Scope

MagicAgent security covers the main-process agent runtime, tool execution, MCP platform, package discovery, graph inspection, graph execution, and Agent Studio Run Detail surfaces. It builds on MagicPot's Electron process boundary: the renderer is UI-facing and least privileged; the main process owns filesystem, subprocess, provider, ComfyUI, MCP, graph catalog, run/event store, package store, and permission decisions.

## Security principles

1. **Least privilege by process**: renderer code uses typed preload/IPC APIs; privileged work stays in main-process services.
2. **Route-scoped identity**: every agent session, graph run, graph event, and tool audit entry should be tied to a normalized route/session key.
3. **Declare before invoke**: tools, graph nodes, app capabilities, and package contributions are described with names, schemas, transports, scopes, and metadata before they are callable.
4. **Validate at boundaries**: validate renderer/MCP/tool/package/graph inputs in the main process before using paths, commands, network targets, credentials, or workflow data.
5. **Default observe/deny for risk**: mutating, filesystem, subprocess, network, or package actions need explicit policy; inspection/read paths are easier to allow.
6. **Preflight before graph execution**: graph runs must resolve a trusted catalog graph and persist permission decisions before any node/tool execution.
7. **Audit privileged decisions**: allow, deny, and failure paths should append audit records with actor, action, target, route, policy, reason, and run/event references.

## Trust boundaries

| Boundary | Trust level | Notes |
| --- | --- | --- |
| Renderer UI | Least privileged app code | Can request agent actions through typed APIs but should not access Node/Electron privileged objects directly. Cannot decide graph permissions. |
| Preload bridge | Narrow trusted bridge | Exposes selected `window.api` and helper surfaces only. |
| Agent Studio route binding | Trusted main/preload binding | Binds Agent Studio IPC callers to the fixed Agent Studio route for graph catalog/run operations. |
| Assistant runtime | Main-process trusted code | Owns sessions, queues, LLM calls, workspace state, and graph records. |
| AgentKernel | Main-process trusted core | Normalizes session, capability, run, event, and tool invocation records. |
| Graph catalog/store | Main-process trusted data boundary | Owns built-in, user, and package graph views; enforces read-only/runnable/forkable state. |
| Run/event store | Main-process trusted audit boundary | Persists run records, ordered events, `graphSnapshot`, and `permissionSnapshot`. |
| MCP platform | Policy/audit boundary | Mediates MCP-visible capabilities, route/session mapping, transport health, and permission decisions. |
| External MCP servers | Untrusted or semi-trusted integrations | Can expose dynamic tools; outputs and tool schemas should not be treated as trusted code. |
| Quick App and MagicAgent packages | User-selected data | Workflow/config/graph/agent data can influence runtime behavior; validate and disclose requirements. |
| Managed subprocesses | Separate OS processes | Python/ComfyUI/terminal commands must be launched only through reviewed service methods. |

## Graph execution permission path

MagicAgent Platform graph execution follows this main-process security path:

```text
Renderer runGraph request
  -> typed IPC validation
  -> feature-flag check
  -> trusted route authorization
  -> graph catalog resolve
  -> reject non-runnable/package-template graphs
  -> objective planning from outputIds
  -> permission preflight for required agents/tools/capabilities
  -> persist run with graphSnapshot + permissionSnapshot
  -> execute nodes
  -> authorize each runtime tool invocation
  -> append run events and audit records
```

Preflight must happen before node execution. It should evaluate:

- whether the graph source is runnable for this route;
- whether the graph definition validates and stays within runtime limits;
- which nodes/channels/outputs are in scope for requested objectives;
- which tools/agents are required;
- `allowedToolNames`, skill allowlists, package-agent allowlists, disabled-by-default flags, `requiresConfirmation`, and permission levels;
- platform policy decisions and denial reasons.

A denied preflight fails closed. It should not invoke tools, launch subprocesses, call external MCP servers, or mutate graph/runtime state beyond persisting the denied run, events, and audit evidence.

## `graphSnapshot` and `permissionSnapshot`

Every graph run should persist immutable snapshots before execution begins:

- `graphSnapshot`: validated graph definition selected from the catalog, including source/fork provenance and excluding local package paths, store directories, secrets, or host-specific absolute paths.
- `permissionSnapshot`: preflight result, including policy ids, allow/deny decisions, requested outputs, required tool set, route/session summary, and denial reasons.

These snapshots are evidence for Run Detail and replay. They are not secrets, but they may contain prompt text, graph instructions, tool names, or policy metadata and therefore remain route-scoped. Wrong-route `listGraphRuns`, `getGraphRun`, `watchGraphRun`, and `cancelGraphRun` must behave like the run is missing and must not reveal snapshots or event metadata.

`permissionSnapshot` is not a reusable approval token. Runtime tool invocation still passes through the tool invocation gate, MCP platform policy, handler validation, and any feature-specific approval checks.

## Tool invocation gate

Kernel-backed assistant tool execution follows this security path:

```text
AssistantExecutionAdapter
  -> skill allowlist check, if supplied
  -> sync tools into AgentKernel
  -> authorizeMagicPotMcpToolInvocation
  -> AgentKernel.invokeTool
  -> AssistantToolRegistry or MCP client alias
  -> append audit entry
```

The skill allowlist limits what a specific skill/run can use. Graph preflight limits what a specific graph run intends to use. The MCP platform policy decides whether the actor, route, action, and target are allowed at the platform level. These checks are cumulative for sensitive tools.

## Default MCP platform policy

The default policy in the MCP platform runtime applies these rules:

- Platform inspection resources under `magicpot://mcp/platform/` are allowed.
- Read-style actions starting with `read:` are allowed.
- Internal assistant actors (`assistant:`, `kernel:`, `bot:`) are allowed to invoke normal assistant tools outside canvas scope.
- Canvas-thread routes are sandboxed to a small approved read-oriented tool set.
- Canvas-thread routes deny known mutating tools and unknown tools by default.
- Canvas file-scoped actions must include an explicit file path and current-canvas root; the path must resolve inside the allowed root.
- Mutating external MCP targets are denied by default unless a higher-privilege policy is configured.

Policy decisions return `allowed`, `reason`, and `policyId`, which are stored in audit metadata and may also be summarized in graph `permissionSnapshot` records.

## Canvas-scoped sandbox

Canvas sessions carry routes where `channel === 'canvas'`, `scopeType === 'thread'`, and both `scopeId` and `threadId` are present. In this scope:

- only approved read/inspection tools such as session, run, event, artifact, audit, and memory inspection are allowed;
- workspace mutation, session cleanup, retry/resume, task-group mutation, and MCP/ops tools are denied;
- file actions must be constrained to current canvas roots;
- unknown tools are denied until explicitly reviewed.

This avoids letting a canvas-focused assistant operate on unrelated workspace or filesystem state.

## Agent Studio route and Run Detail isolation

Agent Studio uses a trusted main/preload route binding for graph catalog and run center operations. The renderer sends the fixed Agent Studio route, but the main service must authorize the invoking frame/window against that route before deriving `sessionKey`.

Run Detail is sensitive because it can display prompts, node outputs, channel payloads, event metadata, `graphSnapshot`, and `permissionSnapshot`. Therefore:

- run list/get/watch/cancel are filtered by authorized `sessionKey`;
- `runId` is not a secret and must not bypass route checks;
- wrong-route access returns missing/not-found semantics without partial metadata;
- stream subscription starts with a route-scoped snapshot only after authorization;
- stream cleanup must unsubscribe watchers on close/abort to avoid cross-run leakage;
- persisted run responses keep main-process redaction decisions intact.

## Terminal command safety

Terminal execution has two deliberately separate boundaries:

- MagicAgent Platform renderer-facing `runAgent` does not expose AssistantRuntime `agent.terminal.run`. Even if a renderer includes `agent.terminal.run` in `allowedToolNames`, the platform adapter strips that tool from the allowlist before calling `AssistantRuntime`.
- MagicAgent creative tools that are marked `requiresConfirmation` or `disabledByDefault` remain disabled/fail-closed at the creative registry boundary; renderer/model-supplied `confirm: true` is not accepted as authorization there.

AssistantRuntime still contains an internal `agent.terminal.run` diagnostic tool for non-platform flows. That path is separately gated by the app terminal feature flag, AssistantRuntime execution policy, command/cwd validation, and `input.confirm === true`. It must not be exposed through MagicAgent Platform renderer IPC until a trusted main-process approval token chain exists.

Future MagicAgent Platform enablement must require trusted main-process approval, route/session binding, preflight integration, and audit evidence. If enabled later, it must only permit bare executable names from a small allowlist (`node`, `git`), reject shell metacharacters/path-qualified commands, permit only read-oriented argument shapes, constrain cwd to approved roots, clamp timeout/output, and launch with `spawn` argument arrays rather than shell command strings.

Do not add write-capable commands, package managers, interpreters, or arbitrary scripts to the MagicAgent Platform surface without a new threat model and tests.

## Filesystem and path handling

For agent-facing file access:

- normalize and resolve paths before comparison;
- compare against explicit roots, not string prefixes from user input;
- reject missing path metadata for scoped file actions;
- avoid persisting raw local paths into external MCP-visible resources, graph snapshots, package catalog responses, or run detail metadata unless intentionally redacted;
- prefer project/canvas/workspace-specific roots over global home directories.

## MCP exposure

MagicPot exposes MCP capabilities through streamable HTTP and optional stdio transport status. External MCP access should be treated as cross-boundary:

- expose safe/inspection tools by default;
- use annotations such as read-only, destructive, and idempotent hints where available;
- avoid exposing secrets in tool descriptions, resources, app catalog metadata, graph snapshots, run events, or audit entries;
- keep headers/tokens in configuration, not catalog resources;
- use audit logs to correlate external sessions and actions.

## Package and graph trust

Quick App packages, MagicAgent packages, package agents, and package graphs are not trusted code just because they are JSON/data:

- `magic` markers and manifest versions identify package type, not trust level;
- validate manifests and contribution entry files before install;
- enforce compatible app version constraints where applicable;
- reject unsafe entry paths, symbolic links, excessive depth/file count/bytes, and executable contribution kinds that lack a reviewed boundary;
- treat package graph contributions as read-only/forkable templates, not runnable runtime authority;
- forked graphs become user graphs but still require normal graph validation and permission preflight;
- treat custom node URLs, model URLs, MCP command configs, and remote resources as untrusted inputs requiring user awareness;
- do not execute scripts from packages without a separate reviewed extension boundary;
- keep host-specific runtime paths out of portable package metadata and renderer responses.

## LLM and prompt-injection considerations

Tools can be invoked by explicit user commands and, in future flows, by model-suggested actions. Treat LLM output as untrusted:

- require tool schemas and allowlists for constrained skills;
- enforce graph preflight and platform policy regardless of why a tool was requested;
- avoid passing secrets or full filesystem state into prompts unless necessary;
- prefer redacted graph/project trace tools for agent-readable diagnostics;
- keep destructive actions behind explicit user approval or higher-privilege policy;
- never let a prompt, package graph, or model response alter `permissionSnapshot` decisions after preflight.

## Audit model

Audit entries should capture:

- `actor`: e.g. `assistant:<sessionKey>` or `bot:<sessionKey>`;
- `action`: e.g. `tool.invoke`, `graph.preflight`, `graph.run`, or `session.negotiate`;
- `target`: capability id, graph id, resource URI, or session id;
- `decision`: `allow`, `deny`, or `observe`;
- `reason` for denies/failures;
- metadata including route, policy id, graph run id, node id, package provenance, duration, and result status.

Inspection surfaces such as `platform.audit.list`, `mcp.status`, `audit.timeline`, run trace tools, and Agent Studio Run Detail make these decisions visible to operators.

## Stage E security test plan

Add or maintain tests for:

- feature flag fail-closed behavior before graph/run/package store access;
- trusted route binding and wrong-route list/get/watch/cancel isolation;
- graph catalog source handling: built-in/user/package mutability and runnable/forkable flags;
- package graph direct execution denial and fork-to-user-graph flow;
- preflight allow/deny snapshots, including disabled tools, confirmation-required tools, destructive tools, and `allowedToolNames` limits;
- denied preflight proving no tool invocation and no subprocess/file side effects;
- `graphSnapshot`/`permissionSnapshot` redaction and stability after graph edit, package upgrade, package uninstall, or restart;
- run/event persistence and stream watcher cleanup;
- package scan/install path constraints, symlink rejection, resource limits, and local path redaction.

## Secure change checklist

When adding MagicAgent capabilities:

1. Define the contract and schema in shared/main code before exposing UI controls.
2. Decide if the tool, graph node, package contribution, or catalog action is read-only, mutating, destructive, filesystem-facing, subprocess-facing, or network-facing.
3. Add schema validation and handler-level validation.
4. Add graph preflight behavior when the capability can be reached from graph execution.
5. Add skill/package allowlist behavior if the tool is only for specific skills or package agents.
6. Update MCP platform policy, especially canvas allow/deny sets.
7. Add audit entries for allow, deny, and failure paths.
8. Redact secrets and local-only data from catalogs, snapshots, traces, events, and replay bundles.
9. Add tests for denied access, accepted access, invalid input, route isolation, snapshot persistence, and audit metadata.
