import { useEffect, useLayoutEffect } from 'react'
import * as path from 'path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasExportWorkflow } from './useCanvasExportWorkflow'
import type { CanvasTextItem } from './types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../QuickAppPage/components/QAppContext', () => ({ restoreGlobalQAppCache: vi.fn() }))
vi.mock('../ChatPage/chatPageShared', () => ({
  getDownloadFileNameFromUrl: vi.fn(), normalizeLocalMediaUrl: (value: string) => value
}))
// Neither canvasStorage nor the export workflow is mocked in this linked fixture.
type Options = Parameters<typeof useCanvasExportWorkflow>[0]
type Workflow = ReturnType<typeof useCanvasExportWorkflow>
const modes = ['Save', 'Save As', 'Standalone'] as const
const text: CanvasTextItem = {
  id: 'linked-synthetic-text', type: 'text', text: 'No external assets', x: 0, y: 0,
  width: 80, height: 30, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 0,
  locked: false, fontSize: 14, fontFamily: 'sans-serif', fill: '#fff'
}
const target = 'C:\\synthetic-output\\linked.mpcanvas'
const write = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const dialog = vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>>()
const success = vi.fn((_: string) => 1)
const info = vi.fn((_: string, _duration?: number | null) => 2)
const close = vi.fn()
const fetchBoundary = vi.fn(() => { throw new Error('Unexpected fetch') })
const dbOpen = vi.fn(() => { throw new Error('Unexpected IndexedDB') })
let undo: Array<() => void>
let release: Array<() => void>
let click: ReturnType<typeof vi.fn<() => void>>
function replace(object: object, key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  Object.defineProperty(object, key, { configurable: true, writable: true, value })
  undo.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : Reflect.deleteProperty(object, key))
}
function options(): Options {
  return {
    canvasId: '', projectName: 'Synthetic linked fixture', items: [text], groups: [], groupBranches: [],
    figmaBinding: null, selectedIds: new Set(), setSelectedIds: vi.fn(), stageRef: { current: null },
    canvasContainerRef: { current: null }, stagePos: { x: 0, y: 0 }, stageScale: 1, bgColor: '#000',
    loadImageFromSrc: vi.fn(), getCanvasItemVisualBounds: () => null,
    notifySuccess: success, notifyError: vi.fn(() => 3), notifyInfo: info, closeMessage: close
  }
}
function invoke(workflow: Workflow, mode: typeof modes[number]) {
  const pending = mode === 'Save' ? workflow.handleSaveCanvas()
    : mode === 'Save As' ? workflow.handleSaveCanvasAs() : workflow.handleExportCanvasProjectFile()
  void pending.catch(() => undefined)
  return pending
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
async function advance() { await act(async () => { vi.advanceTimersByTime(1500); await flush() }) }
function mount() {
  const lifetime: string[] = []
  const hook = renderHook(() => {
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
  return hook
}
beforeEach(() => {
  vi.useFakeTimers(); undo = []; release = []
  success.mockClear(); info.mockClear(); close.mockClear(); fetchBoundary.mockClear(); dbOpen.mockClear()
  write.mockReset().mockResolvedValue({ success: true, fullPath: target })
  dialog.mockReset().mockResolvedValue({ canceled: false, filePath: target })
  replace(window, 'api', { svcFs: { saveImageToPath: write }, svcDialog: { showSaveDialog: dialog } })
  replace(window, 'path', path.win32)
  replace(globalThis, 'fetch', fetchBoundary); replace(globalThis, 'indexedDB', { open: dbOpen })
  replace(URL, 'createObjectURL', vi.fn(() => 'blob:linked-synthetic')); replace(URL, 'revokeObjectURL', vi.fn())
  click = vi.fn(); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { click() })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(async () => {
  try {
    await act(async () => { for (const done of release) done(); await flush() })
    expect(fetchBoundary).not.toHaveBeenCalled(); expect(dbOpen).not.toHaveBeenCalled()
  } finally {
    try {
      cleanup()
    } finally {
      vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
      for (const restore of undo.reverse()) restore()
      document.querySelectorAll('a[download]').forEach((anchor) => anchor.remove())
    }
  }
})

describe('linked real storage plus real workflow under synthetic native/browser seams', () => {
  for (const mode of modes) {
    it(`${mode} actual dialog cancellation never becomes a Saved notification`, async () => {
      dialog.mockResolvedValue({ canceled: true })
      const { result } = mount()
      await act(async () => { await invoke(result.current, mode) })
      await advance()
      expect(dialog).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled()
      expect(click).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled()
      expect(info.mock.calls.some(([message]) => /100%|download requested/i.test(message))).toBe(false)
      expect(result.current.isSavingCanvasFile).toBe(false); expect(vi.getTimerCount()).toBe(0)
    })
    it(`${mode} actual pending native acknowledgement is not an early success`, async () => {
      let resolve!: (ack: { success: boolean; fullPath: string }) => void
      const receipt = new Promise((done) => { resolve = done })
      release.push(() => resolve({ success: true, fullPath: target })); write.mockReturnValueOnce(receipt)
      const { result } = mount()
      let pending!: Promise<void>
      act(() => { pending = invoke(result.current, mode) })
      await act(async () => { await flush() })
      expect(write).toHaveBeenCalledTimes(1); expect(result.current.isSavingCanvasFile).toBe(true)
      await advance(); expect(success).not.toHaveBeenCalled()
      await act(async () => { resolve({ success: true, fullPath: target }); await pending })
      expect(success).toHaveBeenCalledExactlyOnceWith('Saved .mpcanvas')
      expect(click).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
      await advance(); expect(success).toHaveBeenCalledTimes(1)
    })
    for (const ack of ['absent native support', 'negative receipt', 'missing receipt'] as const) {
      it(`${mode} ${ack} can request download but cannot certify a saved file`, async () => {
        if (ack === 'absent native support') replace(window, 'api', undefined)
        else write.mockResolvedValueOnce(ack === 'negative receipt' ? { success: false } : undefined)
        const { result } = mount()
        await act(async () => { await invoke(result.current, mode) })
        expect(click).toHaveBeenCalledTimes(1); expect(success).not.toHaveBeenCalled()
        expect(info.mock.calls.filter(([message]) => /download requested.*browser.*confirm/i.test(message))).toHaveLength(1)
        expect(info.mock.calls.some(([message]) => /100%/.test(message))).toBe(false)
        await advance(); expect(success).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
      })
    }
  }
})
