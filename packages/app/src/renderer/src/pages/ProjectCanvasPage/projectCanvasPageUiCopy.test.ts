import { describe, expect, it } from 'vitest'

import {
  getBackgroundColorLabel,
  getCanvasFilePreviewCopy,
  isChineseUiLanguage
} from './projectCanvasPageUiCopy'

describe('projectCanvasPageUiCopy', () => {
  it('detects Chinese UI languages', () => {
    expect(isChineseUiLanguage('zh-CN')).toBe(true)
    expect(isChineseUiLanguage('zh')).toBe(true)
    expect(isChineseUiLanguage('en-US')).toBe(false)
    expect(isChineseUiLanguage(undefined)).toBe(false)
  })

  it('returns Chinese file preview copy for Chinese UI', () => {
    const copy = getCanvasFilePreviewCopy('zh-CN')

    expect(copy.titleFallback).toBe('文件预览')
    expect(copy.editPlaceholder).toBe('在这里编辑文件内容')
    expect(copy.embeddedImagesLabel(2)).toBe('内嵌图片（2）')
    expect(copy.closeButton).toBe('关闭')
    expect(copy.saveButton).toBe('保存')
  })

  it('keeps English file preview copy for English UI', () => {
    const copy = getCanvasFilePreviewCopy('en-US')

    expect(copy.titleFallback).toBe('File Preview')
    expect(copy.editPlaceholder).toBe('Edit file content here')
    expect(copy.embeddedImagesLabel(2)).toBe('Embedded Images (2)')
    expect(copy.closeButton).toBe('Close')
    expect(copy.saveButton).toBe('Save')
  })

  it('localizes background color labels only for Chinese UI', () => {
    expect(getBackgroundColorLabel('Default Dark', 'zh-CN')).toBe('默认深色')
    expect(getBackgroundColorLabel('Transparent', 'zh-CN')).toBe('透明')
    expect(getBackgroundColorLabel('Default Dark', 'en-US')).toBe('Default Dark')
  })
})
