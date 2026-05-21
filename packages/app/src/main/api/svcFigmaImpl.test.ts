import { describe, expect, it } from 'vitest'

import { normalizeFigmaFileKey } from './svcFigmaImpl'

describe('svcFigmaImpl', () => {
  it('extracts Figma file keys from figma.com URLs only', () => {
    expect(normalizeFigmaFileKey('www.figma.com/design/ABC123Demo/file-name?node-id=1-2')).toBe(
      'ABC123Demo'
    )
    expect(() =>
      normalizeFigmaFileKey('https://gateway.example/figma.com/design/ABC123Demo/file-name')
    ).toThrow('figma.com')
  })
})
