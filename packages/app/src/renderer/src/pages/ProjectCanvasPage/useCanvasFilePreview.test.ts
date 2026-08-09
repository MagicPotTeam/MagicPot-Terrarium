import React, { StrictMode, useState } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvasFilePreviewUrlLifecycle, useCanvasFilePreview } from './useCanvasFilePreview'
import type { CanvasFilePreviewImage, CanvasItem } from './types'

const resolveOfficeFileNodeDataMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { resolvedLanguage: 'en' } })
}))

vi.mock('./officePreviewUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./officePreviewUtils')>()
  return {
    ...actual,
    resolveOfficeFileNodeData: (...args: unknown[]) => resolveOfficeFileNodeDataMock(...args)
  }
})

const previewImage = (src: string): CanvasFilePreviewImage => ({
  id: src,
  src,
  mimeType: 'image/png',
  fileName: 'preview.png'
})

const fileItem = (id: string, sources: string[] = []): CanvasItem =>
  ({
    id,
    type: 'file',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 1,
    src: `blob:${id}-source`,
    fileName: `${id}.docx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileKind: 'word',
    previewImages: sources.map(previewImage)
  }) as CanvasItem

function HookHarness({ initialItems }: { initialItems: CanvasItem[] }) {
  const [items, setItems] = useState(initialItems)
  useCanvasFilePreview({
    items,
    setItems,
    setItemsWithHistory: setItems,
    setSelectedIds: vi.fn(),
    setTool: vi.fn(),
    notifySuccess: vi.fn(),
    notifyError: vi.fn()
  })
  return null
}

describe('canvas file preview object URL lifecycle', () => {
  it('keeps shared owned URLs until their final explicit replacement', () => {
    const revoke = vi.fn()
    const lifecycle = createCanvasFilePreviewUrlLifecycle(revoke)
    const shared = 'blob:shared-preview'
    lifecycle.claimProduced([previewImage(shared)])

    lifecycle.sync([fileItem('a', [shared]), fileItem('b', [shared])])
    lifecycle.sync([fileItem('a', ['blob:replacement']), fileItem('b', [shared])])
    expect(revoke).not.toHaveBeenCalled()

    lifecycle.sync([fileItem('a', ['blob:replacement']), fileItem('b', [])])
    expect(revoke).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith(shared)
  })

  it('does not adopt arbitrary pre-existing blob preview strings', () => {
    const revoke = vi.fn()
    const lifecycle = createCanvasFilePreviewUrlLifecycle(revoke)

    lifecycle.sync([fileItem('a', ['blob:owned-elsewhere'])])
    lifecycle.sync([fileItem('a', [])])
    lifecycle.dispose()

    expect(revoke).not.toHaveBeenCalled()
  })

  it('keeps owned URLs across transient item removal so history can restore them', () => {
    const revoke = vi.fn()
    const lifecycle = createCanvasFilePreviewUrlLifecycle(revoke)
    const owned = previewImage('blob:undoable')
    lifecycle.claimProduced([owned])
    lifecycle.sync([fileItem('a', [owned.src])])

    lifecycle.sync([])
    lifecycle.sync([fileItem('a', [owned.src])])
    expect(revoke).not.toHaveBeenCalled()

    lifecycle.dispose()
    expect(revoke).toHaveBeenCalledWith(owned.src)
  })

  it('revokes uninstalled output and output produced after disposal', () => {
    const revoke = vi.fn()
    const lifecycle = createCanvasFilePreviewUrlLifecycle(revoke)

    expect(lifecycle.claimProduced([previewImage('blob:stale')])).toBe(true)
    lifecycle.settleProduced([previewImage('blob:stale')], false)
    expect(revoke).toHaveBeenCalledWith('blob:stale')

    lifecycle.dispose()
    expect(lifecycle.claimProduced([previewImage('blob:after-unmount')])).toBe(false)
    expect(revoke).toHaveBeenCalledWith('blob:after-unmount')
  })
})

describe('useCanvasFilePreview object URL lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resolveOfficeFileNodeDataMock.mockReset()
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['office'])) })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('does not revoke a live pre-existing preview URL during StrictMode effect replay', async () => {
    const existing = fileItem('existing', ['blob:owned-elsewhere'])
    ;(existing as Extract<CanvasItem, { type: 'file' }>).previewText = 'already hydrated'

    const view = render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(HookHarness, { initialItems: [existing] })
      )
    )
    await act(async () => vi.runOnlyPendingTimers())

    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    view.unmount()
    await act(async () => vi.runOnlyPendingTimers())
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('revokes hydration output that completes after real unmount', async () => {
    let resolvePreview!: (value: {
      previewText: string
      previewImages: CanvasFilePreviewImage[]
      previewSheets: []
      content: null
    }) => void
    resolveOfficeFileNodeDataMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve
      })
    )

    const view = render(React.createElement(HookHarness, { initialItems: [fileItem('race')] }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolveOfficeFileNodeDataMock).toHaveBeenCalled()

    view.unmount()
    await act(async () => vi.runOnlyPendingTimers())
    await act(async () => {
      resolvePreview({
        previewText: 'hydrated',
        previewImages: [previewImage('blob:late-preview')],
        previewSheets: [],
        content: null
      })
      await Promise.resolve()
    })

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late-preview')
  })
})
