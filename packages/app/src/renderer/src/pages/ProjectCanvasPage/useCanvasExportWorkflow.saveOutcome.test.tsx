import { useEffect, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasExportWorkflow } from './useCanvasExportWorkflow'

const storage = vi.hoisted(() => ({ save: vi.fn(), standalone: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))
vi.mock('./canvasStorage', () => ({
  exportCanvasFile: storage.save,
  exportCanvasFileAsStandalone: storage.standalone
}))

type Outcome = { status: 'native-written' | 'cancelled' | 'download-requested' }
type Workflow = ReturnType<typeof useCanvasExportWorkflow>
type Options = Parameters<typeof useCanvasExportWorkflow>[0]
type Mode = 'Save' | 'Save As' | 'Standalone'
const modes: Mode[] = ['Save', 'Save As', 'Standalone']
let release: Array<() => void>
let nextKey: number
const success = vi.fn((_: string) => ++nextKey)
const info = vi.fn((_: string, _duration?: number | null) => ++nextKey)
const failure = vi.fn((_: string) => ++nextKey)
const close = vi.fn()

function options(canvasId = 'canvas-a'): Options {
  return {
    canvasId, projectName: 'Synthetic save outcome', items: [], groups: [], groupBranches: [],
    figmaBinding: null, selectedIds: new Set(), setSelectedIds: vi.fn(), stageRef: { current: null },
    canvasContainerRef: { current: null }, stagePos: { x: 0, y: 0 }, stageScale: 1, bgColor: '#000',
    loadImageFromSrc: vi.fn(), getCanvasItemVisualBounds: () => null,
    notifySuccess: success, notifyError: failure, notifyInfo: info, closeMessage: close
  }
}
function deferred() {
  let resolve!: (value: Outcome) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Outcome>((done, failed) => { resolve = done; reject = failed })
  release.push(() => resolve({ status: 'cancelled' }))
  return { promise, resolve, reject }
}
function invoke(workflow: Workflow, mode: Mode): Promise<void> {
  const pending = mode === 'Save' ? workflow.handleSaveCanvas()
    : mode === 'Save As' ? workflow.handleSaveCanvasAs() : workflow.handleExportCanvasProjectFile()
  // Attach a handler immediately even when an assertion fails before the fixture joins it.
  void pending.catch(() => undefined)
  return pending
}
function calls() { return storage.save.mock.calls.length + storage.standalone.mock.calls.length }
function messages() { return info.mock.calls.map(([message]) => message) }
function countComplete() { return messages().filter((message) => /100%/.test(message)).length }
function countDownload() { return messages().filter((message) => /download requested/i.test(message)).length }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }
async function advance(milliseconds = 2000) {
  await act(async () => { vi.advanceTimersByTime(milliseconds); await flush() })
}
function stubPending(gate: ReturnType<typeof deferred>) {
  storage.save.mockReturnValue(gate.promise); storage.standalone.mockReturnValue(gate.promise)
}
function renderTrackedWorkflow() {
  let committedId: string | null = null
  const retiredIds: string[] = []
  const hook = renderHook(({ id }) => {
    const workflow = useCanvasExportWorkflow(options(id))
    // Registered after the real hook: this witnesses the committed layout lifetime, not render intent.
    useLayoutEffect(() => {
      committedId = id
      return () => { committedId = null; retiredIds.push(id) }
    }, [id])
    return workflow
  }, { initialProps: { id: 'a' } })
  return { ...hook, retiredIds, committedId: () => committedId }
}

beforeEach(() => {
  vi.useFakeTimers(); release = []; nextKey = 0
  success.mockReset().mockImplementation((_: string) => ++nextKey)
  info.mockReset().mockImplementation((_: string, _duration?: number | null) => ++nextKey)
  failure.mockReset().mockImplementation((_: string) => ++nextKey)
  close.mockReset()
  storage.save.mockReset().mockResolvedValue({ status: 'cancelled' })
  storage.standalone.mockReset().mockResolvedValue({ status: 'cancelled' })
})
afterEach(async () => {
  try {
    await act(async () => { for (const done of release) done(); await flush() })
  } finally {
    try { cleanup() } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() }
  }
})

