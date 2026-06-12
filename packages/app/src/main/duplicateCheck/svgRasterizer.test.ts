import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  browserWindowCtorMock,
  loadURLMock,
  executeJavaScriptMock,
  destroyMock,
  isDestroyedMock
} = vi.hoisted(() => {
  const loadURLMock = vi.fn(() => Promise.resolve())
  const executeJavaScriptMock = vi.fn<(script: string, userGesture?: boolean) => Promise<unknown>>(
    () => Promise.resolve()
  )
  const destroyMock = vi.fn()
  const isDestroyedMock = vi.fn(() => false)

  return {
    appMock: {
      whenReady: vi.fn(() => Promise.resolve())
    },
    browserWindowCtorMock: vi.fn(function MockBrowserWindow() {
      return {
        loadURL: loadURLMock,
        destroy: destroyMock,
        isDestroyed: isDestroyedMock,
        webContents: {
          executeJavaScript: executeJavaScriptMock
        }
      }
    }),
    loadURLMock,
    executeJavaScriptMock,
    destroyMock,
    isDestroyedMock
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowCtorMock
}))

import {
  assertSelfContainedSvg,
  looksLikeSvgBuffer,
  rasterizeSvgToPngBuffer,
  resolveSvgRasterSize
} from './svgRasterizer'

describe('svgRasterizer', () => {
  beforeEach(() => {
    appMock.whenReady.mockClear()
    browserWindowCtorMock.mockClear()
    loadURLMock.mockClear()
    executeJavaScriptMock.mockClear()
    destroyMock.mockClear()
    isDestroyedMock.mockClear()
    isDestroyedMock.mockReturnValue(false)
  })

  it('derives raster size from the svg viewBox when width and height are omitted', () => {
    expect(resolveSvgRasterSize('<svg viewBox="0 0 512 256"></svg>')).toEqual({
      width: 512,
      height: 256
    })
  })

  it('rejects svg files that reference external resources', () => {
    expect(() =>
      assertSelfContainedSvg('<svg><image href="https://example.com/test.png" /></svg>')
    ).toThrow('SVG external references are unsupported')
  })

  it('allows internal svg references and data urls', () => {
    expect(() =>
      assertSelfContainedSvg(
        '<svg><defs><linearGradient id="g" /></defs><rect fill="url(#g)" /><image href="data:image/png;base64,AAAA" /></svg>'
      )
    ).not.toThrow()
  })

  it('detects svg payloads by content sniffing', () => {
    expect(
      looksLikeSvgBuffer(Buffer.from('\ufeff<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>'))
    ).toBe(true)
    expect(looksLikeSvgBuffer(Buffer.from('not-an-svg'))).toBe(false)
  })

  it('rasterizes svg content through a hidden browser window', async () => {
    executeJavaScriptMock.mockResolvedValue({
      pngDataUrl: `data:image/png;base64,${Buffer.from('png-data').toString('base64')}`,
      width: 320,
      height: 200
    })

    const result = await rasterizeSvgToPngBuffer(
      Buffer.from('<svg width="320" height="200"></svg>', 'utf8')
    )

    expect(appMock.whenReady).toHaveBeenCalledTimes(1)
    expect(browserWindowCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false,
        width: 320,
        height: 200
      })
    )
    expect(loadURLMock).toHaveBeenCalledTimes(1)
    expect(executeJavaScriptMock).toHaveBeenCalledTimes(1)
    expect(result.width).toBe(320)
    expect(result.height).toBe(200)
    expect(result.pngBuffer.equals(Buffer.from('png-data'))).toBe(true)
    expect(destroyMock).toHaveBeenCalledTimes(1)
  })
})
