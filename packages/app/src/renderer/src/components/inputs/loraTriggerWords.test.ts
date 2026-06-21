import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendPromptTriggerWords,
  LORA_TRIGGER_WORDS_STORAGE_KEY,
  normalizeTriggerWords,
  readLoraTriggerWordsMap,
  resolveLoraTriggerWordsWithCache,
  updateLoraTriggerWordsMap,
  weightTriggerWordsForPrompt,
  writeLoraTriggerWordsMap
} from './loraTriggerWords'

describe('loraTriggerWords', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('normalizes multiline trigger words into comma-separated tags', () => {
    expect(normalizeTriggerWords('  hero pose  \n cinematic light\n\n')).toBe(
      'hero pose, cinematic light'
    )
  })

  it('persists trigger words by LoRA name', () => {
    const next = updateLoraTriggerWordsMap({}, ' style.safetensors ', ' style tag\nbest quality ')

    writeLoraTriggerWordsMap(next)

    expect(readLoraTriggerWordsMap()).toEqual({
      'style.safetensors': 'style tag, best quality'
    })
  })

  it('drops empty trigger word entries', () => {
    localStorage.setItem(
      LORA_TRIGGER_WORDS_STORAGE_KEY,
      JSON.stringify({ 'style.safetensors': 'old tag' })
    )

    const next = updateLoraTriggerWordsMap(readLoraTriggerWordsMap(), 'style.safetensors', '  ')

    expect(next).toEqual({})
  })

  it('uses cached trigger words before reading model metadata', async () => {
    writeLoraTriggerWordsMap({ 'style.safetensors': 'cached style\nbest quality' })
    const readMetadataTriggerWords = vi.fn(async () => 'metadata style')

    await expect(
      resolveLoraTriggerWordsWithCache({
        loraName: 'style.safetensors',
        readMetadataTriggerWords
      })
    ).resolves.toEqual({
      triggerWords: 'cached style, best quality',
      triggerWordsByLoraName: {
        'style.safetensors': 'cached style, best quality'
      }
    })
    expect(readMetadataTriggerWords).not.toHaveBeenCalled()
  })

  it('stores metadata trigger words for later selections', async () => {
    const readMetadataTriggerWords = vi.fn(async () => 'metadata style\nhero pose')

    await expect(
      resolveLoraTriggerWordsWithCache({
        loraName: 'style.safetensors',
        readMetadataTriggerWords
      })
    ).resolves.toEqual({
      triggerWords: 'metadata style, hero pose',
      triggerWordsByLoraName: {
        'style.safetensors': 'metadata style, hero pose'
      }
    })
    expect(readLoraTriggerWordsMap()).toEqual({
      'style.safetensors': 'metadata style, hero pose'
    })
  })

  it('prepends trigger tags before regular prompt tags', () => {
    expect(appendPromptTriggerWords('masterpiece, style tag', 'style tag, hero pose')).toBe(
      'style tag, hero pose, masterpiece'
    )
    expect(appendPromptTriggerWords('', 'style tag, hero pose')).toBe('style tag, hero pose')
  })

  it('keeps existing trigger weights when moving trigger tags to the front', () => {
    expect(
      appendPromptTriggerWords(
        'masterpiece, (style tag:1.25), cinematic light, hero pose',
        'style tag, hero pose'
      )
    ).toBe('(style tag:1.25), hero pose, masterpiece, cinematic light')
    expect(appendPromptTriggerWords('masterpiece, [style tag]', 'style tag')).toBe(
      '[style tag], masterpiece'
    )
  })

  it('uses weighted trigger words from the explicit append action when prompt has duplicates', () => {
    expect(appendPromptTriggerWords('masterpiece, style tag', '(style tag:1.2)')).toBe(
      '(style tag:1.2), masterpiece'
    )
    expect(appendPromptTriggerWords('masterpiece, (style tag:0.8)', '(style tag:1.2)')).toBe(
      '(style tag:1.2), masterpiece'
    )
  })

  it('weights trigger words using LoRA model strength for prompt insertion', () => {
    expect(weightTriggerWordsForPrompt('style tag\nhero pose', 0.8)).toBe(
      '(style tag:0.8), (hero pose:0.8)'
    )
    expect(weightTriggerWordsForPrompt('(style tag:1.2), hero pose', 1.05)).toBe(
      '(style tag:1.05), (hero pose:1.05)'
    )
  })
})
