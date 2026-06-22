# MagicAgent Tools Architecture

## Scope

MagicAgent tools are callable capabilities used by the assistant runtime, skills, MCP bridges, and debugging flows. They are implemented in the main process and described through shared JSON-schema-like contracts so tool catalogs can be rendered in UI, synchronized into the `AgentKernel`, and exposed through the MagicPot MCP platform.

## Tool layers

```text
Tool definition
  AssistantToolDefinition { name, description, inputSchema }
        |
        v
AssistantToolRegistry
  built-in handlers + MCP client aliases
        |
        v
AgentKernel tool registration
  AgentToolDefinition + AgentToolInvoker
        |
        v
Permission/audit gate
  MagicPot MCP Platform policy
        |
        v
Tool execution
  main-process runtime, session store, workspace files, MCP client manager, or controlled subprocess
```

## Built-in tool catalog

`AssistantToolRegistry` defines the local MagicAgent tools. The catalog includes:

- Session and history tools: `session.status`, `session.summary`, `session.history`, `sessions.list`, `session.cleanup`.
- Run and workflow tools: `runs.list`, `runs.get`, `run.trace`, `run.lineage`, `run.replay`, `run.resume`, `workflow.inspect`, `workflow.resume`.
- Workspace tools: `workspace.attach`, `workspace.detach`, `workspace.manage`, `workspace.context`, `workspaces.list`, `workspace.inspect`.
- Task-group tools: `task.group.start`, `task.group.progress`, `task.group.approve`, `task.group.export`, `task.group.cancel`, `task.group.resume`, and inspection/list variants.
- Artifact and audit tools: `artifacts.list`, `artifacts.get`, `events.list`, `audit.timeline`, `ops.status`, `limits.status`.
- Project trace tools: `project.trace.list`, `project.trace.read`, `project.trace.references`, `project.trace.replay`, `project.trace.verify`.
- MCP visibility tool: `mcp.status`.
- Controlled terminal tool: `agent.terminal.run`.

The registry also appends external MCP client tool aliases from `McpClientManager.listToolsSnapshot()` so configured MCP servers participate in the same assistant tool list.

## Invocation modes

### Explicit chat invocation

The assistant execution adapter recognizes explicit tool commands:

```text
/tool <tool-name> <json-or-text-args>
```

The adapter parses the command, checks any skill-level allowlist, emits progress events, and routes execution through the kernel-backed tool bridge.

### Runtime API invocation

Main-process callers can invoke tools through `AssistantRuntime.callTool(...)`. This path is used by the MCP bridge and internal runtime features. It still flows through the registry, schema validation, permission checks, and audit behavior.

### MCP bridge invocation

The MCP server bridge registers a safe subset of tools for external MCP clients. Tool handlers convert MCP route arguments into assistant routes and call the assistant runtime. Tool outputs are returned as text and structured content.

## Kernel synchronization

Before listing or invoking tools, `syncAssistantToolsWithAgentKernel` mirrors the assistant tool catalog into `AgentKernel`:

- Capability id: `chat.tool.<toolName>`.
- Kind: `tool`.
- Scope: `session`.
- Transport: `internal` and `mcp`.
- Input schema: copied from the assistant tool definition.
- Invoker: a wrapper that calls `AssistantToolRegistry.callTool` with the current tool context.

Stale `chat.tool.*` capabilities are removed when no longer present in the assistant registry.

## Validation

Tool inputs are validated against the declared schema in `AssistantToolRegistry.callTool` before handlers run. The validator covers the schema features currently used by MagicAgent tools:

- object properties and required keys
- `additionalProperties: false`
- string, integer, number, boolean, array
- numeric min/max
- enum values

Handlers should still validate privileged values at the boundary they own. Schema validation is a first pass for caller ergonomics and error messages, not the only security control.

## Permission and audit flow

Every kernel-backed assistant tool invocation is checked through the MagicPot MCP platform policy:

```text
assistant:<sessionKey>
  action: tool.invoke
  target: chat.tool.<toolName>
  metadata.route: current assistant route
```

The default policy:

- allows internal assistant tools for non-canvas routes;
- restricts canvas-thread routes to an approved read-oriented tool set;
- denies known mutating tools in canvas scope;
- applies file-root checks for file-scoped canvas actions;
- denies mutating external MCP targets unless a higher-privilege policy is supplied.

Audit entries are appended for allow, deny, and observed failure paths. Entries include actor, action, target, route metadata, policy id, result state, and duration where available.

## Tool access from skills

Assistant requests can include an execution allowlist. `assertAssistantToolAllowed` ensures a skill-bound run can only list or invoke tools named in that allowlist. This is separate from MCP platform policy: the allowlist controls skill binding, while the platform policy controls privilege and route scope.

## Controlled terminal tool

Terminal execution is intentionally not exposed through MagicAgent Platform v1 renderer-facing runs because there is no trusted main-process UI approval token chain yet:

- the platform adapter strips AssistantRuntime `agent.terminal.run` out of renderer-provided `runAgent.allowedToolNames` before calling `AssistantRuntime`;
- MagicAgent creative tools marked `requiresConfirmation` or `disabledByDefault` are denied at the creative registry boundary before adapter handlers run, so renderer/model-supplied `confirm: true` is ignored and cannot authorize creative-tool execution;
- AssistantRuntime's internal diagnostic `agent.terminal.run` remains a separate non-platform path, gated by feature flag, execution policy, command/cwd validation, and `input.confirm === true`.

Do not expose terminal execution through MagicAgent Platform without adding trusted route/session-bound approval and updating the security documentation and tests. Any future enabled path must keep only allowlisted executables (`node`, `git`), read-oriented command forms, approved-root cwd resolution, and clamped timeouts/output limits.

## Adding a tool

1. Add a definition to `baseDefinitions` in `AssistantToolRegistry` with a stable name and input schema.
2. Add a handler in `toolHandlers` or route to an existing runtime service.
3. Keep privileged actions in main-process modules and validate paths, commands, network targets, and credentials there.
4. If external MCP clients should see the tool, add it to the safe MCP bridge list and app/catalog descriptors as appropriate.
5. If canvas routes may use it, update the canvas allow/deny policy in `mcp/platform/runtime.ts` deliberately.
6. Add tests for schema validation, permission behavior, and handler effects.
