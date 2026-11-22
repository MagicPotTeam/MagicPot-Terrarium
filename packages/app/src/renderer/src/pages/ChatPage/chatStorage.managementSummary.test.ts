import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readExistingSessionSummaries } from './chatStorage'

const service = vi.hoisted(() => vi.fn(() => { throw new Error('Metadata must not access managed-media or MAIN') }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: service }))

type Options = {
  inventory?: Array<{ name: string; version: number }>
  enumeration?: 'unsupported' | 'reject' | 'hang'
  disappear?: boolean
  openDelay?: number
  blocked?: boolean
  dbVersion?: number
  storeMissing?: boolean
  keyPath?: string
  requestErrorAt?: number
  finish?: 'abort' | 'close' | 'versionchange' | 'hang'
  beforeComplete?: () => void
}
type Row = Record<string, unknown>
const scope = 'tab-project-p.agent-1'
const row = (id = 'same-id', storageScope = scope, extra: Row = {}): Row => ({ id, storageScope, storageKey: `${storageScope}\0${id}`, title: 'Existing title', createdAt: 7, messages: [{ content: 'SECRET_MESSAGES' }], draft: { inputValue: 'SECRET_DRAFT' }, sessionUrl: 'SECRET_URL', ...extra })
function fakeDatabase(rows: Row[] = [], options: Options = {}) {
  const state = { opens: 0, scans: 0, aborts: 0, closes: 0, upgradeAborts: 0, committedCreates: 0, continuations: 0, modes: [] as string[], getAll: 0, primaryKeyOverride: undefined as unknown }
  let tx: Record<string, unknown> | undefined
  const db: Record<string, unknown> = {
    version: options.dbVersion ?? 2,
    objectStoreNames: { contains: (name: string) => !options.storeMissing && name === 'sessions-v2' },
    close: () => { state.closes++ },
    transaction: (name: string, mode: string) => {
      expect(name).toBe('sessions-v2'); state.modes.push(mode)
      let aborted = false
      tx = { abort: () => { if (aborted) return; aborted = true; state.aborts++; setTimeout(() => (tx?.onabort as (() => void) | undefined)?.(), 0) } }
      tx.objectStore = () => ({
        keyPath: options.keyPath ?? 'storageKey',
        getAll: () => { state.getAll++; throw new Error('getAll is forbidden') },
        openCursor: () => {
          state.scans++
          const request: Record<string, unknown> = {}
          const visit = (index: number) => {
            if (aborted) return
            if (options.requestErrorAt === index) { request.error = new DOMException('Injected read error'); (request.onerror as (() => void))?.(); return }
            request.result = index < rows.length ? { value: rows[index], primaryKey: state.primaryKeyOverride ?? rows[index].storageKey, continue: () => { state.continuations++; setTimeout(() => visit(index + 1), 0) } } : null
            ;(request.onsuccess as (() => void))?.()
            if (index === rows.length) {
              options.beforeComplete?.()
              setTimeout(() => {
                if (aborted) return
                if (options.finish === 'hang') return
                if (options.finish === 'abort') { (tx?.abort as () => void)(); return }
                if (options.finish === 'close') { (db.onclose as (() => void) | undefined)?.(); return }
                if (options.finish === 'versionchange') { (db.onversionchange as (() => void) | undefined)?.(); return }
                ;(tx?.oncomplete as (() => void) | undefined)?.()
              }, 0)
            }
          }
          setTimeout(() => visit(0), 0)
          return request
        }
      })
      return tx
    }
  }
  const factory = {
    databases: options.enumeration === 'unsupported' ? undefined : vi.fn(() => options.enumeration === 'hang' ? new Promise(() => {}) : options.enumeration === 'reject' ? Promise.reject(new Error('Enumeration denied')) : Promise.resolve(options.inventory ?? [{ name: 'magicpot-chat', version: 2 }])),
    open: vi.fn((name: string, version?: number) => {
      expect(name).toBe('magicpot-chat'); expect(version).toBeUndefined(); state.opens++
      const request: Record<string, unknown> = { result: db }
      let upgradeAborted = false
      request.transaction = { abort: () => { state.upgradeAborts++; upgradeAborted = true } }
      setTimeout(() => {
        if (options.blocked) (request.onblocked as (() => void) | undefined)?.()
        if (options.disappear) {
          ;(request.onupgradeneeded as (() => void) | undefined)?.()
          if (!upgradeAborted) state.committedCreates++
          else { (request.onerror as (() => void) | undefined)?.(); return }
        }
        ;(request.onsuccess as (() => void) | undefined)?.()
      }, options.openDelay ?? 0)
      return request
    })
  }
  vi.stubGlobal('indexedDB', factory)
  return { state, factory, lateComplete: () => (tx?.oncomplete as (() => void) | undefined)?.() }
}
async function settled<T>(promise: Promise<T>): Promise<T> { await vi.runAllTimersAsync(); return promise }
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); service.mockClear() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('existing-compatible-store summary reader', () => {
  it('projects only detached allowlisted metadata for exact scopes after a readonly cursor transaction', async () => {
    const one = row(); const two = row('same-id', 'other.scope'); const db = fakeDatabase([one, two])
    const result = await settled(readExistingSessionSummaries([scope]))
    expect(result).toEqual({ status: 'ready', sessions: [{ storageScope: scope, sessionId: 'same-id', title: 'Existing title', titleTruncated: false, createdAt: 7 }] })
    expect(db.state.modes).toEqual(['readonly']); expect(db.state.closes).toBe(1); expect(db.state.getAll).toBe(0)
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(service).not.toHaveBeenCalled()
    if (result.status === 'ready') result.sessions[0].title = 'detached'
    expect(one.title).toBe('Existing title')
  })
  it('distinguishes a complete empty compatible scan from unavailable and preserves optional createdAt absence', async () => {
    const value = row(); delete value.createdAt; fakeDatabase([value])
    expect(await settled(readExistingSessionSummaries([scope]))).toEqual({ status: 'ready', sessions: [{ storageScope: scope, sessionId: 'same-id', title: 'Existing title', titleTruncated: false }] })
    fakeDatabase([])
    expect(await settled(readExistingSessionSummaries([scope]))).toEqual({ status: 'ready', sessions: [] })
  })
  it('does not open or enumerate a database when there are no validated pane scopes', async () => {
    const db = fakeDatabase([])
    expect(await readExistingSessionSummaries([])).toEqual({ status: 'ready', sessions: [] })
    expect(db.factory.databases).not.toHaveBeenCalled(); expect(db.factory.open).not.toHaveBeenCalled()
  })
  it.each(['unsupported', 'reject', 'hang'] as const)('does not open on %s enumeration', async (enumeration) => {
    const db = fakeDatabase([], { enumeration })
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable'); expect(db.state.opens).toBe(0)
  })
  it.each([{ inventory: [] }, { inventory: [{ name: 'magicpot-chat', version: 1 }] }, { inventory: [{ name: 'magicpot-chat', version: 3 }] }])('does not create or migrate missing/legacy/incompatible inventory %j', async ({ inventory }) => {
    const db = fakeDatabase([], { inventory })
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable'); expect(db.state.opens).toBe(0)
  })
  it.each([{ dbVersion: 1 }, { storeMissing: true }, { keyPath: 'id' }, { blocked: true }])('refuses incompatible or blocked private connection %j', async (options) => {
    const db = fakeDatabase([], options)
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable'); expect(db.state.scans).toBe(0); expect(db.state.closes).toBe(1)
  })
  it.each([0, 11000])('aborts every disappearance upgrade even when it arrives late after %ims', async (openDelay) => {
    const db = fakeDatabase([], { disappear: true, openDelay })
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable')
    expect(db.state.upgradeAborts).toBe(1); expect(db.state.committedCreates).toBe(0); expect(db.state.scans).toBe(0)
  })
  it('closes late successful open after timeout without a scan or result revival', async () => {
    const db = fakeDatabase([row()], { openDelay: 11000 })
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable'); expect(db.state.closes).toBe(1); expect(db.state.scans).toBe(0)
  })
  it.each(['abort', 'close', 'versionchange', 'hang'] as const)('discards cursor-exhausted rows when the transaction ends with %s', async (finish) => {
    const db = fakeDatabase([row()], { finish })
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable'); db.lateComplete(); expect(db.state.closes).toBeGreaterThan(0)
    if (finish !== 'abort') expect(db.state.aborts).toBe(1)
  })
  it('discards accumulated rows after a later cursor error', async () => {
    const db = fakeDatabase([row(), row('two')], { requestErrorAt: 1 })
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable'); expect(db.state.aborts).toBe(1)
  })
  it('omits any non-null tombstone and rechecks tombstones at transaction completion', async () => {
    const key = `magicpot-chat-delete-tombstone:${encodeURIComponent(scope)}:same-id`
    localStorage.setItem(key, ''); fakeDatabase([row()])
    expect(await settled(readExistingSessionSummaries([scope]))).toEqual({ status: 'ready', sessions: [] })
    localStorage.removeItem(key); fakeDatabase([row()], { beforeComplete: () => localStorage.setItem(key, '1') })
    const result = await settled(readExistingSessionSummaries([scope]))
    expect(result.status === 'unavailable' || result.sessions.length === 0).toBe(true)
  })
  it('does not interpret unavailable tombstone storage as not deleted', async () => {
    fakeDatabase([row()]); vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied') })
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable')
  })
  it.each([{ scopes: [''] }, { scopes: ['default'] }, { scopes: ['a\0b'] }, { scopes: [scope, scope] }, { scopes: Array.from({ length: 257 }, (_, i) => `scope.${i}`) }])('rejects invalid/ambiguous/oversized scope requests %j before opening', async ({ scopes }) => {
    const db = fakeDatabase([])
    expect((await settled(readExistingSessionSummaries(scopes))).status).toBe('unavailable'); expect(db.state.opens).toBe(0)
  })
  it.each([{ id: 'bad\0id' }, { storageKey: 'wrong' }, { createdAt: 'yesterday' }, { title: 7 }])('rejects malformed matching row metadata %j without a partial success', async (extra) => {
    fakeDatabase([row('good'), row('bad', scope, extra)])
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable')
  })
  it('compares the cursor primary key as well as the stored key/tuple', async () => {
    const db = fakeDatabase([row()]); db.state.primaryKeyOverride = 'another-key'
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable')
  })
  it('bounds displayed title and flags truncation without modifying the stored title', async () => {
    const value = row('id', scope, { title: 'x'.repeat(300) }); fakeDatabase([value])
    const result = await settled(readExistingSessionSummaries([scope])); expect(result.status).toBe('ready')
    if (result.status === 'ready') { expect(result.sessions[0].title).toHaveLength(256); expect(result.sessions[0].titleTruncated).toBe(true) }
    expect(value.title).toHaveLength(300)
  })
  it('counts unrelated rows toward the traversal limit and never returns a partial list', async () => {
    fakeDatabase(Array.from({ length: 4097 }, (_, i) => row(`id${i}`, 'unrelated')))
    expect(await settled(readExistingSessionSummaries([scope]))).toEqual({ status: 'unavailable', reason: 'limit-exceeded' })
  })
  it('ignores enumeration resolving after timeout and never starts its open', async () => {
    const db = fakeDatabase([])
    let release!: (value: Array<{ name: string; version: number }>) => void
    db.factory.databases!.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const pending = readExistingSessionSummaries([scope])
    await vi.advanceTimersByTimeAsync(10001)
    expect((await pending).status).toBe('unavailable')
    release([{ name: 'magicpot-chat', version: 2 }])
    await vi.runAllTimersAsync()
    expect(db.state.opens).toBe(0)
  })
  it('aborts an upgrade that arrives after an earlier blocked settlement', async () => {
    const db = fakeDatabase([], { blocked: true, disappear: true })
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable')
    expect(db.state.upgradeAborts).toBe(1)
    expect(db.state.committedCreates).toBe(0)
    expect(db.state.scans).toBe(0)
  })
  it('does not settle on cursor exhaustion before transaction completion, or revive after abort', async () => {
    const db = fakeDatabase([row()], { finish: 'hang' })
    const observe = vi.fn()
    const pending = readExistingSessionSummaries([scope]).then((result) => { observe(result); return result })
    await vi.advanceTimersByTimeAsync(20)
    expect(observe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10000)
    expect((await pending).status).toBe('unavailable')
    db.lateComplete()
    expect(observe).toHaveBeenCalledTimes(1)
  })
  it('does not access excluded record getters while projecting or stringify raw records', async () => {
    const value = row()
    for (const key of ['messages', 'draft', 'sessionUrl', 'compactedMessages']) {
      Object.defineProperty(value, key, { get: () => { throw new Error('Excluded content was traversed') } })
    }
    fakeDatabase([value])
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('ready')
  })
  it('accepts exactly the visit cap and bounds output independently without returning a partial success', async () => {
    fakeDatabase(Array.from({ length: 4096 }, (_, i) => row(`id${i}`, 'unrelated')))
    expect(await settled(readExistingSessionSummaries([scope]))).toEqual({ status: 'ready', sessions: [] })
    fakeDatabase(Array.from({ length: 512 }, (_, i) => row(`id${i}`)))
    const exact = await settled(readExistingSessionSummaries([scope]))
    expect(exact.status).toBe('ready')
    if (exact.status === 'ready') expect(exact.sessions).toHaveLength(512)
    fakeDatabase(Array.from({ length: 513 }, (_, i) => row(`id${i}`)))
    expect(await settled(readExistingSessionSummaries([scope]))).toEqual({ status: 'unavailable', reason: 'limit-exceeded' })
  })
  it('keeps identical IDs in different explicitly requested scopes structurally separate', async () => {
    fakeDatabase([row(), row('same-id', 'second.scope')])
    const result = await settled(readExistingSessionSummaries([scope, 'second.scope']))
    expect(result.status).toBe('ready')
    if (result.status === 'ready') expect(result.sessions.map((item) => [item.storageScope, item.sessionId])).toEqual([[scope, 'same-id'], ['second.scope', 'same-id']])
  })
  it.each([1, 31, 127])('rejects identifier control code %i without a regex-rule exception', async (code) => {
    const bad = `bad${String.fromCharCode(code)}id`
    const db = fakeDatabase([row(bad)])
    expect((await settled(readExistingSessionSummaries([scope]))).status).toBe('unavailable')
    expect(db.state.aborts).toBe(1)
    const empty = fakeDatabase([])
    expect((await settled(readExistingSessionSummaries([bad]))).status).toBe('unavailable')
    expect(empty.state.opens).toBe(0)
  })
  it('supports cancellation before enumeration and while a private scan is pending', async () => {
    const c = new AbortController(); c.abort(); const one = fakeDatabase([])
    expect(await readExistingSessionSummaries([scope], c.signal)).toEqual({ status: 'unavailable', reason: 'cancelled' }); expect(one.state.opens).toBe(0)
    const next = new AbortController(); const two = fakeDatabase([row()], { finish: 'hang' }); const pending = readExistingSessionSummaries([scope], next.signal)
    await vi.advanceTimersByTimeAsync(20); next.abort()
    expect(await settled(pending)).toEqual({ status: 'unavailable', reason: 'cancelled' }); expect(two.state.aborts).toBe(1); expect(two.state.closes).toBe(1)
  })
})
