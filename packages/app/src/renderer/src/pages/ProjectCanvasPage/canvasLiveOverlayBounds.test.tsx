import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CANVAS_LIVE_VISUAL_BOUNDS_CHANGE_EVENT,
  useLiveSelectionOverlayGroups
} from './canvasLiveOverlayBounds'
import type { CanvasImageItem } from './types'

function createImageItem(id: string): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `${id}.png`,
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

describe('useLiveSelectionOverlayGroups', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('recomputes group bounds during live drag previews', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(16)
        return 1
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const canvasContainer = document.createElement('div')
    const overlayElement = document.createElement('div')
    overlayElement.setAttribute('data-canvas-item-id', 'image-1')
    canvasContainer.appendChild(overlayElement)
    document.body.appendChild(canvasContainer)

    let overlayRect = {
      left: 10,
      top: 20,
      width: 100,
      height: 80,
      right: 110,
      bottom: 100
    }

    Object.defineProperty(canvasContainer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600
      })
    })
    Object.defineProperty(overlayElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => overlayRect
    })

    const item = createImageItem('image-1')
    const selectionOverlayGroups = [
      {
        id: 'group-1',
        name: 'Group 1',
        itemIds: [item.id],
        validItems: [item],
        validCount: 1,
        totalCount: 1,
        createdAt: '2026-04-22T00:00:00.000Z',
        bounds: {
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height
        },
        selectedMemberIds: [item.id]
      }
    ]

    const { result } = renderHook(() =>
      useLiveSelectionOverlayGroups({
        canvasContainerRef: { current: canvasContainer },
        selectionOverlayGroups,
        stagePos: { x: 0, y: 0 },
        stageRef: { current: null },
        stageScale: 1
      })
    )

    expect(result.current[0].bounds).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 80
    })

    act(() => {
      overlayRect = {
        left: 180,
        top: 140,
        width: 100,
        height: 80,
        right: 280,
        bottom: 220
      }
      window.dispatchEvent(
        new CustomEvent(CANVAS_LIVE_VISUAL_BOUNDS_CHANGE_EVENT, {
          detail: { itemIds: [item.id] }
        })
      )
    })

    expect(result.current[0].bounds).toEqual({
      x: 180,
      y: 140,
      width: 100,
      height: 80
    })
  })

  it('reuses overlay lookup and element rect measurements while resolving group bounds', () => {
    const canvasContainer = document.createElement('div')
    const firstOverlayElement = document.createElement('div')
    firstOverlayElement.setAttribute('data-canvas-item-id', 'image-1')
    firstOverlayElement.setAttribute('data-canvas-overlay', 'image-interaction')
    const secondOverlayElement = document.createElement('div')
    secondOverlayElement.setAttribute('data-canvas-item-id', 'image-2')
    secondOverlayElement.setAttribute('data-canvas-overlay', 'image-interaction')
    canvasContainer.append(firstOverlayElement, secondOverlayElement)
    document.body.appendChild(canvasContainer)

    Object.defineProperty(canvasContainer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600
      })
    })
    const firstRect = vi.fn(() => ({
      left: 10,
      top: 20,
      width: 100,
      height: 80,
      right: 110,
      bottom: 100
    }))
    const secondRect = vi.fn(() => ({
      left: 110,
      top: 120,
      width: 100,
      height: 80,
      right: 210,
      bottom: 200
    }))
    Object.defineProperty(firstOverlayElement, 'getBoundingClientRect', {
      configurable: true,
      value: firstRect
    })
    Object.defineProperty(secondOverlayElement, 'getBoundingClientRect', {
      configurable: true,
      value: secondRect
    })
    const querySelectorAll = vi.spyOn(canvasContainer, 'querySelectorAll')

    const firstItem = createImageItem('image-1')
    const secondItem = createImageItem('image-2')
    const { result } = renderHook(() =>
      useLiveSelectionOverlayGroups({
        canvasContainerRef: { current: canvasContainer },
        selectionOverlayGroups: [
          {
            id: 'group-1',
            name: 'Group 1',
            itemIds: [firstItem.id, secondItem.id, firstItem.id],
            validItems: [firstItem, secondItem, firstItem],
            validCount: 3,
            totalCount: 3,
            createdAt: '2026-04-22T00:00:00.000Z',
            bounds: {
              x: firstItem.x,
              y: firstItem.y,
              width: firstItem.width,
              height: firstItem.height
            },
            selectedMemberIds: [firstItem.id, secondItem.id]
          }
        ],
        stagePos: { x: 0, y: 0 },
        stageRef: { current: null },
        stageScale: 1
      })
    )

    expect(result.current[0].bounds).toEqual({
      x: 10,
      y: 20,
      width: 200,
      height: 180
    })
    expect(firstRect).toHaveBeenCalledTimes(1)
    expect(secondRect).toHaveBeenCalledTimes(1)
    expect(
      querySelectorAll.mock.calls.filter(
        ([selector]) => selector === '[data-canvas-overlay="image-interaction"]'
      )
    ).toHaveLength(1)
  })

  it('prefers the matching image interaction overlay when duplicate item ids exist in the container', () => {
    const canvasContainer = document.createElement('div')
    const staleElement = document.createElement('div')
    staleElement.setAttribute('data-canvas-item-id', 'image-1')
    const imageOverlayElement = document.createElement('div')
    imageOverlayElement.setAttribute('data-canvas-item-id', 'image-1')
    imageOverlayElement.setAttribute('data-canvas-overlay', 'image-interaction')
    canvasContainer.appendChild(staleElement)
    canvasContainer.appendChild(imageOverlayElement)
    document.body.appendChild(canvasContainer)

    Object.defineProperty(canvasContainer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600
      })
    })
    Object.defineProperty(staleElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 12,
        top: 18,
        width: 24,
        height: 24,
        right: 36,
        bottom: 42
      })
    })
    Object.defineProperty(imageOverlayElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 220,
        top: 180,
        width: 160,
        height: 120,
        right: 380,
        bottom: 300
      })
    })

    const item = createImageItem('image-1')
    const { result } = renderHook(() =>
      useLiveSelectionOverlayGroups({
        canvasContainerRef: { current: canvasContainer },
        selectionOverlayGroups: [
          {
            id: 'group-1',
            name: 'Group 1',
            itemIds: [item.id],
            validItems: [item],
            validCount: 1,
            totalCount: 1,
            createdAt: '2026-04-22T00:00:00.000Z',
            bounds: {
              x: item.x,
              y: item.y,
              width: item.width,
              height: item.height
            },
            selectedMemberIds: [item.id]
          }
        ],
        stagePos: { x: 0, y: 0 },
        stageRef: { current: null },
        stageScale: 1
      })
    )

    expect(result.current[0].bounds).toEqual({
      x: 220,
      y: 180,
      width: 160,
      height: 120
    })
  })
})
