import { describe, expect, it } from 'vitest'
import { convertGuiWorkflowToPrompt } from './guiWorkflowToPrompt'

describe('convertGuiWorkflowToPrompt', () => {
  it('does not carry Note nodes from GUI workflow exports into executable prompts', () => {
    const workflow = convertGuiWorkflowToPrompt({
      nodes: [
        {
          id: 1,
          type: 'LoadImage',
          title: 'Load Image',
          inputs: [],
          outputs: [],
          widgets_values: ['input.png'],
          properties: {
            widget_ue_connectable: {
              image: {}
            }
          }
        },
        {
          id: 18,
          type: 'Note',
          inputs: [],
          outputs: [],
          widgets_values: ['Enable to upscale alpha/mask channel along with RGB channel.']
        },
        {
          id: 5,
          type: 'SaveImage',
          title: 'Save Image',
          inputs: [{ name: 'images', link: 1 }],
          outputs: []
        }
      ],
      links: [[1, 1, 0, 5, 0, 'IMAGE']]
    })

    expect(workflow).toEqual({
      '1': {
        class_type: 'LoadImage',
        inputs: {
          image: 'input.png'
        },
        _meta: {
          title: 'Load Image'
        }
      },
      '5': {
        class_type: 'SaveImage',
        inputs: {
          images: ['1', 0]
        },
        _meta: {
          title: 'Save Image'
        }
      }
    })
  })
})
