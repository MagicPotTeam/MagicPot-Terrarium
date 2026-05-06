import { describe, expect, it } from 'vitest'
import {
  getUnsupportedQuickAppDropMessage,
  isQuickAppBundleFile,
  isQuickAppImportImageFile
} from './qAppDropValidation'

describe('qAppDropValidation', () => {
  it('accepts workflow images and qapp bundles', () => {
    expect(
      isQuickAppImportImageFile(new File(['img'], 'workflow.png', { type: 'image/png' }))
    ).toBe(true)
    expect(
      isQuickAppBundleFile(new File(['{}'], 'demo.mpqapp', { type: 'application/json' }))
    ).toBe(true)
    expect(
      getUnsupportedQuickAppDropMessage([
        new File(['img'], 'workflow.png', { type: 'image/png' }),
        new File(['{}'], 'demo.mpqapp', { type: 'application/json' })
      ])
    ).toBeNull()
  })

  it('rejects unsupported office and text files with a clear message', () => {
    const message = getUnsupportedQuickAppDropMessage([
      new File(['doc'], 'brief.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }),
      new File(['deck'], 'slides.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      }),
      new File(['notes'], 'readme.md', { type: 'text/markdown' })
    ])

    expect(message).toContain('.mpqapp')
    expect(message).toContain('.docx')
    expect(message).toContain('.pptx')
    expect(message).toContain('.md')
  })

  it('flags mixed drops when any unsupported file is present', () => {
    const message = getUnsupportedQuickAppDropMessage([
      new File(['img'], 'workflow.png', { type: 'image/png' }),
      new File(['vector'], 'diagram.svg', { type: 'image/svg+xml' })
    ])

    expect(message).toContain('.svg')
  })

  it('guides external video drops back to internal result cards', () => {
    const message = getUnsupportedQuickAppDropMessage([
      new File(['video'], 'preview.mp4', { type: 'video/mp4' })
    ])

    expect(message).toContain('结果卡')
    expect(message).toContain('.mpqapp')
  })
})
