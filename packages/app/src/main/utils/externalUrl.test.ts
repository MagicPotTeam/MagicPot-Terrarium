import { describe, expect, it } from 'vitest'

import { isAllowedExternalUrl, normalizeAllowedExternalUrl } from './externalUrl'

describe('external URL validation', () => {
  it('allows http and https links', () => {
    expect(normalizeAllowedExternalUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(normalizeAllowedExternalUrl('http://example.com/')).toBe('http://example.com/')
  })

  it('blocks dangerous protocols before opening externally', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('file:///C:/secret.txt')).toBe(false)
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isAllowedExternalUrl('mailto:support@example.com')).toBe(false)
    expect(isAllowedExternalUrl('vscode://file/C:/secret.txt')).toBe(false)
  })
})
