# canvas-thumbnail-sidecar

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

## Test

```bash
CARGO_TARGET_DIR=.cache/cargo-target/canvas-thumbnail-sidecar-worker cargo fmt --check --manifest-path packages/canvas-thumbnail-sidecar/Cargo.toml
CARGO_TARGET_DIR=.cache/cargo-target/canvas-thumbnail-sidecar-worker cargo test --manifest-path packages/canvas-thumbnail-sidecar/Cargo.toml
```
