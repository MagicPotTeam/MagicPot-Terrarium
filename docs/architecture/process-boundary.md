# Process Boundary

## Boundary summary

MagicPot follows the standard Electron split:

| Boundary             | Trust/privilege                              | Responsibilities                                                                                                                                                        |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer             | UI-facing, least privileged application code | React UI, pages, forms, canvas interaction, client-side state, rendering, user-initiated actions.                                                                       |
| Preload              | Narrow bridge with Electron access           | Creates the typed IPC client and exposes selected globals to `window`.                                                                                                  |
| Main                 | Privileged desktop process                   | App lifecycle, BrowserWindow creation, dialogs, updates, config persistence, filesystem, logs, ComfyUI, subprocesses, LLM/MCP/proxy services, external desktop bridges. |
| Managed subprocesses | Separate OS processes                        | ComfyUI/Python runtime and other explicitly launched local processes.                                                                                                   |
| External services    | Out of process and often out of machine      | LLM providers, video-generation providers, MCP servers, ComfyUI HTTP/WS endpoints, DCC tools, Figma/Photoshop-style integrations.                                       |

## Renderer

The renderer is the React application. It should:

- Import shared contracts and pure utilities from `packages/app/src/shared`.
- Treat `window.api` and the other preload globals as its only privileged access path.
- Keep UI-specific concerns in renderer pages/components/hooks.
- Avoid direct use of Node.js, filesystem, subprocess, or Electron main-process APIs.

Renderer features include the chat UI, Quick App UI, Project Canvas, settings panels, model/file browsing views, logs/terminal views, and other desktop interaction surfaces.

## Preload

The preload code exposes these public bridges to the renderer:

- `window.api`: typed MagicPot service API generated from shared API definitions.
- `window.electron`: selected Electron toolkit preload API.
- `window.electronFile`: helper for resolving a selected browser `File` to a local path when Electron supports it.
- `window.path`: path helper surface used by renderer code.
- `window.win`: window controls used by the custom title bar.

Preload is not a feature layer. Its job is to translate shared API definitions into IPC client calls and expose only the minimum bridge objects required by the renderer.

## Main process

Main-process services own privileged work. Examples include:

- Reading and writing configuration and user data.
- Listing, reading, and writing selected local files.
- Starting or detecting ComfyUI and communicating with ComfyUI HTTP/WebSocket APIs.
- Running managed subprocesses and commands through reviewed service methods.
- Handling OS dialogs, clipboard access, GPU info, logs, app updates, MCP/LLM proxy status, and external app bridges.

Main services are registered under typed service names such as `svcState`, `svcComfy`, `svcLLMProxy`, and `svcFs`. See [IPC API](ipc-api.md).

## Managed ComfyUI boundary

ComfyUI can be supplied by the user or bundled by maintainers depending on build mode:

- `pure`: the user configures Python and ComfyUI paths in settings.
- `embedded`: the package can include an embedded Python/ComfyUI runtime and use it as the default when no user path is configured.

In both modes, the renderer does not talk to ComfyUI directly for privileged operations. Main-process services mediate process startup, queue interaction, file access, and event streams.

## Common flows

### Configuration read/write

```text
Renderer settings panel
  -> window.api.svcState.getConfig/saveConfig
  -> IPC bridge
  -> Main state/config service
  -> user-data-backed configuration files
```

### Submit a ComfyUI workflow

```text
Renderer Quick App or canvas feature
  -> window.api.svcComfy.submitWorkflow / watchQueue / waitPromptId
  -> Main Comfy service and internal queue handling
  -> ComfyUI HTTP/WebSocket APIs
  -> streamed status/results back to renderer
```

### Watch logs

```text
Renderer Logs / Terminal panel
  -> window.api.svcLog.watchAppLogs or watchComfyLogs
  -> streaming IPC MessagePort
  -> Main log source
  -> incremental log events back to renderer
```

## Rules for new cross-process features

1. Define request/response types in `packages/app/src/shared/api` first.
2. Choose `unary` for finite request/response operations and `serverStreaming` for long-lived streams.
3. Implement privileged behavior in `packages/app/src/main/api` or a main-process module it owns.
4. Expose no raw Node/Electron object to renderer code.
5. Validate untrusted renderer input in the main process before using filesystem paths, process commands, network targets, or credentials.
6. Keep private or provider-specific additions behind the public extension boundary documented in [Extension API v1](extension-api-v1.md).
