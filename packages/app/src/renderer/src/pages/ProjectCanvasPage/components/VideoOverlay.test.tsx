import path from 'node:path'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import VideoOverlay from './VideoOverlay'
import type { CanvasVideoItem } from '../types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

const PROJECT_CANVAS_VIDEO_FIXTURE_URL = pathToFileURL(
  path.join(
    process.cwd(),
    'src',
    'main',
    'testSupport',
    'fixtures',
    'projectCanvas',
    'projectCanvasSampleVideo.webm'
  )
).href

function createVideoItem(): CanvasVideoItem {
  return {
    id: 'video-1',
    type: 'video',
    src: PROJECT_CANVAS_VIDEO_FIXTURE_URL,
    fileName: 'projectCanvasSampleVideo.webm',
    x: 80,
    y: 64,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    playing: false,
    muted: true,
    volume: 0
  }
}

function createCanvasContainerRef(): React.RefObject<HTMLDivElement | null> {
  const element = document.createElement('div')
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 1280,
      bottom: 720,
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  })

  return { current: element }
}

function countPointerListenerCalls(spy: MockInstance<typeof window.addEventListener>): number {
  return spy.mock.calls.filter(
    ([eventName]) =>
      eventName === 'pointermove' || eventName === 'pointerup' || eventName === 'pointercancel'
  ).length
}

