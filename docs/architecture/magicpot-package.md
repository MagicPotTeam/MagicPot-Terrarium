# MagicPot Package Architecture

## Scope

This document describes how MagicPot packages application capabilities, Quick Apps, and MagicAgent contributions for discovery and transport through MagicAgent. It focuses on the public package/catalog contracts in `packages/app/src/shared/app`, `packages/app/src/shared/qApp`, `packages/app/src/shared/magicAgentRuntime`, `packages/app/src/main/qApp`, `packages/app/src/main/magicAgentRuntime/package`, and the bundled `packages/qapps` content.

## Package meanings

MagicPot uses three related package concepts:

1. **Application package/build modes**: the Electron app can be built as `pure` or `embedded`, documented separately in build-mode docs. This controls whether runtime assets such as Python/ComfyUI are expected from the user or bundled by maintainers.
2. **MagicPot capability packages**: Quick Apps, custom skills, MCP servers, and core tools are described as catalog entries so MagicAgent and MCP clients can discover them consistently.
3. **MagicAgent packages**: installed user packages can contribute agent definitions and graph templates to the MagicAgent Platform catalog.

This document covers the second and third concepts, plus the Quick App export/import file shape.

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

MagicAgent Platform also has a graph catalog assembled by the main process:

```text
Built-in graph definitions
        +
User graph store
        +
Installed MagicAgent package graph contributions
        |
        v
svcMagicAgentPlatform.listGraphs / inspectGraph
        |
        +-- Agent Studio graph catalog
        +-- Run Graph preflight and execution
        +-- Run Detail graphSnapshot display
```

Package graph contributions enter the catalog as read-only templates. They are discoverable and inspectable, but not directly executable until forked into the user graph store.

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

## MagicAgent package manifest

MagicAgent packages use `magicpot-package.json` with a manifest versioned separately from Quick App packages. The manifest identifies package metadata and contribution entries:

```ts
{
  manifestVersion: 1,
  id: string,
  name: string,
  version: string,
  description?: string,
  author?: string,
  homepage?: string,
  license?: string,
  compatibleAppVersions?: string,
  keywords?: string[],
  contributions?: [
    {
      id: string,
      kind: 'agent' | 'graph' | 'tool' | 'trigger' | 'plugin',
      title?: string,
      description?: string,
      entry?: string,
      config?: Record<string, unknown>
    }
  ]
}
```

In v1.5, agent and graph contribution entries must be JSON files. Executable contribution kinds (`tool`, `trigger`, `plugin`) are reserved and rejected until a separate extension execution boundary exists.

## MagicAgent package graph contributions

A graph contribution is a validated `MagicAgentGraphDefinition` referenced by a manifest contribution with `kind: 'graph'`. Package graph handling is intentionally conservative:

- graph entries are validated during scan/install;
- entry paths must be relative package paths and cannot escape the package root;
- package graph definitions are listed/inspected as catalog templates with source package provenance;
- package graph templates are read-only and cannot be replaced in place through `createGraph`;
- package graph templates are not directly runnable by MagicAgent GraphRuntime in v1.5;
- Agent Studio may offer Fork, which deep-copies the package graph into the user graph store with a new user-owned graph id;
- the forked user graph keeps provenance metadata (`sourcePackageId`, package version, contribution id, original graph id) but must not expose local `packagePath`, `manifestPath`, or store directories.

This model lets packages distribute reusable workflows without letting installed package data silently gain execution authority. A forked graph is treated like any other user graph and must pass graph validation and permission preflight before each run.

## MagicAgent package store lifecycle

MagicAgent package IPC is main-process owned:

- `validatePackageManifest` validates manifest shape without installing.
- `scanPackage` reads a package under the configured package root and returns validation results with local paths redacted.
- `installPackage` validates, copies package contents into the managed store, writes install metadata, and replaces atomically where practical.
- `listPackages` returns installed package metadata with local paths redacted.
- `inspectPackage` returns installed package or local package validation with local paths redacted.
- `uninstallPackage` removes the installed package directory.

The package store rejects renderer-supplied arbitrary absolute paths by requiring package directories under the configured package root. Scans and installs reject symbolic links and enforce conservative resource limits for directory depth, file count, and total bytes.

## User graph persistence and package forks

User graph persistence is separate from package storage. Installing a package makes package graph templates visible in the catalog; it does not copy them into the user graph store. Forking performs that copy intentionally:

```text
Package graph template
  -> inspectGraph
  -> choose new user graph id/name
  -> createGraph({ route, graph: copiedDefinition, replace: false })
  -> user graph store persists copy
  -> runGraph executes forked user graph after preflight
```

