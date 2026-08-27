import { describe, expect, it } from 'vitest'

import { isTrustedRendererNavigation } from './rendererNavigation'

describe('renderer navigation policy', () => {
  it('allows navigation within the trusted renderer origin', () => {
    expect(
      isTrustedRendererNavigation('http://localhost:5173/settings', 'http://localhost:5173/')
    ).toBe(true)
  })

  it('blocks navigation to another origin or protocol', () => {
    const trustedUrl = 'http://localhost:5173/'

    expect(isTrustedRendererNavigation('https://example.com/', trustedUrl)).toBe(false)
    expect(isTrustedRendererNavigation('javascript:alert(1)', trustedUrl)).toBe(false)
    expect(isTrustedRendererNavigation('file:///C:/secret.html', trustedUrl)).toBe(false)
  })

  it('requires the same local file when the renderer is packaged', () => {
    const trustedUrl = 'file:///C:/app/resources/renderer/index.html'

    expect(isTrustedRendererNavigation(trustedUrl, trustedUrl)).toBe(true)
    expect(
      isTrustedRendererNavigation('file:///C:/app/resources/renderer/other.html', trustedUrl)
    ).toBe(false)
  })
})
