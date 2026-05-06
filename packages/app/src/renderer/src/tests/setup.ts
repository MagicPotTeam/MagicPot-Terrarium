import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockCanvasContext2D = {
  fillStyle: '#000000',
  strokeStyle: '#000000',
  font: '12px sans-serif',
  globalAlpha: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  lineWidth: 1,
  textAlign: 'start',
  textBaseline: 'alphabetic',
  save: () => undefined,
  restore: () => undefined,
  resetTransform: () => undefined,
  transform: () => undefined,
  setTransform: () => undefined,
  translate: () => undefined,
  rotate: () => undefined,
  scale: () => undefined,
  beginPath: () => undefined,
  closePath: () => undefined,
  moveTo: () => undefined,
  lineTo: () => undefined,
  rect: () => undefined,
  clip: () => undefined,
  arc: () => undefined,
  arcTo: () => undefined,
  bezierCurveTo: () => undefined,
  quadraticCurveTo: () => undefined,
  ellipse: () => undefined,
  stroke: () => undefined,
  fill: () => undefined,
  clearRect: () => undefined,
  fillRect: () => undefined,
  strokeRect: () => undefined,
  drawImage: () => undefined,
  fillText: () => undefined,
  getImageData: (x = 0, y = 0, width = 1, height = 1) => ({
    data: new Uint8ClampedArray(Math.max(1, width * height * 4)),
    width,
    height
  }),
  putImageData: () => undefined,
  measureText: (text: string) => ({ width: Math.max(1, text.length) * 8 })
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  writable: true,
  value: () => mockCanvasContext2D
})

Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
  configurable: true,
  writable: true,
  value: () => 'data:image/png;base64,mock-canvas'
})

Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
  configurable: true,
  writable: true,
  value: (callback: BlobCallback, type?: string) => {
    const blob = new Blob(['mock-canvas'], { type: type || 'image/png' })
    callback(blob)
  }
})

// runs a clean after each test case (e.g. clearing jsdom)
afterEach(() => {
  cleanup()
})
