# MagicPot Architecture Overview

## Scope

This document describes the architecture of the public `magicpot-open` workspace. It is based on the repository README, package scripts, and public TypeScript contracts. It intentionally avoids private implementation details; private integrations are described only as extension and packaging boundaries.

## Product shape

MagicPot is an Electron-based AI workstation for local AI creation and workflow automation. The public README describes these major capabilities:

- AI Chat with multi-model, streaming, attachment, and tool-call flows.
- Quick Apps for running and managing reusable AI workflows.
- AI video generation Quick Apps using configured providers.
- Project Canvas for importing, arranging, cropping, restoring, and working with image/video/3D/layer assets.
- ComfyUI integration for process management, HTTP/WebSocket communication, queue handling, output access, and model browsing.
- Settings for Python, ComfyUI, LLM, MCP, plugins, themes, and application behavior.
- Logs and terminal/status panels for diagnostics.

The README identifies the core stack as Electron, electron-vite, React, TypeScript, MUI, Redux Toolkit, Three.js/React Three Fiber, Konva/PixiJS, Vitest/Testing Library, and electron-builder. `package.json` currently provides the exact npm scripts and dependency versions used by this workspace.

## Runtime shape

```text
User
  |
  v
Renderer process (React UI)
  |
  | window.api / preload bridges
  v
Preload process boundary
  |
  | typed IPC: service.method
  v
Main process services
  |        |          |           |          |
  |        |          |           |          +-- Electron app/update/dialog/window APIs
  |        |          |           +------------- User data, files, logs, local cache
  |        |          +------------------------- ComfyUI HTTP/WebSocket and queue APIs
  |        +------------------------------------ LLM/MCP/proxy/provider integrations
  +--------------------------------------------- Managed subprocesses and external tools
```

The renderer owns presentation and interaction. The main process owns privileged capabilities: local filesystem access, application configuration, ComfyUI management, subprocesses, OS dialogs, update checks, local proxy services, and external desktop integrations. The preload layer exposes a deliberately shaped bridge so renderer code does not call Electron main-process APIs directly.

## Repository layout

| Area                        | Role                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/main`     | Electron main process, service implementations, app lifecycle, process management, local servers, update logic.                           |
| `packages/app/src/preload`  | Context bridge and IPC client construction exposed to `window`.                                                                           |
| `packages/app/src/renderer` | React UI, pages, components, hooks, canvas experience, settings, chat, Quick Apps.                                                        |
| `packages/app/src/shared`   | Shared API contracts, configuration types, extension contracts, utility types, Comfy/LLM/QApp shared models.                              |
| `config`                    | Electron, TypeScript, Vitest, ESLint, and Prettier configuration.                                                                         |
| `scripts`                   | Build, packaging, release, embedded-runtime preparation, QA, benchmark, and candidate-generation automation.                              |
| `vendor`                    | Optional external/runtime inputs such as ComfyUI and Windows runtime resources. Public source candidates do not assume these are present. |
| `docs`                      | Public user and architecture documentation.                                                                                               |

## Architectural principles

1. **Typed process boundary**: Renderer-to-main communication goes through shared service contracts and IPC definitions rather than ad hoc channels.
2. **Privilege separation**: UI code stays in the renderer; filesystem, subprocess, ComfyUI, update, and provider access stay in main-process services.
3. **Build-mode clarity**: `pure` and `embedded` are build/package modes, not a runtime toggle after packaging.
4. **Open/private split**: The open repository must build without private code, secrets, submodules, local runtime data, or proprietary release assets. Optional private functionality must integrate through public extension seams or packaging inputs.
5. **User data separation**: Settings, chat records, cache, QApps, skills, and target schemes are stored outside the app installation directory by default, with `MAGICPOT_USER_DATA_DIR` available for explicit overrides.
6. **Maintainer-only releases**: GitHub release workflows can require signing, upload, OSS publishing, and notification secrets. Forks and public source checkouts can build locally but should not expect release publishing without maintainer-provided credentials.

## Related architecture docs

- [Process boundary](process-boundary.md)
- [IPC API](ipc-api.md)
- [Extension API v1](extension-api-v1.md)
- [Private wrapper](private-wrapper.md)
- [Build modes](build-modes.md)
- [Module boundaries](module-boundaries.md)
- [Security model](security-model.md)
- [Project Canvas Asset Resource Engine](project-canvas-asset-resource-engine.md)
- [ADR index](adr/0001-public-private-extension-boundary.md)
