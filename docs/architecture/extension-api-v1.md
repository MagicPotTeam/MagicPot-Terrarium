# Extension API v1

## Purpose

Extension API v1 provides typed seams where optional product-specific behavior can be added without making the open repository depend on private code. The open build registers the public Codex (ChatGPT sign-in) and Tripo extensions by default. A maintainer or downstream wrapper may replace those registries during its own build process, and the public application must continue to compile and run when they are empty.

This API is a compile-time/package-time extension seam, not a general-purpose untrusted plugin loader.

## Public extension modules

| Layer    | Public module                                                    | Open-build default                                    | Responsibility                                                       |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Shared   | `packages/app/src/shared/extensions/generatedRegistry.ts`        | Codex service definitions and Codex LLM profile hook. | Shared extension contracts and shared LLM profile hooks.             |
| Main     | `packages/app/src/main/extensions/generatedRegistry.ts`          | Codex then Tripo LLM proxy hooks; Codex API services. | Main-process provider/proxy hooks and optional IPC service creation. |
| Renderer | `packages/app/src/renderer/src/extensions/generatedRegistry.tsx` | Codex chat and settings hooks.                        | UI hooks for chat/settings behavior.                                 |

The `generatedRegistry` name reflects that downstream packaging may generate or replace registry contents. Open-source implementation files should consume the exported contracts and must still tolerate empty registries. LLM proxy hooks are matched in array order, so Codex is listed before Tripo.

## Shared host API

`SharedHostExtensionApiV1` currently exposes:

```ts
{
  llmProfiles: SharedLlmProfileExtensionV1[]
}
```

A shared LLM profile extension can provide an `id` plus optional hooks for:

- Building model catalog options for a provider/deployment/model-use combination.
- Creating an LLM client from a profile.
- Determining whether a profile is runnable.
- Resolving chat capabilities.
- Resolving profile call type, deployment, model use, and provider.
- Transforming Quick App API profiles from configuration.

Shared hooks must stay deterministic and serializable where their results cross process boundaries. They should not directly depend on main-process-only capabilities.

## Main host API

`MainHostExtensionApiV1` currently exposes:

```ts
{
  llmProxy: MainLlmProxyExtensionV1[]
}
```

A main LLM proxy extension can provide an `id` plus optional hooks for:

- Creating an LLM client from a configured profile.
- Handling a chat request before or instead of the default implementation.
- Normalizing requested profile IDs.

Main extensions may access main-process-only context provided by the host, including configuration and request abort signals. Provider secrets and privileged network behavior belong in main extensions, not renderer extensions.

Main also exposes `createApiExtensionServices(context)`, which returns `ApiExtensionServices`. In the open build this returns `{}`. Downstream extensions that add IPC services must also provide matching shared service types and definition sheets through `apiExtensionDef`.

## Renderer host API

`RendererHostExtensionApiV1` currently exposes optional `chat` and `settings` hooks.

Chat hooks can resolve UI preferences such as assistant image auto-save location or profile-specific reasoning preference keys.

Settings hooks can customize Quick App profile presentation and legacy-profile migration behavior. Renderer hooks must not require secrets. If a hook needs privileged data, it should request it through a typed IPC service.

## Versioning policy

- V1 additions should be additive: new optional hooks, new optional fields, or new extension arrays.
- Existing hook names and parameter meanings should not change without introducing a V2 contract.
- Hooks should include stable `id` values for diagnostics and conflict handling.
- Open build defaults must remain safe and limited to public extensions (currently Codex and Tripo).

## Extension implementation rules

1. Depend on public contracts under `shared/extensions`, `main/extensions`, `renderer/src/extensions`, and `shared/api`.
2. Do not import private implementation modules from open source code.
3. Keep secrets in main-process configuration or main extensions. Never expose provider credentials through renderer hooks.
4. Make hooks optional and fail closed. If an extension cannot handle a profile/request, return `undefined` and let the host continue.
5. Avoid side effects in shared/renderer hooks except for explicit UI behavior.
6. Document any added IPC service in the downstream wrapper and keep request/response payloads structured-clone compatible.

## Relationship to the private wrapper

The private wrapper may populate these registries and provide proprietary assets or release automation. The open repository must not assume that wrapper exists. See [Private wrapper](private-wrapper.md).
