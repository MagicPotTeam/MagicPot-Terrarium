// Owner decision 2: crops saved before crop source records existed are
// re-measured once per board open (G3-5). Synthetic bytes and fake decodes only.
import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { createHash } from 'node:crypto'

import { DEFAULT_CONFIG } from '@shared/config/config'
import type { CanvasFigmaBinding } from '@shared/figma'
import { isConfirmedIdentityCrop } from './canvasCropProvenance'
import { serializeCanvasItem } from './canvasItemSerialization'
import { useCanvasBridgeActions } from './useCanvasBridgeActions'
import {
  collectCanvasLegacyCropCandidates,
  isLegacyCropWithoutSourceSize,
  LEGACY_CROP_WITHOUT_SOURCE_SIZE_KEY,
  useCanvasLegacyCropUpgrade,
  type CanvasLegacyCropEvidence,
  type CanvasLegacyCropEvidenceReader
} from './useCanvasLegacyCropUpgrade'
import { useCanvasViewportPersistence } from './useCanvasViewportPersistence'
import { useProjectCanvasPageRuntimeState } from './useProjectCanvasPageRuntimeState'
import type { CanvasGroup, CanvasGroupBranch, CanvasImageItem, CanvasItem } from './types'

const mockLoadCanvasItems = vi.fn()
const mockSaveCanvasItems = vi.fn()
const mockClearCanvasItems = vi.fn()
const mockDispatch = vi.fn()

vi.mock('./canvasStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./canvasStorage')>()),
  clearCanvasItems: (...args: unknown[]) => mockClearCanvasItems(...args),
  loadCanvasItems: (...args: unknown[]) => mockLoadCanvasItems(...args),
  saveCanvasItems: (...args: unknown[]) => mockSaveCanvasItems(...args)
}))

vi.mock('react-redux', () => ({
  useDispatch: () => mockDispatch
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({})
}))

vi.mock('../../store/slices/layoutSlice', () => ({
  openRightPanel: () => ({ type: 'layout/openRightPanel' })
}))

vi.mock('../ChatPage/chatVideoAttachmentUtils', () => ({
  extractVideoBoundaryFrameDataUrls: vi.fn(async () => ({
    firstFrameDataUrl: null,
    lastFrameDataUrl: null
  }))
}))

const SOURCE_PATH = 'C:/MagicPot/legacy-crop.jpg'
const SOURCE_SRC = `local-media:///${SOURCE_PATH}`
const SOURCE_BYTES = new TextEncoder().encode('synthetic legacy crop source bytes')
const SOURCE_SHA256 = createHash('sha256').update(SOURCE_BYTES).digest('hex')
const CROP = { x: 10, y: 20, width: 30, height: 40 }
const CROPPED_PNG = 'data:image/png;base64,legacy-crop-visible'

type ServedSource = { bytes: Uint8Array; width: number; height: number }

type SourceFixture = {
  sources: Map<string, ServedSource>
  fetch: Mock<(url: string) => Promise<unknown>>
  decodeInputs: string[]
}

const cleanups: Array<() => void> = []

// A Blob as Chromium serves it: jsdom's Blob has no arrayBuffer().
function browserBlob(bytes: Uint8Array, type: string): Blob {
  const blob = new Blob([bytes.slice()], { type })
  return Object.assign(blob, { arrayBuffer: async () => bytes.slice().buffer })
}

// Serves local-media files from a map. The fake Image decodes only object URLs
// of read bytes (never the original URL) to the size of the source they came from.
function installSourceFixture(served: Record<string, ServedSource>): SourceFixture {
  const sources = new Map(Object.entries(served))
  const objectUrlBlobs = new Map<string, Blob>()
  const decodeInputs: string[] = []
  let next = 0
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = `blob:legacy-crop-${++next}`
    objectUrlBlobs.set(url, blob as Blob)
    return url
  })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const fetchMock: Mock<(url: string) => Promise<unknown>> = vi.fn(async (url: string) => {
    const requested = decodeURIComponent(String(url))
    const entry = [...sources.entries()].find(([path]) => requested.endsWith(path))
    if (!entry)
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        blob: async () => new Blob([])
      }
    const [, source] = entry
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(source.bytes.byteLength) },
      blob: async () => browserBlob(source.bytes, 'image/jpeg')
    }
  })
  class FakeImage {
    naturalWidth = 0
    naturalHeight = 0
    onload: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    crossOrigin: string | null = null
    set src(value: string) {
      decodeInputs.push(value)
      void Promise.resolve().then(() => {
        const blob = objectUrlBlobs.get(value)
        const source = blob
          ? [...sources.values()].find((entry) => entry.bytes.byteLength === blob.size)
          : undefined
        if (!source) {
          this.onerror?.(new Event('error'))
          return
        }
        this.naturalWidth = source.width
        this.naturalHeight = source.height
        this.onload?.(new Event('load'))
      })
    }
  }
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('electronFile', {
    resolveAuthorizedLocalMediaPath: vi.fn(async (path: string) => path)
  })
  cleanups.push(() => {
    create.mockRestore()
    revoke.mockRestore()
  })
  return { sources, fetch: fetchMock, decodeInputs }
}

