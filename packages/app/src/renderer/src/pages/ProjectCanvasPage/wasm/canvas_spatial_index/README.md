# Canvas spatial index WASM accelerator

This crate provides an optional Rust/WASM broadphase accelerator for the project canvas spatial index.

The renderer keeps the existing TypeScript spatial-index API and always has a JavaScript fallback. If the generated WASM files are missing or fail to load, the canvas continues to use the existing JavaScript implementation.

## Build

Install Rust and `wasm-pack`, then run from the repository root:

```bash
npm run build:canvas-spatial-index-wasm
```

The script writes the generated web-target bundle to:

```text
packages/app/src/renderer/public/wasm/canvas_spatial_index/
```

Expected generated files:

- `canvas_spatial_index.js`
- `canvas_spatial_index_bg.wasm`
- `canvas_spatial_index.d.ts`

## Contract

- Input bounds are a `Float64Array` flattened as `[minX, minY, maxX, maxY, ...]`.
- Query returns original entry indexes sorted in stable entry order.
- TypeScript still performs exact bounds verification after the accelerated broadphase.
- Invalid/missing candidates fall back to the JavaScript index.
