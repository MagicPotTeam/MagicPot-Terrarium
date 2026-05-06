import { describe, expect, it } from 'vitest'

import { normalizeRendererPublicBaseUrl, resolveRendererPublicAssetUrl } from './compressionLoaders'

describe('compressionLoaders', () => {
  it('normalizes renderer public base urls for stable asset resolution', () => {
    expect(normalizeRendererPublicBaseUrl('/')).toBe('/')
    expect(normalizeRendererPublicBaseUrl('./')).toBe('./')
    expect(normalizeRendererPublicBaseUrl('./renderer')).toBe('./renderer/')
  })

  it('resolves renderer public asset urls in dev-style locations', () => {
    expect(
      resolveRendererPublicAssetUrl('three/draco/gltf/', '/', 'http://localhost:5173/index.html')
    ).toBe('http://localhost:5173/three/draco/gltf/')
  })

  it('resolves renderer public asset urls in packaged file locations', () => {
    expect(
      resolveRendererPublicAssetUrl(
        'three/basis/',
        './',
        'file:///C:/MagicPot/out/renderer/index.html'
      )
    ).toBe('file:///C:/MagicPot/out/renderer/three/basis/')
  })
})
