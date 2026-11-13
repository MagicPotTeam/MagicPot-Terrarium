// REAL importer, tiny synthetic text and a deterministic staged IDB MODEL, never a native engine.
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it as rawIt, vi } from 'vitest'
import { importCanvasFile, loadCanvasItems } from './canvasStorage'

vi.mock('../QuickAppPage/components/QAppContext', () => ({ restoreGlobalQAppCache: vi.fn() }))
vi.mock('../ChatPage/chatPageShared', () => ({
  getDownloadFileNameFromUrl: vi.fn(), normalizeLocalMediaUrl: (value: string) => value
}))
vi.mock('../MainPage/projectStore', () => ({
  getProjectById: () => ({ name: 'Synthetic project', storageDirName: 'synthetic-project' }),
  buildProjectStorageDirName: () => 'synthetic-project'
}))

const failure = 'Unable to persist MagicPot canvas import assets without overwriting existing data'
const target = 'synthetic-assets-target'
const scope = (key: string, storeKey = target) => `${storeKey}::canvas::${key}`
const textItem = () => ({ id: 'synthetic-text', type: 'text', text: 'Synthetic only', x: 0, y: 0,
  width: 100, height: 30, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false,
  fontSize: 14, fontFamily: 'sans-serif', fill: '#111' })
const asset = (base64 = 'AQ==', mimeType = 'application/octet-stream') => ({ base64, mimeType })
const payload = (extra: Record<string, unknown> = {}) => ({ magic: 'MAGICPOT_CANVAS', version: 8,
  createdAt: 'synthetic', items: [textItem()], ...extra })
type Stored = { data: ArrayBuffer; mimeType: string }
type Callback = (event?: unknown) => void
type Request = { result?: unknown; onsuccess?: Callback; onerror?: Callback }
type Operation = { kind: 'add' | 'put' | 'get'; key: string; value?: Stored; request: Request }
type Tx = { id: number; operations: Operation[]; staged: Map<string, Stored>; processed: boolean;
  terminal?: 'complete' | 'abort'; failed: boolean; abortRequested: boolean; oncomplete?: Callback;
  onabort?: Callback; onerror?: Callback; objectStore: (name: string) => object; abort: () => void }
type Open = { request: Request & { transaction: { abort: () => void }; onupgradeneeded?: Callback };
  close: ReturnType<typeof vi.fn>; done: boolean; upgradeFailed: boolean }
type Observed<T> = { kind: 'pending' } | { kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown }

