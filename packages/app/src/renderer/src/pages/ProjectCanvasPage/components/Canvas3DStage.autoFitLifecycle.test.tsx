import React from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { AutoFitCamera } from './Canvas3DStage'

const fiberState = vi.hoisted(() => ({ current: {} as unknown }))
vi.mock('@react-three/fiber', () => ({
  Canvas: () => null,
  useFrame: vi.fn(),
  useThree: () => fiberState.current
}))

type ModelEvents = {
  'model-centered': { center: THREE.Vector3; radius: number; size: THREE.Vector3 }
}
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: { target: THREE.Vector3; update: ReturnType<typeof vi.fn> }
let nextFrameId: number
let pending: Map<number, FrameRequestCallback>

const centered = () => {
  ;(scene as unknown as THREE.EventDispatcher<ModelEvents>).dispatchEvent({
    type: 'model-centered',
    center: new THREE.Vector3(3, 4, 5),
    radius: 2,
    size: new THREE.Vector3(2, 3, 4)
  })
}

beforeEach(() => {
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera()
  controls = { target: new THREE.Vector3(), update: vi.fn() }
  fiberState.current = { scene, camera, controls, size: { width: 800, height: 600 } }
  nextFrameId = 1
  pending = new Map()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++
      pending.set(id, callback)
      return id
    })
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => pending.delete(id))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('3D viewer auto-fit camera lifecycle', () => {
  it('cancels the initial frame and every queued model event on unmount', () => {
    const view = render(<AutoFitCamera />)
    act(() => {
      centered()
      centered()
    })
    const queued = [...pending]
    expect(queued).toHaveLength(3)

    view.unmount()

    expect(pending.size).toBe(0)
    expect(vi.mocked(cancelAnimationFrame).mock.calls.map(([id]) => id)).toEqual(
      queued.map(([id]) => id)
    )
    act(() => {
      for (const [, callback] of queued) callback(16)
      centered()
    })
    expect(controls.update).not.toHaveBeenCalled()
    expect(camera.position.toArray()).toEqual([0, 0, 0])
    expect(requestAnimationFrame).toHaveBeenCalledTimes(3)
  })

  it('discards old callbacks when the viewport changes and keeps the new listener active', () => {
    const view = render(<AutoFitCamera />)
    act(centered)
    const oldFrames = [...pending.values()]
    fiberState.current = { scene, camera, controls, size: { width: 1200, height: 600 } }

    view.rerender(<AutoFitCamera />)

    expect(pending.size).toBe(1)
    act(() => {
      for (const callback of oldFrames) callback(16)
    })
    expect(controls.update).not.toHaveBeenCalled()
    act(centered)
    const currentFrames = [...pending.values()]
    act(() => {
      for (const callback of currentFrames) callback(32)
    })
    expect(controls.update).toHaveBeenCalledOnce()
    expect(controls.target.toArray()).toEqual([3, 4, 5])
    expect(camera.position.length()).toBeGreaterThan(0)
  })

  it('does not retain already-delivered frame handles for later cleanup', () => {
    const view = render(<AutoFitCamera />)
    const [initialId, initialCallback] = [...pending][0]
    pending.delete(initialId)
    act(() => initialCallback(16))
    act(centered)
    const [eventId, eventCallback] = [...pending][0]
    pending.delete(eventId)
    act(() => eventCallback(32))

    view.unmount()

    expect(controls.update).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()
  })
})