describe('actual save workflow feedback consumes outcomes, not fulfilled void', () => {
  for (const mode of modes) {
    it(`${mode} cancellation stays silent after the former delayed-success window`, async () => {
      const { result } = renderHook(() => useCanvasExportWorkflow(options()))
      await act(async () => { await invoke(result.current, mode) })
      await advance()
      expect(calls()).toBe(1); expect(success).not.toHaveBeenCalled()
      expect(countComplete()).toBe(0); expect(countDownload()).toBe(0)
      expect(result.current.isSavingCanvasFile).toBe(false); expect(close).toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })
    it(`${mode} download requests neutral confirmation rather than Saved or 100 percent`, async () => {
      storage.save.mockResolvedValue({ status: 'download-requested' })
      storage.standalone.mockResolvedValue({ status: 'download-requested' })
      const { result } = renderHook(() => useCanvasExportWorkflow(options()))
      await act(async () => { await invoke(result.current, mode) })
      expect(success).not.toHaveBeenCalled(); expect(countComplete()).toBe(0)
      expect(countDownload()).toBe(1)
      expect(messages().find((message) => /download requested/i.test(message))).toMatch(/browser.*confirm/i)
      await advance()
      expect(countDownload()).toBe(1); expect(success).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })
    it(`${mode} reports native-written exactly once after actual promise settlement, without delayed timers`, async () => {
      const gate = deferred(); stubPending(gate)
      const { result } = renderHook(() => useCanvasExportWorkflow(options()))
      let pending!: Promise<void>
      act(() => { pending = invoke(result.current, mode) })
      expect(calls()).toBe(1); expect(result.current.isSavingCanvasFile).toBe(true)
      expect(success).not.toHaveBeenCalled(); expect(countComplete()).toBe(0)
      await advance(900)
      expect(success).not.toHaveBeenCalled(); expect(countComplete()).toBe(0)
      await act(async () => { gate.resolve({ status: 'native-written' }); await pending })
      expect(success).toHaveBeenCalledExactlyOnceWith('Saved .mpcanvas')
      expect(result.current.isSavingCanvasFile).toBe(false); expect(vi.getTimerCount()).toBe(0)
      await advance()
      expect(success).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled()
    })
    it(`${mode} rejects with the original error and releases busy state only after settlement`, async () => {
      const gate = deferred(); stubPending(gate)
      const { result } = renderHook(() => useCanvasExportWorkflow(options()))
      let pending!: Promise<void>
      act(() => { pending = invoke(result.current, mode) })
      const error = new Error(`synthetic ${mode} failure`)
      let caught: unknown
      await act(async () => { gate.reject(error); try { await pending } catch (reason) { caught = reason } })
      expect(caught).toBe(error)
      await advance()
      expect(success).not.toHaveBeenCalled(); expect(countComplete()).toBe(0)
      expect(result.current.isSavingCanvasFile).toBe(false); expect(vi.getTimerCount()).toBe(0)
      storage.save.mockResolvedValue({ status: 'cancelled' })
      storage.standalone.mockResolvedValue({ status: 'cancelled' })
      await act(async () => { await invoke(result.current, mode) })
      expect(calls()).toBe(2)
    })
    it(`${mode} blocks every file action while pending and allows a new action after real cancellation`, async () => {
      const gate = deferred(); stubPending(gate)
      const { result } = renderHook(() => useCanvasExportWorkflow(options()))
      let pending!: Promise<void>
      act(() => { pending = invoke(result.current, mode) })
      let additional: Promise<void>[] = []
      act(() => { additional = modes.map((other) => invoke(result.current, other)) })
      expect(calls()).toBe(1)
      expect(result.current.isSavingCanvasFile).toBe(true)
      await act(async () => { gate.resolve({ status: 'cancelled' }); await pending; await Promise.all(additional) })
      storage.save.mockResolvedValue({ status: 'cancelled' })
      storage.standalone.mockResolvedValue({ status: 'cancelled' })
      await act(async () => { await invoke(result.current, mode) })
      expect(calls()).toBe(2); expect(result.current.isSavingCanvasFile).toBe(false)
      await advance(); expect(success).not.toHaveBeenCalled()
    })
    for (const outcome of ['native-written', 'download-requested'] as const) {
      it(`${mode} late ${outcome} cannot notify or complete progress after unmount`, async () => {
        const gate = deferred(); stubPending(gate)
        const { result, unmount } = renderHook(() => useCanvasExportWorkflow(options()))
        let pending!: Promise<void>
        act(() => { pending = invoke(result.current, mode) })
        unmount()
        const before = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        expect(vi.getTimerCount()).toBe(0)
        await act(async () => { gate.resolve({ status: outcome }); await pending })
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        expect(vi.getTimerCount()).toBe(0)
      })
      it(`${mode} late ${outcome} is retired by canvas identity change even if it changes back`, async () => {
        const gate = deferred(); stubPending(gate)
        const { result, rerender } = renderHook(({ id }) => useCanvasExportWorkflow(options(id)), { initialProps: { id: 'a' } })
        let pending!: Promise<void>
        act(() => { pending = invoke(result.current, mode) })
        const additional: Promise<void>[] = []
        for (const id of ['b', 'a']) {
          rerender({ id })
          act(() => { additional.push(...modes.map((other) => invoke(result.current, other))) })
          expect(calls()).toBe(1)
          expect(result.current.isSavingCanvasFile).toBe(true)
          const retired = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
          await advance()
          expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(retired)
          expect(vi.getTimerCount()).toBe(0)
        }
        const before = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        expect(vi.getTimerCount()).toBe(0)
        await act(async () => { gate.resolve({ status: outcome }); await pending; await Promise.all(additional) })
        expect(result.current.isSavingCanvasFile).toBe(false)
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        expect(vi.getTimerCount()).toBe(0)
      })
    }
  }

  for (const mode of modes) {
    for (const retire of ['unmount', 'canvas change'] as const) {
      it(`${mode} initial notification reentrant ${retire} cannot publish a key or interval after retirement`, async () => {
        const gate = deferred(); stubPending(gate)
        const hook = renderTrackedWorkflow()
        const returnedKey = 49000
        info.mockImplementationOnce(() => {
          if (retire === 'unmount') hook.unmount()
          else flushSync(() => hook.rerender({ id: 'b' }))
          expect(hook.retiredIds).toEqual(['a'])
          expect(hook.committedId()).toBe(retire === 'unmount' ? null : 'b')
          return returnedKey
        })
        let pending!: Promise<void>
        act(() => { pending = invoke(hook.result.current, mode) })
        expect(calls()).toBe(1)
        expect(close).toHaveBeenCalledExactlyOnceWith(returnedKey)
        expect(vi.getTimerCount()).toBe(0)
        const before = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
        const additional: Promise<void>[] = []
        if (retire === 'canvas change') {
          act(() => { additional.push(...modes.map((other) => invoke(hook.result.current, other))) })
          expect(calls()).toBe(1); expect(hook.result.current.isSavingCanvasFile).toBe(true)
        }
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        expect(vi.getTimerCount()).toBe(0)
        await act(async () => { gate.resolve({ status: 'native-written' }); await pending; await Promise.all(additional) })
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        if (retire === 'canvas change') expect(hook.result.current.isSavingCanvasFile).toBe(false)
      })
      it(`${mode} progress-close reentrant ${retire} cannot continue publishing retired progress`, async () => {
        const gate = deferred(); stubPending(gate)
        const hook = renderTrackedWorkflow()
        let pending!: Promise<void>
        act(() => { pending = invoke(hook.result.current, mode) })
        close.mockImplementationOnce(() => {
          if (retire === 'unmount') hook.unmount()
          else flushSync(() => hook.rerender({ id: 'b' }))
          expect(hook.retiredIds).toEqual(['a'])
          expect(hook.committedId()).toBe(retire === 'unmount' ? null : 'b')
        })
        const notified = info.mock.calls.length
        await advance(180)
        expect(info).toHaveBeenCalledTimes(notified)
        expect(vi.getTimerCount()).toBe(0)
        const before = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        await act(async () => { gate.resolve({ status: 'download-requested' }); await pending })
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        if (retire === 'canvas change') expect(hook.result.current.isSavingCanvasFile).toBe(false)
      })
    }
    it(`${mode} cleanup failure cannot replace the original export rejection`, async () => {
      const gate = deferred(); stubPending(gate)
      const hook = renderHook(() => useCanvasExportWorkflow(options()))
      let pending!: Promise<void>
      act(() => { pending = invoke(hook.result.current, mode) })
      const original = new Error(`original ${mode} export rejection`)
      const cleanupError = new Error('synthetic closeMessage failure')
      close.mockImplementation(() => { throw cleanupError })
      let caught: unknown
      try {
        await act(async () => { gate.reject(original); try { await pending } catch (reason) { caught = reason } })
        expect(caught).toBe(original)
        expect(close).toHaveBeenCalledTimes(1)
        expect(hook.result.current.isSavingCanvasFile).toBe(false)
        expect(vi.getTimerCount()).toBe(0); expect(success).not.toHaveBeenCalled()
      } finally { close.mockReset() }
    })
  }

  for (const mode of modes) {
    for (const status of ['native-written', 'download-requested'] as const) {
      for (const retire of ['unmount', 'canvas change'] as const) {
        it(`${mode} terminal ${status} reentrant ${retire} closes its exact unpublished key`, async () => {
          storage.save.mockResolvedValue({ status }); storage.standalone.mockResolvedValue({ status })
          const hook = renderTrackedWorkflow()
          const returnedKey = 59000
          const retireAndReturn = () => {
            if (retire === 'unmount') hook.unmount()
            else flushSync(() => hook.rerender({ id: 'b' }))
            expect(hook.retiredIds).toEqual(['a'])
            expect(hook.committedId()).toBe(retire === 'unmount' ? null : 'b')
            return returnedKey
          }
          if (status === 'native-written') success.mockImplementation(retireAndReturn)
          else info.mockImplementation((message) => /download requested/i.test(message) ? retireAndReturn() : ++nextKey)
          await act(async () => { await invoke(hook.result.current, mode) })
          expect(calls()).toBe(1)
          expect(close.mock.calls.filter(([key]) => key === returnedKey)).toEqual([[returnedKey]])
          expect(success).toHaveBeenCalledTimes(status === 'native-written' ? 1 : 0)
          expect(countDownload()).toBe(status === 'download-requested' ? 1 : 0)
          expect(vi.getTimerCount()).toBe(0)
          const before = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
          await advance()
          expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
          if (retire === 'canvas change') {
            expect(hook.result.current.isSavingCanvasFile).toBe(false)
            storage.save.mockResolvedValue({ status: 'cancelled' }); storage.standalone.mockResolvedValue({ status: 'cancelled' })
            await act(async () => { await invoke(hook.result.current, mode) })
            expect(calls()).toBe(2); expect(vi.getTimerCount()).toBe(0)
          }
        })
      }
      it(`${mode} terminal ${status} notifier rejection releases only the settled attempt`, async () => {
        const gate = deferred(); stubPending(gate)
        const hook = renderHook(() => useCanvasExportWorkflow(options()))
        const notifierError = new Error(`synthetic terminal ${status} notifier failure`)
        if (status === 'native-written') success.mockImplementation(() => { throw notifierError })
        else info.mockImplementation((message) => { if (/download requested/i.test(message)) throw notifierError; return ++nextKey })
        let pending!: Promise<void>
        act(() => { pending = invoke(hook.result.current, mode) })
        expect(calls()).toBe(1); expect(hook.result.current.isSavingCanvasFile).toBe(true)
        const additional: Promise<void>[] = []
        act(() => { additional.push(...modes.map((other) => invoke(hook.result.current, other))) })
        expect(calls()).toBe(1)
        let caught: unknown
        await act(async () => { gate.resolve({ status }); try { await pending } catch (reason) { caught = reason }; await Promise.all(additional) })
        expect(caught).toBe(notifierError)
        expect(hook.result.current.isSavingCanvasFile).toBe(false); expect(vi.getTimerCount()).toBe(0)
        const before = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        storage.save.mockResolvedValue({ status: 'cancelled' }); storage.standalone.mockResolvedValue({ status: 'cancelled' })
        await act(async () => { await invoke(hook.result.current, mode) })
        expect(calls()).toBe(2); expect(vi.getTimerCount()).toBe(0)
      })
    }
    for (const phase of ['initial', 'tick'] as const) {
      it(`${mode} ${phase} progress notifier throw retires only feedback and preserves later export rejection`, async () => {
        const gate = deferred(); stubPending(gate)
        const hook = renderHook(() => useCanvasExportWorkflow(options()))
        const notifierError = new Error(`synthetic ${phase} progress notifier failure`)
        const original = new Error(`synthetic ${mode} actual export rejection`)
        if (phase === 'initial') info.mockImplementationOnce(() => { throw notifierError })
        let pending!: Promise<void>
        act(() => { pending = invoke(hook.result.current, mode) })
        if (phase === 'tick') {
          info.mockImplementationOnce(() => { throw notifierError })
          await advance(180)
        }
        expect(calls()).toBe(1); expect(hook.result.current.isSavingCanvasFile).toBe(true)
        expect(info).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2)
        expect(vi.getTimerCount()).toBe(0)
        const before = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
        const additional: Promise<void>[] = []
        act(() => { additional.push(...modes.map((other) => invoke(hook.result.current, other))) })
        await advance()
        expect(calls()).toBe(1); expect(hook.result.current.isSavingCanvasFile).toBe(true)
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        let caught: unknown
        await act(async () => { gate.reject(original); try { await pending } catch (reason) { caught = reason }; await Promise.all(additional) })
        expect(caught).toBe(original)
        expect(hook.result.current.isSavingCanvasFile).toBe(false); expect(vi.getTimerCount()).toBe(0)
        await advance()
        expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
        info.mockImplementation((_: string, _duration?: number | null) => ++nextKey)
        storage.save.mockResolvedValue({ status: 'cancelled' }); storage.standalone.mockResolvedValue({ status: 'cancelled' })
        await act(async () => { await invoke(hook.result.current, mode) })
        expect(calls()).toBe(2); expect(vi.getTimerCount()).toBe(0)
      })
    }
  }

  it.each(['native-written', 'cancelled', 'download-requested'] as const)('suppressed Save %s never emits any notification', async (status) => {
    storage.save.mockResolvedValue({ status })
    const { result } = renderHook(() => useCanvasExportWorkflow(options()))
    await act(async () => { await result.current.handleSaveCanvas({ suppressNotifications: true }) })
    await advance()
    expect(info).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  })
  it('dialog-open callback cannot release actual pending ownership or lower the busy flag', async () => {
    const gate = deferred()
    storage.save.mockImplementation((...args: unknown[]) => {
      const opened = args[8] as (() => void) | undefined
      opened?.()
      return gate.promise
    })
    storage.standalone.mockReturnValue(gate.promise)
    const { result } = renderHook(() => useCanvasExportWorkflow(options()))
    let pending!: Promise<void>
    act(() => { pending = invoke(result.current, 'Save') })
    expect(result.current.isSavingCanvasFile).toBe(true)
    let additional: Promise<void>[] = []
    act(() => { additional = [invoke(result.current, 'Standalone'), invoke(result.current, 'Save As')] })
    expect(calls()).toBe(1)
    await act(async () => { gate.resolve({ status: 'cancelled' }); await pending; await Promise.all(additional) })
    expect(result.current.isSavingCanvasFile).toBe(false)
  })
  it('StrictMode replay retires an effect-started old attempt and never revives its late success', async () => {
    const gate = deferred(); stubPending(gate)
    const lifetime: string[] = []
    storage.save.mockImplementation(() => { lifetime.push('export'); return gate.promise })
    info.mockImplementation(() => { lifetime.push('progress'); return ++nextKey })
    close.mockImplementation(() => { lifetime.push('close') })
    let pending: Promise<void> | undefined
    const { result } = renderHook(() => {
      const workflow = useCanvasExportWorkflow(options())
      useLayoutEffect(() => {
        lifetime.push('layout setup')
        return () => { lifetime.push('layout cleanup') }
      }, [])
      const start = useRef(() => invoke(workflow, 'Save'))
      useEffect(() => {
        lifetime.push('starter setup')
        const attempt = start.current(); pending ??= attempt
        return () => { lifetime.push('starter cleanup') }
      }, [start])
      return workflow
    }, { reactStrictMode: true })
    expect(lifetime).toEqual([
      'layout setup', 'starter setup', 'progress', 'export', 'close', 'layout cleanup',
      'starter cleanup', 'layout setup', 'starter setup'
    ])
    expect(calls()).toBe(1)
    const before = [info.mock.calls.length, success.mock.calls.length]
    await advance()
    expect([info.mock.calls.length, success.mock.calls.length]).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { gate.resolve({ status: 'native-written' }); await pending })
    await advance()
    expect([info.mock.calls.length, success.mock.calls.length]).toEqual(before)
    expect(result.current.isSavingCanvasFile).toBe(false); expect(vi.getTimerCount()).toBe(0)
  })
  it('ordinary StrictMode user action still receives its own native acknowledgement once', async () => {
    storage.save.mockResolvedValue({ status: 'native-written' })
    const lifetime: string[] = []
    const { result } = renderHook(() => {
      const workflow = useCanvasExportWorkflow(options())
      useLayoutEffect(() => {
        lifetime.push('layout setup')
        return () => { lifetime.push('layout cleanup') }
      }, [])
      useEffect(() => {
        lifetime.push('passive setup')
        return () => { lifetime.push('passive cleanup') }
      }, [])
      return workflow
    }, { reactStrictMode: true })
    expect(lifetime).toEqual([
      'layout setup', 'passive setup', 'layout cleanup', 'passive cleanup',
      'layout setup', 'passive setup'
    ])
    await act(async () => { await invoke(result.current, 'Save') })
    expect(success).toHaveBeenCalledExactlyOnceWith('Saved .mpcanvas')
    await advance(); expect(success).toHaveBeenCalledTimes(1)
  })
  it('an unmounted old hook cannot close or replace progress owned by a new hook', async () => {
    const oldGate = deferred(); stubPending(oldGate)
    const old = renderHook(() => useCanvasExportWorkflow(options('old')))
    let oldPending!: Promise<void>
    act(() => { oldPending = invoke(old.result.current, 'Save') })
    old.unmount()
    const retired = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
    await advance()
    expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(retired)
    expect(vi.getTimerCount()).toBe(0)
    const newGate = deferred(); stubPending(newGate)
    const current = renderHook(() => useCanvasExportWorkflow(options('new')))
    let newPending!: Promise<void>
    act(() => { newPending = invoke(current.result.current, 'Save') })
    const before = [info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]
    await act(async () => { oldGate.resolve({ status: 'native-written' }); await oldPending })
    expect([info.mock.calls.length, success.mock.calls.length, close.mock.calls.length]).toEqual(before)
    expect(current.result.current.isSavingCanvasFile).toBe(true)
    await act(async () => { newGate.resolve({ status: 'native-written' }); await newPending })
    expect(success).toHaveBeenCalledExactlyOnceWith('Saved .mpcanvas')
    await advance(); expect(success).toHaveBeenCalledTimes(1)
  })
})
