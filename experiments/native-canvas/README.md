# Native Canvas experiment: bounded scene/working-set kernel

This directory is a bounded, dependency-free C++20 milestone only. It is not production integration and it does not enable or alter the existing Pixi/hybrid renderer.

## Scope

The kernel implements the first scene-delta boundary described in the restored design:

- `AddItems`, `RemoveItems`, `UpdateTransforms`, `UpdateSelection`, `SetViewport`, and `SetInteractionState`.
- Incremental own spatial index using bounded uniform-grid cell coverage.
- Cached conservative AABBs for arbitrary finite rotation and signed scales.
- Viewport culling with finite, bounded overscan and deterministic `ItemId` ordering.
- Bounded item/selection/index coverage capacity and explicit finite/overflow validation.
- Rejected deltas validate before mutation; capacity/invalid/replacement failures do not apply a partial delta.
- Selection and cache/index consistency validation for tests.

Coordinates use item center `(x, y)` and non-negative local dimensions. The transform may have negative scale values. Viewport `scale` is world-units per screen pixel inverse: a scale of `0.001` is accepted and queried without producing non-finite output.

## Build and test on Windows

From the repository root, use the installed Visual Studio 18 BuildTools CMake:

```powershell
$cmake = 'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
& $cmake -S experiments/native-canvas -B experiments/native-canvas/build -G 'Visual Studio 18 2026' -A x64
& $cmake --build experiments/native-canvas/build --config Release
& $cmake --build experiments/native-canvas/build --config Release --target test
& $cmake --test-dir experiments/native-canvas/build -C Release --output-on-failure
```

If the generator name differs in a future installation, run `& $cmake --help` and select the installed Visual Studio generator. No downloaded dependencies are needed.

## Diagnostic benchmark

```powershell
& experiments/native-canvas/build/Release/native_canvas_scene_benchmark.exe
```

The deterministic workload has 3,200 items and prints scene count, visible result count, checksum, and CPU-only headless query timings. These numbers are diagnostic kernel measurements only; they are not Canvas, GPU, frame-time, or end-to-end renderer claims.

## Explicit non-scope / promotion gate

Skia, a GPU backend, `nativeImage`, tile/decode/texture caches, render graph, Electron IPC, native presentation/surface interop, visual rendering, input integration, and visual-parity/A-B evidence are unimplemented. The production hybrid Pixi path remains authoritative. This milestone is only a tested native scene foundation; no production flag or package was changed. Any future promotion requires same-corpus, same-machine visual-quality A/B evidence and the broader performance/correctness gate, not this CPU-only benchmark alone.
