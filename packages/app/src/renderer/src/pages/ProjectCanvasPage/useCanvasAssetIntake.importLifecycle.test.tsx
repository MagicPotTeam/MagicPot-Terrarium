import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { Suspense, startTransition, useCallback, useEffect, useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as drafts from './canvasAssetDraftFactories'
import { useCanvasAssetIntake } from './useCanvasAssetIntake'
import { useProjectCanvasPageRuntimeState } from './useProjectCanvasPageRuntimeState'
import type { CanvasGroup, CanvasGroupBranch, CanvasImageItem, CanvasItem, CanvasTextItem } from './types'

const mocks = vi.hoisted(() => ({ importer: vi.fn(), hydrate: vi.fn(), psd: vi.fn() }))
vi.mock('./canvasStorage', () => ({ importCanvasFile: mocks.importer }))
vi.mock('./psdImport', () => ({ materializePsdFile: mocks.psd }))
vi.mock('./canvasAssetIntakeHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canvasAssetIntakeHelpers')>()
  return { ...actual, hydrateCanvasImageItemForCanvas: mocks.hydrate }
})
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))

type Intake = ReturnType<typeof useCanvasAssetIntake>
type Options = Parameters<typeof useCanvasAssetIntake>[0]
type Payload = Awaited<ReturnType<typeof import('./canvasStorage').importCanvasFile>>
type Update<T> = T | ((previous: T) => T)
type Settlement<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
const originalNormalize = drafts.normalizeImportedCanvasGroups
const staleMessage = 'Canvas import is no longer current'
let releases: Array<() => void>
let settlements: Array<Promise<unknown>>