If the source package is upgraded or uninstalled later, existing user forks and historical run `graphSnapshot` records remain inspectable. The fork should show stale/missing-source provenance rather than re-reading package files.

## Run snapshots and package provenance

When a graph run starts, the main process persists `graphSnapshot` and `permissionSnapshot` with the run. For package-derived graphs:

- `graphSnapshot` should include package provenance from the fork metadata, not local package paths;
- `permissionSnapshot` should show that execution used the user fork, not the read-only package template;
- Run Detail should remain usable after package uninstall because it reads the run snapshot, not package files.

## MCP and package discovery

The MCP platform turns catalog entries into MCP capability sources:

- app tools become MCP tool descriptors;
- app resources become MCP resource descriptors;
- transport/auth/state metadata remains available in catalog snapshots;
- external MCP client apps are enriched with live tool aliases and connection status.

This lets external agents discover both MagicPot's built-in capability package and configured external app packages without knowing the renderer's internal page structure. Package graph templates are not executable MCP tools by default; exposing graph execution externally requires the same route/session authorization, preflight, snapshots, and audit model as Agent Studio.

## Versioning and compatibility

Package compatibility follows these rules:

- Keep `QAPP_PACKAGE_MAGIC` stable for MagicPot Quick App package detection.
- Increment `QAPP_PACKAGE_VERSION` only when Quick App parsing semantics change.
- Keep `MAGIC_AGENT_PACKAGE_MANIFEST_VERSION` stable for MagicAgent package manifest semantics.
- Preserve backward parsers for older package versions where practical.
- Add new `QAppCfg`, MagicAgent agent spec, and MagicAgent graph fields as additive schema changes where possible.
- Use `compatibleAppVersions` when a package requires a feature only available in newer app versions.
- Do not rely on host-specific bundled runtime paths in package metadata; packages should describe requirements, not local machine state.

## Security and trust boundaries

- Quick App and MagicAgent packages are data, not executable TypeScript.
- Workflow/graph data can still cause model downloads, custom node prompts, tool calls, or ComfyUI execution once a user chooses to run a capability; user-facing import, fork, and run flows must validate and disclose requirements.
- Custom node URLs and model URLs should be treated as remote/untrusted inputs until the user chooses to install/download them.
- MCP server package/config entries may include commands, URLs, or headers; keep credentials in configuration and avoid exposing secrets in catalog resources.
- Renderer code should not read package files directly from arbitrary paths except through approved file selection and main-process services.
- MagicAgent package scan/install IPC is constrained to the configured package root; renderer-supplied arbitrary absolute paths are rejected before store access.
- Package store scans and install copies reject symbolic links and enforce conservative resource limits for directory depth, file count, and total bytes.
- Renderer-facing package responses redact local `sourcePath`, `packagePath`, `manifestPath`, package root, and store directory values; local paths remain main-process implementation details.
- Package graph templates are read-only/forkable; direct execution is denied so preflight cannot be bypassed by installed package data.
- Forked user graphs and all graph runs still require route authorization, graph validation, permission preflight, run/event persistence, and snapshot redaction.

## Package and graph test plan

Recommended coverage for Stage E:

- manifest validation accepts agent/graph JSON entries and rejects unknown fields, executable contribution kinds, unsafe entry paths, missing entries, and invalid graph definitions;
- scan/install reject symlinks, root escapes, excessive depth/file count/bytes, and redact local paths in errors/responses;
- installed package graph contributions appear in graph catalog as read-only, non-runnable, forkable templates with package provenance;
- direct `runGraph` against a package graph template is disabled in UI and denied in main-process preflight;
- fork flow creates a user graph copy with new id and provenance metadata, and the fork remains after package uninstall;
- `graphSnapshot` for runs of forked package graphs contains provenance but no local package paths;
- `permissionSnapshot` proves execution was authorized against the forked user graph;
- Run Detail remains available after package uninstall/upgrade by reading persisted snapshots and events.

## Adding a package/capability source

1. Add or extend shared descriptors in `packages/app/src/shared/app/types.ts`, `packages/app/src/shared/qApp/*`, or `packages/app/src/shared/magicAgentRuntime/*`.
2. Update catalog builders so the new package appears in `MagicPotAppCatalogSnapshot` or the MagicAgent graph catalog as appropriate.
3. If the package exposes tools/resources to MCP, update MCP platform source mapping.
4. If the package contributes graphs, keep package graph templates read-only and implement fork-to-user-graph behavior rather than direct mutation.
5. Add import/export/scan/install validation and compatibility tests.
6. Document user-visible trust prompts for remote downloads, custom nodes, credentials, mutating tools, graph preflight denials, or package graph fork behavior.