function createLegacyCrop(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'legacy-crop',
    type: 'image',
    src: SOURCE_SRC,
    fileName: 'legacy-crop.jpg',
    sizeBytes: SOURCE_BYTES.byteLength,
    sourceWidth: 100,
    sourceHeight: 80,
    crop: { ...CROP },
    x: 0,
    y: 0,
    width: 30,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

type HarnessProps = {
  canvasId: string
  readEvidence?: CanvasLegacyCropEvidenceReader
  hydrate?: (item: CanvasImageItem) => Promise<CanvasImageItem | null>
}

const RESTORED_BLOB_SRC = 'blob:restored-legacy-crop'

// Hydration as the real app does it on the full-load path: src is the restored
// blob: URL of the board's own copy, and missing size hints are filled in from
// the decoded image (canvasAssetIntakeHelpers hydrateCanvasImageItemForCanvas).
function backfillingHydrate(decoded: { width: number; height: number; sizeBytes: number }) {
  return async (item: CanvasImageItem): Promise<CanvasImageItem> => ({
    ...item,
    sourceWidth: item.sourceWidth ?? decoded.width,
    sourceHeight: item.sourceHeight ?? decoded.height,
    sizeBytes: item.sizeBytes ?? decoded.sizeBytes
  })
}

// The page wiring: the persistence hook loads the board and reports 'items
// loaded'; the upgrade pass writes without history; the save path persists.
function renderBoard(initialProps: HarnessProps) {
  return renderHook(
    ({ canvasId, readEvidence, hydrate }: HarnessProps) => {
      const [items, setItems] = React.useState<CanvasItem[]>([])
      const [groups, setGroups] = React.useState<CanvasGroup[]>([])
      const [groupBranches, setGroupBranches] = React.useState<CanvasGroupBranch[]>([])
      const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
      const [stagePos, setStagePos] = React.useState({ x: 0, y: 0 })
      const [stageScale, setStageScale] = React.useState(1)
      const [figmaBinding, setFigmaBinding] = React.useState<CanvasFigmaBinding | null>(null)
      const setItemsWithoutHistory = React.useMemo(() => vi.fn(setItems), [])
      const { handleCanvasItemsLoaded } = useCanvasLegacyCropUpgrade({
        canvasId,
        items,
        setItemsWithoutHistory,
        ...(readEvidence ? { readEvidence } : {}),
        waitForIdle: async () => undefined
      })
      useCanvasViewportPersistence({
        config: DEFAULT_CONFIG,
        canvasId,
        items,
        groups,
        groupBranches,
        selectedIds,
        figmaBinding,
        stagePos,
        stageScale,
        stageSize: { width: 1280, height: 720 },
        maxFitStageScale: 2,
        clampStageScale: (value: number) => value,
        getCanvasItemsVisualBounds: () => null,
        hydrateCanvasImageItemForCanvas: hydrate ?? (async (item) => item),
        nextZIndexRef: React.useRef(1),
        setItems,
        setItemsWithHistory: setItems,
        setGroups,
        setGroupBranches,
        setSelectedIds,
        setStagePos,
        setStageScale,
        setFigmaBinding,
        handleImportFiles: vi.fn(),
        addModel3DToCanvas: vi.fn(),
        addVideoToCanvas: vi.fn(),
        onCanvasItemsLoaded: handleCanvasItemsLoaded
      })
      return { items, setItems, setItemsWithoutHistory }
    },
    { initialProps }
  )
}

function boardWith(items: CanvasItem[]) {
  return { items, groups: [], groupBranches: [], figmaBinding: null }
}

function findImage(items: CanvasItem[], id = 'legacy-crop'): CanvasImageItem {
  const item = items.find((candidate) => candidate.id === id)
  if (!item || item.type !== 'image') throw new Error(`missing image ${id}`)
  return item
}

function legacyCropWarnings(warn: Mock): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('stays unverified'))
}