function text(id = 'imported'): CanvasTextItem {
  return { id, type: 'text', text: id, fontSize: 16, fontFamily: 'sans-serif', fill: '#fff',
    x: 0, y: 0, width: 100, height: 32, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0, locked: false }
}
function image(id = 'image'): CanvasImageItem { return { ...text(id), type: 'image', src: 'synthetic:image' } }
function payload(items: CanvasItem[] = [text()]): Payload {
  return { items, groups: [{ id: 'group', name: 'Synthetic', createdAt: 'synthetic-time', branchId: 'branch', itemIds: items.map(item => item.id) }],
    groupBranches: [{ id: 'branch', name: 'Synthetic', createdAt: 'synthetic-time' }], qAppKey: 'synthetic-qapp', figmaBinding: null }
}
function empty(): Payload { return { items: [], groups: [], groupBranches: [], qAppKey: undefined, figmaBinding: null } }
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  releases.push(() => resolve(fallback))
  return { promise, resolve, reject }
}
function observe<T>(pending: Promise<T>) {
  // Install both handlers immediately, including on intentionally rejected undefined/raw values.
  const settled = pending.then<Settlement<T>, Settlement<T>>(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
  settlements.push(settled)
  return { pending, settled }
}
function begin(callback: Intake['handleImportCanvasSceneFile']) {
  return observe(callback(new File(['owned synthetic data'], 'synthetic.mpcanvas')))
}
function denied(outcome: Settlement<unknown>) {
  expect(outcome.status).toBe('rejected')
  if (outcome.status === 'rejected') {
    expect(outcome.reason).toBeInstanceOf(Error)
    expect((outcome.reason as Error).message).toBe(staleMessage)
  }
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve() }

function target() {
  const events: string[] = []
  const state = { items: [] as CanvasItem[], groups: [] as CanvasGroup[], branches: [] as CanvasGroupBranch[],
    ids: new Set<string>(), tool: 'draw', z: 7 }
  const queued = { items: [] as Update<CanvasItem[]>[], groups: [] as Update<CanvasGroup[]>[], branches: [] as Update<CanvasGroupBranch[]>[] }
  const control: { deferred: boolean; stage?: (name: string) => void } = { deferred: false }
  const step = (name: string) => { events.push(name); control.stage?.(name) }
  const zRef = Object.defineProperty({}, 'current', { configurable: true,
    get: () => { step('z:get'); return state.z }, set: (value: number) => { state.z = value; step('z:set') }
  }) as Options['nextZIndexRef']
  const apply = <T,>(previous: T, update: Update<T>) => typeof update === 'function' ? (update as (value: T) => T)(previous) : update
  const setItemsWithHistory = vi.fn((update: Update<CanvasItem[]>) => {
    queued.items.push(update); if (!control.deferred) state.items = apply(state.items, update); step('items')
  })
  const setGroups = vi.fn((update: Update<CanvasGroup[]>) => {
    queued.groups.push(update); if (!control.deferred) state.groups = apply(state.groups, update); step('groups')
  })
  const setGroupBranches = vi.fn((update: Update<CanvasGroupBranch[]>) => {
    queued.branches.push(update); if (!control.deferred) state.branches = apply(state.branches, update); step('branches')
  })
  const setSelectedIds = vi.fn((value: Update<Set<string>>) => { state.ids = apply(state.ids, value); step('selected') })
  const setTool = vi.fn((value: Parameters<Options['setTool']>[0]) => { state.tool = String(value); step('tool') })
  const openQuickAppPanel = vi.fn(() => step('qapp'))
  const options = { nextZIndexRef: zRef, setItemsWithHistory, setGroups, setGroupBranches, setSelectedIds,
    setTool: setTool as Options['setTool'], openQuickAppPanel, notifyError: vi.fn(), notifyWarning: vi.fn(), notifySuccess: vi.fn() }
  return { state, queued, control, events, step, options }
}
type Target = ReturnType<typeof target>
type Props = { id: string | undefined; tick: number; replace?: Partial<Options> }
function useOptions(t: Target, props: Props): Options {
  return { ...t.options, canvasId: props.id,
    // Intentionally fresh on ordinary rerenders, like the canonical page; not publication authority.
    resolveCurrentItemCount: () => props.tick, getCenterPosition: () => ({ x: 0, y: 0 }),
    ...props.replace }
}
function installStages(t: Target) {
  mocks.hydrate.mockImplementation(async (item: CanvasImageItem) => { t.step('hydrate'); return item })
  vi.mocked(drafts.normalizeImportedCanvasGroups).mockImplementation((groups, items) => {
    const result = originalNormalize(groups, items); t.step('normalize'); return result
  })
}
function tracked(strict: boolean, t = target(), initial: { id: string | undefined } = { id: 'a' }, effectStart?: (callback: Intake['handleImportCanvasSceneFile']) => void) {
  const { id } = initial
  installStages(t)
  const lifetime: string[] = [], retired: Array<string | undefined> = []
  let committed: string | undefined | null = null
  const hook = renderHook((props: Props) => {
    const options = useOptions(t, props), intake = useCanvasAssetIntake(options)
    useLayoutEffect(() => {
      committed = props.id; lifetime.push('layout setup')
      return () => { committed = null; retired.push(props.id); lifetime.push('layout cleanup') }
    }, [props.id, options.nextZIndexRef, options.setItemsWithHistory, options.setGroups,
      options.setGroupBranches, options.setSelectedIds, options.setTool, options.openQuickAppPanel])
    const { handleImportCanvasSceneFile } = intake
    useEffect(() => {
      lifetime.push('passive setup'); effectStart?.(handleImportCanvasSceneFile)
      return () => { lifetime.push('passive cleanup') }
    }, [handleImportCanvasSceneFile])
    return intake
  }, { initialProps: { id, tick: 0 } as Props, reactStrictMode: strict })
  expect(lifetime).toEqual(strict ? ['layout setup', 'passive setup', 'layout cleanup', 'passive cleanup', 'layout setup', 'passive setup'] : ['layout setup', 'passive setup'])
  return { ...hook, target: t, lifetime, retired, committed: () => committed }
}
type Tracked = ReturnType<typeof tracked>
function retireSync(hook: Tracked) {
  // This completes layout cleanup BEFORE the triggering external callout returns.
  flushSync(() => { hook.rerender({ id: 'b', tick: 0 }) })
  expect(hook.committed()).toBe('b'); expect(hook.retired).toContain('a')
}
function retire(hook: Tracked, mode: 'unmount' | 'ABA') {
  if (mode === 'unmount') { hook.unmount(); expect(hook.committed()).toBeNull() }
  else {
    hook.rerender({ id: 'b', tick: 0 }); hook.rerender({ id: 'a', tick: 0 })
    expect(hook.committed()).toBe('a'); expect(hook.retired).toContain('a')
  }
}
function updater<T>(value: Update<T> | undefined): (prev: T) => T {
  expect(typeof value).toBe('function'); return value as (prev: T) => T
}
// Supplemental reflection/iteration oracles: observation is installed only after ordinary values
// have been snapshotted. Every subsequent lookup, invocation and result read is observable.
function observeIteration<T>(values: T[], t: Target, scope: string): T[] {
  const captured = values.slice()
  Object.defineProperty(values, Symbol.iterator, { configurable: true, get: () => {
    t.step('iterate:' + scope + ':method')
    return function () {
      t.step('iterate:' + scope + ':invoke')
      let index = 0
      return Object.defineProperty({}, 'next', { get: () => {
        t.step('iterate:' + scope + ':next-get')
        return () => {
          t.step('iterate:' + scope + ':next-call')
          const position = index++
          return Object.defineProperties({}, {
            done: { get: () => { t.step('iterate:' + scope + ':done'); return position >= captured.length } },
            value: { get: () => { t.step('iterate:' + scope + ':value'); return captured[position] } }
          })
        }
      } })
    }
  } })
  return values
}
// End supplemental observation helper.

beforeEach(() => {
  releases = []; settlements = []
  mocks.importer.mockReset().mockImplementation(async () => payload())
  mocks.hydrate.mockReset(); mocks.psd.mockReset()
  vi.spyOn(drafts, 'normalizeImportedCanvasGroups').mockImplementation(originalNormalize)
})
afterEach(async () => {
  try {
    cleanup()
    await act(async () => { for (const done of releases) done(); await Promise.all(settlements); await flush() })
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals() }
})

for (const strict of [false, true]) {
  describe(`explicit import lifecycle (${strict ? 'root StrictMode replay' : 'ordinary root'})`, () => {
    it('healthy image/text/group/branch/QApp import keeps current order and exact target argument', async () => {
      const t = target(), hook = tracked(strict, t), input = payload([image('image-a'), text('text-b'), image('image-c')])
      input.groups[0].itemIds.push('missing'); mocks.importer.mockResolvedValue(input)
      let operation!: ReturnType<typeof begin>
      await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
      expect(mocks.importer).toHaveBeenCalledExactlyOnceWith(expect.any(File), 'a')
      expect((await operation.settled).status).toBe('fulfilled')
      expect(t.events).toEqual(['qapp', 'z:get', 'hydrate', 'hydrate', 'z:set', 'normalize', 'items', 'selected', 'tool', 'groups', 'branches'])
      expect(t.state.items.map(item => [item.id, item.zIndex])).toEqual([['image-a', 7], ['text-b', 8], ['image-c', 9]])
      expect(t.state.z).toBe(10); expect(t.state.groups[0].itemIds).toEqual(['image-a', 'text-b', 'image-c'])
      expect(t.state.branches).toEqual(input.groupBranches); expect([...t.state.ids]).toEqual(['image-a', 'text-b', 'image-c'])
      expect(t.state.tool).toBe('select')
    })
    it('healthy empty import remains an empty success without scene setters', async () => {
      const hook = tracked(strict), t = hook.target; mocks.importer.mockResolvedValue(empty())
      let operation!: ReturnType<typeof begin>
      await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
      expect(await operation.settled).toEqual({ status: 'fulfilled', value: [] })
      expect(t.events).toEqual(['z:get', 'z:set', 'normalize']); expect(t.state.z).toBe(7)
    })
    for (const id of [undefined, ''] as const) {
      it(`captures legacy default store argument for ${id === undefined ? 'undefined' : 'empty string'} ID`, async () => {
        const hook = tracked(strict, target(), { id })
        await act(async () => { await begin(hook.result.current.handleImportCanvasSceneFile).settled })
        expect(mocks.importer).toHaveBeenCalledExactlyOnceWith(expect.any(File), undefined)
      })
    }
    for (const mode of ['unmount', 'ABA'] as const) {
      it(`pending importer fulfilled after ${mode} is denied before any result field or later stage`, async () => {
        const gate = deferred(empty()), hook = tracked(strict), t = hook.target
        mocks.importer.mockReturnValue(gate.promise)
        const operation = begin(hook.result.current.handleImportCanvasSceneFile)
        expect(mocks.importer).toHaveBeenCalledTimes(1); retire(hook, mode)
        let reads = 0; const input = payload(), accessor = {} as Payload
        for (const key of ['items', 'groups', 'groupBranches', 'qAppKey', 'figmaBinding'] as const) {
          Object.defineProperty(accessor, key, { enumerable: true, get: () => { reads++; return input[key] } })
        }
        await act(async () => { gate.resolve(accessor); await operation.settled })
        denied(await operation.settled); expect(reads).toBe(0); expect(t.events).toEqual([])
      })
      it(`saved callback after ${mode} denies before NEW importer invocation`, async () => {
        const hook = tracked(strict), saved = hook.result.current.handleImportCanvasSceneFile
        retire(hook, mode)
        let operation!: ReturnType<typeof begin>
        await act(async () => { operation = begin(saved); await operation.settled })
        denied(await operation.settled); expect(mocks.importer).not.toHaveBeenCalled(); expect(hook.target.events).toEqual([])
        if (mode === 'ABA') {
          await act(async () => { expect((await begin(hook.result.current.handleImportCanvasSceneFile).settled).status).toBe('fulfilled') })
          expect(mocks.importer).toHaveBeenCalledExactlyOnceWith(expect.any(File), 'a')
        }
      })
      it(`pending first hydration after ${mode} cannot start second hydration or publication`, async () => {
        const hook = tracked(strict), t = hook.target, first = image('first'), gate = deferred(first)
        mocks.importer.mockResolvedValue(payload([first, image('second')]))
        mocks.hydrate.mockImplementationOnce(() => { t.step('hydrate'); return gate.promise })
        const operation = begin(hook.result.current.handleImportCanvasSceneFile)
        await act(async () => { await flush() })
        expect(mocks.hydrate).toHaveBeenCalledTimes(1); retire(hook, mode)
        const before = [...t.events]
        await act(async () => { gate.resolve(first); await operation.settled })
        denied(await operation.settled); expect(mocks.hydrate).toHaveBeenCalledTimes(1); expect(t.events).toEqual(before)
      })
    }
    it('pending import survives stable-target rerender with fresh inline count and placement helpers', async () => {
      const gate = deferred(empty()), hook = tracked(strict); mocks.importer.mockReturnValue(gate.promise)
      const operation = begin(hook.result.current.handleImportCanvasSceneFile), retired = hook.retired.length
      hook.rerender({ id: 'a', tick: 17 })
      expect(hook.retired).toHaveLength(retired)
      await act(async () => { gate.resolve(payload()); await operation.settled })
      expect((await operation.settled).status).toBe('fulfilled'); expect(hook.target.state.items).toHaveLength(1)
    })
    for (const reference of ['nextZIndexRef', 'setItemsWithHistory', 'setGroups', 'setGroupBranches', 'setSelectedIds', 'setTool', 'openQuickAppPanel'] as const) {
      it(`saved callback cannot borrow replacement ${reference} publication binding`, async () => {
        const hook = tracked(strict), replacement = target(), saved = hook.result.current.handleImportCanvasSceneFile
        hook.rerender({ id: 'a', tick: 0, replace: { [reference]: replacement.options[reference] } })
        let operation!: ReturnType<typeof begin>
        await act(async () => { operation = begin(saved); await operation.settled })
        denied(await operation.settled); expect(mocks.importer).not.toHaveBeenCalled()
      })
    }
    it('raw ID change retires binding even when legacy normalized store argument is identical', async () => {
      const hook = tracked(strict, target(), { id: undefined }), saved = hook.result.current.handleImportCanvasSceneFile
      hook.rerender({ id: '', tick: 0 })
      let operation!: ReturnType<typeof begin>
      await act(async () => { operation = begin(saved); await operation.settled })
      denied(await operation.settled); expect(mocks.importer).not.toHaveBeenCalled()
    })

    const syncStages = ['importer', 'result:items', 'result:groups', 'result:groupBranches', 'result:qAppKey',
      'qapp', 'z:get', 'item:type', 'item:src', 'item:spread', 'hydrate', 'z:set', 'normalize',
      'items', 'selected', 'tool', 'groups', 'branches'] as const
    for (const stage of syncStages) {
      it(`synchronous retirement inside ${stage} stops later hook stages without rollback`, async () => {
        const hook = tracked(strict), t = hook.target, input = payload([image()])
        let armed = true, afterRetirement: string[] | undefined
        t.control.stage = name => {
          if (armed && name === stage) { armed = false; retireSync(hook); afterRetirement = [...t.events] }
        }
        if (stage.startsWith('result:')) {
          // Observe ALL result fields, not only the getter that retires the owner. A bulk
          // destructure followed by one guard must fail when it reads later fields while stale.
          const values = Object.entries(input)
          for (const [key, value] of values) {
            Object.defineProperty(input, key, { enumerable: true, get: () => { t.step('result:' + key); return value } })
          }
        }
        if (stage.startsWith('item:')) {
          // Observe every enumerable item read, including later spread fields. Copies which
          // keep reading after a retiring getter are not authorized just because hydration stops.
          const values = Object.entries(input.items[0])
          for (const [key, value] of values) {
            const label = key === 'width' ? 'item:spread' : 'item:' + key
            Object.defineProperty(input.items[0], key, { enumerable: true, get: () => { t.step(label); return value } })
          }
        }
        mocks.importer.mockImplementation(() => { if (stage === 'importer') t.step(stage); return Promise.resolve(input) })
        let operation!: ReturnType<typeof begin>
        await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
        expect(armed).toBe(false); expect(afterRetirement).toBeDefined(); denied(await operation.settled)
        expect(t.events).toEqual(afterRetirement)
      })
    }
    it('retirement microtask after append publications but before handler continuation rejects outer success', async () => {
      const hook = tracked(strict), t = hook.target
      t.control.stage = name => { if (name === 'branches') queueMicrotask(() => retireSync(hook)) }
      let operation!: ReturnType<typeof begin>
      await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
      denied(await operation.settled); expect(hook.committed()).toBe('b')
      // Earlier publications are deliberately not undone by outer denial.
      expect(t.state.items).toHaveLength(1); expect(t.state.groups).toHaveLength(1); expect(t.state.branches).toHaveLength(1)
    })
    for (const kind of ['undefined', 'null', 'string', 'object', 'Error', 'proxy'] as const) {
      it(`original ${kind} importer rejection survives retirement with no diagnostic reads`, async () => {
        const hook = tracked(strict), gate = deferred(empty()); let traps = 0
        const sentinel = kind === 'undefined' ? undefined : kind === 'null' ? null : kind === 'string' ? 'synthetic rejection'
          : kind === 'Error' ? new Error('synthetic rejection') : kind === 'object' ? Object.freeze({ synthetic: true })
            : new Proxy({}, { get: () => { traps++; throw new Error('diagnostic read') }, getPrototypeOf: () => { traps++; throw new Error('prototype read') }, ownKeys: () => { traps++; throw new Error('reflection') } })
        mocks.importer.mockReturnValue(gate.promise)
        const operation = begin(hook.result.current.handleImportCanvasSceneFile); retire(hook, 'ABA')
        await act(async () => { gate.reject(sentinel); await operation.settled })
        const outcome = await operation.settled
        expect(outcome.status).toBe('rejected'); expect(outcome.status === 'rejected' && Object.is(outcome.reason, sentinel)).toBe(true)
        expect(traps).toBe(0); expect(hook.target.events).toEqual([])
      })
    }
    it('synchronous importer throw after committed retirement retains original identity', async () => {
      const hook = tracked(strict), sentinel = Object.freeze({ original: 'sync' })
      mocks.importer.mockImplementation(() => { retireSync(hook); throw sentinel })
      let operation!: ReturnType<typeof begin>
      await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
      const outcome = await operation.settled
      expect(outcome.status === 'rejected' && Object.is(outcome.reason, sentinel)).toBe(true)
      expect(hook.target.events).toEqual([])
    })
    for (const stage of ['hydrate', 'normalize', 'items', 'branches']) {
      it(`throwing ${stage} callout preserves active rejection after it retires owner`, async () => {
        const hook = tracked(strict), t = hook.target, sentinel = Object.freeze({ original: stage })
        mocks.importer.mockResolvedValue(payload([image()]))
        t.control.stage = name => { if (name === stage) { retireSync(hook); throw sentinel } }
        let operation!: ReturnType<typeof begin>
        await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
        const outcome = await operation.settled
        expect(outcome.status === 'rejected' && Object.is(outcome.reason, sentinel)).toBe(true)
        expect(t.events.at(-1)).toBe(stage)
      })
    }
    // Supplemental implementation-review coverage; all original 129 cases below/above are retained.
    for (const scope of ['items', 'normalized-groups', 'branches'] as const) {
      for (const boundary of ['method', 'invoke', 'next-get', 'next-call', 'done', 'value'] as const) {
        it(`retirement in ${scope} iterator ${boundary} prevents subsequent protocol reads and stages`, async () => {
          const hook = tracked(strict), t = hook.target, input = payload([image()])
          const stage = 'iterate:' + scope + ':' + boundary
          let armed = true, afterRetirement: string[] | undefined
          t.control.stage = name => {
            if (armed && name === stage) { armed = false; retireSync(hook); afterRetirement = [...t.events] }
          }
          if (scope === 'items') observeIteration(input.items, t, scope)
          else if (scope === 'branches') observeIteration(input.groupBranches!, t, scope)
          else {
            vi.mocked(drafts.normalizeImportedCanvasGroups).mockImplementation((groups, items) => {
              const normalized = originalNormalize(groups, items)
              t.step('normalize')
              return observeIteration(normalized, t, scope)
            })
          }
          mocks.importer.mockResolvedValue(input)
          let operation!: ReturnType<typeof begin>
          await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
          expect(armed).toBe(false); expect(afterRetirement).toBeDefined(); denied(await operation.settled)
          expect(t.events).toEqual(afterRetirement)
        })
      }
    }
    for (const boundary of ['ownKeys', 'descriptor'] as const) {
      it(`retirement in item Proxy ${boundary} stops subsequent reflection and value reads`, async () => {
        const hook = tracked(strict), t = hook.target, input = payload([image()]), original = input.items[0]
        const stage = boundary === 'ownKeys' ? 'proxy:ownKeys' : 'proxy:descriptor:id'
        let armed = true, afterRetirement: string[] | undefined
        input.items[0] = new Proxy(original, {
          get: (object, key, receiver) => { t.step('proxy:get:' + String(key)); return Reflect.get(object, key, receiver) },
          ownKeys: object => { t.step('proxy:ownKeys'); return Reflect.ownKeys(object) },
          getOwnPropertyDescriptor: (object, key) => { t.step('proxy:descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(object, key) }
        })
        t.control.stage = name => {
          if (armed && name === stage) { armed = false; retireSync(hook); afterRetirement = [...t.events] }
        }
        mocks.importer.mockResolvedValue(input)
        let operation!: ReturnType<typeof begin>
        await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
        expect(armed).toBe(false); expect(afterRetirement).toBeDefined(); denied(await operation.settled)
        expect(t.events).toEqual(afterRetirement)
      })
    }
    const extraThrowStages = ['result:items', 'result:groups', 'result:groupBranches', 'result:qAppKey',
      'item:type', 'item:src', 'item:spread', 'z:get', 'z:set', 'qapp', 'selected', 'tool', 'groups'] as const
    for (const stage of extraThrowStages) {
      it(`retiring ${stage} exception stays original rather than being replaced by stale denial`, async () => {
        const hook = tracked(strict), t = hook.target, input = payload([image()])
        let armed = true, afterRetirement: string[] | undefined, diagnosticReads = 0
        const poison = () => { diagnosticReads++; throw new Error('diagnostic access') }
        const raw = new Proxy({}, { get: poison, getPrototypeOf: poison, ownKeys: poison })
        const sentinel = stage === 'z:get' ? undefined : stage === 'qapp' ? raw : Object.freeze({ original: stage })
        if (stage.startsWith('result:')) {
          const values = Object.entries(input)
          for (const [key, value] of values) {
            Object.defineProperty(input, key, { enumerable: true, get: () => { t.step('result:' + key); return value } })
          }
        }
        if (stage.startsWith('item:')) {
          const values = Object.entries(input.items[0])
          for (const [key, value] of values) {
            const label = key === 'width' ? 'item:spread' : 'item:' + key
            Object.defineProperty(input.items[0], key, { enumerable: true, get: () => { t.step(label); return value } })
          }
        }
        t.control.stage = name => {
          if (armed && name === stage) {
            armed = false; retireSync(hook); afterRetirement = [...t.events]; throw sentinel
          }
        }
        // @vitest/spy's catch performs `error instanceof TypeError`, invoking the poison
        // Proxy's getPrototypeOf before the hook can receive the throw. Use a raw QApp target
        // for this sentinel only; keep all identity/zero-diagnostic/event assertions unchanged.
        if (stage === 'qapp') hook.rerender({ id: 'a', tick: 0, replace: { openQuickAppPanel: () => t.step('qapp') } })
        mocks.importer.mockResolvedValue(input)
        let operation!: ReturnType<typeof begin>
        await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
        const outcome = await operation.settled
        expect(armed).toBe(false); expect(afterRetirement).toBeDefined(); expect(outcome.status).toBe('rejected')
        expect(outcome.status === 'rejected' && Object.is(outcome.reason, sentinel)).toBe(true)
        expect(diagnosticReads).toBe(0); expect(t.events).toEqual(afterRetirement)
      })
    }
    // End supplemental implementation-review coverage.
    it('two healthy independent pending imports both enter before either settles and both publish', async () => {
      const hook = tracked(strict), first = deferred(empty()), second = deferred(empty())
      mocks.importer.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      const a = begin(hook.result.current.handleImportCanvasSceneFile), b = begin(hook.result.current.handleImportCanvasSceneFile)
      expect(mocks.importer).toHaveBeenCalledTimes(2); expect(hook.target.events).toEqual([])
      await act(async () => { second.resolve(payload([text('second')])); await b.settled })
      await act(async () => { first.resolve(payload([text('first')])); await a.settled })
      expect((await a.settled).status).toBe('fulfilled'); expect((await b.settled).status).toBe('fulfilled')
      expect(hook.target.state.items.map(item => item.id)).toEqual(['second', 'first'])
      expect(hook.target.options.setItemsWithHistory).toHaveBeenCalledTimes(2)
    })
    for (const field of ['items', 'groups', 'branches'] as const) {
      it(`deferred ${field} updater evaluated after retirement returns exact previous value on replay`, async () => {
        const hook = tracked(strict), t = hook.target; t.control.deferred = true
        await act(async () => { await begin(hook.result.current.handleImportCanvasSceneFile).settled })
        const update = updater(t.queued[field][0] as Update<unknown[]>), previous: unknown[] = []
        retire(hook, 'ABA'); const before = [...t.events]
        expect(update(previous)).toBe(previous); expect(update(previous)).toBe(previous)
        expect(t.events).toEqual(before)
      })
      it(`healthy deferred ${field} updater stays authorized after handler fulfillment`, async () => {
        const hook = tracked(strict), t = hook.target; t.control.deferred = true
        let operation!: ReturnType<typeof begin>
        await act(async () => { operation = begin(hook.result.current.handleImportCanvasSceneFile); await operation.settled })
        expect((await operation.settled).status).toBe('fulfilled')
        const update = updater(t.queued[field][0] as Update<unknown[]>), previous: unknown[] = [], before = [...t.events]
        expect(update(previous)).toHaveLength(1); expect(update(previous)).not.toBe(previous); expect(t.events).toEqual(before)
      })
      it(`reentrant previous ${field} array iteration retirement denies constructed appended result`, async () => {
        const hook = tracked(strict), t = hook.target; t.control.deferred = true
        await act(async () => { await begin(hook.result.current.handleImportCanvasSceneFile).settled })
        const update = updater(t.queued[field][0] as Update<unknown[]>), previous: unknown[] = []
        Object.defineProperty(previous, Symbol.iterator, { value: function* () { retireSync(hook); yield { synthetic: true } } })
        expect(update(previous)).toBe(previous); expect(hook.committed()).toBe('b')
      })
    }
    it('materializes branch iteration outside deferred updater evaluation', async () => {
      const hook = tracked(strict), t = hook.target, input = payload(); t.control.deferred = true
      const branches = input.groupBranches!, iterate = branches[Symbol.iterator].bind(branches); let reads = 0
      Object.defineProperty(branches, Symbol.iterator, { value: () => { reads++; return iterate() } })
      mocks.importer.mockResolvedValue(input)
      await act(async () => { await begin(hook.result.current.handleImportCanvasSceneFile).settled })
      const before = reads; expect(before).toBeGreaterThan(0)
      const result = updater(t.queued.branches[0])([])
      expect(result).toEqual([{ id: 'branch', name: 'Synthetic', createdAt: 'synthetic-time' }]); expect(reads).toBe(before)
    })
    it('returned direct append remains unguarded by originating explicit binding after target rerender', async () => {
      const hook = tracked(strict), saved = hook.result.current.appendImportedCanvasPayload
      hook.rerender({ id: 'b', tick: 0 })
      let restored: CanvasItem[] = []
      await act(async () => { restored = await saved(payload()) })
      expect(restored).toHaveLength(1); expect(hook.target.state.items).toHaveLength(1)
      expect(mocks.importer).not.toHaveBeenCalled(); expect(hook.target.options.openQuickAppPanel).not.toHaveBeenCalled()
    })
    it('PSD still adopts through public append and preserves its ordinary success feedback', async () => {
      const hook = tracked(strict), t = hook.target
      mocks.psd.mockResolvedValue({ items: [text('psd-text')], groups: [], warnings: [], sourceApp: 'photoshop' })
      let restored: CanvasItem[] = []
      await act(async () => { restored = await hook.result.current.handleImportPsdFile(new File(['owned'], 'synthetic.psd')) })
      expect(restored).toHaveLength(1); expect(t.state.items[0].id).toBe('psd-text'); expect(mocks.psd).toHaveBeenCalledTimes(1)
      expect(t.options.notifySuccess).toHaveBeenCalledExactlyOnceWith('Imported 1 item(s) from PHOTOSHOP.')
      expect(mocks.importer).not.toHaveBeenCalled()
    })
    it('abandoned alternative render cannot publish binding authority or retire committed work', async () => {
      const t = target(); installStages(t)
      const gate = deferred(empty()), never = new Promise<void>(() => {}), lifetimes: string[] = []
      let current!: Intake, abandoned: Intake | undefined
      function Child({ id, suspend }: { id: string; suspend: boolean }) {
        const intake = useCanvasAssetIntake(useOptions(t, { id, tick: 0 }))
        useLayoutEffect(() => { current = intake; lifetimes.push(id + ':setup'); return () => { lifetimes.push(id + ':cleanup') } }, [id, intake])
        if (suspend) { abandoned = intake; throw never }
        return <span data-testid="committed-import-target">{id}</span>
      }
      const view = render(<Suspense fallback={<span>pending</span>}><Child id="a" suspend={false} /></Suspense>, { reactStrictMode: strict })
      const prior = [...lifetimes]; mocks.importer.mockReturnValueOnce(gate.promise)
      const operation = begin(current.handleImportCanvasSceneFile)
      await act(async () => { startTransition(() => view.rerender(<Suspense fallback={<span>pending</span>}><Child id="b" suspend /></Suspense>)); await flush() })
      expect(abandoned).toBeDefined(); expect(screen.getByTestId('committed-import-target')).toHaveTextContent('a'); expect(lifetimes).toEqual(prior)
      let deniedOperation!: ReturnType<typeof begin>
      await act(async () => { deniedOperation = begin(abandoned!.handleImportCanvasSceneFile); await deniedOperation.settled })
      denied(await deniedOperation.settled); expect(mocks.importer).toHaveBeenCalledTimes(1)
      await act(async () => { gate.resolve(payload()); await operation.settled })
      expect((await operation.settled).status).toBe('fulfilled'); expect(t.state.items).toHaveLength(1)
    })
    it('real runtime keeps items/history/redo/revision/selected history when retired item updater evaluates', async () => {
      const t = target(); installStages(t)
      const queued: Update<CanvasItem[]>[] = [], lifetime: string[] = []
      const hook = renderHook(({ id }) => {
        const state = useProjectCanvasPageRuntimeState()
        const queueItems = useCallback((update: Update<CanvasItem[]>) => { queued.push(update) }, [])
        const intake = useCanvasAssetIntake({ ...t.options, canvasId: id, setItemsWithHistory: queueItems,
          setGroups: state.setGroups, setGroupBranches: state.setGroupBranches, setSelectedIds: state.setSelectedIds, setTool: state.setTool })
        useLayoutEffect(() => { lifetime.push(id + ':setup'); return () => { lifetime.push(id + ':cleanup') } }, [id])
        return { state, intake }
      }, { initialProps: { id: 'a' }, reactStrictMode: strict })
      expect(lifetime).toEqual(strict ? ['a:setup', 'a:cleanup', 'a:setup'] : ['a:setup'])
      const first = text('first'), second = text('second')
      act(() => { hook.result.current.state.setItemsWithHistory([first]); hook.result.current.state.setItemsWithHistory([second]) })
      act(() => { hook.result.current.state.handleUndo() })
      act(() => { hook.result.current.state.setSelectedHistoryRevision(0) })
      await act(async () => { await begin(hook.result.current.intake.handleImportCanvasSceneFile).settled })
      expect(queued).toHaveLength(1)
      hook.rerender({ id: 'b' }); expect(lifetime).toContain('a:cleanup')
      const before = hook.result.current.state, histories = before.historySnapshots.map(entry => entry.items)
      act(() => { hook.result.current.state.setItemsWithHistory(updater(queued[0])) })
      const after = hook.result.current.state
      expect(after.items).toBe(before.items); expect(after.historyCount).toBe(before.historyCount)
      expect(after.historyRevision).toBe(before.historyRevision); expect(after.selectedHistoryRevision).toBe(0)
      expect(after.historySnapshots.map(entry => entry.items)).toEqual(histories)
      act(() => { hook.result.current.state.handleRedo() })
      expect(hook.result.current.state.items).toEqual([second]); expect(hook.result.current.state.historyRevision).toBe(before.historyRevision + 1)
    })
  })
}

it('true root StrictMode retires old effect-started attempt but fresh same-binding invocation succeeds', async () => {
  const gate = deferred(empty()), t = target(); mocks.importer.mockReturnValueOnce(gate.promise)
  let first: ReturnType<typeof begin> | undefined, initialCallback: Intake['handleImportCanvasSceneFile'] | undefined
  const hook = tracked(true, t, { id: 'a' }, callback => {
    if (!first) { initialCallback = callback; first = begin(initialCallback) }
  })
  expect(first).toBeDefined(); expect(mocks.importer).toHaveBeenCalledTimes(1)
  await act(async () => { gate.resolve(payload()); await first!.settled })
  denied(await first!.settled); expect(t.events).toEqual([])
  await act(async () => { expect((await begin(initialCallback!).settled).status).toBe('fulfilled') })
  expect(mocks.importer).toHaveBeenCalledTimes(2); expect(t.state.items).toHaveLength(1)
})
