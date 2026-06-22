# Security Model

## Trust boundaries

MagicPot is a desktop application, so the most important boundary is not between a remote server and a browser tab; it is between unprivileged renderer UI code and privileged local capabilities in the Electron main process.

| Boundary                | Trusted side                  | Less-trusted side                                           | Rule                                                                                                                    |
| ----------------------- | ----------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Renderer to preload     | Preload bridge                | React renderer code and DOM events                          | Expose a small, typed API surface through `contextBridge`; do not expose raw Node.js or Electron modules.               |
| Preload to main         | Main-process services         | IPC requests                                                | Route requests through `shared/api` service contracts and validate high-risk inputs in main.                            |
| Main to local system    | OS/files/subprocesses/network | User-controlled paths, URLs, models, workflows, plugin data | Normalize and validate paths, URLs, commands, and payload sizes before privileged operations.                           |
| Open to private wrapper | Public extension contracts    | Private Codex/Tripo implementations                         | Open code must not import private modules; private behavior enters through extension registries or package-time inputs. |

## Process responsibilities

- `renderer` owns UI state, rendering, and user interaction. It must not directly import main-process implementations or Node-only modules.
- `preload` constructs the typed IPC client and exposes controlled bridge objects.
- `shared` defines service contracts and transport-neutral helpers.
- `main` owns privileged operations: filesystem access, shell integration, subprocess management, ComfyUI communication, LLM provider calls, MCP runtime, local proxy servers, and external desktop bridges.

## IPC security posture

Renderer input is not trusted just because it comes from this application. Treat IPC requests as a local privilege boundary.

High-risk request fields include:

- filesystem paths and filenames;
- URLs opened or fetched by main;
- shell/external-open targets;
- subprocess commands and arguments;
- ComfyUI workflow JSON, upload payloads, and output paths;
- LLM profile IDs, provider credentials, and remote-fetch options;
- bridge targets for Adobe, Photoshop, Figma, DCC tools, and MCP.

When adding or changing an IPC service:

1. Define the request/response types in `shared/api`.
2. Prefer explicit request objects over positional primitive parameters for new methods.
3. Validate high-risk fields in the main process before using privileged APIs.
4. Return structured, user-actionable errors where possible.
5. Avoid putting secrets, stack traces, full local paths, or large binary payloads into renderer-visible errors unless the user explicitly needs them.

## Runtime validation and error model

The shared helper `packages/app/src/shared/api/apiUtils/serviceValidation.ts` provides the current validation and error-governance primitives:

- `validateServiceValue` accepts Zod-style `safeParse` validators, `parse` validators, predicate validators, or transform validators.
- `withServiceValidation` wraps unary handlers.
- `withServerStreamingValidation` wraps streaming handlers and validates emitted data before forwarding it.
- `ServiceError` and `ServiceValidationError` provide stable `code`, `message`, and optional JSON `payload` fields.
- `serializeServiceError` converts unknown errors into IPC-safe transport errors.

Streaming IPC errors use the same shape via `ServerStreamingError`:

```ts
{
  message: string
  code?: string
  payload?: JsonDict
}
```

Representative high-risk service validation is applied to shell/download/install request objects in `ShellSvcImpl`. Additional high-risk services should adopt the same helpers incrementally as they are touched.

## High-risk service guidance

| Service                                                      | Risk                                                                                     | Required care                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `svcFs`                                                      | Reads/writes user files and app artifacts.                                               | Resolve paths, avoid path traversal in generated filenames, do not expose arbitrary recursive deletes. |
| `svcShell`                                                   | Opens external targets, downloads files, installs Git repositories, creates directories. | Validate URLs, sanitize path segments, resolve output directories, and reject empty request fields.    |
| `svcComfy`                                                   | Talks to ComfyUI, uploads images/masks, retrieves outputs.                               | Validate workflow payloads and file references; do not expose internal runtime paths unnecessarily.    |
| `svcLLMProxy`                                                | Uses provider credentials and may stream model output.                                   | Keep secrets in main/config; validate profile IDs and provider routing; support aborts.                |
| `svcDccBridge`, `svcPhotoshop`, `svcAdobeBridge`, `svcFigma` | Sends local assets to external applications.                                             | Validate source paths, target formats, bridge context, and user intent.                                |
| MCP runtime/services                                         | May execute external tool capabilities.                                                  | Register allowed tools explicitly and enforce tool access policy before execution.                     |

## Extension security

Extension API v1 is a package-time trusted extension seam, not an untrusted marketplace plugin API. Private or downstream extensions still need to respect these rules:

- Main extensions may access privileged credentials and provider clients.
- Renderer extensions must not receive secrets directly.
- Shared extensions must stay deterministic and free of main-process side effects.
- Extension services must define typed shared API contracts and use the same IPC validation/error conventions.
- Open source files must depend only on extension abstractions, never on private implementation modules.

## Secrets and release assets

Do not commit secrets, tokens, signing certificates, local `.env` files, model checkpoints, generated logs, user-data directories, or runtime caches. Maintainer release workflows may require credentials that are intentionally absent from public source checkouts.
