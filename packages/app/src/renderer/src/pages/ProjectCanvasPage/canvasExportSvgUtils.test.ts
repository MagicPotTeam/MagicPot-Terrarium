import { describe, expect, it } from 'vitest'
import { buildRasterBackedSvgMarkup } from './canvasExportSvgUtils'

describe('buildRasterBackedSvgMarkup', () => {
  it('includes svg metadata and image content', () => {
    const markup = buildRasterBackedSvgMarkup({
      width: 320,
      height: 180,
      imageHref: 'data:image/png;base64,abc123',
      backgroundColor: '#ffffff'
    })

    expect(markup).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(markup).toContain('width="320"')
    expect(markup).toContain('height="180"')
    expect(markup).toContain('viewBox="0 0 320 180"')
    expect(markup).toContain('fill="#ffffff"')
    expect(markup).toContain('href="data:image/png;base64,abc123"')
  })

  it('escapes xml-sensitive attributes', () => {
    const markup = buildRasterBackedSvgMarkup({
      width: 100,
      height: 50,
      imageHref: 'data:image/svg+xml;utf8,<svg viewBox="0 0 1 1"></svg>'
    })

    expect(markup).toContain(
      'href="data:image/svg+xml;utf8,&lt;svg viewBox=&quot;0 0 1 1&quot;&gt;&lt;/svg&gt;"'
    )
    expect(markup).not.toContain('<rect x="0" y="0"')
  })
})