// Tasks and request errors are separated from terminal commit/abort. Rollback here is MODEL ONLY.
class DatabaseModel {
  data = new Map<string, Stored>()
  log: string[] = []
  tasks: Callback[] = []
  txs: Tx[] = []
  opens: Open[] = []
  callbackErrors: unknown[] = []
  observed: Array<() => string> = []
  nativeError = Object.create(null) as object
  diagnosticReads = vi.fn<() => void>()
  openErrorReads = vi.fn<() => void>()
  txErrorReads = vi.fn<() => void>()
  requestErrorReads = vi.fn<() => void>()
  preventDefault = vi.fn()
  openMode: 'success' | 'error' | 'upgrade-success' | 'upgrade-error' | 'upgrade-late-success' = 'success'
  holdOpenTerminal = false
  holdTerminal = false
  openThrows = false
  transactionThrows = false
  objectStoreThrows = false
  throwAddAt = 0
  errorAt = 0
  txErrorOnly = false
  abortThrows = false
  closeThrows = false
  upgradeThrowsAt = ''
  upgradeAbortThrows = false
  completeAfterError = false
  storeNames = new Set(['canvas-items', 'canvas-blobs'])
  constructor() {
    for (const key of ['name', 'message', 'stack', 'cause', 'toJSON']) {
      Object.defineProperty(this.nativeError, key, { enumerable: key === 'message',
        get: () => { this.diagnosticReads(); return key === 'message' ? 'synthetic native diagnostic' : undefined } })
    }
    Object.defineProperty(this.nativeError, Symbol.toPrimitive, {
      value: () => { this.diagnosticReads(); return 'synthetic native coercion' }
    })
  }
  invoke(callback?: Callback, event?: unknown) {
    try { callback?.(event) } catch (error) { this.callbackErrors.push(error) }
  }
  poisonRequest(read: () => void): Request {
    const request: Request = {}
    Object.defineProperty(request, 'error', { get: () => { read(); return this.nativeError } })
    return request
  }
  open = vi.fn((name: string, version: number) => {
    this.log.push(`open:${name}:${version}`)
    if (this.openThrows) throw this.nativeError
    const request = this.poisonRequest(this.openErrorReads) as Open['request']
    const close = vi.fn(() => { this.log.push(`close:${this.opens.indexOf(opened)}`); if (this.closeThrows) throw this.nativeError })
    const opened: Open = { request, close, done: false, upgradeFailed: false }
    const db = {
      objectStoreNames: { contains: (store: string) => this.storeNames.has(store) },
      createObjectStore: (store: string) => {
        this.log.push(`create:${store}`)
        if (this.upgradeThrowsAt === store) throw this.nativeError
        this.storeNames.add(store)
      },
      close,
      transaction: (store: string, mode: string) => this.transaction(store, mode)
    }
    request.result = db
    request.transaction = { abort: () => {
      this.log.push('upgrade-abort'); opened.upgradeFailed = true
      if (this.upgradeAbortThrows) throw this.nativeError
    } }
    this.opens.push(opened)
    this.tasks.push(() => {
      if (this.openMode.startsWith('upgrade-')) this.invoke(request.onupgradeneeded)
      if (!this.holdOpenTerminal) this.finishOpen(opened)
    })
    return request
  })
  finishOpen(opened: Open, mode = this.openMode) {
    if (opened.done) return
    opened.done = true
    const error = mode === 'error' || mode === 'upgrade-error'
    this.log.push(`open-terminal:${error ? 'error' : 'success'}`)
    this.invoke(error ? opened.request.onerror : opened.request.onsuccess)
  }
  transaction(storeName: string, mode: string) {
    this.log.push(`transaction:${storeName}:${mode}`)
    if (this.transactionThrows) throw this.nativeError
    const tx: Tx = { id: this.txs.length, operations: [], staged: new Map(), processed: false,
      failed: false, abortRequested: false,
      objectStore: (name: string) => {
        this.log.push(`store:${tx.id}:${name}`)
        if (this.objectStoreThrows) throw this.nativeError
        return {
          add: (value: Stored, key: string) => this.enqueue(tx, 'add', key, value),
          put: (value: Stored, key: string) => this.enqueue(tx, 'put', key, value),
          get: (key: string) => this.enqueue(tx, 'get', key)
        }
      },
      abort: () => {
        this.log.push(`abort-request:${tx.id}`); tx.abortRequested = true
        if (this.abortThrows) throw this.nativeError
      } }
    Object.defineProperty(tx, 'error', { get: () => { this.txErrorReads(); return this.nativeError } })
    this.txs.push(tx)
    this.tasks.push(() => this.processNext())
    return tx
  }
  enqueue(tx: Tx, kind: Operation['kind'], key: string, value?: Stored) {
    this.log.push(`${kind}:${tx.id}:${key}`)
    if (kind === 'add' && this.throwAddAt === tx.operations.length + 1) throw this.nativeError
    const request = this.poisonRequest(this.requestErrorReads)
    tx.operations.push({ kind, key, value, request })
    return request
  }
  processNext() {
    // Serial MODEL transactions: next one cannot evaluate occupancy before its predecessor terminal.
    const tx = this.txs.find((candidate) => !candidate.terminal)
    if (!tx || tx.processed) return
    tx.processed = true
    if (!tx.abortRequested) {
      for (const [index, op] of tx.operations.entries()) {
        const collision = op.kind === 'add' && (this.data.has(op.key) || tx.staged.has(op.key))
        if (collision || this.errorAt === index + 1) {
          tx.failed = true
          this.log.push(`request-error:${tx.id}:${index}`)
          const event = { target: op.request, preventDefault: this.preventDefault }
          if (!this.txErrorOnly) this.invoke(op.request.onerror, event)
          this.invoke(tx.onerror, event)
          break
        }
        if (op.kind === 'get') op.request.result = undefined
        else tx.staged.set(op.key, op.value!)
        this.log.push(`request-success:${tx.id}:${index}`)
        this.invoke(op.request.onsuccess)
      }
    }
    if (!this.holdTerminal) this.finish(tx, (tx.failed || tx.abortRequested) && !this.completeAfterError ? 'abort' : 'complete')
  }
  finish(tx: Tx, terminal: 'complete' | 'abort') {
    if (tx.terminal) return
    tx.terminal = terminal
    if (terminal === 'complete' && !tx.failed && !tx.abortRequested) {
      for (const [key, value] of tx.staged) this.data.set(key, value)
      this.log.push(`commit:${tx.id}`)
    } else tx.staged.clear()
    this.log.push(`terminal:${tx.id}:${terminal}`)
    this.invoke(terminal === 'complete' ? tx.oncomplete : tx.onabort)
    this.tasks.push(() => this.processNext())
  }
  async flush() {
    // Bounded microtask scheduling only; never wait on an unresolved product promise or native timer.
    for (let turn = 0; turn < 32; turn++) {
      const tasks = this.tasks.splice(0)
      for (const task of tasks) task()
      await Promise.resolve()
    }
  }
  watch<T>(promise: Promise<T>, label = 'caller') {
    const box: { state: Observed<T> } = { state: { kind: 'pending' } }
    this.observed.push(() => box.state.kind)
    void promise.then((value) => { box.state = { kind: 'fulfilled', value }; this.log.push(`${label}:fulfilled`) },
      (error: unknown) => { box.state = { kind: 'rejected', error }; this.log.push(`${label}:rejected`) })
    return box
  }
  async drain() {
    this.holdOpenTerminal = false; this.holdTerminal = false
    for (let turn = 0; turn < 8; turn++) {
      for (const opened of this.opens) this.finishOpen(opened)
      for (const tx of this.txs) if (!tx.terminal) this.finish(tx, 'abort')
      await this.flush()
    }
    // TEARDOWN ONLY: legacy saveBlobEntries has no onabort and would retain its local promise.
    // Deliver a synthetic cleanup callback after assertions, never counted as a transaction witness.
    // Correct strict implementations settle on terminal abort and never enter this recovery branch.
    if (this.observed.some((state) => state() === 'pending')) {
      this.log.push('teardown-only-legacy-promise-release')
      for (const tx of this.txs) if (tx.terminal === 'abort') this.invoke(tx.oncomplete)
      await this.flush()
    }
  }
}

