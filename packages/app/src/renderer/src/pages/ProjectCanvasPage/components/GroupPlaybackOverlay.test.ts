import React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'

let latestCanvas3DStageProps: Record<string, unknown> | null = null

vi.mock('react-konva', () => ({
  Stage: () => null,
  Layer: () => null,
  Rect: () => null,
  Image: () => null,
  Transformer: () => null,
  Line: () => null,
  Text: () => null,
  Ellipse: () => null,
  Arrow: () => null,
  Shape: () => null,
  Group: () => null
}))

vi.mock('konva/lib/Stage', () => ({
  Stage: class {}
}))

vi.mock('konva', () => ({
  default: {}
}))

vi.mock('./Canvas3DStage', () => ({
  default: (props: Record<string, unknown>) => {
    latestCanvas3DStageProps = props
    const items = (props.items as Array<{ id: string }>) ?? []
    return React.createElement(
      'div',
      { 'data-testid': 'canvas-3d-stage' },
      items.map((item) => item.id).join(',')
    )
  }
}))

import {
  resolveGroupPlaybackOverlayLayout,
  shouldShowGroupPlaybackTransportControl
} from './GroupPlaybackOverlay'
import GroupPlaybackOverlay from './GroupPlaybackOverlay'
import {
  findNextValidGroupPlaybackIndex,
  getGroupPlaybackLocateBounds,
  getNextGroupPlaybackIndex,
  orderGroupItemsByGroupIds,
  resolveGroupPlaybackVideoFramePlan,
  shouldRenderStandaloneModel3DItemDuringGroupPlayback,
  shouldSuppressStandaloneModel3DSurface
} from '../groupPlaybackUtils'
import type { CanvasImageItem, CanvasModel3DItem, CanvasVideoItem } from '../types'

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined)
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn()
  })
})

afterEach(() => {
  latestCanvas3DStageProps = null
  vi.clearAllMocks()
})

function createImageItem(): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'image.png',
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

function createScaledImageItem(): CanvasImageItem {
  return {
    ...createImageItem(),
    id: 'image-scaled',
    x: 10,
    y: 20,
    width: 320,
    height: 200,
    scaleX: 0.5,
    scaleY: 2
  }
}

function createMirroredImageItem(): CanvasImageItem {
  return {
    ...createImageItem(),
    id: 'image-mirrored',
    x: 10,
    y: 20,
    width: 320,
    height: 200,
    scaleX: -0.5,
    scaleY: 2
  }
}

function createVideoItem(): CanvasVideoItem {
  return {
    id: 'video-1',
    type: 'video',
    src: 'video.mp4',
    fileName: 'video.mp4',
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    playing: false,
    muted: true,
    volume: 0
  }
}

