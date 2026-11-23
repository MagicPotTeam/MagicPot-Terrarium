# ADR 0001: Public/private behavior enters through extension registries

## Status

Accepted

## Context

MagicPot is maintained as the public open application in `open/MagicPot-Terrarium` and a private wrapper at the repository root. Codex and Tripo integrations add provider behavior, optional IPC services, and renderer UI contributions. Both started as private integrations and are now public; see Migration notes.

Historically, private overlays could patch high-churn open files such as chat pages, settings panels, IPC assembly, LLM proxy implementation, and shared LLM/config files. That is workable for short-lived experiments but creates long-term merge risk and can accidentally leak private assumptions into public candidates.

The open application already has generated registry seams in shared, main, and renderer source trees. These registries were originally empty in the public build and can be populated or replaced by downstream/private packaging.

## Decision

Use Extension API v1 as the preferred boundary for private or downstream behavior.

Open source code may define and consume public extension contracts, but it must not import private modules or check for private directory names. Private wrappers may populate generated registries and provide implementation files during private workspace generation.

For new private requirements, maintainers should prefer this order:

1. Use an existing extension hook.
2. Add an additive optional hook to a V1 extension contract.
3. Add a typed extension IPC service via `ApiExtensionServices` and `apiExtensionDef`.
4. As a temporary migration step only, patch an open file and document the remaining migration reason.

High-churn files such as `ChatPage.tsx`, settings panels, `serverIpc.ts`, `shared/api/index.ts`, shared LLM/config files, and LLM proxy internals should not be long-term private patch targets.

## Consequences

Positive:

- Open candidate generation remains safer and easier to reason about.
- Private features can evolve without repeatedly conflicting with public UI and service files.
- Extension contracts become reviewable architecture artifacts.
- Main/renderer/shared boundaries stay explicit.

Negative or trade-offs:

- Some private migration work requires adding new public extension points before private behavior can move.
- Extension contracts require versioning discipline; V1 additions should remain additive.
- Generated registries must be tested in both empty-open and populated-private forms.

## Migration notes

- Tripo moved from the private wrapper into `main/extensions/` and is registered in the main registry by default.
- 2026-11: Codex (ChatGPT sign-in OAuth, model discovery, image generation) moved from the private overlay into `shared/extensions/`, `main/extensions/`, `renderer/src/extensions/`, and `main/api/`. The public registries now register Codex by default (Codex before Tripo in `llmProxy`). It lives in `extensions/` rather than a private extension directory so that public code still never imports private modules.
- The private wrapper must drop its Codex overlay entries once this lands, otherwise private packaging would carry a second Codex copy and regenerate the registries to point at it.

## Follow-up

- Keep `docs/architecture/extension-api-v1.md` updated as hooks are added.
- Move private overlay targets away from high-churn files over time.
- Add contract tests for extension registries and private overlay verification.