// The real bridge, as the Agent send uses it.
async function sendToAgent(items: CanvasItem[]) {
  const notifyError = vi.fn()
  const events = vi.spyOn(window, 'dispatchEvent')
  const drawImage = vi.fn()
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ drawImage } as never)
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(CROPPED_PNG)
  try {
    const { result } = renderHook(() =>
      useCanvasBridgeActions({
        canvasId: 'board-a',
        projectName: 'Demo',
        items,
        groups: [],
        notifySuccess: vi.fn(),
        notifyError,
        extractPromptTextFromCanvasItems: () => '',
        renderCanvasItemsImageDataUrl: vi.fn(async () => 'data:image/png;base64,overview'),
        renderCanvasItemsSvgMarkup: vi.fn(async () => '<svg/>')
      })
    )
    let accepted: unknown
    await act(async () => {
      accepted = await result.current.handleSendCanvasItemsToAgent(items, 'board-a.agent-1')
    })
    const attachmentUrls = () =>
      events.mock.calls.flatMap(([event]) => {
        if (event.type !== 'send-to-agent') return []
        const url = (event as CustomEvent<{ attachment?: { url?: string } }>).detail?.attachment
          ?.url
        return url ? [url] : []
      })
    if (accepted) await waitFor(() => expect(attachmentUrls()).toContain(CROPPED_PNG))
    return { accepted, notifyError, drawImage, attachmentUrls: attachmentUrls() }
  } finally {
    events.mockRestore()
    getContext.mockRestore()
    toDataURL.mockRestore()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const MATCHING_EVIDENCE: CanvasLegacyCropEvidence = {
  sizeBytes: SOURCE_BYTES.byteLength,
  sha256: SOURCE_SHA256,
  width: 100,
  height: 80
}

describe('useCanvasLegacyCropUpgrade (owner decision 2)', () => {
  let warn: Mock

  beforeEach(() => {
    mockLoadCanvasItems.mockReset()
    mockSaveCanvasItems.mockReset().mockResolvedValue(undefined)
    mockClearCanvasItems.mockReset()
    mockDispatch.mockReset()
    localStorage.clear()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as Mock
    window.win = {
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      isMaximized: vi.fn(async () => false),
      close: vi.fn(),
      setUnsavedDocumentState: vi.fn(async () => undefined),
      reportUnsavedSaveResult: vi.fn(async () => undefined),
      onRequestUnsavedSave: vi.fn(() => vi.fn()),
      onMaximizeChanged: vi.fn(() => vi.fn())
    } as unknown as Window['win']
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('records an old crop with a matching source as reopen, and the bridge then sends its crop', async () => {
    const fixture = installSourceFixture({
      [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 100, height: 80 }
    })
    const stored = createLegacyCrop()
    // Before the pass the bridge refuses the crop with the existing message.
    const before = await sendToAgent([stored])
    expect(before.accepted).toBe(false)
    expect(before.notifyError).toHaveBeenCalledExactlyOnceWith(
      'canvas.agent_send_cropped_image_failed'
    )
    expect(fixture.fetch).not.toHaveBeenCalled()

    mockLoadCanvasItems.mockResolvedValue(boardWith([stored]))
    const { result } = renderBoard({ canvasId: 'board-a' })
    await waitFor(() => expect(findImage(result.current.items).cropSource).toBeDefined())

    const upgraded = findImage(result.current.items)
    expect(upgraded.cropSource).toEqual({
      version: 1,
      origin: 'reopen',
      width: 100,
      height: 80,
      sizeBytes: SOURCE_BYTES.byteLength,
      sha256: SOURCE_SHA256
    })
    // Only the record is added: src, crop and size hints stay as they were.
    const { cropSource: _record, ...rest } = upgraded
    expect(rest).toEqual(stored)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(fixture.decodeInputs.every((input) => input.startsWith('blob:legacy-crop-'))).toBe(true)
    expect(legacyCropWarnings(warn)).toEqual([])

    fixture.fetch.mockClear()
    const after = await sendToAgent([upgraded])
    expect(after.notifyError).not.toHaveBeenCalled()
    expect(after.accepted).toBe(true)
    expect(after.drawImage).toHaveBeenCalledWith(expect.anything(), 10, 20, 30, 40, 0, 0, 30, 40)
    expect(after.attachmentUrls).toContain(CROPPED_PNG)
    expect(after.attachmentUrls).not.toContain(SOURCE_SRC)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
  })

  it.each<{
    name: string
    served: Record<string, ServedSource>
    item: CanvasImageItem
    reason: string
    reads: number
  }>([
    {
      name: 'the source file is missing',
      served: {},
      item: createLegacyCrop(),
      reason: 'source-unavailable',
      reads: 1
    },
    {
      name: 'the source has a different pixel size',
      served: { [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 120, height: 80 } },
      item: createLegacyCrop(),
      reason: 'pixel-size-mismatch',
      reads: 1
    },
    {
      name: 'the stored byte size differs',
      served: { [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 100, height: 80 } },
      item: createLegacyCrop({ sizeBytes: SOURCE_BYTES.byteLength + 1 }),
      reason: 'byte-size-mismatch',
      reads: 1
    },
    {
      name: 'the local file identity records a different byte size',
      served: { [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 100, height: 80 } },
      item: createLegacyCrop({
        sizeBytes: SOURCE_BYTES.byteLength,
        sourceIdentity: {
          version: 1,
          kind: 'local-file',
          canonicalPath: SOURCE_PATH,
          sizeBytes: SOURCE_BYTES.byteLength + 7,
          lastModifiedMs: 1,
          cacheKey: 'synthetic-cache-key'
        }
      }),
      reason: 'byte-size-mismatch',
      reads: 1
    },
    {
      name: 'the crop lies outside the stored source',
      served: { [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 100, height: 80 } },
      item: createLegacyCrop({ crop: { x: 80, y: 20, width: 30, height: 40 } }),
      reason: 'crop-outside-source',
      reads: 0
    }
  ])(
    'adds no record when $name, and the bridge still refuses',
    async ({ served, item, reason, reads }) => {
      const fixture = installSourceFixture(served)
      mockLoadCanvasItems.mockResolvedValue(boardWith([item]))
      const { result } = renderBoard({ canvasId: 'board-a' })
      await waitFor(() => expect(legacyCropWarnings(warn)).toHaveLength(1))
      // One line naming the reason, never the path.
      expect(legacyCropWarnings(warn)[0]).toContain(`(${reason})`)
      expect(warn.mock.calls.flat().join(' ')).not.toContain('MagicPot/legacy-crop')
      expect(fixture.fetch).toHaveBeenCalledTimes(reads)
      expect(result.current.setItemsWithoutHistory).not.toHaveBeenCalled()
      const current = findImage(result.current.items)
      expect(current).toEqual(item)
      expect(current).not.toHaveProperty('cropSource')
      expect(mockSaveCanvasItems).not.toHaveBeenCalled()

      const refused = await sendToAgent([current])
      expect(refused.accepted).toBe(false)
      expect(refused.notifyError).toHaveBeenCalledExactlyOnceWith(
        'canvas.agent_send_cropped_image_failed'
      )
      expect(refused.attachmentUrls).toEqual([])
    }
  )

  it('never lets a reopen record enable the identity strip or a flatten of the saved item', async () => {
    installSourceFixture({ [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 100, height: 80 } })
    // A full-image crop: with a 'confirm' record it would be an identity crop.
    const stored = createLegacyCrop({ crop: { x: 0, y: 0, width: 100, height: 80 } })
    mockLoadCanvasItems.mockResolvedValue(boardWith([stored]))
    const { result } = renderBoard({ canvasId: 'board-a' })
    await waitFor(() => expect(findImage(result.current.items).cropSource).toBeDefined())
    const upgraded = findImage(result.current.items)
    expect(upgraded.cropSource?.origin).toBe('reopen')
    expect(isConfirmedIdentityCrop(upgraded)).toBe(false)
    expect(
      isConfirmedIdentityCrop({
        ...upgraded,
        cropSource: { ...upgraded.cropSource!, origin: 'confirm' }
      })
    ).toBe(true)
    // The persisted form keeps the original source and the crop next to the record.
    const persisted = serializeCanvasItem(upgraded) as CanvasImageItem
    expect(persisted.src).toBe(SOURCE_SRC)
    expect(persisted.crop).toEqual({ x: 0, y: 0, width: 100, height: 80 })
    expect(persisted.cropSource).toEqual(upgraded.cropSource)
    await waitFor(() => expect(mockSaveCanvasItems).toHaveBeenCalledTimes(1))
    const [savedItems] = mockSaveCanvasItems.mock.calls[0] as [CanvasItem[]]
    expect(findImage(savedItems)).toMatchObject({
      src: SOURCE_SRC,
      crop: { x: 0, y: 0, width: 100, height: 80 }
    })
    expect(findImage(savedItems).cropSource?.origin).toBe('reopen')
  })

  it('runs once per board open and not on re-render', async () => {
    const fixture = installSourceFixture({
      [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 120, height: 80 }
    })
    mockLoadCanvasItems.mockResolvedValue(boardWith([createLegacyCrop()]))
    const { result, rerender } = renderBoard({ canvasId: 'board-a' })
    await waitFor(() => expect(legacyCropWarnings(warn)).toHaveLength(1))
    for (let index = 0; index < 3; index += 1) {
      rerender({ canvasId: 'board-a' })
      act(() => {
        result.current.setItems((prev) => [...prev])
      })
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(legacyCropWarnings(warn)).toHaveLength(1)
    expect(mockLoadCanvasItems).toHaveBeenCalledTimes(1)
  })

  it('records nothing on a second open once the first open stored the record', async () => {
    const fixture = installSourceFixture({
      [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 100, height: 80 }
    })
    mockLoadCanvasItems.mockResolvedValue(boardWith([createLegacyCrop()]))
    const first = renderBoard({ canvasId: 'board-a' })
    await waitFor(() => expect(mockSaveCanvasItems).toHaveBeenCalledTimes(1))
    const [savedItems] = mockSaveCanvasItems.mock.calls[0] as [CanvasItem[]]
    first.unmount()
    fixture.fetch.mockClear()

    mockLoadCanvasItems.mockResolvedValue(boardWith(savedItems))
    const second = renderBoard({ canvasId: 'board-a' })
    await waitFor(() =>
      expect(findImage(second.result.current.items).cropSource?.origin).toBe('reopen')
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(second.result.current.setItemsWithoutHistory).not.toHaveBeenCalled()
  })

  it('writes nothing into the next board when the board is switched mid-pass', async () => {
    const reads: Array<ReturnType<typeof deferred<CanvasLegacyCropEvidence | null>>> = []
    const readEvidence: CanvasLegacyCropEvidenceReader = vi.fn(() => {
      const read = deferred<CanvasLegacyCropEvidence | null>()
      reads.push(read)
      return read.promise
    })
    // Board B holds an item with the same id, source, crop and hints.
    mockLoadCanvasItems.mockImplementation(async () => boardWith([createLegacyCrop()]))
    const { result, rerender } = renderBoard({ canvasId: 'board-a', readEvidence })
    await waitFor(() => expect(reads).toHaveLength(1))

    rerender({ canvasId: 'board-b', readEvidence })
    await waitFor(() => expect(reads).toHaveLength(2))
    expect(mockLoadCanvasItems).toHaveBeenLastCalledWith('board-b')
    // Board B's own source is gone; board A's late read matches.
    await act(async () => {
      reads[1].resolve(null)
      reads[0].resolve(MATCHING_EVIDENCE)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(result.current.setItemsWithoutHistory).not.toHaveBeenCalled()
    expect(findImage(result.current.items)).not.toHaveProperty('cropSource')
    expect(legacyCropWarnings(warn)).toEqual([
      '[Canvas] A crop saved without a source record stays unverified (source-unavailable).'
    ])
  })

  it('writes nothing after unmount or when the crop changed during the read', async () => {
    const reads: Array<ReturnType<typeof deferred<CanvasLegacyCropEvidence | null>>> = []
    const readEvidence: CanvasLegacyCropEvidenceReader = vi.fn((_src, isCurrent) => {
      const read = deferred<CanvasLegacyCropEvidence | null>()
      reads.push(read)
      return read.promise.then((evidence) => (isCurrent() ? evidence : null))
    })
    mockLoadCanvasItems.mockResolvedValue(boardWith([createLegacyCrop()]))
    const edited = renderBoard({ canvasId: 'board-a', readEvidence })
    await waitFor(() => expect(reads).toHaveLength(1))
    act(() => {
      edited.result.current.setItems((prev) =>
        prev.map((item) =>
          item.type === 'image' ? { ...item, crop: { x: 0, y: 0, width: 50, height: 50 } } : item
        )
      )
    })
    await act(async () => {
      reads[0].resolve(MATCHING_EVIDENCE)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(edited.result.current.setItemsWithoutHistory).not.toHaveBeenCalled()
    expect(findImage(edited.result.current.items)).not.toHaveProperty('cropSource')
    edited.unmount()

    const unmounted = renderBoard({ canvasId: 'board-a', readEvidence })
    await waitFor(() => expect(reads).toHaveLength(2))
    const setter = unmounted.result.current.setItemsWithoutHistory
    unmounted.unmount()
    await act(async () => {
      reads[1].resolve(MATCHING_EVIDENCE)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(setter).not.toHaveBeenCalled()
  })

  it('marks the board dirty once under the persisted signature and saves the records once', async () => {
    const otherPath = 'C:/MagicPot/legacy-crop-2.jpg'
    const otherBytes = new TextEncoder().encode('another synthetic legacy source, longer')
    installSourceFixture({
      [SOURCE_PATH]: { bytes: SOURCE_BYTES, width: 100, height: 80 },
      [otherPath]: { bytes: otherBytes, width: 64, height: 64 }
    })
    const second = createLegacyCrop({
      id: 'legacy-crop-2',
      src: `local-media:///${otherPath}`,
      sizeBytes: otherBytes.byteLength,
      sourceWidth: 64,
      sourceHeight: 64,
      crop: { x: 4, y: 4, width: 16, height: 16 }
    })
    mockLoadCanvasItems.mockResolvedValue(boardWith([createLegacyCrop(), second]))
    const { result } = renderBoard({ canvasId: 'board-a' })
    await waitFor(() => expect(mockSaveCanvasItems).toHaveBeenCalledTimes(1))
    const [savedItems, savedCanvasId] = mockSaveCanvasItems.mock.calls[0] as [CanvasItem[], string]
    expect(savedCanvasId).toBe('board-a')
    expect(findImage(savedItems).cropSource?.origin).toBe('reopen')
    expect(findImage(savedItems, 'legacy-crop-2').cropSource).toMatchObject({
      origin: 'reopen',
      width: 64,
      height: 64
    })
    // Both records arrive in one update without history.
    expect(result.current.setItemsWithoutHistory).toHaveBeenCalledTimes(1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(mockSaveCanvasItems).toHaveBeenCalledTimes(1)
    const dirtyStates = (window.win!.setUnsavedDocumentState as Mock).mock.calls.map(
      ([state]) => (state as { dirty: boolean }).dirty
    )
    const dirtyTransitions = dirtyStates.filter((dirty, index) => dirty && !dirtyStates[index - 1])
    expect(dirtyTransitions).toHaveLength(1)
    expect(dirtyStates.at(-1)).toBe(false)
  })

  it('keeps a crop stored without a source size refused on every later open, although hydration fills the hints in', async () => {
    const fixture = installSourceFixture({
      [RESTORED_BLOB_SRC]: { bytes: SOURCE_BYTES, width: 100, height: 80 }
    })
    const hydrate = backfillingHydrate({
      width: 100,
      height: 80,
      sizeBytes: SOURCE_BYTES.byteLength
    })
    const stored = createLegacyCrop({
      src: RESTORED_BLOB_SRC,
      sourceWidth: undefined,
      sourceHeight: undefined,
      sizeBytes: undefined
    })

    // Open 1: refused with one line, nothing read; the crop is marked.
    mockLoadCanvasItems.mockResolvedValue(boardWith([stored]))
    const first = renderBoard({ canvasId: 'board-a', hydrate })
    await waitFor(() => expect(mockSaveCanvasItems).toHaveBeenCalled())
    expect(legacyCropWarnings(warn)).toEqual([
      '[Canvas] A crop saved without a source record stays unverified (no-source-size).'
    ])
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(first.result.current.setItemsWithoutHistory).toHaveBeenCalledTimes(1)
    const opened = findImage(first.result.current.items)
    expect(opened).not.toHaveProperty('cropSource')
    expect(isLegacyCropWithoutSourceSize(opened)).toBe(true)
    // The save holds the hints hydration filled in, and the marker next to them.
    const [savedItems] = mockSaveCanvasItems.mock.calls.at(-1) as [CanvasItem[]]
    const saved = findImage(savedItems)
    expect(saved).toMatchObject({ sourceWidth: 100, sourceHeight: 80, crop: CROP })
    expect(saved).not.toHaveProperty('cropSource')
    expect(
      (saved as unknown as Record<string, unknown>)[LEGACY_CROP_WITHOUT_SOURCE_SIZE_KEY]
    ).toEqual(CROP)
    expect(serializeCanvasItem(opened)).toHaveProperty(LEGACY_CROP_WITHOUT_SOURCE_SIZE_KEY, CROP)
    const firstRefusal = await sendToAgent([opened])
    expect(firstRefusal.accepted).toBe(false)
    expect(firstRefusal.notifyError).toHaveBeenCalledExactlyOnceWith(
      'canvas.agent_send_cropped_image_failed'
    )
    first.unmount()

    // Open 2 and 3 on what was saved: the stored hints are now present, but the
    // crop is still not measured, and the bridge still refuses.
    let reopened = saved
    for (let open = 2; open <= 3; open += 1) {
      warn.mockClear()
      mockSaveCanvasItems.mockClear()
      fixture.fetch.mockClear()
      mockLoadCanvasItems.mockResolvedValue(boardWith([reopened]))
      const board = renderBoard({ canvasId: 'board-a', hydrate })
      await waitFor(() => expect(legacyCropWarnings(warn)).toHaveLength(1))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600))
      })
      expect(legacyCropWarnings(warn)[0]).toContain('(no-source-size)')
      expect(fixture.fetch).not.toHaveBeenCalled()
      expect(board.result.current.setItemsWithoutHistory).not.toHaveBeenCalled()
      expect(mockSaveCanvasItems).not.toHaveBeenCalled()
      reopened = findImage(board.result.current.items)
      expect(reopened).not.toHaveProperty('cropSource')
      const refused = await sendToAgent([reopened])
      expect(refused.accepted).toBe(false)
      expect(refused.notifyError).toHaveBeenCalledExactlyOnceWith(
        'canvas.agent_send_cropped_image_failed'
      )
      expect(refused.attachmentUrls).toEqual([])
      board.unmount()
    }
  })

  it('keeps the crop marked when an ordinary edit autosaves the board before the next open', async () => {
    installSourceFixture({ [RESTORED_BLOB_SRC]: { bytes: SOURCE_BYTES, width: 100, height: 80 } })
    const hydrate = backfillingHydrate({
      width: 100,
      height: 80,
      sizeBytes: SOURCE_BYTES.byteLength
    })
    const stored = createLegacyCrop({
      src: RESTORED_BLOB_SRC,
      sourceWidth: undefined,
      sourceHeight: undefined
    })
    mockLoadCanvasItems.mockResolvedValue(boardWith([stored]))
    const first = renderBoard({ canvasId: 'board-a', hydrate })
    await waitFor(() =>
      expect(isLegacyCropWithoutSourceSize(findImage(first.result.current.items))).toBe(true)
    )
    // An ordinary edit (a move) after the pass, then the autosave.
    act(() => {
      first.result.current.setItems((prev) =>
        prev.map((item) => (item.id === 'legacy-crop' ? { ...item, x: 42 } : item))
      )
    })
    await waitFor(() =>
      expect(
        (mockSaveCanvasItems.mock.calls as Array<[CanvasItem[]]>).some(
          ([items]) => findImage(items).x === 42
        )
      ).toBe(true)
    )
    const [savedItems] = mockSaveCanvasItems.mock.calls.at(-1) as [CanvasItem[]]
    first.unmount()

    const readEvidence: CanvasLegacyCropEvidenceReader = vi.fn(async () => MATCHING_EVIDENCE)
    mockLoadCanvasItems.mockResolvedValue(boardWith(savedItems))
    const second = renderBoard({ canvasId: 'board-a', hydrate, readEvidence })
    await waitFor(() => expect(legacyCropWarnings(warn)).toHaveLength(2))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(readEvidence).not.toHaveBeenCalled()
    expect(findImage(second.result.current.items)).not.toHaveProperty('cropSource')
  })

  it('measures a new crop of a marked image like any other crop', async () => {
    const fixture = installSourceFixture({
      [RESTORED_BLOB_SRC]: { bytes: SOURCE_BYTES, width: 100, height: 80 }
    })
    // The marker covers an older rectangle; the current crop was made later
    // with stored size hints.
    const stored = {
      ...createLegacyCrop({ src: RESTORED_BLOB_SRC }),
      [LEGACY_CROP_WITHOUT_SOURCE_SIZE_KEY]: { x: 0, y: 0, width: 5, height: 5 }
    } as CanvasImageItem
    expect(isLegacyCropWithoutSourceSize(stored)).toBe(false)
    mockLoadCanvasItems.mockResolvedValue(boardWith([stored]))
    const { result } = renderBoard({ canvasId: 'board-a' })
    await waitFor(() => expect(findImage(result.current.items).cropSource?.origin).toBe('reopen'))
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(legacyCropWarnings(warn)).toEqual([])
  })

  describe('with the page runtime state (F2 part 3)', () => {
    function renderRuntimeBoard(readEvidence: CanvasLegacyCropEvidenceReader) {
      return renderHook(() => {
        const runtime = useProjectCanvasPageRuntimeState()
        const setItemsWithoutHistory = React.useMemo(() => vi.fn(runtime.setItems), [runtime.setItems])
        const upgrade = useCanvasLegacyCropUpgrade({
          canvasId: 'board-a',
          items: runtime.items,
          setItemsWithoutHistory,
          attestItems: runtime.attestItems,
          readEvidence,
          waitForIdle: async () => undefined
        })
        return { runtime, upgrade, setItemsWithoutHistory }
      })
    }

    it('keeps the reopen record through an undo of an edit made before it landed, and the selected revision', async () => {
      const read = deferred<CanvasLegacyCropEvidence | null>()
      const readEvidence = vi.fn(() => read.promise)
      const { result } = renderRuntimeBoard(readEvidence)
      const stored = createLegacyCrop()
      act(() => result.current.runtime.setItems([stored]))
      act(() =>
        result.current.upgrade.handleCanvasItemsLoaded({ canvasId: 'board-a', storedItems: [stored] })
      )
      await waitFor(() => expect(readEvidence).toHaveBeenCalledTimes(1))
      // The user edits twice and picks a history node before the record lands.
      act(() => result.current.runtime.setItemsWithHistory([{ ...stored, x: 10 }]))
      act(() => result.current.runtime.setItemsWithHistory([{ ...stored, x: 20 }]))
      act(() => result.current.runtime.restoreHistoryRevision(1))
      expect(result.current.runtime.selectedHistoryRevision).toBe(1)

      await act(async () => read.resolve(MATCHING_EVIDENCE))
      await waitFor(() =>
        expect(findImage(result.current.runtime.items).cropSource?.origin).toBe('reopen')
      )
      expect(result.current.setItemsWithoutHistory).not.toHaveBeenCalled()
      expect(result.current.runtime.selectedHistoryRevision).toBe(1)

      act(() => result.current.runtime.handleUndo())
      expect(findImage(result.current.runtime.items).cropSource?.origin).toBe('reopen')
      act(() => result.current.runtime.handleRedo())
      act(() => result.current.runtime.handleRedo())
      expect(findImage(result.current.runtime.items).x).toBe(20)
      expect(findImage(result.current.runtime.items).cropSource?.origin).toBe('reopen')
    })
  })

  describe('fences of the pass (F2 part 6: guards no test reached)', () => {
    function renderFenceBoard(readEvidence: CanvasLegacyCropEvidenceReader) {
      return renderHook(() => {
        const runtime = useProjectCanvasPageRuntimeState()
        const upgrade = useCanvasLegacyCropUpgrade({
          canvasId: 'board-a',
          items: runtime.items,
          setItemsWithoutHistory: runtime.setItems,
          attestItems: runtime.attestItems,
          readEvidence,
          waitForIdle: async () => undefined
        })
        return { runtime, upgrade }
      })
    }

    async function startPass() {
      const read = deferred<CanvasLegacyCropEvidence | null>()
      const readEvidence = vi.fn(
        (_src: string, _isCurrent: () => boolean) => read.promise
      )
      const view = renderFenceBoard(readEvidence)
      const stored = createLegacyCrop()
      act(() => view.result.current.runtime.setItems([stored]))
      act(() =>
        view.result.current.upgrade.handleCanvasItemsLoaded({
          canvasId: 'board-a',
          storedItems: [stored]
        })
      )
      await waitFor(() => expect(readEvidence).toHaveBeenCalledTimes(1))
      return { ...view, read, readEvidence, stored }
    }

    it('writes no record when the source changes during the read, although crop and size stay', async () => {
      const { result, read, readEvidence, stored } = await startPass()
      act(() =>
        result.current.runtime.setItems([{ ...stored, src: 'blob:replaced-same-size-source' }])
      )
      expect((readEvidence.mock.calls[0][1] as () => boolean)()).toBe(false)
      await act(async () => read.resolve(MATCHING_EVIDENCE))
      await act(async () => {
        await Promise.resolve()
      })
      expect(findImage(result.current.runtime.items).cropSource).toBeUndefined()
    })

    it('never replaces a confirm record that lands during the read with a reopen record', async () => {
      const { result, read, stored } = await startPass()
      const confirmRecord = {
        version: 1 as const,
        origin: 'confirm' as const,
        ...MATCHING_EVIDENCE
      }
      act(() =>
        result.current.runtime.attestItems((item) =>
          item.id === stored.id ? ({ ...item, cropSource: confirmRecord } as CanvasItem) : item
        )
      )
      await act(async () => read.resolve(MATCHING_EVIDENCE))
      await act(async () => {
        await Promise.resolve()
      })
      expect(findImage(result.current.runtime.items).cropSource).toEqual(confirmRecord)
    })
  })

  it('judges candidates on the stored items', () => {
    const { candidates, refusals, toMark } = collectCanvasLegacyCropCandidates([
      createLegacyCrop(),
      createLegacyCrop({
        id: 'recorded',
        cropSource: { version: 1, origin: 'confirm', ...MATCHING_EVIDENCE }
      }),
      createLegacyCrop({ id: 'uncropped', crop: undefined }),
      createLegacyCrop({ id: 'fractional-hint', sourceWidth: 100.5 }),
      createLegacyCrop({ id: 'negative', crop: { x: -1, y: 0, width: 10, height: 10 } }),
      createLegacyCrop({ id: 'no-bytes', sizeBytes: undefined }),
      createLegacyCrop({ id: 'no-hints', sourceWidth: undefined, sourceHeight: undefined }),
      {
        ...createLegacyCrop({ id: 'marked' }),
        [LEGACY_CROP_WITHOUT_SOURCE_SIZE_KEY]: { ...CROP }
      } as CanvasImageItem
    ])
    expect(candidates.map((candidate) => [candidate.id, candidate.expectedSizeBytes])).toEqual([
      ['legacy-crop', SOURCE_BYTES.byteLength],
      ['no-bytes', null]
    ])
    expect(refusals).toEqual([
      'no-source-size',
      'crop-outside-source',
      'no-source-size',
      'no-source-size'
    ])
    // Crops first seen without a valid stored size are marked; a marked one is not again.
    expect(toMark).toEqual([
      { id: 'fractional-hint', crop: CROP },
      { id: 'no-hints', crop: CROP }
    ])
  })
})
