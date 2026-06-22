# Project Canvas Asset Resource Engine

## Status and scope

Status: draft architecture and threat model for the Project Canvas Asset Resource Engine. This document is documentation-only; it describes the intended boundaries and acceptance rules for current thumbnail-cache work and any future Rust sidecar. It does not require a Rust sidecar to be present in open builds.

The engine is the Project Canvas subsystem that turns user-selected assets into canvas-safe runtime resources:

- source identity and metadata for local files;
- thumbnail-first image previews;
- thumbnail cache manifests and cache files;
- deferred source upgrades for high zoom or explicit user actions;
- benchmark and acceptance evidence for large boards.

Non-goals:

- no renderer access to raw Node.js, filesystem, subprocess, or sidecar APIs;
- no cache storage of original source files;
- no official acceptance based on diagnostic-only benchmark relaxations;
- no private implementation dependency in the public open repository.

## Boundary model

```text
Renderer Project Canvas
  |  UI events, canvas layout, thumbnail-first hydration
  |  window.api.svcCanvasThumbnail / svcFs
  v
Preload typed IPC bridge
  |
  v
Main process Asset Resource broker
  |  path canonicalization, cache-root confinement, manifest validation
  |  optional launch/control only; never exposed to renderer
  v
Optional Rust sidecar
  |  bounded decode/probe/thumbnail jobs for untrusted media bytes
  v
User-data thumbnail cache and user-selected source files
```

The renderer owns visual state and must treat all local asset paths, metadata, and cached thumbnails as untrusted data received through a typed bridge. The main process owns privileged filesystem work, cache root creation, manifest read/write, native thumbnail generation, and any future sidecar lifecycle. A Rust sidecar, if introduced, is a constrained worker for parsing hostile media inputs; it is not a trusted policy authority.

## Asset identity and cache key rules

An image source identity is valid only when all of the following are true:

1. The source is a user-selected local file or another explicitly approved local source.
2. The main process resolves the requested path, follows symlinks with a canonical/real path lookup, and confirms the target is a regular file.
3. The identity records the normalized canonical path, source byte size, and last-modified timestamp.
4. The cache key is derived from that identity and is treated as an index, not as a security boundary.
5. The renderer may use the identity for cache lookups, but the main process must re-validate cache paths and manifest payloads before reading or writing.

Path normalization for identity comparison should use forward slashes and lower-case Windows drive letters. Staleness is determined by identity mismatch: different cache key, canonical path, source size, or source modification time means the cached entry is stale and must not be used as a fresh thumbnail set.

## Cache manifest rules

Each thumbnail cache entry is a directory under the resolved thumbnail cache root:

```text
<cache-root>/<cache-key>/
  manifest.json
  128.webp|128.png
  256.webp|256.png
  512.webp|512.png
  1024.webp|1024.png
  2048.webp|2048.png
```

Manifest version 1 must contain:

| Field | Rule |
| --- | --- |
| `version` | Must be `1`. New incompatible layouts require a new version. |
| `cacheKey` | Must exactly match the cache entry directory key and the requested key. |
| `canonicalPath` | Must match the current source identity canonical path. |
| `sourceSizeBytes` | Must be finite, non-negative, and match the source identity size when read as fresh. |
| `sourceLastModifiedMs` | Must be finite, non-negative, and match the source identity timestamp when read as fresh. |
| `levels` | Must include the required thumbnail levels for a complete set: `128`, `256`, `512`, `1024`, and `2048` max side. |
| `levels[].filename` | Must be a safe basename ending in `.png` or `.webp`; no path separators, traversal, or absolute paths. |
| `levels[].src` | Not authoritative when persisted. The main process reconstructs renderer-visible URLs from verified cache paths. |
| `levels[].mimeType` | Must be `image/png` or `image/webp`. |
| `levels[].width`, `height`, `sizeBytes` | Must be finite positive dimensions and finite non-negative file size metadata. |
| `createdAt`, `updatedAt` | Must be ISO-like strings for observability; they are not freshness authority. |

Read behavior:

- A missing, malformed, stale, incomplete, or file-missing manifest is a cache miss/stale result, not a partial success.
- Warm-cache acceptance requires every manifest level file to exist inside the cache entry directory.
- A manifest must not be allowed to redirect reads outside the cache entry via `src`, `filename`, symlinks, or path traversal.

Write behavior:

- The expected file list is the manifest level list.
- Every expected level must be written for a complete set.
- Extra files in the write request are rejected unless they are explicitly referenced by the manifest.
- Persist the manifest without trusting renderer-provided `src` values; renderer-visible URLs are reconstructed after validation.
- Use atomic or near-atomic manifest replacement (`manifest.json.tmp` then rename) so readers do not accept half-written manifests.

## Path canonicalization and cache-root confinement

All privileged path decisions happen in the main process or in a future sidecar launched by the main process under the same policy.

Required rules:

