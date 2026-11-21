import { describe, expect, it } from 'vitest'
import { isThreadImageReviewPrompt } from './threadImageReviewIntent'

describe('isThreadImageReviewPrompt', () => {
  it.each([
    'Inspect the last image',
    'Can you review the latest generated picture for visual issues?',
    "What's wrong with the previous image?",
    '分析上一张图片中的问题',
    '请检查刚才生成的图像有什么问题吗？'
  ])('recognizes an explicit image-review prompt: %s', (text) => {
    expect(isThreadImageReviewPrompt(text, { previousAssistantImage: false })).toBe(true)
  })

  it.each([
    'Can you spot the problem?',
    'What is wrong with this picture?',
    '这张图有什么问题？',
    '你能自己找出问题吗'
  ])(
    'only recognizes a contextual screenshot follow-up with an immediately preceding assistant image: %s',
    (text) => {
      expect(isThreadImageReviewPrompt(text, { previousAssistantImage: true })).toBe(true)
      expect(isThreadImageReviewPrompt(text, { previousAssistantImage: false })).toBe(false)
    }
  )

  it.each([
    'Edit the last image',
    '你能自己找出问题并重画吗？',
    'Make the latest image brighter',
    'Generate a new picture based on the previous image',
    'Read the image.png file',
    'Review the source code for image handling',
    'I think the last image needs review',
    'Quoted request: "inspect the last image"',
    'https://example.invalid/review-the-last-image',
    'Can you spot the problem in this screenshot? Also change the title',
    'The file is named "previous image.png"'
  ])(
    'does not route edits, code/files, links or embedded/older-turn mentions to image review: %s',
    (text) => {
      expect(isThreadImageReviewPrompt(text, { previousAssistantImage: true })).toBe(false)
    }
  )

  it.each(['', 'Inspect the last image\nand explain', 'x'.repeat(241)])(
    'rejects empty, multiline or oversized prompts',
    (text) => {
      expect(isThreadImageReviewPrompt(text, { previousAssistantImage: true })).toBe(false)
    }
  )
})
