import { describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import {
  normalizeReasoningPreferenceMap,
  readStoredImageGenerationOptions,
  readStoredReasoningEffortMap,
  resolveImageGenerationOptionsForAttachments,
  resolveReferenceImageGenerationSizeFromAttachments
} from './chatPreferences'

const createStorage = (values: Record<string, string | null>): Pick<Storage, 'getItem'> => ({
  getItem: (key: string) => values[key] ?? null
})

const imageAttachment = (sourceWidth?: number, sourceHeight?: number): ChatAttachment => ({
  type: 'image',
  url: 'file:///reference.png',
  sourceWidth,
  sourceHeight
})

describe('chatPreferences', () => {
  it('normalizes reasoning preferences and ignores blank profile keys', () => {
    expect(
      normalizeReasoningPreferenceMap({
        modelA: 'HIGH',
        ' ': 'medium',
        modelB: 'invalid',
        modelC: 'none'
      })
    ).toEqual({ modelA: 'high', modelC: 'none' })
  })

  it('reads stored reasoning preferences defensively', () => {
    expect(
      readStoredReasoningEffortMap(
        'reasoning',
        createStorage({ reasoning: JSON.stringify({ modelA: 'xhigh', modelB: 'unsupported' }) })
      )
    ).toEqual({ modelA: 'xhigh' })
    expect(readStoredReasoningEffortMap('reasoning', createStorage({ reasoning: '[]' }))).toEqual(
      {}
    )
    expect(
      readStoredReasoningEffortMap('reasoning', createStorage({ reasoning: 'not-json' }))
    ).toEqual({})
  })

  it('reads image generation options over defaults without mutating defaults', () => {
    const defaults = { enabled: false, size: 'auto', quality: 'medium' as const }

    expect(
      readStoredImageGenerationOptions(
        'image-options',
        defaults,
        createStorage({ 'image-options': JSON.stringify({ enabled: true, size: '1024x1024' }) })
      )
    ).toEqual({ enabled: true, size: '1024x1024', quality: 'medium' })
    expect(defaults).toEqual({ enabled: false, size: 'auto', quality: 'medium' })
    expect(readStoredImageGenerationOptions('image-options', defaults, createStorage({}))).toEqual(
      defaults
    )
  })

  it('resolves image generation reference size from valid image attachment dimensions', () => {
    expect(
      resolveReferenceImageGenerationSizeFromAttachments([
        { type: 'file', url: 'file:///notes.txt' },
        imageAttachment(2048, 1024)
      ])
    ).toBe('2048x1024')

    expect(resolveReferenceImageGenerationSizeFromAttachments([imageAttachment(0, 1024)])).toBe(
      undefined
    )
  })

  it('preserves explicit image generation size and uses image reference only for auto size', () => {
    expect(
      resolveImageGenerationOptionsForAttachments({ enabled: true, size: ' 512 x 512 ' }, [
        imageAttachment(2048, 1024)
      ])
    ).toEqual({ enabled: true, size: '1024x1024' })

    expect(
      resolveImageGenerationOptionsForAttachments({ enabled: true, size: 'auto' }, [
        imageAttachment(2048, 1024)
      ])
    ).toEqual({ enabled: true, size: '2048x1024' })
  })
})
