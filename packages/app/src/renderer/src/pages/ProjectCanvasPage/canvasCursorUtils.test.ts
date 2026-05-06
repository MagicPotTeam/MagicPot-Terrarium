import { describe, expect, it } from 'vitest'
import { getCanvasCursorStyle, shouldForceCanvasCrosshair } from './canvasCursorUtils'

describe('canvasCursorUtils', () => {
  it('keeps shape-creation tools on a crosshair cursor', () => {
    expect(getCanvasCursorStyle('annotate', false)).toBe('crosshair')
    expect(getCanvasCursorStyle('export-select', false)).toBe('crosshair')
    expect(getCanvasCursorStyle('crop-select', false)).toBe('crosshair')
    expect(getCanvasCursorStyle('extract-select', false)).toBe('crosshair')
  })

  it('uses grab states for the hand tool', () => {
    expect(getCanvasCursorStyle('hand', false)).toBe('grab')
    expect(getCanvasCursorStyle('hand', true)).toBe('grabbing')
  })

  it('only forces the canvas-wide crosshair while creating non-text shapes', () => {
    expect(shouldForceCanvasCrosshair('annotate', 'rect')).toBe(true)
    expect(shouldForceCanvasCrosshair('annotate', 'text-anno')).toBe(false)
    expect(shouldForceCanvasCrosshair('crop-select', 'text-anno')).toBe(true)
    expect(shouldForceCanvasCrosshair('extract-select', 'text-anno')).toBe(true)
  })
})
