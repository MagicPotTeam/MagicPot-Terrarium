import { describe, expect, it } from 'vitest'
import { getCanvasProjectName, isCanvasSceneFile } from './canvasProjectDropUtils'

describe('CanvasProjectDropBridge helpers', () => {
  it('uses the .mpcanvas filename without its extension as the project name', () => {
    expect(getCanvasProjectName('角色设计.mpcanvas')).toBe('角色设计')
    expect(getCanvasProjectName('Scene.MPCANVAS')).toBe('Scene')
  })

  it('only accepts mpcanvas files', () => {
    expect(isCanvasSceneFile(new File(['{}'], 'scene.mpcanvas'))).toBe(true)
    expect(isCanvasSceneFile(new File(['{}'], 'scene.png'))).toBe(false)
  })
})