1. Resolve source paths before use and canonicalize existing local files with real-path semantics.
2. Confirm the source is a regular file before reading, thumbnailing, or sending it to a sidecar.
3. Resolve the cache root to an absolute path. Production cache roots should live under the user-data directory by default.
4. For tests and benchmarks, any explicit cache root override must still be canonicalized and must not escape its allowed test artifact root.
5. Resolve every cache entry path as `<cache-root>/<safe-cache-key>` and verify `path.relative(cacheRoot, entryPath)` is neither outside nor absolute.
6. Resolve every cache file path as `<entry-dir>/<safe-filename>` and verify it remains inside the entry directory.
7. Reject filenames containing traversal segments, path separators, device names, or unsupported extensions.
8. Treat symlinked cache entries as hostile unless the resolved real path remains confined to the cache root.
9. Do not include full local paths or sidecar stack traces in renderer-visible errors unless a user action requires that path.

Cache confinement is mandatory for both official and diagnostic runs. Diagnostic mode may change workload size or watchdog thresholds, but it must not relax path validation or cache-root confinement.

## Thumbnail-first import contract

Large image import must prefer thumbnails before decoding or retaining source-resolution images:

1. Collect source metadata through main-process APIs.
2. Build source identity from canonical path, size, and modified time.
3. Try a warm thumbnail manifest read before loading the source image.
4. If the warm manifest is fresh and complete, hydrate the canvas item from the best thumbnail level for the current preview budget.
5. If no warm thumbnail exists, generate thumbnails through the browser worker path, native thumbnail path, or future sidecar path, then write a manifest-backed set.
6. Use placeholder assets only as temporary error/settling fallbacks; they must not be counted as official benchmark success after the settle window.
7. Defer source-resolution image decode and source texture retention until high zoom, explicit edit/export, or another feature requires it.
8. Revoke transient object URLs and release decoded source resources after thumbnails or display previews are available.

The official large-board import path is thumbnail-first. A path that imports thousands of images by eagerly decoding and retaining all sources is not acceptable even if it passes a smaller diagnostic smoke run.

## Resource budget

Resource budgets protect the user desktop from untrusted media and large-board workloads. The exact numeric limits may evolve, but these categories are required for official acceptance:

| Budget | Requirement |
| --- | --- |
| Source decode | Decode source-resolution pixels only when required; imported board display should use thumbnail or preview assets by default. |
| Thumbnail levels | Keep the fixed bounded level set (`128`, `256`, `512`, `1024`, `2048`) unless a versioned manifest migration changes it. |
| Cache storage | Store thumbnails and manifests, not original source files. Enforce safe names and cache-root confinement. |
| Renderer memory | Do not retain every imported source image in JS heap, DOM image objects, ImageBitmaps, WebGL textures, or object URLs. |
| GPU memory | Keep full source textures resident only for visible/high-zoom candidates; tiny overview zoom must suppress source textures. |
| CPU/decode concurrency | Bound worker/sidecar/native thumbnail jobs and support cancellation when an import is abandoned. |
| Sidecar output | Validate sidecar-reported dimensions, MIME type, byte length, and level count before caching. |
| Error paths | Fail closed to cache miss, placeholder, or skipped asset; do not bypass security limits to keep an import moving. |
| Benchmark memory | Official real-board runs keep the memory watchdog enabled with default soft/hard policy unless the benchmark policy is revised. |

Any future Rust sidecar must have documented per-job limits before it can be part of official acceptance: maximum input bytes, maximum decoded pixels, maximum page/layer/frame count where applicable, maximum output bytes, wall-clock timeout, idle timeout, concurrent job count, and cancellation semantics.

## Rust sidecar threat model draft

### Protected assets

- User-selected source files and directories.
- Thumbnail cache integrity and confinement.
- Application availability and UI responsiveness.
- User privacy: local paths, file names, media content, and metadata.
- Main-process privileges and release/update trust.

### Attacker-controlled inputs

- Malformed image, PSD, archive, Office, video, or 3D files.
- Files designed as decompression bombs, pixel bombs, recursive containers, or metadata bombs.
- Paths containing symlinks, junctions, traversal, special devices, unusual Unicode normalization, or case-collision tricks.
- Cache directories or manifests modified by local malware or by previous app versions.
- Sidecar protocol payloads if the renderer or another process can influence requests.

### Main threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Decoder memory corruption | Prefer memory-safe Rust crates where practical; isolate decode/probe work in the sidecar process; treat crashes as job failure. |
| Sidecar privilege expansion | Main launches only a packaged, expected sidecar path without a shell; renderer never launches or talks to the sidecar directly. |
| Protocol injection/desync | Use a length-delimited, schema-versioned protocol; cap message size; reject unknown required fields. |
| Path traversal | Main canonicalizes source paths and confines cache output paths before a sidecar job; sidecar output filenames are ignored or revalidated. |
| Symlink/junction escape | Resolve real paths for existing files and cache entries; compare resolved paths against allowed roots. |
| Resource exhaustion | Enforce file size, pixel count, frame/page/layer count, output byte, concurrency, and timeout limits. |
| Cache poisoning | Validate manifest identity and every level file; do not trust persisted `src`; reject stale/incomplete manifests. |
| Data exfiltration | Sidecar has no network requirement; do not pass secrets; scrub logs; return only needed metadata/thumbnails. |
| UI denial of service | Run sidecar work off the renderer; surface progress/cancellation; keep thumbnail-first hydration and placeholders available. |
| Binary replacement | Release builds should package/sign or hash-check the sidecar; development builds must make the sidecar path explicit and observable. |
| Confused deputy writes | Sidecar writes, if allowed at all, must target only main-created temp/cache locations; main performs final validation and move. |

