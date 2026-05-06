import { describe, expect, it } from 'vitest'
import {
  conditionFieldSeed,
  conditionFieldVideoUpload,
  conditionNodeIsOutputNode,
  conditionNodeLLMAPI,
  conditionNodeLoRALoader
} from './conditions'
import { ObjectInfo, ObjectInfoInputField } from '@shared/comfy/types'

describe('conditions node lora loader', () => {
  it('should return true if the node is a lora loader node', () => {
    const objectInfos: ObjectInfo = {
      input: {
        required: {
          model: ['MODEL', { tooltip: 'The diffusion model the LoRA will be applied to.' }],
          clip: ['CLIP', { tooltip: 'The CLIP model the LoRA will be applied to.' }],
          lora_name: [
            [
              'MoXinV1.safetensors',
              'Ryuuou no Oshigoto!_hinatsuru ai.safetensors',
              'SD1.5/animatediff/v3_sd15_adapter.ckpt',
              'blindbox_v1_mix.safetensors'
            ],
            { tooltip: 'The name of the LoRA.' }
          ],
          strength_model: [
            'FLOAT',
            {
              default: 1.0,
              min: -100.0,
              max: 100.0,
              step: 0.01,
              tooltip: 'How strongly to modify the diffusion model. This value can be negative.'
            }
          ],
          strength_clip: [
            'FLOAT',
            {
              default: 1.0,
              min: -100.0,
              max: 100.0,
              step: 0.01,
              tooltip: 'How strongly to modify the CLIP model. This value can be negative.'
            }
          ]
        }
      },
      input_order: {
        required: ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip']
      },
      output: ['MODEL', 'CLIP'],
      name: 'LoraLoader',
      display_name: 'Load LoRA',
      output_node: false
    }
    const result = conditionNodeLoRALoader(objectInfos)
    expect(result).toBe(true)
  })
})

describe('conditions llm api', () => {
  it('should return true if the field is a llm api field', () => {
    const objectInfos: ObjectInfo = {
      input: {
        required: {
          model_name: [
            'STRING',
            { default: 'gpt-4o-mini', tooltip: 'The name of the model, such as gpt-4o-mini.' }
          ]
        },
        optional: {
          base_url: [
            'STRING',
            {
              default: '',
              tooltip: 'The base URL of the API, such as https://api.openai.com/v1.'
            }
          ],
          api_key: ['STRING', { default: '', tooltip: 'The API key for the API.' }],
          is_ollama: ['BOOLEAN', { default: false, tooltip: 'Whether to use ollama.' }]
        }
      },
      input_order: { required: ['model_name'], optional: ['base_url', 'api_key', 'is_ollama'] },
      output: ['CUSTOM'],
      name: 'LLM_api_loader',
      display_name: '\u2601\ufe0fAPI LLM Loader',
      output_node: false
    }
    const result = conditionNodeLLMAPI(objectInfos)
    expect(result).toBe(true)
  })
})

describe('conditions video upload', () => {
  it('recognizes the supported video upload metadata variants', () => {
    const videoFieldVariants: ObjectInfoInputField[] = [
      ['STRING', { video_upload: true }],
      ['STRING', { accept: 'video/*' }],
      ['STRING', { accept: '.mov,.mp4' }],
      ['STRING', { media_type: 'video' }],
      ['STRING', { file_type: ['image', 'video'] }]
    ]

    for (const variant of videoFieldVariants) {
      expect(conditionFieldVideoUpload({} as ObjectInfo, variant)).toBe(true)
    }

    expect(conditionFieldVideoUpload({} as ObjectInfo, ['STRING', { accept: 'image/*' }])).toBe(
      false
    )
    expect(conditionFieldVideoUpload({} as ObjectInfo, ['INT', { video_upload: true }])).toBe(false)
  })
})

describe('conditions node is output node', () => {
  it('should return true if the node is a output node', () => {
    const objectInfos: ObjectInfo = {
      input: {
        required: {
          images: ['IMAGE', { tooltip: 'The images to save.' }],
          filename_prefix: [
            'STRING',
            {
              default: 'ComfyUI',
              tooltip:
                'The prefix for the file to save. This may include formatting information such as %date:yyyy-MM-dd% or %Empty Latent Image.width% to include values from nodes.'
            }
          ]
        }
      },
      input_order: {
        required: ['images', 'filename_prefix']
      },
      output: [],
      output_name: [],
      name: 'SaveImage',
      display_name: 'Save Image',
      output_node: true
    }
    const result = conditionNodeIsOutputNode(objectInfos)
    expect(result).toBe(true)
  })
})
