import { describe, expect, it } from 'vitest'

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
      prompt: {} as never
    })
  })

  it('removes ComfyUI front-end-only nodes before submission', () => {
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
      '31': {
        class_type: 'LoadImage',
        inputs: {
          image: 'input.png'
        }
      }
    })
  })
})