describe('VideoOverlay', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('selects and opens context menu from the root overlay', () => {
    const onSelect = vi.fn()
    const onContextMenu = vi.fn()
    const onUpdateItem = vi.fn()
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined as unknown as void)
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onContextMenu={onContextMenu}
        onUpdateItem={onUpdateItem}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.click(overlay!)
    fireEvent.contextMenu(overlay!)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    expect(playSpy).not.toHaveBeenCalled()
    expect(pauseSpy).toHaveBeenCalled()
  })

  it('commits a direct drag for an unselected video overlay', () => {
    const onSelect = vi.fn()
    const onDragEnd = vi.fn()
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={onDragEnd}
        onUpdateItem={vi.fn()}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(countPointerListenerCalls(addEventListenerSpy)).toBe(0)

    fireEvent.pointerDown(overlay!, { pointerId: 7, button: 0, clientX: 120, clientY: 90 })
    expect(countPointerListenerCalls(addEventListenerSpy)).toBe(3)

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 170, clientY: 140 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 170, clientY: 140 })

    expect(onDragEnd).toHaveBeenCalledWith('video-1', 130, 114, expect.any(PointerEvent))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(countPointerListenerCalls(removeEventListenerSpy)).toBe(3)
  })

  it('removes active drag listeners when a drag is canceled', () => {
    const onDragEnd = vi.fn()
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={vi.fn()}
        onDragEnd={onDragEnd}
        onUpdateItem={vi.fn()}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.pointerDown(overlay!, { pointerId: 7, button: 0, clientX: 120, clientY: 90 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 170, clientY: 140 })
    fireEvent.pointerCancel(window, { pointerId: 7, clientX: 170, clientY: 140 })

    expect(onDragEnd).not.toHaveBeenCalled()
    expect(countPointerListenerCalls(removeEventListenerSpy)).toBe(3)
    expect(overlay).toHaveStyle({ transform: 'translate3d(80px, 64px, 0)' })
  })

  it('does not mount a video element for poster-frame budget mode', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()

    const { container, getByTestId } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="poster-frame"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    expect(container.querySelector('video')).toBeNull()
    expect(getByTestId('video-poster-video-1')).toBeInTheDocument()
  })

  it('does not auto-play poster-frame videos on hover', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined as unknown as void)

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="poster-frame"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.mouseEnter(overlay!)

    expect(container.querySelector('video')).toBeNull()
    expect(playSpy).not.toHaveBeenCalled()
  })

  it('preserves the video budget mode attribute when the media element errors', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    const video = container.querySelector('video') as HTMLVideoElement | null
    expect(video).not.toBeNull()
    fireEvent.error(video!)

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(overlay?.dataset.canvasVideoBudgetMode).toBe('visible-paused')
  })

  it('does not render a centered play affordance while idle', () => {
    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onUpdateItem={vi.fn()}
      />
    )

    expect(container.querySelectorAll('svg[data-testid="PlayArrowIcon"]')).toHaveLength(0)
  })

  it('keeps hovered visible-paused videos paused until the active-playing budget admits playback', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()
    const item = createVideoItem()
    item.playing = true
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined as unknown as void)
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})

    const { container, rerender } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={item}
        budgetMode="visible-paused"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.mouseEnter(overlay!)

    expect(playSpy).not.toHaveBeenCalled()
    expect(pauseSpy).toHaveBeenCalled()
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(container.querySelectorAll('svg[data-testid="PlayArrowIcon"]')).toHaveLength(1)

    rerender(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={item}
        budgetMode="active-playing"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    expect(playSpy).toHaveBeenCalled()
  })

  it('disables pointer input when hand panning owns the video overlay', () => {
    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected={false}
        showSelectionOutline={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        allowPointerPassthrough
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onUpdateItem={vi.fn()}
      />
    )

    const root = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(root).not.toBeNull()
    expect(root).toHaveStyle({ pointerEvents: 'none' })
  })

  it('treats the visible play control as a real play request when runtime budget throttles an item that still wants playback', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()
    const item = createVideoItem()
    item.playing = true

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={item}
        budgetMode="visible-paused"
        isSelected
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(overlay).not.toBeNull()
    fireEvent.mouseEnter(overlay!)

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)

    expect(onUpdateItem).toHaveBeenCalledWith('video-1', { playing: true })
  })

  it('keeps explicit play interaction available for mounted visible-paused videos', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined as unknown as void)

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    expect(overlay).not.toBeNull()

    fireEvent.mouseEnter(overlay!)

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(2)

    fireEvent.click(buttons[0]!)

    expect(onUpdateItem).toHaveBeenCalledWith('video-1', { playing: true })
    expect(playSpy).not.toHaveBeenCalled()
  })

  it('updates the control bar from loaded metadata for a fixture-backed video src', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})

    const { container, getByText } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="video"]') as HTMLElement | null
    const video = container.querySelector('video') as HTMLVideoElement | null
    expect(overlay).not.toBeNull()
    expect(video).not.toBeNull()

    Object.defineProperty(video!, 'duration', { configurable: true, value: 1 })
    fireEvent.loadedMetadata(video!)
    fireEvent.mouseEnter(overlay!)

    expect(getByText('0:00 / 0:01')).toBeInTheDocument()
    expect(pauseSpy).toHaveBeenCalled()
  })

  it('updates video volume from the control bar slider', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={createVideoItem()}
        budgetMode="visible-paused"
        isSelected
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    const volumeSlider = container.querySelector(
      'input[aria-label="Video volume"]'
    ) as HTMLInputElement | null
    expect(volumeSlider).not.toBeNull()

    fireEvent.change(volumeSlider!, { target: { value: '0.65' } })

    expect(onUpdateItem).toHaveBeenCalledWith('video-1', {
      volume: 0.65,
      muted: false
    })
  })

  it('restores an audible volume when unmuting a zero-volume video', () => {
    const onSelect = vi.fn()
    const onUpdateItem = vi.fn()
    const item = createVideoItem()
    item.volume = 0
    item.muted = true

    const { container } = render(
      <VideoOverlay
        canvasContainerRef={createCanvasContainerRef()}
        item={item}
        budgetMode="visible-paused"
        isSelected
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={onSelect}
        onDragEnd={vi.fn()}
        onUpdateItem={onUpdateItem}
      />
    )

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(2)

    fireEvent.click(buttons[1]!)

    expect(onUpdateItem).toHaveBeenCalledWith('video-1', {
      muted: false,
      volume: 0.5
    })
  })
})
