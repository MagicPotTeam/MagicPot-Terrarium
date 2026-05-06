import { describe, expect, it } from 'vitest'
import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import {
  inspectSkillAttachmentSupport,
  resolveSkillAttachmentSupport
} from './chatSkillAttachmentSupport'

const imageAttachment: ChatAttachment = {
  type: 'image',
  url: 'file:///C:/magicpot/hero.png',
  fileName: 'hero.png',
  mimeType: 'image/png'
}

const documentAttachment: ChatAttachment = {
  type: 'file',
  url: 'file:///C:/magicpot/brief.pdf',
  fileName: 'brief.pdf',
  mimeType: 'application/pdf'
}

describe('chatSkillAttachmentSupport', () => {
  it('treats vision models as image-capable only', () => {
    expect(
      resolveSkillAttachmentSupport({
        model_use: 'vision',
        is_vision_model: true
      })
    ).toEqual({
      supportsImages: true,
      supportsDocuments: false
    })
  })

  it('treats ocr models as image and document capable', () => {
    expect(
      resolveSkillAttachmentSupport({
        model_use: 'ocr',
        is_ocr_model: true
      })
    ).toEqual({
      supportsImages: true,
      supportsDocuments: true
    })
  })

  it('reports both image and document inputs as unsupported for text-only models', () => {
    expect(
      inspectSkillAttachmentSupport([imageAttachment, documentAttachment], {
        model_use: 'chat'
      })
    ).toEqual({
      hasImages: true,
      hasDocuments: true,
      supportsImages: false,
      supportsDocuments: false,
      unsupportedImages: true,
      unsupportedDocuments: true
    })
  })

  it('reports only document input as unsupported for image-only models', () => {
    expect(
      inspectSkillAttachmentSupport([imageAttachment, documentAttachment], {
        model_use: 'vision',
        is_vision_model: true
      })
    ).toEqual({
      hasImages: true,
      hasDocuments: true,
      supportsImages: true,
      supportsDocuments: false,
      unsupportedImages: false,
      unsupportedDocuments: true
    })
  })
})
