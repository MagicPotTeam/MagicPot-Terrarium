# MagicAgent Security Architecture

## Scope

MagicAgent security covers the main-process agent runtime, tool execution, MCP platform, package discovery, and graph inspection surfaces. It builds on MagicPot's Electron process boundary: the renderer is UI-facing and least privileged; the main process owns filesystem, subprocess, provider, ComfyUI, and MCP access.

## Security principles

1. **Least privilege by process**: renderer code uses typed preload/IPC APIs; privileged work stays in main-process services.
2. **Route-scoped identity**: every agent session and tool audit entry should be tied to a normalized route/session key.
3. **Declare before invoke**: tools and app capabilities are described with names, schemas, transports, scopes, and metadata before they are callable.
4. **Validate at boundaries**: validate renderer/MCP/tool inputs in the main process before using paths, commands, network targets, credentials, or workflow data.
5. **Default observe/deny for risk**: mutating or filesystem actions need explicit policy; inspection/read paths are easier to allow.
6. **Audit privileged decisions**: allow, deny, and failure paths should append audit records with actor, action, target, route, policy, and reason.

## Trust boundaries

| Boundary | Trust level | Notes |
| --- | --- | --- |
| Renderer UI | Least privileged app code | Can request agent actions through typed APIs but should not access Node/Electron privileged objects directly. |
| Preload bridge | Narrow trusted bridge | Exposes selected `window.api` and helper surfaces only. |
| Assistant runtime | Main-process trusted code | Owns sessions, queues, LLM calls, workspace state, and graph records. |
| AgentKernel | Main-process trusted core | Normalizes session, capability, and tool invocation records. |
| MCP platform | Policy/audit boundary | Mediates MCP-visible capabilities, route/session mapping, transport health, and permission decisions. |
| External MCP servers | Untrusted or semi-trusted integrations | Can expose dynamic tools; outputs and tool schemas should not be treated as trusted code. |
| Quick App packages | User-selected data | Workflow/config data can trigger ComfyUI behavior and downloads; validate and disclose requirements. |
| Managed subprocesses | Separate OS processes | Python/ComfyUI/terminal commands must be launched only through reviewed service methods. |

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

The skill allowlist limits what a specific skill/run can use. The MCP platform policy decides whether the actor, route, action, and target are allowed at the platform level. Both checks are required for sensitive tools.

## Default MCP platform policy

The default policy in the MCP platform runtime applies these rules:

- Platform inspection resources under `magicpot://mcp/platform/` are allowed.
- Read-style actions starting with `read:` are allowed.
- Internal assistant actors (`assistant:`, `kernel:`, `bot:`) are allowed to invoke normal assistant tools outside canvas scope.
- Canvas-thread routes are sandboxed to a small approved read-oriented tool set.
- Canvas-thread routes deny known mutating tools and unknown tools by default.
- Canvas file-scoped actions must include an explicit file path and current-canvas root; the path must resolve inside the allowed root.
- Mutating external MCP targets are denied by default unless a higher-privilege policy is configured.

Policy decisions return `allowed`, `reason`, and `policyId`, which are stored in audit metadata.

## Canvas-scoped sandbox

Canvas sessions carry routes where `channel === 'canvas'`, `scopeType === 'thread'`, and both `scopeId` and `threadId` are present. In this scope:

- only approved read/inspection tools such as session, run, event, artifact, audit, and memory inspection are allowed;
- workspace mutation, session cleanup, retry/resume, task-group mutation, and MCP/ops tools are denied;
- file actions must be constrained to current canvas roots;
- unknown tools are denied until explicitly reviewed.

This avoids letting a canvas-focused assistant operate on unrelated workspace or filesystem state.

## Terminal command safety

Terminal execution has two deliberately separate boundaries:

