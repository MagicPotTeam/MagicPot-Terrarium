import { describe, expect, it } from 'vitest'

import { encodeDeferredComfyFileInputValue } from '@shared/comfy/deferredImages'
import { fileItemToValue } from '@shared/comfy/funcs'
import { buildQAppSubmitWorkflowRequest } from './qAppSubmitWorkflow'

describe('buildQAppSubmitWorkflowRequest', () => {
  it('includes the explicit client identity fields when provided', () => {
    const request = buildQAppSubmitWorkflowRequest({
      prompt: {} as never,
      qAppKey: ' demo.app ',
      clientId: ' renderer-quickapp ',
      sessionKey: ' session-1 ',
      extraData: { trace: true }
    })

    expect(request).toEqual({
      prompt: {} as never,
      qAppKey: 'demo.app',
      clientId: 'renderer-quickapp',
      sessionKey: 'session-1',
      cleanupAfterRun: false,
      extra_data: { trace: true }
    })
  })

  it('omits blank optional identity fields', () => {
    const request = buildQAppSubmitWorkflowRequest({
      prompt: {} as never,
      qAppKey: '   ',
      clientId: '  ',
      sessionKey: null
    })

    expect(request).toEqual({
      prompt: {} as never,
      cleanupAfterRun: false
    })
  })

  it('allows callers to opt in to automatic ComfyUI memory cleanup', () => {
    const request = buildQAppSubmitWorkflowRequest({
      prompt: {} as never,
      cleanupAfterRun: true
    })

    expect(request).toEqual({
      prompt: {} as never,
      cleanupAfterRun: true
    })
  })

  it('preserves deferred and routed file envelopes unchanged before lease acquisition', () => {
    const deferredValue = encodeDeferredComfyFileInputValue({
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      filePath: 'C:/cache/clip.mp4'
    })
    const routedValue = fileItemToValue({
      filename: 'result.png',
      type: 'output',
      instanceId: 'gpu-a',
      instanceRouteId: 'route-a',
      instanceOrigin: 'https://gpu.example/',
      instanceKind: 'remote'
    })

    const request = buildQAppSubmitWorkflowRequest({
      prompt: {
        '1': { class_type: 'LoadVideo', inputs: { video: deferredValue } },
        '2': { class_type: 'LoadImage', inputs: { image: routedValue } }
      }
    })

    expect(request.prompt['1'].inputs.video).toBe(deferredValue)
    expect(request.prompt['2'].inputs.image).toBe(routedValue)
  })

  it('preserves malformed reserved values for the lease-time materializer to reject', () => {
    const malformedReservedValue = 'MAGICPOT_DEFERRED_COMFY_FILE:%not-json'
    const prompt = {
      '1': { class_type: 'LoadVideo', inputs: { video: malformedReservedValue } }
    }

    const request = buildQAppSubmitWorkflowRequest({ prompt })

    expect(request.prompt).toBe(prompt)
    expect(request.prompt['1'].inputs.video).toBe(malformedReservedValue)
  })

  it('preserves the original workflow object including front-end-only history nodes', () => {
    const request = buildQAppSubmitWorkflowRequest({
      prompt: {
        '10': {
          class_type: 'SeedVR2VideoUpscaler',
          inputs: {
            image: ['31', 0]
          }
        },
        '18': {
          class_type: 'Note',
          inputs: {
            value: 'Enable to upscale alpha/mask channel along with RGB channel.'
          }
        },
        '31': {
          class_type: 'LoadImage',
          inputs: {
            image: 'input.png'
          }
        }
      }
    })

    expect(request.prompt).toEqual({
      '10': {
        class_type: 'SeedVR2VideoUpscaler',
        inputs: {
          image: ['31', 0]
        }
      },
      '18': {
        class_type: 'Note',
        inputs: {
          value: 'Enable to upscale alpha/mask channel along with RGB channel.'
        }
      },
      '31': {
        class_type: 'LoadImage',
        inputs: {
          image: 'input.png'
        }
      }
    })
  })
})
