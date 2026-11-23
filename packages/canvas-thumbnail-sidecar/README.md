# canvas-thumbnail-sidecar

- GIF input is intentionally deferred: enabling `image/gif` requires a safely regenerated `Cargo.lock`; the required transitive crates were not present in the local registry cache and no Rust toolchain was available.
- `maxSourceBytes`, `maxOutputPixels`, and `maxGeneratedBytes` are optional hardening limits in addition to `maxDecodedPixels`.
- Outputs use content-keyed filenames and are encoded to temporary files, cumulatively size-checked, then published before the versioned manifest. Failed publication preserves prior cache entries and cleans only newly created files/temps.

Rust/native thumbnail sidecar for Project Canvas local image assets. The crate is standalone and reads a JSON batch request from stdin (or `--input`) and writes a JSON batch response to stdout.

## CLI

```bash
cargo run --manifest-path packages/canvas-thumbnail-sidecar/Cargo.toml -- <<'JSON'
{
  "cacheRoot": "./.cache/canvas-thumbnails",
  "maxConcurrency": 2,
  "maxDecodedPixels": 16777216,
  "thumbnail": {
    "levels": [128, 256, 512, 1024, 2048],
    "format": "png",
    "allowUpscale": false
  },
  "items": [
    { "id": "asset-1", "path": "./fixtures/example.png" }
  ]
}
JSON
```

A response contains one result per item. Per-file failures are returned in that item's `error` field and do not fail the whole batch.

## Request schema

- `cacheRoot` (string): directory where thumbnails/manifests are written. Relative paths are resolved against the current working directory.
- `items` (array): `{ "id": string, "path": string }` entries.
- `thumbnail` (optional):
  - `levels` (number[]): max-side levels to generate. Defaults to `[128, 256, 512, 1024, 2048]`.
  - `maxSide` (number): compatibility shortcut for a single level when `levels` is omitted.
  - `maxWidth` + `maxHeight` (number): compatibility shortcut for a single level using `min(maxWidth, maxHeight)` when `levels`/`maxSide` are omitted.
  - `allowUpscale` (boolean): defaults to `false`; when false, levels larger than the source dimensions emit a source-sized image rather than upscaling.
  - `format`: `"png"` (default), `"webp"`, `"jpg"`, or `"jpeg"`.
- `hash` (optional): `"blake3"` (default) or `"sha256"`; both are streamed in bounded chunks.
- `maxConcurrency` (optional): bounded worker count. Defaults to available parallelism, capped by item count.
- `maxDecodedPixels` (optional): decode guard; files exceeding width × height are rejected before decoding.

## Output files and JSON

For each successful file the sidecar writes under `cacheRoot/<cacheKey>/`:

- `<maxSide>.<ext>` for each generated level.
- `manifest.json` with ProjectCanvas-compatible identity and level metadata.

Each successful result includes a `manifest` containing:

- `version`/`schemaVersion`.
- `cacheKey`, `canonicalPath`, `sourceSizeBytes`, `sourceLastModifiedMs`, `sourceWidth`, `sourceHeight`.
- `sourceIdentity` with `kind: "local-file"`, canonical path, size, mtime, cache key and cache root.
- streamed `hash` (`algorithm`, `hex`).
- `levels[]` with `maxSide`, `width`, `height`, `filename`, absolute `path`, `src` (`local-media:` URL), `mimeType`, and `sizeBytes`.

Output path construction is confined to `cacheRoot`, and JSON uses UTF-8-lossy display strings so Windows and Chinese paths remain supported by `PathBuf` internally.

## Build/package integration

Build the release binary and copy it into the Electron runtime assets tree with:

```bash
npm run build:image-worker
```

The build script runs `cargo build --release --manifest-path packages/canvas-thumbnail-sidecar/Cargo.toml` with `CARGO_TARGET_DIR` set to `<repo>/.cache/cargo-target/canvas-thumbnail-sidecar`, then writes the packaged binary to:

```text
packages/runtime-assets/resources/bin/image-worker/${process.platform}-${process.arch}/magicpot-image-worker(.exe)
```

This creates a local packaging artifact; generated binaries are ignored by git and should be produced by the target-platform packaging job before `electron-builder` runs. Runtime IPC/resolver wiring is intentionally not included here.

electron-builder also copies `packages/runtime-assets/resources/bin` to `<install dir>/bin`, next to the executable; the main process looks there before any cwd-relative location, so the packaged app does not depend on the shortcut's working directory.

`npm run dev` (via `scripts/run-electron-vite.mjs` and `scripts/dev-image-worker.mjs`) publishes the same binary to the same `packages/runtime-assets` path, which the main process finds relative to the dev cwd. It skips cargo when the binary is newer than `Cargo.toml`, `Cargo.lock` and `src/`, uses `cargo` from `PATH` or `~/.cargo/bin`, builds with `CARGO_NET_OFFLINE=true`, and only warns on failure (thumbnails then fall back to the original image). The first build needs the crates already downloaded: run `npm run build:image-worker` once while online. Setting `MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH` skips the dev build.

## Test

```bash
CARGO_TARGET_DIR=.cache/cargo-target/canvas-thumbnail-sidecar-worker cargo fmt --check --manifest-path packages/canvas-thumbnail-sidecar/Cargo.toml
CARGO_TARGET_DIR=.cache/cargo-target/canvas-thumbnail-sidecar-worker cargo test --manifest-path packages/canvas-thumbnail-sidecar/Cargo.toml
```
