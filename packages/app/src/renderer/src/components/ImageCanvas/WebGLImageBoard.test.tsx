import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockPoint = {
  x: number
  y: number
  set: (x: number, y?: number) => void
}

type MockTexture = {
  image: HTMLImageElement
}

type MockListener = (...args: unknown[]) => void

type MockSprite = {
  texture: MockTexture
  position: MockPoint
  scale: MockPoint
  width: number
  height: number
  label: string
  eventMode: string
  cursor: string
  parent: MockContainer | null
  destroyed: boolean
  listeners: Map<string, MockListener[]>
  removeAllListeners: (event: string) => void
  on: (event: string, handler: MockListener) => void
  removeFromParent: () => void
  destroy: () => void
}

type MockContainer = {
  children: MockSprite[]
  position: MockPoint
  scale: MockPoint
  sortableChildren: boolean
  addChild: (child: MockSprite) => void
}

let initCalls = 0
let destroyCalls = 0
let createdSprites: MockSprite[] = []

function createPoint(initialX = 0, initialY = 0): MockPoint {
  return {
    x: initialX,
    y: initialY,
    set(x: number, y = x) {
      this.x = x
      this.y = y
    }
  }
}

function installPixiMock() {
  vi.doMock('pixi.js', () => {
    class Texture {
      constructor(public image: HTMLImageElement) {}

      static from(image: HTMLImageElement) {
        return new Texture(image)
      }
    }

    class SpriteImpl implements MockSprite {
      position = createPoint()
      scale = createPoint(1, 1)
      width = 0
      height = 0
      label = ''
      eventMode = 'none'
      cursor = 'default'
      parent: MockContainer | null = null
      destroyed = false
      listeners = new Map<string, MockListener[]>()

      constructor(public texture: MockTexture) {
        createdSprites.push(this)
      }

      removeAllListeners(event: string) {
        this.listeners.delete(event)
      }

      on(event: string, handler: MockListener) {
        const handlers = this.listeners.get(event) ?? []
        handlers.push(handler)
        this.listeners.set(event, handlers)
      }

      removeFromParent() {
        if (!this.parent) return
        this.parent.children = this.parent.children.filter((child) => child !== this)
        this.parent = null
      }

      destroy() {
        this.destroyed = true
      }

      static from(image: HTMLImageElement) {
        return new SpriteImpl(Texture.from(image))
      }
    }

    class ContainerImpl implements MockContainer {
      children: MockSprite[] = []
      position = createPoint()
      scale = createPoint(1, 1)
      sortableChildren = false

      addChild(child: MockSprite) {
        this.children.push(child)
        child.parent = this
      }
    }

    class Application {
      stage = new ContainerImpl()
      canvas = document.createElement('canvas')
      render = vi.fn()

      async init() {
        initCalls += 1
      }

      destroy() {
        destroyCalls += 1
      }
    }

    return {
      Application,
      Container: ContainerImpl,
      Sprite: SpriteImpl,
      Texture
    }
  })
}

function createImage(width: number, height: number) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: width })
  Object.defineProperty(image, 'naturalHeight', { value: height })
  return image
}

describe('WebGLImageBoard', () => {
  beforeEach(() => {
    vi.resetModules()
    initCalls = 0
    destroyCalls = 0
    createdSprites = []
    installPixiMock()

    class MockResizeObserver {
      observe() {
        return undefined
      }

      disconnect() {
        return undefined
      }
    }

    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  it('fits oversized images inside the visible board area', async () => {
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 600,
        right: 800,
        toJSON: () => ({})
      } as DOMRect)

    try {
      const { default: WebGLImageBoard } = await import('./WebGLImageBoard')
      const image = createImage(2500, 2500)

      render(
        <div style={{ width: 800, height: 600 }}>
          <WebGLImageBoard image={image} />
        </div>
      )

      await waitFor(
        () => {
          expect(createdSprites).toHaveLength(1)
        },
        { timeout: 15000 }
      )

      const world = createdSprites[0].parent
      expect(world).not.toBeNull()
      expect(world?.scale.x).toBeCloseTo(0.2208, 4)
      expect(world?.scale.y).toBeCloseTo(0.2208, 4)
      expect(world?.position.x).toBeCloseTo(124, 2)
      expect(world?.position.y).toBeCloseTo(24, 2)
    } finally {
      getBoundingClientRectSpy.mockRestore()
    }
  }, 15000)

  it('initializes Pixi once and incrementally syncs sprite state across rerenders', async () => {
    const { default: WebGLImageBoard } = await import('./WebGLImageBoard')
    const baseItem = {
      id: 'item-1',
      image: createImage(120, 60),
      x: 10,
      y: 20,
      width: 120,
      height: 60
    }

    const { rerender, unmount } = render(
      <div style={{ width: 800, height: 600 }}>
        <WebGLImageBoard items={[baseItem]} allowItemDrag={false} />
      </div>
    )

    await waitFor(
      () => {
        expect(initCalls).toBe(1)
        expect(createdSprites).toHaveLength(1)
      },
      { timeout: 15000 }
    )

    const sprite = createdSprites[0]
    expect(sprite.position.x).toBe(10)
    expect(sprite.position.y).toBe(20)
    expect(sprite.width).toBe(120)
    expect(sprite.height).toBe(60)
    expect(sprite.eventMode).toBe('none')

    rerender(
      <div style={{ width: 800, height: 600 }}>
        <WebGLImageBoard
          items={[
            {
              ...baseItem,
              x: 42,
              y: 84
            }
          ]}
          allowItemDrag
        />
      </div>
    )

    await waitFor(
      () => {
        expect(initCalls).toBe(1)
        expect(createdSprites).toHaveLength(1)
        expect(sprite.position.x).toBe(42)
        expect(sprite.position.y).toBe(84)
        expect(sprite.eventMode).toBe('static')
        expect(sprite.cursor).toBe('move')
      },
      { timeout: 15000 }
    )

    rerender(
      <div style={{ width: 800, height: 600 }}>
        <WebGLImageBoard items={[]} allowItemDrag />
      </div>
    )

    await waitFor(
      () => {
        expect(sprite.destroyed).toBe(true)
      },
      { timeout: 15000 }
    )

    unmount()

    expect(destroyCalls).toBe(1)
  }, 15000)
})
