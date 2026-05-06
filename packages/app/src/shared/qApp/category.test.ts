import { describe, expect, it } from 'vitest'
import type { Workflow } from '@shared/comfy/types'
import { inferQAppCategory } from './category'

describe('inferQAppCategory', () => {
  it('classifies quick apps with video input components as video', () => {
    expect(
      inferQAppCategory({
        key: 'alpha',
        cfg: {
          icon: '',
          autoInputs: [],
          inputs: [
            {
              component: 'InputComfyVideo',
              label: 'Source Video',
              slot: '$.1.inputs.video'
            }
          ]
        }
      })
    ).toBe('video')
  })

  it('classifies quick apps with save video output nodes as video even when the name is neutral', () => {
    const workflow: Workflow = {
      '108': {
        class_type: 'SaveVideo',
        inputs: {
          filename_prefix: 'demo'
        }
      }
    }

    expect(
      inferQAppCategory({
        key: 'neutral-app',
        name: 'neutral-app',
        cfg: {
          icon: '',
          autoInputs: [],
          inputs: [],
          outputNodeIds: ['108']
        },
        workflow
      })
    ).toBe('video')
  })

  it('prefers explicit categories from the menu item payload', () => {
    expect(
      inferQAppCategory({
        key: 'alpha',
        name: 'alpha',
        category: 'video'
      })
    ).toBe('video')
  })

  it('keeps known built-in quick apps in their canonical categories even with stale explicit categories', () => {
    const seedVrWorkflow: Workflow = {
      '8': {
        class_type: 'SaveImage',
        inputs: {
          images: ['6', 0]
        }
      },
      '7': {
        class_type: 'SeedVR2VideoUpscaler',
        inputs: {
          image: ['2', 0]
        }
      }
    }

    expect(
      inferQAppCategory({
        key: '\u9ad8\u6e05\u653e\u5927/\u67d4\u548c_SeedVR2',
        name: '\u67d4\u548c_SeedVR2',
        category: 'video',
        cfg: {
          icon: '',
          autoInputs: [],
          inputs: [],
          outputNodeIds: ['8']
        },
        workflow: seedVrWorkflow
      })
    ).toBe('image')

    expect(
      inferQAppCategory({
        key: '~builtin/hunyuan3d/concept',
        name: 'concept',
        category: 'image'
      })
    ).toBe('model3d')

    expect(
      inferQAppCategory({
        key: '~builtin/inspection/duplicate-check',
        name: 'duplicate-check',
        category: 'video'
      })
    ).toBe('inspection')
  })

  it('falls back to image when no video or 3D signals are present', () => {
    expect(
      inferQAppCategory({
        key: 'alpha',
        name: 'alpha',
        cfg: {
          icon: '',
          autoInputs: [],
          inputs: []
        }
      })
    ).toBe('image')
  })
})