let model: DatabaseModel
let undo: Array<() => void>
const createUrl = vi.fn<(blob: Blob) => string>(), revokeUrl = vi.fn()
const listFiles = vi.fn(), nativeRead = vi.fn(), nativeWrite = vi.fn(), fetchBoundary = vi.fn()
const getConfig = vi.fn(), getDirectories = vi.fn(), bridge = vi.fn()
let decode: ReturnType<typeof vi.spyOn>
let originalAtob: typeof atob
// Behavioral MODEL assertions belong to the body. Never let a later check erase a body error.
async function runWithChecks(run: () => unknown | Promise<unknown>, checks: ReadonlyArray<() => unknown | Promise<unknown>>) {
  const errors: unknown[] = []
  try { await run() } catch (error) { errors.push(error) }
  for (const check of checks) {
    try { await check() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Synthetic test body and MODEL check failures')
}
function it(title: string, run: () => Promise<void>) {
  rawIt(title, () => runWithChecks(run, [
    () => model.drain(),
    () => expect(model.observed.every((state) => state() !== 'pending')).toBe(true),
    () => expect(model.callbackErrors).toEqual([]),
    () => expect(fetchBoundary).not.toHaveBeenCalled(),
    () => expect(nativeWrite).not.toHaveBeenCalled()
  ]))
}
function replace(object: object, key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  Object.defineProperty(object, key, { configurable: true, writable: true, value })
  undo.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : Reflect.deleteProperty(object, key))
}
function file(value: unknown = payload({ blobs: { orphan: asset() } }), size?: unknown) {
  return { size, text: async () => typeof value === 'string' ? value : JSON.stringify(value),
    path: 'C:\\synthetic-assets-source\\canvas.mpcanvas' } as unknown as File
}
function start(value?: unknown, storeKey = target) { return model.watch(importCanvasFile(file(value), storeKey)) }
function rejected(box: { state: Observed<unknown> }) {
  expect(box.state.kind).toBe('rejected')
  if (box.state.kind !== 'rejected') return undefined
  expect(box.state.error).toBeInstanceOf(Error)
  expect((box.state.error as Error).message).toBe(failure)
  expect(Object.hasOwn(box.state.error as object, 'cause')).toBe(false)
  return box.state.error
}
function noDiagnostics() {
  expect(model.openErrorReads).not.toHaveBeenCalled(); expect(model.txErrorReads).not.toHaveBeenCalled()
  expect(model.requestErrorReads).not.toHaveBeenCalled(); expect(model.diagnosticReads).not.toHaveBeenCalled()
  expect(model.preventDefault).not.toHaveBeenCalled()
  expect(console.warn).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
}
function closedOnce() { expect(model.opens.length).toBeGreaterThan(0); for (const opened of model.opens) expect(opened.close).toHaveBeenCalledTimes(1) }
function noFallback() {
  expect(model.log.filter((entry) => /^(put|get):/.test(entry))).toEqual([])
  expect(listFiles).not.toHaveBeenCalled(); expect(nativeRead).not.toHaveBeenCalled()
  expect(nativeWrite).not.toHaveBeenCalled(); expect(fetchBoundary).not.toHaveBeenCalled()
}

beforeEach(() => {
  model = new DatabaseModel(); undo = []
  for (const mock of [createUrl, revokeUrl, listFiles, nativeRead, nativeWrite, fetchBoundary, getConfig, getDirectories, bridge]) mock.mockReset()
  createUrl.mockImplementation(() => `blob:synthetic-assets-${createUrl.mock.calls.length}`)
  listFiles.mockResolvedValue({ files: [] })
  nativeRead.mockImplementation(() => { throw new Error('Unexpected substituted file read') })
  nativeWrite.mockImplementation(() => { throw new Error('Unexpected substituted write') })
  fetchBoundary.mockImplementation(() => { throw new Error('Unexpected substituted fetch') })
  getConfig.mockResolvedValue({ config: {} }); getDirectories.mockResolvedValue({ state: {} })
  replace(globalThis, 'indexedDB', { open: model.open }); replace(globalThis, 'fetch', fetchBoundary)
  replace(URL, 'createObjectURL', createUrl); replace(URL, 'revokeObjectURL', revokeUrl)
  replace(window, 'api', { svcFs: { listFilesInFolder: listFiles, readTextFile: nativeRead,
    writeTextFile: nativeWrite, readFileFromPath: nativeRead, saveImageToPath: nativeWrite },
    svcState: { getConfig, getUserDataDirectoryState: getDirectories } })
  replace(window, 'path', path.win32); replace(window, 'electronFile', { getPathForFile: bridge })
  originalAtob = globalThis.atob
  decode = vi.spyOn(globalThis, 'atob')
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  localStorage.clear()
})
afterEach(async () => {
  try {
    await model.drain()
  } finally {
    vi.restoreAllMocks()
    for (const restore of undo.reverse()) restore()
    localStorage.clear()
  }
})

describe('test-only error aggregation preserves RED classification evidence', () => {
  const caught = (run: () => unknown) => {
    try { run() } catch (error) { return error }
    throw new Error('Synthetic assertion witness did not throw')
  }
  const outcome = (run: () => unknown | Promise<unknown>, checks: ReadonlyArray<() => unknown | Promise<unknown>>) =>
    runWithChecks(run, checks).then(() => ({ failed: false, error: undefined as unknown }), (error: unknown) => ({ failed: true, error }))
  it('retains primary body TypeError together with later actual assertion error', async () => {
    const primary = new TypeError('synthetic body runtime failure')
    const secondary = caught(() => expect(true).toBe(false))
    const result = await outcome(() => { throw primary }, [() => { throw secondary }])
    expect(result.failed).toBe(true); expect(result.error).toBeInstanceOf(AggregateError)
    expect((result.error as AggregateError).errors).toEqual([primary, secondary])
    expect((result.error as AggregateError).errors[0]).toBe(primary)
    expect((result.error as AggregateError).errors[1]).toBe(secondary)
  })
  it('retains body assertion and later check runtime failure without assertion-only masking', async () => {
    const primary = caught(() => expect(1).toBe(2)), secondary = new TypeError('synthetic invariant runtime failure')
    const result = await outcome(() => { throw primary }, [() => { throw secondary }])
    expect(result.failed).toBe(true); expect(result.error).toBeInstanceOf(AggregateError)
    expect((result.error as AggregateError).errors[0]).toBe(primary)
    expect((result.error as AggregateError).errors[1]).toBe(secondary)
  })
  it('retains an undefined primary throw instead of treating falsy exceptions as success', async () => {
    const secondary = caught(() => expect(false).toBe(true))
    const result = await outcome(() => { throw undefined }, [() => { throw secondary }])
    expect(result.failed).toBe(true); expect(result.error).toBeInstanceOf(AggregateError)
    expect((result.error as AggregateError).errors).toEqual([undefined, secondary])
  })
  it('preserves one body runtime rejection by exact identity when all checks pass', async () => {
    const primary = new TypeError('synthetic lone body failure'), check = vi.fn()
    const result = await outcome(async () => { throw primary }, [check])
    expect(result.failed).toBe(true); expect(result.error).toBe(primary); expect(check).toHaveBeenCalledTimes(1)
  })
  it('runs every later check after drain and an earlier check both reject', async () => {
    const drain = new Error('synthetic drain failure'), invariant = caught(() => expect(2).toBe(3)), tail = vi.fn()
    const result = await outcome(() => undefined, [async () => { throw drain }, () => { throw invariant }, tail])
    expect(result.failed).toBe(true); expect(result.error).toBeInstanceOf(AggregateError)
    expect((result.error as AggregateError).errors).toEqual([drain, invariant]); expect(tail).toHaveBeenCalledTimes(1)
  })
  it('retains both actual assertion errors instead of weakening either invariant', async () => {
    const first = caught(() => expect('first').toBe('other')), second = caught(() => expect('second').toBe('other'))
    const result = await outcome(() => { throw first }, [() => { throw second }])
    expect(result.failed).toBe(true); expect((result.error as AggregateError).errors).toEqual([first, second])
    expect((result.error as AggregateError).errors.map((error: Error) => error.name)).toEqual(['AssertionError', 'AssertionError'])
  })
  it('completes the body and every MODEL check in order when all succeed', async () => {
    const order: string[] = []
    const result = await outcome(async () => { order.push('body') }, [async () => { order.push('drain') }, () => { order.push('check') }])
    expect(result.failed).toBe(false); expect(result.error).toBeUndefined(); expect(order).toEqual(['body', 'drain', 'check'])
  })
})

describe('REAL explicit canvas import embedded-assets no-overwrite under substituted transaction MODEL', () => {
  it('uses only add for primary, model texture and unused assets with exact target keys and bytes', async () => {
    const data = payload({ items: [{ id: 'm', type: 'model3d', src: '', textures: { 't.png': '' } }],
      blobs: { m: asset('AQI=', 'model/gltf-binary'), 'm::tex::t.png': asset('Aw==', 'image/png'), orphan: asset('BA==') } })
    const box = start(data); await model.flush()
    expect(box.state.kind).toBe('fulfilled'); expect(model.open).toHaveBeenCalledExactlyOnceWith('magicpot-canvas', 2)
    expect(model.log.filter((entry) => entry.startsWith('transaction:'))).toEqual(['transaction:canvas-blobs:readwrite'])
    expect(model.log.filter((entry) => entry.startsWith('add:'))).toEqual(['add:0:' + scope('m'), 'add:0:' + scope('m::tex::t.png'), 'add:0:' + scope('orphan')])
    expect([...model.data.keys()]).toEqual([scope('m'), scope('m::tex::t.png'), scope('orphan')])
    expect([...new Uint8Array(model.data.get(scope('m'))!.data)]).toEqual([1, 2])
    expect(model.data.get(scope('m'))!.mimeType).toBe('model/gltf-binary')
    expect([...new Uint8Array(model.data.get(scope('m::tex::t.png'))!.data)]).toEqual([3])
    if (box.state.kind === 'fulfilled') expect(box.state.value.items[0]).toMatchObject({ id: 'm', src: 'blob:synthetic-assets-1', textures: { 't.png': 'blob:synthetic-assets-2' } })
    noFallback(); closedOnce(); noDiagnostics()
  })
  for (const [name, blobs] of [['absent', undefined], ['null', null], ['empty', {}]] as const) {
    it(`admits ${name} blobs and text-only legacy-size input without opening a database`, async () => {
      const box = start(payload({ blobs })); await model.flush()
      expect(box.state.kind).toBe('fulfilled'); expect(model.open).not.toHaveBeenCalled()
      expect(createUrl).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled()
    })
  }
  for (const [name, value] of [['wrong magic', payload({ magic: 'OTHER' })], ['null item', payload({ items: [null] })],
    ['bad final base64', payload({ blobs: { first: asset(), last: asset('A') } })]] as const) {
    it(`preserves preflight ${name} refusal before any asset boundary`, async () => {
      const box = start(value); await model.flush()
      expect(box.state.kind).toBe('rejected')
      if (box.state.kind === 'rejected') expect((box.state.error as Error).message).toBe('Invalid or oversized MagicPot canvas import')
      expect(model.open).not.toHaveBeenCalled(); expect(createUrl).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled()
    })
  }
  it('materializes all admitted bytes before starting the asset transaction', async () => {
    decode.mockImplementation((text: string) => { model.log.push('decode'); return originalAtob(text) })
    const box = start(payload({ blobs: { a: asset(), b: asset('Ag==') } })); await model.flush()
    expect(box.state.kind).toBe('fulfilled')
    const transactionIndex = model.log.indexOf('transaction:canvas-blobs:readwrite')
    expect(model.log.filter((entry) => entry === 'decode')).toHaveLength(4)
    expect(model.log.slice(transactionIndex + 1)).not.toContain('decode')
  })
  it('finishes both URL and strict-persistence decodes before opening the database', async () => {
    decode.mockImplementation((text: string) => { model.log.push('decode-before-open'); return originalAtob(text) })
    const box = start(payload({ blobs: { a: asset(), b: asset('Ag==') } })); await model.flush()
    expect(box.state.kind).toBe('fulfilled'); expect(decode).toHaveBeenCalledTimes(4)
    expect(model.open).toHaveBeenCalledExactlyOnceWith('magicpot-canvas', 2)
    expect(model.opens).toHaveLength(1)
    const openIndex = model.log.indexOf('open:magicpot-canvas:2')
    expect(openIndex).toBeGreaterThanOrEqual(4)
    expect(model.log.slice(0, openIndex)).toEqual(Array(4).fill('decode-before-open'))
    expect(model.log.slice(openIndex)).not.toContain('decode-before-open')
    expect(model.txs).toHaveLength(1); expect(createUrl).toHaveBeenCalledTimes(2)
    noFallback(); noDiagnostics(); closedOnce()
  })
  for (const failAt of [3, 4]) {
    it(`strict materialization decode failure at call ${failAt} denies before open and cleans both URL decodes`, async () => {
      decode.mockImplementation((text: string) => {
        if (decode.mock.calls.length === failAt) throw model.nativeError
        return originalAtob(text)
      })
      const box = start(payload({ storageMode: 'project',
        items: [{ id: 'i', type: 'image', src: 'assets/images/synthetic.png' }],
        blobs: { a: asset(), b: asset('Ag==') } }))
      await model.flush(); rejected(box)
      expect(decode).toHaveBeenCalledTimes(failAt); expect(createUrl).toHaveBeenCalledTimes(2)
      expect(revokeUrl.mock.calls.map(([url]) => url)).toEqual(['blob:synthetic-assets-1', 'blob:synthetic-assets-2'])
      expect(model.open).not.toHaveBeenCalled(); expect(model.opens).toHaveLength(0)
      expect(model.txs).toHaveLength(0); expect(model.data.size).toBe(0)
      expect(model.log.filter((entry) => /^(transaction|add|put|commit):/.test(entry))).toEqual([])
      noFallback(); noDiagnostics(); expect(console.log).not.toHaveBeenCalled()
    })
  }
  for (const key of ['first', 'middle', 'last']) {
    it(`refuses existing ${key} key and commits no preceding staged assets in the MODEL`, async () => {
      const existing = { data: new Uint8Array([99]).buffer, mimeType: 'existing/synthetic' }
      model.data.set(scope(key), existing)
      const box = start(payload({ blobs: { first: asset(), middle: asset('Ag=='), last: asset('Aw==') } })); await model.flush()
      rejected(box); expect([...model.data]).toEqual([[scope(key), existing]])
      expect(model.log.filter((entry) => entry.startsWith('commit:'))).toEqual([])
      expect(model.log.filter((entry) => entry.startsWith('abort-request:'))).toEqual(['abort-request:0'])
      closedOnce(); noFallback(); noDiagnostics()
      expect(revokeUrl.mock.calls.map(([url]) => url)).toEqual(['blob:synthetic-assets-1', 'blob:synthetic-assets-2', 'blob:synthetic-assets-3'])
    })
  }
  it('refuses identical existing bytes rather than deduplicating or overwriting', async () => {
    model.data.set(scope('orphan'), { data: new Uint8Array([1]).buffer, mimeType: 'application/octet-stream' })
    const before = model.data.get(scope('orphan')); const box = start(); await model.flush()
    rejected(box); expect(model.data.get(scope('orphan'))).toBe(before); noFallback()
  })
  it('admits an equal logical key in another target without touching existing scoped bytes', async () => {
    const existing = { data: new Uint8Array([7]).buffer, mimeType: 'existing/synthetic' }
    model.data.set(scope('orphan'), existing)
    const box = start(undefined, 'different-synthetic-target'); await model.flush()
    expect(box.state.kind).toBe('fulfilled'); expect(model.data.get(scope('orphan'))).toBe(existing)
    expect([...new Uint8Array(model.data.get(scope('orphan', 'different-synthetic-target'))!.data)]).toEqual([1])
    expect(model.data.size).toBe(2); noFallback(); closedOnce()
  })
  for (const key of ['unused-orphan', 'm::tex::t.png']) {
    it(`protects existing ${key} independently of scene item membership`, async () => {
      const existing = { data: new Uint8Array([9]).buffer, mimeType: 'existing/synthetic' }
      model.data.set(scope(key), existing)
      const box = start(payload({ blobs: { [key]: asset() } })); await model.flush()
      rejected(box); expect([...model.data]).toEqual([[scope(key), existing]]); noFallback()
    })
  }
  it('serial MODEL competing imports both settle terminally with exactly one commit/success and one abort/rejection', async () => {
    model.holdTerminal = true
    const first = start(payload({ blobs: { same: asset('AQ==') } }))
    const second = start(payload({ blobs: { same: asset('Ag==') } }))
    await model.flush()
    expect(model.txs).toHaveLength(2); expect(first.state.kind).toBe('pending'); expect(second.state.kind).toBe('pending')
    expect(model.data.size).toBe(0); expect(model.txs[1].processed).toBe(false)
    model.finish(model.txs[0], 'complete'); await model.flush()
    expect(first.state.kind).toBe('fulfilled'); expect(second.state.kind).toBe('pending')
    expect(model.txs[1].failed).toBe(true); expect(model.opens[1].close).not.toHaveBeenCalled()
    model.finish(model.txs[1], 'abort'); await model.flush()
    rejected(second); expect(model.log.filter((entry) => entry.startsWith('commit:'))).toEqual(['commit:0'])
    expect(model.txs.map((tx) => tx.terminal)).toEqual(['complete', 'abort'])
    expect([...new Uint8Array(model.data.get(scope('same'))!.data)]).toEqual([1])
    closedOnce(); noFallback(); noDiagnostics()
    expect(model.log.indexOf('caller:fulfilled')).toBeGreaterThan(model.log.indexOf('terminal:0:complete'))
    expect(model.log.indexOf('caller:rejected')).toBeGreaterThan(model.log.indexOf('terminal:1:abort'))
  })
  it('does not publish or close on request successes before transaction completion', async () => {
    model.holdTerminal = true; const box = start(); await model.flush()
    expect(model.log).toContain('request-success:0:0'); expect(box.state.kind).toBe('pending')
    expect(model.data.size).toBe(0); expect(model.opens[0].close).not.toHaveBeenCalled()
    model.finish(model.txs[0], 'complete'); await model.flush()
    expect(box.state.kind).toBe('fulfilled'); closedOnce()
    expect(model.log.indexOf('close:0')).toBeGreaterThan(model.log.indexOf('terminal:0:complete'))
  })
  for (const origin of ['request-error', 'transaction-error'] as const) {
    it(`keeps ${origin} and abort invocation nonterminal until actual abort event`, async () => {
      model.holdTerminal = true; model.errorAt = 1; model.txErrorOnly = origin === 'transaction-error'
      const box = start(); await model.flush()
      expect(box.state.kind).toBe('pending'); expect(model.opens[0].close).not.toHaveBeenCalled()
      expect(model.log.filter((entry) => entry.startsWith('abort-request:'))).toEqual(['abort-request:0'])
      expect(listFiles).not.toHaveBeenCalled(); expect(revokeUrl).not.toHaveBeenCalled()
      model.finish(model.txs[0], 'abort'); await model.flush()
      rejected(box); closedOnce(); noDiagnostics(); expect(model.preventDefault).not.toHaveBeenCalled()
    })
  }
  it('abort throwing does not replace failure or pretend terminal drainage', async () => {
    model.holdTerminal = true; model.errorAt = 1; model.abortThrows = true
    const box = start(); await model.flush()
    expect(box.state.kind).toBe('pending'); expect(model.opens[0].close).not.toHaveBeenCalled()
    expect(model.log.filter((entry) => entry.startsWith('abort-request:'))).toEqual(['abort-request:0'])
    model.finish(model.txs[0], 'abort'); await model.flush()
    rejected(box); closedOnce(); noDiagnostics()
  })
  it('native abort without preceding error rejects with fixed error only after terminal abort', async () => {
    model.holdTerminal = true; const box = start(); await model.flush()
    expect(box.state.kind).toBe('pending'); model.finish(model.txs[0], 'abort'); await model.flush()
    rejected(box); expect(model.data.size).toBe(0); closedOnce(); noDiagnostics()
  })
  it('a late complete signal after recorded transaction error cannot turn rejection into success', async () => {
    model.errorAt = 1; model.completeAfterError = true
    const box = start(); await model.flush()
    rejected(box); expect(model.data.size).toBe(0); closedOnce(); noDiagnostics()
  })
  for (const name of ['transaction', 'object-store', 'first-add', 'second-add'] as const) {
    it(`handles synchronous ${name} throw without queueing a tail or masking failure`, async () => {
      model.transactionThrows = name === 'transaction'; model.objectStoreThrows = name === 'object-store'
      model.throwAddAt = name === 'first-add' ? 1 : name === 'second-add' ? 2 : 0
      const box = start(payload({ blobs: { a: asset(), b: asset('Ag=='), c: asset('Aw==') } })); await model.flush()
      rejected(box); expect(model.data.size).toBe(0); closedOnce(); noFallback(); noDiagnostics()
      if (name !== 'transaction') expect(model.log.filter((entry) => entry.startsWith('abort-request:'))).toEqual(['abort-request:0'])
      const queuedAdds = model.log.filter((entry) => entry.startsWith('add:'))
      expect(queuedAdds).toHaveLength(name === 'first-add' ? 1 : name === 'second-add' ? 2 : 0)
    })
  }
  for (const at of [1, 2, 3]) {
    it(`denies asynchronous generic write error at queued request ${at} and attempts abort only once`, async () => {
      model.errorAt = at; const box = start(payload({ blobs: { a: asset(), b: asset('Ag=='), c: asset('Aw==') } })); await model.flush()
      rejected(box); expect(model.data.size).toBe(0); noFallback(); closedOnce(); noDiagnostics()
      expect(model.log.filter((entry) => entry.startsWith('abort-request:'))).toEqual(['abort-request:0'])
    })
  }
  for (const terminal of ['complete', 'abort'] as const) {
    it(`synchronous add throw waits for controlled ${terminal} terminal before close and rejection`, async () => {
      model.holdTerminal = true; model.throwAddAt = 2
      const box = start(payload({ blobs: { a: asset(), b: asset(), c: asset() } })); await model.flush()
      expect(box.state.kind).toBe('pending'); expect(model.opens[0].close).not.toHaveBeenCalled()
      model.finish(model.txs[0], terminal); await model.flush()
      rejected(box); closedOnce(); noDiagnostics(); expect(model.data.size).toBe(0)
    })
  }
  for (const mode of ['synchronous', 'asynchronous'] as const) {
    it(`sanitizes ${mode} database-open failure without reading native diagnostics`, async () => {
      model.openThrows = mode === 'synchronous'; model.openMode = mode === 'asynchronous' ? 'error' : 'success'
      const box = start(); await model.flush()
      rejected(box); noDiagnostics(); expect(model.txs).toHaveLength(0)
      for (const opened of model.opens) expect(opened.close).not.toHaveBeenCalled()
      expect(revokeUrl).toHaveBeenCalledTimes(1); noFallback()
    })
  }
  it('open error-request getter itself is unread, not merely absent from final fixed message', async () => {
    model.openMode = 'error'; const box = start(); await model.flush()
    rejected(box); expect(model.openErrorReads).not.toHaveBeenCalled(); expect(model.diagnosticReads).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled()
  })
  it('initializes exactly the existing two stores on strict same-schema upgrade success', async () => {
    model.openMode = 'upgrade-success'; model.storeNames.clear()
    const box = start(); await model.flush()
    expect(box.state.kind).toBe('fulfilled')
    expect(model.log.filter((entry) => entry.startsWith('create:'))).toEqual(['create:canvas-items', 'create:canvas-blobs'])
    expect(model.log).not.toContain('upgrade-abort'); closedOnce(); noDiagnostics(); noFallback()
  })
  for (const terminal of ['upgrade-error', 'upgrade-late-success'] as const) {
    for (const abortThrows of [false, true]) {
      it(`contains upgrade initialization throw until ${terminal} with upgrade-abort-throws=${abortThrows}`, async () => {
        model.openMode = terminal; model.storeNames.clear(); model.upgradeThrowsAt = 'canvas-blobs'
        model.holdOpenTerminal = true; model.upgradeAbortThrows = abortThrows
        const box = start(); await model.flush()
        expect(box.state.kind).toBe('pending'); expect(model.txs).toHaveLength(0)
        expect(model.callbackErrors).toEqual([]); expect(model.log.filter((entry) => entry === 'upgrade-abort')).toHaveLength(1)
        expect(model.opens[0].close).not.toHaveBeenCalled()
        model.finishOpen(model.opens[0]); await model.flush()
        rejected(box); noDiagnostics(); noFallback()
        expect(model.opens[0].close).toHaveBeenCalledTimes(terminal === 'upgrade-late-success' ? 1 : 0)
      })
    }
  }
  for (const outcome of ['success', 'failure'] as const) {
    it(`best-effort database-close throw preserves strict ${outcome} outcome after terminal`, async () => {
      model.closeThrows = true; model.errorAt = outcome === 'failure' ? 1 : 0
      const box = start(); await model.flush()
      if (outcome === 'failure') rejected(box)
      else expect(box.state.kind).toBe('fulfilled')
      closedOnce(); noDiagnostics(); expect(model.callbackErrors).toEqual([])
      expect(model.log.indexOf('close:0')).toBeGreaterThan(model.log.findIndex((entry) => entry.startsWith('terminal:0:')))
    })
  }
  it('attempts every created URL cleanup despite one cleanup throwing and preserves fixed write failure', async () => {
    model.errorAt = 2; revokeUrl.mockImplementationOnce(() => { throw model.nativeError })
    const box = start(payload({ blobs: { a: asset(), b: asset(), c: asset() } })); await model.flush()
    rejected(box); expect(revokeUrl.mock.calls.map(([url]) => url)).toEqual(['blob:synthetic-assets-1', 'blob:synthetic-assets-2', 'blob:synthetic-assets-3'])
    closedOnce(); noDiagnostics()
  })
  it('strict asset failure prevents project-reference listing and item restoration after created URLs', async () => {
    model.errorAt = 1
    const box = start(payload({ storageMode: 'project', items: [{ id: 'i', type: 'image', src: 'assets/images/synthetic.png' }], blobs: { orphan: asset() } }))
    await model.flush(); rejected(box); expect(createUrl).toHaveBeenCalledTimes(1)
    expect(listFiles).not.toHaveBeenCalled(); expect(revokeUrl).toHaveBeenCalledTimes(1); closedOnce()
  })
  it('preserves original valid later reference failure and retains already committed MODEL assets, not scene rollback', async () => {
    const original = new Error('synthetic later reference failure'); listFiles.mockRejectedValue(original)
    const box = start(payload({ storageMode: 'project', items: [{ id: 'i', type: 'image', src: 'assets/images/synthetic.png' }], blobs: { orphan: asset() } }))
    await model.flush(); expect(box.state.kind).toBe('rejected')
    if (box.state.kind === 'rejected') expect(box.state.error).toBe(original)
    expect(model.data.has(scope('orphan'))).toBe(true); expect(model.log).toContain('commit:0')
    expect(listFiles).toHaveBeenCalledTimes(1); expect(revokeUrl).toHaveBeenCalledTimes(1); closedOnce()
  })
  for (const version of [3, 7, 8]) {
    it(`preserves admitted v${version} metadata and ignored quick-app state with a first asset write`, async () => {
      const box = start(payload({ version, blobs: { orphan: asset() }, currentQAppKey: 'not-restored', qAppCache: { q: {} }, metadata: { arbitrary: true } }))
      await model.flush(); expect(box.state.kind).toBe('fulfilled')
      if (box.state.kind === 'fulfilled') { expect(box.state.value.items).toEqual([textItem()]); expect(box.state.value.qAppKey).toBeUndefined() }
      expect(localStorage.getItem('qapp.currentQAppKey')).toBeNull(); noFallback(); closedOnce()
    })
  }
  for (const mode of ['embedded', 'project', 'future-mode']) {
    it(`keeps ${mode} mode interpretation and first orphan asset write without remapping`, async () => {
      const box = start(payload({ storageMode: mode, blobs: { orphan: asset() } })); await model.flush()
      expect(box.state.kind).toBe('fulfilled'); expect([...model.data.keys()]).toEqual([scope('orphan')]); noFallback()
    })
  }
  it('ordinary project fallback stays read-only and does not replace a default-canvas binary', async () => {
    getDirectories.mockResolvedValue({ state: { autoSaveRoot: 'C:\\synthetic-autosave' } })
    nativeRead.mockResolvedValue({ content: JSON.stringify(payload({ blobs: { orphan: asset('Ag==') } })) })
    const before = { data: new Uint8Array([9]).buffer, mimeType: 'existing/synthetic' }
    model.data.set('default::canvas::orphan', before)
    const box = model.watch(loadCanvasItems(target)); await model.flush()
    expect(box.state.kind).toBe('fulfilled'); expect(nativeRead).toHaveBeenCalledTimes(1)
    if (box.state.kind === 'fulfilled') expect(box.state.value.items).toEqual([textItem()])
    expect(model.log.filter((entry) => /^(put|add):/.test(entry))).toEqual([])
    expect(model.data.get('default::canvas::orphan')).toBe(before)
    expect([...new Uint8Array(before.data)]).toEqual([9])
  })
  it('ordinary fallback restores without another database write when opening IDB fails', async () => {
    getDirectories.mockResolvedValue({ state: { autoSaveRoot: 'C:\\synthetic-autosave' } })
    nativeRead.mockResolvedValue({ content: JSON.stringify(payload({ blobs: { orphan: asset() } })) })
    model.openMode = 'error'
    const box = model.watch(loadCanvasItems(target)); await model.flush()
    expect(box.state.kind).toBe('fulfilled')
    if (box.state.kind === 'fulfilled') expect(box.state.value.items).toEqual([textItem()])
    expect(nativeRead).toHaveBeenCalledTimes(1); expect(model.data.size).toBe(0)
    expect(console.error).toHaveBeenCalled(); expect(model.openErrorReads).toHaveBeenCalled()
    expect(model.open).toHaveBeenCalledTimes(1)
    expect(model.log.filter((entry) => /^(put|add):/.test(entry))).toEqual([])
  })
})
