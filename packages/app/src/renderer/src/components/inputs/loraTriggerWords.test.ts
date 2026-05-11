import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendPromptTriggerWords,
  LORA_TRIGGER_WORDS_STORAGE_KEY,
  normalizeTriggerWords,
  readLoraTriggerWordsMap,
  updateLoraTriggerWordsMap,
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

  it('appends only missing trigger tags to prompts', () => {
    expect(appendPromptTriggerWords('masterpiece, style tag', 'style tag, hero pose')).toBe(
      'masterpiece, style tag, hero pose'
    )
    expect(appendPromptTriggerWords('', 'style tag, hero pose')).toBe('style tag, hero pose')
  })
})
