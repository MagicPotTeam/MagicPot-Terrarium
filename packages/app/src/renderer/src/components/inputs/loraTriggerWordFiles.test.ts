import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractTriggerWordsFromMetadataObject,
  extractTriggerWordsFromSafetensorsMetadata,
  readLoraTriggerWordsAuto,
  readLoraTriggerWordsComfyUIMetadata,
  resolveLoraModelFile,
  toLoraOptionName
} from './loraTriggerWordFiles'

describe('loraTriggerWordFiles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves a selected LoRA model inside the LoRA directory', () => {
    expect(
      resolveLoraModelFile('C:\\ComfyUI\\models\\loras', 'anime\\style.safetensors', path.win32)
    ).toEqual({
      outputPath: 'C:\\ComfyUI\\models\\loras\\anime',
      filename: 'style.safetensors',
      fullPath: 'C:\\ComfyUI\\models\\loras\\anime\\style.safetensors'
    })
  })

  it('rejects LoRA model names outside the LoRA directory', () => {
    expect(
      resolveLoraModelFile('C:\\ComfyUI\\models\\loras', '..\\style.safetensors', path.win32)
    ).toBeNull()
    expect(
      resolveLoraModelFile('C:\\ComfyUI\\models\\loras', 'C:\\other\\style.safetensors', path.win32)
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

  it('extracts trigger words from explicit metadata payloads', () => {
    expect(
      extractTriggerWordsFromMetadataObject({
        trainedWords: ['hero_style', 'cinematic'],
        modelVersions: [{ trainedWords: ['nested_token'] }]
      })
    ).toBe('hero_style, cinematic, nested_token')
    expect(
      extractTriggerWordsFromMetadataObject(
        JSON.stringify({ modelVersion: { triggerWords: 'alpha, beta' } })
      )
    ).toBe('alpha, beta')
  })

  it('extracts trigger words from safetensors metadata explicit fields only', () => {
    expect(
      extractTriggerWordsFromSafetensorsMetadata({
        __metadata__: {
          trigger_words: 'main_style\nsecondary_style'
        }
      })
    ).toBe('main_style, secondary_style')
    expect(
      extractTriggerWordsFromSafetensorsMetadata({
        __metadata__: {
          ss_dataset_dirs: JSON.stringify({ '12_char_style': { n_repeats: 12 } }),
          ss_tag_frequency: JSON.stringify({ char_style: 20 })
        }
      })
    ).toBe('')
    expect(
      extractTriggerWordsFromSafetensorsMetadata({
        __metadata__: {
          ss_dataset_dirs: JSON.stringify({ '1_complete_split41': { n_repeats: 1 } })
        }
      })
    ).toBe('')
  })

  it('reads trigger words only from ComfyUI /view_metadata/loras', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ trigger_words: 'remote style, remote token' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const configUtils = {
      getComfyUIOrigin: () => 'http://remote-comfyui:8188'
    }

    await expect(
      readLoraTriggerWordsComfyUIMetadata('anime/style.safetensors', configUtils as never)
    ).resolves.toBe('remote style, remote token')
    await expect(
      readLoraTriggerWordsAuto('anime/style.safetensors', configUtils as never)
    ).resolves.toBe('remote style, remote token')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://remote-comfyui:8188/view_metadata/loras?filename=anime%2Fstyle.safetensors'
    )
  })

  it('skips non-safetensors files for ComfyUI metadata detection', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      readLoraTriggerWordsAuto('anime/style.ckpt', {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188'
      } as never)
    ).resolves.toBe('')

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