- MagicAgent Platform renderer-facing `runAgent` does not expose AssistantRuntime `agent.terminal.run`. Even if a renderer includes `agent.terminal.run` in `allowedToolNames`, the platform adapter strips that tool from the allowlist before calling `AssistantRuntime`.
- MagicAgent creative tools that are marked `requiresConfirmation` or `disabledByDefault` remain disabled/fail-closed at the creative registry boundary; renderer/model-supplied `confirm: true` is not accepted as authorization there.

AssistantRuntime still contains an internal `agent.terminal.run` diagnostic tool for non-platform flows. That path is separately gated by the app terminal feature flag, AssistantRuntime execution policy, command/cwd validation, and `input.confirm === true`. It must not be exposed through MagicAgent Platform renderer IPC until a trusted main-process approval token chain exists.

Future MagicAgent Platform enablement must require trusted main-process approval, route/session binding, and audit evidence. If enabled later, it must only permit bare executable names from a small allowlist (`node`, `git`), reject shell metacharacters/path-qualified commands, permit only read-oriented argument shapes, constrain cwd to approved roots, clamp timeout/output, and launch with `spawn` argument arrays rather than shell command strings.

Do not add write-capable commands, package managers, interpreters, or arbitrary scripts to the MagicAgent Platform surface without a new threat model and tests.

## Filesystem and path handling

For agent-facing file access:

- normalize and resolve paths before comparison;
- compare against explicit roots, not string prefixes from user input;
- reject missing path metadata for scoped file actions;
- avoid persisting raw local paths into external MCP-visible resources unless intentionally redacted;
- prefer project/canvas/workspace-specific roots over global home directories.

## MCP exposure

MagicPot exposes MCP capabilities through streamable HTTP and optional stdio transport status. External MCP access should be treated as cross-boundary:

- expose safe/inspection tools by default;
- use annotations such as read-only, destructive, and idempotent hints where available;
- avoid exposing secrets in tool descriptions, resources, app catalog metadata, or audit entries;
- keep headers/tokens in configuration, not catalog resources;
- use audit logs to correlate external sessions and actions.

## Package and Quick App trust

Quick App packages and custom skill definitions are not trusted code just because they are JSON/data:

- `magic` markers and versions identify package type, not trust level;
- validate presence of required `cfg` and workflow fields;
- enforce compatible app version constraints;
- treat custom node URLs and model URLs as remote inputs requiring user awareness;
- do not execute scripts from packages without a separate reviewed extension boundary;
- keep private/package-only runtime paths out of portable package metadata.

## LLM and prompt-injection considerations

Tools can be invoked by explicit user commands and, in future flows, by model-suggested actions. Treat LLM output as untrusted:

- require tool schemas and allowlists for constrained skills;
- enforce platform policy regardless of why a tool was requested;
- avoid passing secrets or full filesystem state into prompts unless necessary;
- prefer redacted graph/project trace tools for agent-readable diagnostics;
- keep destructive actions behind explicit user approval or higher-privilege policy.

## Audit model

Audit entries should capture:

- `actor`: e.g. `assistant:<sessionKey>` or `bot:<sessionKey>`;
- `action`: e.g. `tool.invoke` or `session.negotiate`;
- `target`: capability id, resource URI, or session id;
- `decision`: `allow`, `deny`, or `observe`;
- `reason` for denies/failures;
- metadata including route, policy id, duration, and result status.

Inspection surfaces such as `platform.audit.list`, `mcp.status`, `audit.timeline`, and run trace tools make these decisions visible to operators.

## Secure change checklist

When adding MagicAgent capabilities:

1. Define the contract and schema in shared/main code before exposing UI controls.
2. Decide if the tool is read-only, mutating, destructive, or filesystem/network-facing.
3. Add schema validation and handler-level validation.
4. Add skill allowlist behavior if the tool is only for specific skills.
5. Update MCP platform policy, especially canvas allow/deny sets.
6. Add audit entries for allow, deny, and failure paths.
7. Redact secrets and local-only data from catalogs, traces, and replay bundles.
8. Add tests for denied access, accepted access, invalid input, and audit metadata.
