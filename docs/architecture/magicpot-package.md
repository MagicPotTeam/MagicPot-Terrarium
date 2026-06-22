# MagicPot Package Architecture

## Scope

This document describes how MagicPot packages application capabilities and Quick Apps for discovery and transport through MagicAgent. It focuses on the public package/catalog contracts in `packages/app/src/shared/app`, `packages/app/src/shared/qApp`, `packages/app/src/main/qApp`, and the bundled `packages/qapps` content.

## Package meanings

MagicPot uses two related package concepts:

1. **Application package/build modes**: the Electron app can be built as `pure` or `embedded`, documented separately in build-mode docs. This controls whether runtime assets such as Python/ComfyUI are expected from the user or bundled by maintainers.
2. **MagicPot capability packages**: Quick Apps, custom skills, MCP servers, and core tools are described as catalog entries so MagicAgent and MCP clients can discover them consistently.

This document covers the second concept, plus the Quick App export/import file shape.

## Unified app catalog

The shared app catalog builds a `MagicPotAppCatalogSnapshot`:

```ts
{
  schemaVersion: 1,
  generatedAt: string,
  apps: MagicPotAppDefinition[]
}
```

Each app definition includes:

- `id`, `name`, `description`;
- `enabled` and `status`;
- `transport`: `local`, `qapp`, `mcp`, `http`, or `bridge`;
- `source`: `magicpot-core`, `builtin`, `qapp`, `mcp-client`, `custom-skill`, and related source types;
- `capabilities`: tool descriptors and resource descriptors;
- optional `configRef`, `discovery`, and metadata.

The catalog combines:

- MagicPot Core tools and resources.
- Built-in Quick App helpers such as image interrogation and prompt translation.
- Configured external MCP servers.
- User custom skills.
- Runtime-enriched MCP tool aliases when MCP status is available.

## Catalog flow

```text
Config + custom skills + MCP runtime status
        |
        v
buildMagicPotAppCatalogSnapshot
        |
        +-- renderer settings/discovery views
        +-- MCP bridge resources: magicpot://chat/apps, magicpot://chat/tools
        +-- MCP platform managed source: app:<appId>
        +-- MagicAgent tool/resource discovery
```

## Quick App package file

A Quick App package is a JSON-compatible object with a magic marker:

```ts
{
  magic: 'MAGICPOT_QAPP',
  version: 2,
  name?: string,
  createdAt?: string,
  manifest?: {
    name: string,
    version: string,
    author?: string,
    description?: string,
    category?: string,
    source?: string,
    compatibleAppVersions?: string
  },
  cfg: QAppCfg,
  workflow: Workflow
}
```

The current package version is `2`. Version `1` packages are still parsed with compatibility defaults.

## Quick App manifest

The manifest is normalized on import/export:

- `name`: display name and fallback package key.
- `version`: Quick App package version, default `1.0.0`.
- `author`, `description`, `category`, `source`: optional metadata.
- `compatibleAppVersions`: simple constraints such as `*`, `>=1.0.109`, `^1.0.0`, `~1.0.0`, or exact versions.

If the current MagicPot version does not satisfy `compatibleAppVersions`, import logic returns a user-facing compatibility error.

## Quick App config (`QAppCfg`)

`QAppCfg` describes how the UI maps user inputs into a ComfyUI workflow. Important fields include:

- `icon`: app icon identifier/path.
- `customNodeUrls`: custom ComfyUI node sources required by the workflow.
- `requiredModels`: model files, sizes, base directories, relative directories, and download URLs.
- `autoInputs`: automatically populated inputs such as seed or LLM API config.
- `inputs`: ordered UI components such as prompt, text, image, video, mask, number, slider, size, select, LoRA chain, camera, section, and description.
- `outputNodeIds`: optional output filtering.
- `batchProcess`: optional batch image workflow settings.

Slots are JSON paths into the workflow object. Quick App input components should mutate workflow data only through declared slots.

## Quick App runtime relationship

```text
QApp package or bundled qapp
  cfg + workflow
        |
        v
Quick App renderer UI
  user inputs / auto inputs / validation
        |
        v
main-process QApp and Comfy services
  workflow preparation, file/model checks, queue submission
        |
        v
ComfyUI process/API
  prompt execution and output retrieval
```

MagicAgent does not execute Quick App workflows directly. It discovers Quick App helper capabilities through the app catalog and can use runtime tools/context to inspect workflow runs or artifacts.

## MCP and package discovery

The MCP platform turns catalog entries into MCP capability sources:

- app tools become MCP tool descriptors;
- app resources become MCP resource descriptors;
- transport/auth/state metadata remains available in catalog snapshots;
- external MCP client apps are enriched with live tool aliases and connection status.

This lets external agents discover both MagicPot's built-in capability package and configured external app packages without knowing the renderer's internal page structure.

## Versioning and compatibility

Package compatibility follows these rules:

- Keep `QAPP_PACKAGE_MAGIC` stable for MagicPot Quick App package detection.
- Increment `QAPP_PACKAGE_VERSION` only when parsing semantics change.
- Preserve backward parsers for older package versions where practical.
- Add new `QAppCfg` components as additive schema changes.
- Use `compatibleAppVersions` when a package requires a feature only available in newer app versions.
- Do not rely on host-specific bundled runtime paths in package metadata; packages should describe requirements, not local machine state.

## Security and trust boundaries

- Quick App packages are data, not executable TypeScript.
- Workflow data can still cause model downloads, custom node prompts, or ComfyUI execution; user-facing import and run flows must validate and disclose requirements.
- Custom node URLs and model URLs should be treated as remote/untrusted inputs until the user chooses to install/download them.
- MCP server package/config entries may include commands, URLs, or headers; keep credentials in configuration and avoid exposing secrets in catalog resources.
- Renderer code should not read package files directly from arbitrary paths except through approved file selection and main-process services.
- MagicAgent package scan/install IPC is constrained to the configured package root; renderer-supplied arbitrary absolute paths are rejected before store access.
- Package store scans and install copies reject symbolic links and enforce conservative resource limits for directory depth, file count, and total bytes.
- Renderer-facing package responses redact local `sourcePath`, `packagePath`, `manifestPath`, package root, and store directory values; local paths remain main-process implementation details.

## Adding a package/capability source

1. Add or extend shared descriptors in `packages/app/src/shared/app/types.ts` or `packages/app/src/shared/qApp/*`.
2. Update catalog builders so the new package appears in `MagicPotAppCatalogSnapshot`.
3. If the package exposes tools/resources to MCP, update MCP platform source mapping.
4. Add import/export validation and compatibility tests.
5. Document user-visible trust prompts for remote downloads, custom nodes, credentials, or mutating tools.
