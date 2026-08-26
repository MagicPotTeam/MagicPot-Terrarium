import { describe, expect, it } from 'vitest'
import type { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import type { QAppCfg } from './cfgTypes'
import { normalizeQAppBatchConfig } from './batchConfig'

const cfg = (inputs: QAppCfg['inputs'] = [], outputNodeIds?: string[]): QAppCfg => ({
  icon: '',
  inputs,
  autoInputs: [],
  ...(outputNodeIds ? { outputNodeIds } : {})
})

describe('normalizeQAppBatchConfig', () => {
  it('uses the configured image input and SaveImage output by default', () => {
    const workflow: Workflow = {
      '51': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
      '147': { class_type: 'LoadImage', inputs: { image: '' } },
      '221': { class_type: 'SaveImage', inputs: {} }
    }
    const objectInfos: ObjectInfoMap = {
      LoadImage: { input: { required: { image: [['x.png'], { image_upload: true }] } } },
      SaveImage: { output_node: true }
    }

    const result = normalizeQAppBatchConfig(
      cfg([{ label: '加载图像', component: 'InputComfyImage', slot: '$.147.inputs.image' }]),
      workflow,
      objectInfos
    )

    expect(result.imageInputSlot).toBe('$.147.inputs.image')
    expect(result.outputNodeIds).toEqual(['221'])
    expect(result.cfg.batchProcess).toEqual({
      enabled: true,
      imageInputSlot: '$.147.inputs.image'
    })
  })

  it('does not enable batch processing when image candidates are ambiguous', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'LoadImage', inputs: { image: '' } },
      '3': { class_type: 'SaveImage', inputs: {} }
    }
    const objectInfos: ObjectInfoMap = {
      LoadImage: { input: { required: { image: [['x.png'], { image_upload: true }] } } },
      SaveImage: { output_node: true }
    }

    const result = normalizeQAppBatchConfig(cfg(), workflow, objectInfos)

    expect(result.imageInputCandidates).toEqual(['$.1.inputs.image', '$.2.inputs.image'])
    expect(result.canBatch).toBe(false)
    expect(result.cfg.batchProcess).toBeUndefined()
    expect(result.outputNodeIds).toEqual(['3'])
  })

  it('does not silently choose between multiple explicit image inputs', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'LoadImage', inputs: { image: '' } },
      '3': { class_type: 'SaveImage', inputs: {} }
    }
    const result = normalizeQAppBatchConfig(
      cfg([
        { label: '图片 1', component: 'InputComfyImage', slot: '$.1.inputs.image' },
        { label: '图片 2', component: 'InputComfyImage', slot: '$.2.inputs.image' }
      ]),
      workflow
    )
    expect(result.imageInputCandidates).toEqual(['$.1.inputs.image', '$.2.inputs.image'])
    expect(result.imageInputSlot).toBeUndefined()
    expect(result.canBatch).toBe(false)
  })

  it('enables a legacy config when explicit image input and output bindings exist', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'PreviewImage', inputs: {} }
    }

    const result = normalizeQAppBatchConfig(
      {
        ...cfg([{ label: '图片', component: 'InputComfyImage', slot: '$.1.inputs.image' }]),
        outputNodeIds: ['2']
      },
      workflow
    )

    expect(result.canBatch).toBe(true)
    expect(result.cfg.batchProcess).toEqual({
      enabled: true,
      imageInputSlot: '$.1.inputs.image'
    })
  })

  it('rejects explicitly configured non-image output bindings', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'KSampler', inputs: {} }
    }
    const result = normalizeQAppBatchConfig(
      {
        ...cfg([{ label: '图片', component: 'InputComfyImage', slot: '$.1.inputs.image' }]),
        outputNodeIds: ['2']
      },
      workflow,
      { KSampler: { output: ['LATENT'] as const } }
    )
    expect(result.outputNodeIds).toEqual([])
    expect(result.canBatch).toBe(false)
  })

  it('does not enable batch processing when output bindings are missing', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: '' } }
    }

    const result = normalizeQAppBatchConfig(
      {
        ...cfg([{ label: '图片', component: 'InputComfyImage', slot: '$.1.inputs.image' }]),
        outputNodeIds: []
      },
      workflow
    )

    expect(result.imageInputSlot).toBe('$.1.inputs.image')
    expect(result.outputNodeIds).toEqual([])
    expect(result.canBatch).toBe(false)
    expect(result.cfg.batchProcess).toBeUndefined()
  })

  it('keeps an explicit disabled setting while normalizing valid bindings', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'PreviewImage', inputs: {} }
    }
    const objectInfos: ObjectInfoMap = {
      LoadImage: { input: { required: { image: [['x.png'], { image_upload: true }] } } },
      PreviewImage: { output_node: true }
    }

    const result = normalizeQAppBatchConfig(
      {
        ...cfg([{ label: '图片', component: 'InputComfyImage', slot: '$.1.inputs.image' }]),
        batchProcess: { enabled: false, imageInputSlot: '$.1.inputs.image' }
      },
      workflow,
      objectInfos
    )

    expect(result.cfg.batchProcess).toEqual({
      enabled: false,
      imageInputSlot: '$.1.inputs.image'
    })
    expect(result.outputNodeIds).toEqual(['2'])
  })
})
