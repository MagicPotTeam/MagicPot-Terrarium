/* @ts-self-types="./canvas_spatial_index.d.ts" */

export class SpatialIndex {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    SpatialIndexFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_spatialindex_free(ptr, 0)
  }
  /**
   * @returns {number}
   */
  cell_count() {
    const ret = wasm.spatialindex_cell_count(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * @returns {number}
   */
  entry_count() {
    const ret = wasm.spatialindex_entry_count(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * @returns {number}
   */
  max_indexed_cells_per_entry() {
    const ret = wasm.spatialindex_max_indexed_cells_per_entry(this.__wbg_ptr)
    return ret
  }
  /**
   * @param {Float64Array} flattened_bounds
   * @param {number} cell_size
   * @param {number} max_indexed_cells_per_entry
   * @param {number} max_query_cells
   */
  constructor(flattened_bounds, cell_size, max_indexed_cells_per_entry, max_query_cells) {
    const ptr0 = passArrayF64ToWasm0(flattened_bounds, wasm.__wbindgen_malloc)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.spatialindex_new(
      ptr0,
      len0,
      cell_size,
      max_indexed_cells_per_entry,
      max_query_cells
    )
    this.__wbg_ptr = ret
    SpatialIndexFinalization.register(this, this.__wbg_ptr, this)
    return this
  }
  /**
   * @returns {number}
   */
  overflow_entry_count() {
    const ret = wasm.spatialindex_overflow_entry_count(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * @param {Float64Array} query_bounds
   * @returns {Uint32Array}
   */
  query(query_bounds) {
    const ptr0 = passArrayF64ToWasm0(query_bounds, wasm.__wbindgen_malloc)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.spatialindex_query(this.__wbg_ptr, ptr0, len0)
    var v2 = getArrayU32FromWasm0(ret[0], ret[1]).slice()
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4)
    return v2
  }
}
if (Symbol.dispose) SpatialIndex.prototype[Symbol.dispose] = SpatialIndex.prototype.free
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg___wbindgen_throw_bbadd78c1bac3a77: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1))
    },
    __wbindgen_init_externref_table: function () {
      const table = wasm.__wbindgen_externrefs
      const offset = table.grow(4)
      table.set(0, undefined)
      table.set(offset + 0, undefined)
      table.set(offset + 1, null)
      table.set(offset + 2, true)
      table.set(offset + 3, false)
    }
  }
  return {
    __proto__: null,
    './canvas_spatial_index_bg.js': import0
  }
}

const SpatialIndexFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg_spatialindex_free(ptr, 1))

function getArrayU32FromWasm0(ptr, len) {
  ptr = ptr >>> 0
  return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len)
}

let cachedFloat64ArrayMemory0 = null
function getFloat64ArrayMemory0() {
  if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
    cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer)
  }
  return cachedFloat64ArrayMemory0
}

function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len)
}

let cachedUint32ArrayMemory0 = null
function getUint32ArrayMemory0() {
  if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
    cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer)
  }
  return cachedUint32ArrayMemory0
}

let cachedUint8ArrayMemory0 = null
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer)
  }
  return cachedUint8ArrayMemory0
}

function passArrayF64ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 8, 8) >>> 0
  getFloat64ArrayMemory0().set(arg, ptr / 8)
  WASM_VECTOR_LEN = arg.length
  return ptr
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
cachedTextDecoder.decode()
const MAX_SAFARI_DECODE_BYTES = 2146435072
let numBytesDecoded = 0
function decodeText(ptr, len) {
  numBytesDecoded += len
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
    cachedTextDecoder.decode()
    numBytesDecoded = len
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len))
}

let WASM_VECTOR_LEN = 0

let wasmModule, wasmInstance, wasm
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance
  wasm = instance.exports
  wasmModule = module
  cachedFloat64ArrayMemory0 = null
  cachedUint32ArrayMemory0 = null
  cachedUint8ArrayMemory0 = null
  wasm.__wbindgen_start()
  return wasm
}

async function __wbg_load(module, imports) {
  if (typeof Response === 'function' && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      try {
        return await WebAssembly.instantiateStreaming(module, imports)
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type)

        if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
          console.warn(
            '`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n',
            e
          )
        } else {
          throw e
        }
      }
    }

    const bytes = await module.arrayBuffer()
    return await WebAssembly.instantiate(bytes, imports)
  } else {
    const instance = await WebAssembly.instantiate(module, imports)

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module }
    } else {
      return instance
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case 'basic':
      case 'cors':
      case 'default':
        return true
    }
    return false
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ;({ module } = module)
    } else {
      console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
    }
  }

  const imports = __wbg_get_imports()
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module)
  }
  const instance = new WebAssembly.Instance(module, imports)
  return __wbg_finalize_init(instance, module)
}

async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm

  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ;({ module_or_path } = module_or_path)
    } else {
      console.warn(
        'using deprecated parameters for the initialization function; pass a single object instead'
      )
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL('canvas_spatial_index_bg.wasm', import.meta.url)
  }
  const imports = __wbg_get_imports()

  if (
    typeof module_or_path === 'string' ||
    (typeof Request === 'function' && module_or_path instanceof Request) ||
    (typeof URL === 'function' && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path)
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports)

  return __wbg_finalize_init(instance, module)
}

export { initSync, __wbg_init as default }