function createModel3DItem(): CanvasModel3DItem {
  return {
    id: 'model-1',
    type: 'model3d',
    src: 'model.glb',
    fileName: 'model.glb',
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

describe('shouldShowGroupPlaybackTransportControl', () => {
  it('hides transport controls for a single image frame', () => {
    expect(shouldShowGroupPlaybackTransportControl(createImageItem(), 1)).toBe(false)
  })

  it('hides transport controls for a single 3d frame', () => {
    expect(shouldShowGroupPlaybackTransportControl(createModel3DItem(), 1)).toBe(false)
  })

  it('keeps transport controls for a single video frame', () => {
    expect(shouldShowGroupPlaybackTransportControl(createVideoItem(), 1)).toBe(true)
  })

  it('keeps transport controls for multi-item playback even on non-video frames', () => {
    expect(shouldShowGroupPlaybackTransportControl(createImageItem(), 2)).toBe(true)
  })
})

describe('resolveGroupPlaybackOverlayLayout', () => {
  it('expands landscape playback to fill the available viewport while preserving aspect ratio', () => {
    const layout = resolveGroupPlaybackOverlayLayout(
      createImageItem(),
      {
        x: 10,
        y: 20,
        width: 320,
        height: 200
      },
      {
        width: 1200,
        height: 900
      }
    )

    expect(layout.surfaceWidth).toBe(1104)
    expect(layout.surfaceHeight).toBe(690)
    expect(layout.mediaWidth).toBe(1104)
    expect(layout.mediaHeight).toBe(690)
    expect(layout.left).toBe(48)
    expect(layout.top).toBe(65)
  })

  it('accounts for rotated playback items when fitting them into the viewport', () => {
    const layout = resolveGroupPlaybackOverlayLayout(
      {
        ...createImageItem(),
        rotation: 90
      },
      {
        x: 10,
        y: 20,
        width: 320,
        height: 200
      },
      {
        width: 1200,
        height: 900
      }
    )

    expect(layout.surfaceWidth).toBe(1104)
    expect(layout.surfaceHeight).toBe(690)
    expect(layout.mediaWidth).toBeCloseTo(690, 5)
    expect(layout.mediaHeight).toBeCloseTo(431.25, 5)
    expect(layout.mediaLeft).toBeCloseTo(207, 5)
    expect(layout.mediaTop).toBeCloseTo(129.375, 5)
  })

  it('keeps the playback frame stable across items with different aspect ratios', () => {
    const landscapeLayout = resolveGroupPlaybackOverlayLayout(
      createImageItem(),
      {
        x: 10,
        y: 20,
        width: 320,
        height: 200
      },
      {
        width: 1200,
        height: 900
      }
    )
    const portraitLayout = resolveGroupPlaybackOverlayLayout(
      {
        ...createImageItem(),
        width: 200,
        height: 320
      },
      {
        x: 10,
        y: 20,
        width: 320,
        height: 200
      },
      {
        width: 1200,
        height: 900
      }
    )

    expect(portraitLayout.surfaceWidth).toBe(landscapeLayout.surfaceWidth)
    expect(portraitLayout.surfaceHeight).toBe(landscapeLayout.surfaceHeight)
    expect(portraitLayout.left).toBe(landscapeLayout.left)
    expect(portraitLayout.top).toBe(landscapeLayout.top)
  })
})

describe('orderGroupItemsByGroupIds', () => {
  it('respects the stored group item order', () => {
    const ordered = orderGroupItemsByGroupIds(
      ['video-1', 'image-1', 'missing'],
      [createImageItem(), createVideoItem(), createModel3DItem()]
    )

    expect(ordered.map((item) => item.id)).toEqual(['video-1', 'image-1'])
  })
})

describe('getNextGroupPlaybackIndex', () => {
  it('advances to the next item while the sequence still has remaining frames', () => {
    expect(getNextGroupPlaybackIndex(0, 3)).toBe(1)
    expect(getNextGroupPlaybackIndex(1, 3)).toBe(2)
  })

  it('returns null once the current frame is the last frame', () => {
    expect(getNextGroupPlaybackIndex(2, 3)).toBeNull()
    expect(getNextGroupPlaybackIndex(0, 0)).toBeNull()
  })
})

describe('findNextValidGroupPlaybackIndex', () => {
  it('finds the next still-available item without wrapping back to the start', () => {
    expect(
      findNextValidGroupPlaybackIndex(
        ['image-1', 'video-1', 'model-1'],
        0,
        (itemId) => itemId !== 'video-1'
      )
    ).toBe(2)
  })

  it('returns null when there is no later valid item in the sequence', () => {
    expect(
      findNextValidGroupPlaybackIndex(
        ['image-1', 'video-1', 'model-1'],
        1,
        (itemId) => itemId === 'image-1'
      )
    ).toBeNull()
  })
})

describe('getGroupPlaybackLocateBounds', () => {
  it.each([
    ['image', createImageItem()],
    ['video', createVideoItem()],
    ['model3d', createModel3DItem()]
  ])('prefers the active %s bounds when they are available', (_type, item) => {
    const locateBounds = getGroupPlaybackLocateBounds(item, {
      x: 10,
      y: 20,
      width: 30,
      height: 40
    })

    expect(locateBounds).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 200
    })
  })

  it('uses the transformed visual bounds for scaled playback items', () => {
    const locateBounds = getGroupPlaybackLocateBounds(createScaledImageItem(), {
      x: 10,
      y: 20,
      width: 30,
      height: 40
    })

    expect(locateBounds).toEqual({
      x: 10,
      y: 20,
      width: 160,
      height: 400
    })
  })

  it('uses the transformed visual bounds for mirrored playback items', () => {
    const locateBounds = getGroupPlaybackLocateBounds(createMirroredImageItem(), {
      x: 10,
      y: 20,
      width: 30,
      height: 40
    })

    expect(locateBounds).toEqual({
      x: -150,
      y: 20,
      width: 160,
      height: 400
    })
  })

  it('falls back to the group bounds when no active item is available', () => {
    expect(
      getGroupPlaybackLocateBounds(null, {
        x: 10,
        y: 20,
        width: 30,
        height: 40
      })
    ).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40
    })
  })
})

describe('shouldSuppressStandaloneModel3DSurface', () => {
  it('suppresses the standalone 3d surface for the active playback model', () => {
    expect(shouldSuppressStandaloneModel3DSurface(createModel3DItem())).toBe(true)
    expect(shouldSuppressStandaloneModel3DSurface(createImageItem())).toBe(false)
  })
})

describe('shouldRenderStandaloneModel3DItemDuringGroupPlayback', () => {
  it('hides the active playback model while keeping unrelated 3d items visible', () => {
    expect(
      shouldRenderStandaloneModel3DItemDuringGroupPlayback('model-1', createModel3DItem())
    ).toBe(false)
    expect(
      shouldRenderStandaloneModel3DItemDuringGroupPlayback('other-model', createModel3DItem())
    ).toBe(true)
    expect(shouldRenderStandaloneModel3DItemDuringGroupPlayback('model-1', createImageItem())).toBe(
      true
    )
  })
})