### Sidecar process rules

- No direct renderer bridge.
- No inherited secrets beyond the minimal environment needed to run.
- No shell invocation for sidecar startup or nested tools.
- No network access requirement for thumbnail/probe jobs.
- Job request includes a request ID, operation, canonical source reference, requested levels, and limits.
- Job response includes request ID, status, dimensions, MIME, byte lengths, and thumbnail bytes or temp-file handles.
- Unknown errors become structured failures; crashes do not corrupt cache state.
- Main verifies every response before writing manifests or exposing URLs.

### Residual risks

Local malware with the user's permissions can still modify user files or cache files between checks. Official acceptance therefore relies on repeated validation at read/write boundaries, fail-closed cache handling, and benchmark evidence rather than assuming local files are trustworthy.

## Official vs diagnostic benchmark rules

Official benchmark acceptance is intentionally stricter than profiling or smoke diagnostics.

### Official acceptance

An official Project Canvas real-board acceptance run must:

- run from a clean built app for the candidate commit;
- use the documented large-board scenario target, including `mixed-3000` for the 3000-image mixed real-board path when that scenario is under review;
- use a real corpus with enough unique image contents for the requested image count;
- run the required cold-cache and warm-cache passes for configured real corpora;
- keep the memory watchdog enabled with the default official soft/hard thresholds;
- keep the official image count and pressure duration for the scenario;
- produce aggregate/report artifacts showing cache hits/generation, visual acceptance, pressure sampling, and memory watchdog status;
- pass without permanent placeholders, missing images, source-upgrade failures, maximum-update-depth errors, right-side occlusion, excessive React commits, sustained monotonic growth, or warm-cache regeneration above the official limit.

### Diagnostic-only runs

Diagnostic runs are useful for reproduction, smoke testing, and narrowing failures, but they are not official acceptance. The following settings are diagnostic only:

- `MAGICPOT_REAL_BOARD_ALLOW_REPEAT=1` / `ALLOW_REPEAT` behavior;
- raising the benchmark memory watchdog thresholds;
- disabling the benchmark memory watchdog;
- lowering `MAGICPOT_REAL_BOARD_IMAGE_COUNT` below the official scenario target;
- lowering corpus uniqueness requirements such as `MAGICPOT_REAL_BOARD_REPEAT_MIN_UNIQUE_FRACTION`;
- shortening pressure duration or skipping warm-cache passes required by the official scenario.

A result produced with `ALLOW_REPEAT`, a raised or disabled watchdog, or a lowered image count must be labeled diagnostic and must not be used as official acceptance evidence.

## Criteria A-M checklist

Use this checklist for Project Canvas Asset Resource Engine design reviews and performance sign-off.

| Criterion | Requirement | Evidence |
| --- | --- | --- |
| A. Boundary separation | Renderer uses typed IPC only; main owns filesystem/cache/sidecar policy. | Architecture review or IPC contract diff. |
| B. Source canonicalization | Source paths are resolved, real-pathed, and confirmed as regular files. | Main-service tests or threat-model review. |
| C. Cache-root confinement | Every cache entry/file path is proven inside the cache root after resolution. | Path traversal and symlink tests. |
| D. Manifest validation | Version, identity, level list, filenames, MIME, dimensions, and file presence are validated. | Manifest unit tests and warm-cache benchmark artifacts. |
| E. Thumbnail-first import | Warm thumbnails are attempted before source decode; generation writes a complete manifest-backed set. | Import tests and large-board cache metrics. |
| F. Deferred source upgrade | Source-resolution resources are loaded only for visible/high-zoom/edit/export needs and can be released. | WebGL/source-retention metrics. |
| G. Resource budgets | Decode, memory, GPU, worker/sidecar concurrency, and output sizes are bounded. | Runtime metrics and watchdog report. |
| H. Sidecar containment | Any Rust sidecar is main-launched, schema-bounded, no-network, cancellable, and fail-closed. | Sidecar threat-model review before enablement. |
| I. Cache poisoning resistance | Persisted manifests cannot redirect reads, escape roots, or override identity freshness. | Security tests and code review. |
| J. Official benchmark integrity | Official runs keep unique corpus, image count, watchdog, pressure, and cache-pass requirements intact. | Perf aggregate report and command/env capture. |
| K. Diagnostic labeling | Relaxed runs are clearly labeled diagnostic and never counted as acceptance. | Perf logs/report metadata. |
| L. Observability | Failures expose actionable status without leaking secrets or unnecessary full paths. | Report artifacts and renderer/main error review. |
| M. Open/private neutrality | Public docs and code do not depend on private sidecar/provider modules. | Open-candidate check and architecture review. |
