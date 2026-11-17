import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CanvasImageSourceEvidence } from './canvasCropProvenance'
import { createCanvasProvenCropRegistry } from './canvasProvenCropRegistry'
import { useCanvasProvenCropRegistryFill } from './useCanvasProvenCropRegistryFill'
import type { CanvasImageCropSource, CanvasImageItem, CanvasItem } from './types'

// Synthetic records and evidence: nothing is read, decoded or encoded.
const SHA = 'cd'.repeat(32)
const RECORD: CanvasImageCropSource = {
  version: 1,
  origin: 'confirm',
  width: 400,
  height: 300,
  sizeBytes: 5000,
  sha256: SHA
}

function provenItem(id: string, overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `local-media:///C:/images/${id}.png`,
    fileName: `${id}.png`,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    sourceWidth: 400,
    sourceHeight: 300,
    crop: { x: 10, y: 20, width: 100, height: 80 },
    cropSource: RECORD,
    ...overrides
  }
}

function evidenceFor(record: CanvasImageCropSource = RECORD): CanvasImageSourceEvidence {
  return {
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    width: record.width,
    height: record.height,
    image: document.createElement('img')
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

function setup(
  items: CanvasItem[],
  {
    selectedIds = new Set<string>(),
    limits = {},
    readEvidence = vi.fn(async () => evidenceFor()),
    drawCrop = vi.fn(async (item: CanvasImageItem) => ({
      blob: new Blob([`png-${item.id}`], { type: 'image/png' }),
      width: item.crop!.width,
      height: item.crop!.height
    }))
  }: {
    selectedIds?: Set<string>
    limits?: Parameters<typeof createCanvasProvenCropRegistry>[0]
    readEvidence?: ReturnType<typeof vi.fn>
    drawCrop?: ReturnType<typeof vi.fn>
  } = {}
) {
  let made = 0
  const revoke = vi.fn()
  const registry = createCanvasProvenCropRegistry(limits, {
    create: () => `blob:filled-${++made}`,
    revoke
  })
  const hook = renderHook(
    (props: { items: CanvasItem[]; selectedIds: Set<string> }) =>
      useCanvasProvenCropRegistryFill({
        items: props.items,
        selectedIds: props.selectedIds,
        registry,
        readEvidence: readEvidence as never,
        drawCrop: drawCrop as never,
        waitForIdle: () => Promise.resolve()
      }),
    { initialProps: { items, selectedIds } }
  )
  return { ...hook, registry, readEvidence, drawCrop, revoke }
}

afterEach(() => {
  cleanup()
})

describe('useCanvasProvenCropRegistryFill', () => {
  it('fills the registry for a stored proven crop after the board loads', async () => {
    const item = provenItem('loaded-crop')
    const { registry, readEvidence, drawCrop } = setup([item])

    await waitFor(() => expect(registry.has(item)).toBe(true))
    expect(readEvidence).toHaveBeenCalledExactlyOnceWith(item.src, expect.any(Function))
    expect(drawCrop).toHaveBeenCalledExactlyOnceWith(item, expect.objectContaining({ sha256: SHA }))
    expect(registry.lookup(item)).toEqual(
      expect.objectContaining({ url: 'blob:filled-1', width: 100, height: 80 })
    )
  })

  it('reads nothing for crops without a valid record, uncropped images or crops already registered', async () => {
    const registered = provenItem('already-registered')
    const items: CanvasItem[] = [
      provenItem('no-record', { cropSource: undefined }),
      provenItem('size-hint-disagrees', { sourceWidth: 401 }),
      provenItem('crop-outside-record', { crop: { x: 390, y: 0, width: 20, height: 20 } }),
      provenItem('uncropped', { crop: undefined, cropSource: undefined }),
      provenItem('too-large-source', { cropSource: { ...RECORD, sizeBytes: 129 * 1024 * 1024 } }),
      registered
    ]
    const { registry, readEvidence, rerender } = setup([])
    registry.register(registered, new Blob(['png'], { type: 'image/png' }), {
      width: 100,
      height: 80
    })
    rerender({ items, selectedIds: new Set() })
    await act(async () => {
      await Promise.resolve()
    })
    expect(readEvidence).not.toHaveBeenCalled()
  })

  it('keeps nothing when the bytes no longer match the record, and does not read that crop again', async () => {
    const item = provenItem('overwritten-file')
    const readEvidence = vi.fn(async () => evidenceFor({ ...RECORD, sha256: 'ef'.repeat(32) }))
    const { registry, drawCrop, rerender } = setup([item], { readEvidence })

    await waitFor(() => expect(readEvidence).toHaveBeenCalledTimes(1))
    await act(async () => {
      await Promise.resolve()
    })
    expect(drawCrop).not.toHaveBeenCalled()
    expect(registry.entryCount).toBe(0)
    rerender({ items: [{ ...item }], selectedIds: new Set([item.id]) })
    await act(async () => {
      await Promise.resolve()
    })
    expect(readEvidence).toHaveBeenCalledTimes(1)
  })

  it('registers nothing when the crop changes while its source is read', async () => {
    const item = provenItem('changed-mid-read')
    const read = deferred<CanvasImageSourceEvidence | null>()
    const readEvidence = vi.fn((_src: string, _isCurrent: () => boolean) => read.promise)
    const { registry, drawCrop, rerender } = setup([item], { readEvidence })
    await waitFor(() => expect(readEvidence).toHaveBeenCalledTimes(1))
    const isCurrent = readEvidence.mock.calls[0][1] as () => boolean
    expect(isCurrent()).toBe(true)

    // A re-crop drops the record until the new crop is attested.
    const recropped = { ...item, crop: { x: 0, y: 0, width: 50, height: 50 }, cropSource: undefined }
    rerender({ items: [recropped], selectedIds: new Set() })
    expect(isCurrent()).toBe(false)
    await act(async () => read.resolve(evidenceFor()))

    expect(drawCrop).not.toHaveBeenCalled()
    expect(registry.has(item)).toBe(false)
  })

  it('leaves an item alone while a confirm read for it is running', async () => {
    const item = provenItem('confirm-running')
    const { registry, readEvidence, rerender } = setup([])
    const endPending = registry.beginPending(item.id)
    rerender({ items: [item], selectedIds: new Set() })
    await act(async () => {
      await Promise.resolve()
    })
    expect(readEvidence).not.toHaveBeenCalled()
    endPending()
    rerender({ items: [{ ...item }], selectedIds: new Set() })
    await waitFor(() => expect(registry.has(item)).toBe(true))
  })

  it('never evicts for an unselected crop, but fills a selected crop after an eviction', async () => {
    const first = provenItem('first')
    const second = provenItem('second')
    const third = provenItem('third')
    const { registry, revoke, rerender } = setup([first, second], { limits: { maxEntries: 2 } })
    await waitFor(() => expect(registry.entryCount).toBe(2))

    // An unselected third crop waits for room.
    rerender({ items: [first, second, third], selectedIds: new Set() })
    await act(async () => {
      await Promise.resolve()
    })
    expect(registry.has(third)).toBe(false)
    expect(revoke).not.toHaveBeenCalled()

    // Selected, it is drawn and the least recently used entry goes.
    rerender({ items: [first, second, third], selectedIds: new Set([third.id]) })
    await waitFor(() => expect(registry.has(third)).toBe(true))
    expect(registry.has(first)).toBe(false)
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:filled-1')

    // The evicted crop comes back once it is selected again.
    rerender({ items: [first, second, third], selectedIds: new Set([first.id]) })
    await waitFor(() => expect(registry.has(first)).toBe(true))
  })

  it('stops after unmount and registers nothing late', async () => {
    const item = provenItem('unmount-mid-read')
    const read = deferred<CanvasImageSourceEvidence | null>()
    const readEvidence = vi.fn((_src: string, _isCurrent: () => boolean) => read.promise)
    const { registry, drawCrop, unmount } = setup([item], { readEvidence })
    await waitFor(() => expect(readEvidence).toHaveBeenCalledTimes(1))
    const isCurrent = readEvidence.mock.calls[0][1] as () => boolean
    unmount()
    expect(isCurrent()).toBe(false)
    await act(async () => read.resolve(evidenceFor()))
    expect(drawCrop).not.toHaveBeenCalled()
    expect(registry.entryCount).toBe(0)
  })

  it('does not draw a crop above the pixel cap', async () => {
    const huge = provenItem('huge-crop', {
      sourceWidth: 8000,
      sourceHeight: 6000,
      crop: { x: 0, y: 0, width: 8000, height: 6000 },
      cropSource: { ...RECORD, width: 8000, height: 6000 }
    })
    const { readEvidence } = setup([huge])
    await act(async () => {
      await Promise.resolve()
    })
    expect(readEvidence).not.toHaveBeenCalled()
  })
})
