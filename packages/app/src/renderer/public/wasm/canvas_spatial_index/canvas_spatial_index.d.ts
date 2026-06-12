/* tslint:disable */
/* eslint-disable */

export class SpatialIndex {
  free(): void
  [Symbol.dispose](): void
  cell_count(): number
  entry_count(): number
  max_indexed_cells_per_entry(): number
  constructor(
    flattened_bounds: Float64Array,
    cell_size: number,
    max_indexed_cells_per_entry: number,
    max_query_cells: number
  )
  overflow_entry_count(): number
  query(query_bounds: Float64Array): Uint32Array
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module

export interface InitOutput {
  readonly memory: WebAssembly.Memory
  readonly __wbg_spatialindex_free: (a: number, b: number) => void
  readonly spatialindex_cell_count: (a: number) => number
  readonly spatialindex_entry_count: (a: number) => number
  readonly spatialindex_max_indexed_cells_per_entry: (a: number) => number
  readonly spatialindex_new: (a: number, b: number, c: number, d: number, e: number) => number
  readonly spatialindex_overflow_entry_count: (a: number) => number
  readonly spatialindex_query: (a: number, b: number, c: number) => [number, number]
  readonly __wbindgen_externrefs: WebAssembly.Table
  readonly __wbindgen_malloc: (a: number, b: number) => number
  readonly __wbindgen_free: (a: number, b: number, c: number) => void
  readonly __wbindgen_start: () => void
}

export type SyncInitInput = BufferSource | WebAssembly.Module

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>
): Promise<InitOutput>
