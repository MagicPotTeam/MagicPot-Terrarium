import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectSelectedLoraTriggerWords,
  resolveLoraTriggerWordsFile,
  toLoraOptionName
} from './loraTriggerWordFiles'

describe('loraTriggerWordFiles', () => {
  it('resolves a trigger-word sidecar beside the selected LoRA file', () => {
    expect(
      resolveLoraTriggerWordsFile(
        'C:\\ComfyUI\\models\\loras',
        'anime\\style.safetensors',
        path.win32
      )
    ).toEqual({
      outputPath: 'C:\\ComfyUI\\models\\loras\\anime',
      filename: 'style.txt',
      fullPath: 'C:\\ComfyUI\\models\\loras\\anime\\style.txt'
    })
  })

  it('rejects LoRA names outside the LoRA directory', () => {
    expect(
      resolveLoraTriggerWordsFile('C:\\ComfyUI\\models\\loras', '..\\style.safetensors', path.win32)
    ).toBeNull()
    expect(
      resolveLoraTriggerWordsFile(
        'C:\\ComfyUI\\models\\loras',
        'C:\\other\\style.safetensors',
        path.win32
      )
    ).toBeNull()
  })

  it('normalizes LoRA file paths to ComfyUI option names', () => {
    expect(
      toLoraOptionName(
        'C:\\ComfyUI\\models\\loras',
        'C:\\ComfyUI\\models\\loras\\anime\\style.safetensors',
        path.win32
      )
    ).toBe('anime/style.safetensors')
    expect(
      toLoraOptionName(
        'C:\\ComfyUI\\models\\loras',
        'C:\\ComfyUI\\models\\checkpoints\\style.safetensors',
        path.win32
      )
    ).toBeNull()
  })

  it('collects trigger words from selected LoRA rows', () => {
    const formState = new Map<string, unknown>([
      [
        'loras',
        [
          { lora_name: 'style.safetensors', trigger_words: ' style tag\ncinematic ' },
          { lora_name: 'empty.safetensors', trigger_words: ' ' },
          { lora_name: 'legacy.safetensors' }
        ]
      ]
    ])

    expect(
      collectSelectedLoraTriggerWords(formState, {
        'legacy.safetensors': 'legacy tag'
      })
    ).toEqual([
      { loraName: 'style.safetensors', triggerWords: 'style tag, cinematic' },
      { loraName: 'legacy.safetensors', triggerWords: 'legacy tag' }
    ])
  })
})
