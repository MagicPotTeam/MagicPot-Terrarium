import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractFallbackTriggerWordsFromMetadataObject,
  getFallbackTriggerWordsFromLoraName,
  extractTriggerWordsFromMetadataObject,
  extractTriggerWordsFromSafetensorsMetadata,
  readLoraTriggerWordsAuto,
  readLoraTriggerWordsComfyUIMetadata,
  resolveLoraComfyUIMetadataFilenames,
  resolveLoraModelFile,
  resolveLoraTriggerWordsFile,
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

  it('resolves a same-name trigger words txt file next to the LoRA model', () => {
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
    expect(
      resolveLoraTriggerWordsFile('C:\\ComfyUI\\models\\loras', '..\\style.safetensors', path.win32)
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

  it('extracts fallback trigger words from LoRA model identity metadata', () => {
    expect(
      extractFallbackTriggerWordsFromMetadataObject({
        __metadata__: {
          ss_output_name: 'qwen_image_lora_task01_kv',
          'modelspec.title': 'ignored duplicate title'
        }
      })
    ).toBe('qwen_image_lora_task01_kv, ignored duplicate title')
    expect(
      extractFallbackTriggerWordsFromMetadataObject({
        __metadata__: {
          'modelspec.title': '20260402\\qwen_image_lora_task01_kv.safetensors'
        }
      })
    ).toBe('qwen_image_lora_task01_kv')
  })

  it('uses the selected LoRA filename stem as the last-resort fallback trigger note', () => {
    expect(
      getFallbackTriggerWordsFromLoraName('20260402\\qwen_image_lora_task01_kv.safetensors')
    ).toBe('qwen_image_lora_task01_kv')
    expect(
      getFallbackTriggerWordsFromLoraName(
        '马上用/20260615/Qwen/HHCT_qwen_image_lora_complete-000022'
      )
    ).toBe('HHCT_qwen_image_lora_complete-000022')
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

  it('reads trigger words from ComfyUI /view_metadata/loras before local txt sidecars', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ trigger_words: 'remote style, remote token' })
    })
    const readTextFileMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('api', () => ({ svcFs: { readTextFile: readTextFileMock } }))

    const configUtils = {
      getComfyUIOrigin: () => 'http://remote-comfyui:8188',
      getLoraDir: () => 'C:\\ComfyUI\\models\\loras'
    }

    await expect(
      readLoraTriggerWordsComfyUIMetadata('anime/style.safetensors', configUtils as never)
    ).resolves.toBe('remote style, remote token')
    await expect(
      readLoraTriggerWordsAuto('anime/style.safetensors', configUtils as never)
    ).resolves.toBe('remote style, remote token')

    expect(readTextFileMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://remote-comfyui:8188/view_metadata/loras?filename=anime%2Fstyle.safetensors'
    )
  })

  it('normalizes Windows-style extensionless LoRA names before querying ComfyUI metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ trainedWords: ['hhct_style', 'restaurant_token'] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const selectedLoraName = '马上用\\20260615\\Qwen\\HHCT_qwen_image_lora_complete-000022'
    expect(resolveLoraComfyUIMetadataFilenames(selectedLoraName)).toEqual([
      '马上用/20260615/Qwen/HHCT_qwen_image_lora_complete-000022.safetensors'
    ])

    await expect(
      readLoraTriggerWordsComfyUIMetadata(selectedLoraName, {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188'
      } as never)
    ).resolves.toBe('hhct_style, restaurant_token')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://remote-comfyui:8188/view_metadata/loras?filename=%E9%A9%AC%E4%B8%8A%E7%94%A8%2F20260615%2FQwen%2FHHCT_qwen_image_lora_complete-000022.safetensors'
    )
  })

  it('falls back to ComfyUI LoRA model identity metadata when no explicit trigger words exist', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ss_output_name: 'qwen_image_lora_task01_kv',
        'modelspec.title': 'qwen_image_lora_task01_kv'
      })
    })
    const readTextFileMock = vi.fn().mockRejectedValue(new Error('no sidecar'))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('path', path.win32)
    window.path = path.win32 as typeof window.path
    window.api = { svcFs: { readTextFile: readTextFileMock } } as unknown as typeof window.api

    await expect(
      readLoraTriggerWordsAuto('20260402\\qwen_image_lora_task01_kv.safetensors', {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188',
        getLoraDir: () => 'C:\\ComfyUI\\models\\loras'
      } as never)
    ).resolves.toBe('qwen_image_lora_task01_kv')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://remote-comfyui:8188/view_metadata/loras?filename=20260402%2Fqwen_image_lora_task01_kv.safetensors'
    )
  })

  it('falls back to the selected LoRA filename stem when metadata and sidecars are unavailable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ComfyUI is not ready'))
    const readTextFileMock = vi.fn().mockRejectedValue(new Error('no sidecar'))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('path', path.win32)
    window.path = path.win32 as typeof window.path
    window.api = { svcFs: { readTextFile: readTextFileMock } } as unknown as typeof window.api

    await expect(
      readLoraTriggerWordsAuto('20260402\\qwen_image_lora_task01_kv.safetensors', {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188',
        getLoraDir: () => 'C:\\ComfyUI\\models\\loras'
      } as never)
    ).resolves.toBe('qwen_image_lora_task01_kv')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readTextFileMock).toHaveBeenCalled()
  })

  it('prefers local sidecar trigger words over ComfyUI model identity fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ss_output_name: 'fallback_model_name' })
    })
    const readTextFileMock = vi.fn().mockResolvedValue({ content: 'sidecar real token' })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('path', path.win32)
    window.path = path.win32 as typeof window.path
    window.api = { svcFs: { readTextFile: readTextFileMock } } as unknown as typeof window.api

    await expect(
      readLoraTriggerWordsAuto('anime/style.safetensors', {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188',
        getLoraDir: () => 'C:\\ComfyUI\\models\\loras'
      } as never)
    ).resolves.toBe('sidecar real token')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readTextFileMock).toHaveBeenCalledWith({
      fullPath: 'C:\\ComfyUI\\models\\loras\\anime\\style.txt'
    })
  })

  it('falls back to a same-name local txt sidecar when ComfyUI metadata has no triggers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ss_dataset_dirs: '{"12_style": {"n_repeats": 12}}' })
    })
    const readTextFileMock = vi.fn().mockResolvedValue({ content: 'sidecar style\nsidecar token' })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('path', path.win32)
    window.path = path.win32 as typeof window.path
    window.api = { svcFs: { readTextFile: readTextFileMock } } as unknown as typeof window.api

    await expect(
      readLoraTriggerWordsAuto('anime/style.safetensors', {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188',
        getLoraDir: () => 'C:\\ComfyUI\\models\\loras'
      } as never)
    ).resolves.toBe('sidecar style, sidecar token')

    expect(readTextFileMock).toHaveBeenCalledWith({
      fullPath: 'C:\\ComfyUI\\models\\loras\\anime\\style.txt'
    })
  })

  it('reads local civitai metadata sidecars for Windows-style extensionless LoRA names', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false })
    const fileExistsBatchMock = vi.fn(async (paths: string[]) =>
      paths.map((candidatePath) =>
        candidatePath.endsWith('HHCT_qwen_image_lora_complete-000022.civitai.info')
      )
    )
    const readTextFileMock = vi.fn().mockResolvedValue({
      content: JSON.stringify({ modelVersions: [{ trainedWords: ['hhct_style', 'dining_room'] }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('path', path.win32)
    window.path = path.win32 as typeof window.path
    window.api = {
      svcFs: { readTextFile: readTextFileMock },
      svcShell: { fileExistsBatch: fileExistsBatchMock }
    } as unknown as typeof window.api

    await expect(
      readLoraTriggerWordsAuto('马上用\\20260615\\Qwen\\HHCT_qwen_image_lora_complete-000022', {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188',
        getLoraDir: () => 'C:\\ComfyUI\\models\\loras'
      } as never)
    ).resolves.toBe('hhct_style, dining_room')

    expect(fileExistsBatchMock).toHaveBeenCalled()
    expect(readTextFileMock).toHaveBeenCalledTimes(1)
    expect(readTextFileMock).toHaveBeenCalledWith({
      fullPath:
        'C:\\ComfyUI\\models\\loras\\马上用\\20260615\\Qwen\\HHCT_qwen_image_lora_complete-000022.civitai.info'
    })
  })

  it('skips ComfyUI metadata for non-safetensors files but can still read txt sidecars', async () => {
    const fetchMock = vi.fn()
    const readTextFileMock = vi.fn().mockResolvedValue({ content: 'ckpt sidecar token' })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('path', path.win32)
    window.path = path.win32 as typeof window.path
    window.api = { svcFs: { readTextFile: readTextFileMock } } as unknown as typeof window.api

    await expect(
      readLoraTriggerWordsComfyUIMetadata('anime/style.ckpt', {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188'
      } as never)
    ).resolves.toBe('')
    await expect(
      readLoraTriggerWordsAuto('anime/style.ckpt', {
        getComfyUIOrigin: () => 'http://remote-comfyui:8188',
        getLoraDir: () => 'C:\\ComfyUI\\models\\loras'
      } as never)
    ).resolves.toBe('ckpt sidecar token')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(readTextFileMock).toHaveBeenCalledWith({
      fullPath: 'C:\\ComfyUI\\models\\loras\\anime\\style.txt'
    })
  })
})
