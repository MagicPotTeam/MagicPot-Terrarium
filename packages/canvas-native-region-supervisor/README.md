# canvas-native-region-supervisor

A deliberately small, opt-in native region/tile backend prototype for Project Canvas.
It reads one JSON request from stdin and writes one JSON response to stdout. The prototype
is suitable for a controlled A/B experiment and is **not** yet wired into Electron.

## Request

```json
{
  "sourcePath": "./fixtures/large.png",
  "allowedRoots": ["./fixtures"],
  "x": 0,
  "y": 0,
  "width": 512,
  "height": 512,
  "maxOutputPixels": 1048576,
  "maxOutputBytes": 8388608,
  "timeoutMs": 5000,
  "cacheRoot": "./.cache/canvas-regions"
}
```

The source is canonicalized and must be inside one of `allowedRoots`. The decoder accepts
PNG/JPEG/WebP/BMP, crops the requested region, encodes PNG, and atomically publishes a
content-keyed cache file. The response contains dimensions, byte count, cache path, and
optional base64 output.

Limits are enforced before allocation/output publication. `timeoutMs` is a cooperative
soft deadline checked at bounded stages; it is not an OS-level kill. A production supervisor
still needs a separate child process, cancellation pipe, hard timeout/kill, RSS watchdog,
crash restart policy, and an IPC integration with the browser tile worker. No native path is
enabled by default by this crate.

## Verification

```bash
cargo fmt --check --manifest-path packages/canvas-native-region-supervisor/Cargo.toml
cargo test --manifest-path packages/canvas-native-region-supervisor/Cargo.toml
```
