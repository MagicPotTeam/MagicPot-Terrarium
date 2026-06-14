# Module Boundaries

## Top-level source boundaries

| Module area                 | May depend on                                                         | Must not depend on                                                                    | Notes                                                                             |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/app/src/main`     | `shared`, Node.js, Electron main-process APIs, main-only helpers.     | Renderer components/pages.                                                            | Owns privileged application behavior and service implementations.                 |
| `packages/app/src/preload`  | `shared`, Electron preload/context bridge APIs, small bridge helpers. | Renderer feature modules and main service implementations.                            | Owns bridge exposure only.                                                        |
| `packages/app/src/renderer` | `shared`, browser/React libraries, renderer extension contracts.      | Main service implementations, Node-only modules, private wrapper code.                | Owns UI and client-side interaction.                                              |
| `packages/app/src/shared`   | Type-only platform contracts, pure utilities, shared models.          | Main/renderer runtime modules.                                                        | Owns IPC contracts and cross-process types.                                       |
| `scripts`                   | Repository config, Node.js tooling, packaging inputs.                 | Runtime feature assumptions that bypass app contracts.                                | Owns automation, QA, benchmarks, release prep.                                    |
| `vendor` and runtime assets | External project/runtime data.                                        | Application source code importing local-only or non-public paths as mandatory dependencies. | Optional for public `pure` builds; required only for prepared embedded packaging. |

## Dependency direction

```text
renderer ---> shared <--- main
    |          ^          ^
    |          |          |
    +------ preload ------+
```

Rules:

1. Renderer features call main behavior through `window.api`, not direct imports.
2. Main process imports shared contracts and provides implementations.
3. Preload imports shared API definitions to construct the bridge, then exposes bridge objects.
4. Shared code remains suitable for both sides. If a type needs Electron-specific types, keep them as contract types and avoid runtime side effects.
5. Private wrappers should not be imported by open source files; use extension registries.

## Service ownership

Main-process service implementation should stay close to its domain:

| Domain                       | Boundary                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Config and storage           | `svcState` plus main config/storage modules.                                                                 |
| ComfyUI                      | `svcComfy` for ComfyUI API/queue/event helpers; `svcHyper` for startup/detection and selected local helpers. |
| LLM, chat proxy, MCP         | `svcLLMProxy`, MCP status/config modules, and extension hooks.                                               |
| Quick Apps and skills        | `svcQApp`, `svcCustomSkill`, `svcTargetScheme`, and their storage modules.                                   |
| Project trace/canvas support | `svcProjectTrace`, `svcCanvasThumbnail`, and renderer Project Canvas modules.                                |
| Local files and dialogs      | `svcFs`, `svcDialog`, and reviewed filesystem/dialog helpers.                                                |
| Logs and updates             | `svcLog`, `svcAppUpdate`, app update modules.                                                                |
| External desktop bridges     | Bridge-specific services such as Adobe/DCC/Figma/Photoshop services.                                         |

If a feature spans multiple domains, keep the orchestration at the highest layer that needs it and avoid pushing UI concerns into main services.

## Shared API boundary

`packages/app/src/shared/api` is the public cross-process contract. It should contain:

- Request and response types.
- Service interfaces.
- Service definition sheets declaring `unary` or `serverStreaming`.
- Transport-independent helper types.

It should not contain:

- Main-process implementation logic.
- Renderer components or hooks.
- Private-provider code.
- Mandatory local paths that are absent from public source candidates.

## Extension boundary

Extension registries are the only public seam for optional private behavior. Open defaults must be empty and safe. A new private requirement should usually result in one of these open changes:

- Add an optional hook to an existing V1 extension contract.
- Add a new optional V1 extension contract.
- Add a typed IPC extension service via `ApiExtensionServices` and `apiExtensionDef`.
- Add public configuration needed by both open and private builds.

Avoid changing open implementation files to import private modules or check for private directory names.

## Storage boundary

User-controlled state belongs under the resolved user-data directory, not under the app installation directory. This includes settings, chat records, caches, QApps, custom skills, target schemes, and project trace state. `MAGICPOT_USER_DATA_DIR` can override the location.

Embedded runtime resources, generated ComfyUI output, Python caches, models, and local custom nodes are runtime data. They are not part of app-body updates and should not be assumed to exist in public `pure` source checkouts.

## Test placement

The repository commonly places tests beside the code under test using `.test.ts` or `.test.tsx`. Keep tests in the same boundary as the feature they validate:

- Main service tests under `packages/app/src/main`.
- Shared contract/utility tests under `packages/app/src/shared`.
- Renderer tests under `packages/app/src/renderer`.
- Startup and smoke tests under configured Vitest projects.

## Boundary checklist

Before adding a module, ask:

1. Does this code need OS, filesystem, subprocess, Electron main, or secret access? If yes, it belongs in main.
2. Is it pure data shape or cross-process contract? If yes, it belongs in shared.
3. Is it UI state/rendering/user interaction? If yes, it belongs in renderer.
4. Is it only bridge exposure? If yes, it belongs in preload.
5. Is it product-specific or private? If yes, use extension registries or package-time inputs.