describe('resolveGroupPlaybackVideoFramePlan', () => {
  it('builds a multi-frame plan across the available duration', () => {
    const plan = resolveGroupPlaybackVideoFramePlan(2, 4, 12)

    expect(plan).toHaveLength(8)
    expect(plan[0]).toEqual({ delayMs: 250, timeSeconds: 0 })
    expect(plan.at(-1)?.timeSeconds).toBeCloseTo(1.95, 5)
  })

  it('caps long videos to the configured frame budget while preserving total playback time', () => {
    const plan = resolveGroupPlaybackVideoFramePlan(20, 6, 12)

    expect(plan).toHaveLength(12)
    expect(plan[0]?.delayMs).toBe(1667)
    expect(plan.at(-1)?.timeSeconds).toBeCloseTo(19.95, 5)
  })

  it('falls back to a single frame when duration metadata is unavailable', () => {
    expect(resolveGroupPlaybackVideoFramePlan(Number.NaN)).toEqual([
      { delayMs: 1000, timeSeconds: 0 }
    ])
  })
})

describe('GroupPlaybackOverlay', () => {
  it('shows the video-style pause icon while playback is active', () => {
    render(
      React.createElement(
        ThemeProvider,
        { theme },
        React.createElement(GroupPlaybackOverlay, {
          item: createVideoItem(),
          bounds: {
            x: 10,
            y: 20,
            width: 320,
            height: 200
          },
          canvasBounds: {
            x: 0,
            y: 0,
            width: 640,
            height: 480
          },
          viewportSize: {
            width: 1200,
            height: 900
          },
          groupName: 'Demo Group',
          currentIndex: 0,
          totalCount: 1,
          paused: false,
          onPauseToggle: vi.fn(),
          onStop: vi.fn(),
          onVideoEnded: vi.fn()
        })
      )
    )

    expect(screen.getByRole('button', { name: '暂停播放' })).toBeInTheDocument()
    expect(screen.getByTestId('PauseCircleFilledIcon')).toBeInTheDocument()
  })

  it('preserves the current video time when resuming the same playback item', () => {
    const props = {
      bounds: {
        x: 10,
        y: 20,
        width: 320,
        height: 200
      },
      canvasBounds: {
        x: 0,
        y: 0,
        width: 640,
        height: 480
      },
      currentIndex: 0,
      groupName: 'Demo Group',
      item: createVideoItem(),
      onPauseToggle: vi.fn(),
      onStop: vi.fn(),
      onVideoEnded: vi.fn(),
      viewportSize: {
        width: 1200,
        height: 900
      },
      totalCount: 1
    }

    const { container, rerender } = render(
      React.createElement(
        ThemeProvider,
        { theme },
        React.createElement(GroupPlaybackOverlay, {
          ...props,
          paused: false
        })
      )
    )

    const video = container.querySelector('video') as HTMLVideoElement | null
    expect(video).not.toBeNull()
    Object.defineProperty(video!, 'currentTime', {
      configurable: true,
      writable: true,
      value: 0
    })
    video!.currentTime = 1.5

    rerender(
      React.createElement(
        ThemeProvider,
        { theme },
        React.createElement(GroupPlaybackOverlay, {
          ...props,
          paused: true
        })
      )
    )

    const pausedVideo = container.querySelector('video') as HTMLVideoElement | null
    expect(pausedVideo).not.toBeNull()
    pausedVideo!.currentTime = 1.5

    rerender(
      React.createElement(
        ThemeProvider,
        { theme },
        React.createElement(GroupPlaybackOverlay, {
          ...props,
          paused: false
        })
      )
    )

    const resumedVideo = container.querySelector('video') as HTMLVideoElement | null
    expect(resumedVideo?.currentTime).toBe(1.5)
  })

  it('routes model playback through the shared 3d stage', () => {
    const item = createModel3DItem()
    const sessionKey = 'canvas:thread:project-8:thread:agent-4'

    render(
      React.createElement(
        ThemeProvider,
        { theme },
        React.createElement(GroupPlaybackOverlay, {
          item,
          bounds: {
            x: 10,
            y: 20,
            width: 320,
            height: 200
          },
          canvasBounds: {
            x: 0,
            y: 0,
            width: 640,
            height: 480
          },
          viewportSize: {
            width: 1200,
            height: 900
          },
          sessionKey,
          groupName: 'Demo Group',
          currentIndex: 0,
          totalCount: 1,
          paused: false,
          onPauseToggle: vi.fn(),
          onStop: vi.fn(),
          onVideoEnded: vi.fn()
        })
      )
    )

    expect(screen.getByTestId('canvas-3d-stage')).toHaveTextContent('model-1')
    expect(latestCanvas3DStageProps?.sessionKey).toBe(sessionKey)
    expect(latestCanvas3DStageProps?.stagePos).toEqual({ x: 0, y: 0 })
    expect(latestCanvas3DStageProps?.stageScale).toBe(1)
    expect(latestCanvas3DStageProps?.stageSize).toEqual({
      width: 1104,
      height: 690
    })
    expect(latestCanvas3DStageProps?.items).toEqual([
      expect.objectContaining({
        id: item.id,
        x: 0,
        y: 0,
        width: 1104,
        height: 690,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      })
    ])
    expect(latestCanvas3DStageProps?.selectedIds).toEqual(new Set())
  })
})
