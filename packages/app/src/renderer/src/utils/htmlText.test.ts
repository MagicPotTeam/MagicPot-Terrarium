import { describe, expect, it } from 'vitest'

import { stripHtmlToText } from './htmlText'

describe('htmlText', () => {
  it('extracts readable text from html and removes script/style content', () => {
    expect(
      stripHtmlToText(
        '<style>.hidden{display:none}</style><p>Hello&nbsp;<strong>world</strong></p><script>alert(1)</script >'
      )
    ).toBe('Hello world')
  })
})
