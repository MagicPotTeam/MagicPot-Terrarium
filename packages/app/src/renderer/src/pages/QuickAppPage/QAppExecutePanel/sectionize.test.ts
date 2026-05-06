import { describe, expect, it, vi } from 'vitest'
import { sectionize } from './sectionize'
import { QAppCfg } from '@shared/qApp/cfgTypes'
import { Workflow } from '@shared/comfy/types'

vi.mock(import('konva'), () => {
  return {}
})

vi.mock(import('react-konva'), () => {
  return {}
})

describe('sectionize', () => {
  it('should return the correct structured input', () => {
    const cfg: QAppCfg = {
      icon: '',
      inputs: [
        {
          component: 'InputNumber',
          label: 'input0',
          slot: '$.1.inputs.a'
        },
        {
          component: 'Section',
          label: 'section1'
        },
        {
          component: 'InputPrompt',
          label: 'input1',
          slot: '$.1.inputs.b'
        }
      ]
    }
    const workflowTemplate: Workflow = {
      '1': {
        class_type: 'class_type',
        inputs: {
          a: 1,
          b: 'b'
        }
      }
    }
    const structuredInput = sectionize(cfg, workflowTemplate)
    expect(structuredInput.headInputs).toHaveLength(1)
    expect(structuredInput.headInputs[0].componentIndex).toBe(0)
    expect(structuredInput.sections).toHaveLength(1)
    expect(structuredInput.sections[0].sectionIndex).toBe(0)
    expect(structuredInput.sections[0].inputs).toHaveLength(1)
    expect(structuredInput.sections[0].inputs[0].componentIndex).toBe(1)
  })

  it('keeps rendering when an input builder throws', () => {
    const cfg: QAppCfg = {
      icon: '',
      inputs: [
        {
          component: 'InputNumber',
          label: 'broken-input',
          slot: '$.1.inputs.a'
        }
      ]
    }
    const workflowTemplate: Workflow = {
      '1': {
        class_type: 'class_type',
        inputs: {
          a: 'not-a-number'
        }
      }
    }

    expect(() => sectionize(cfg, workflowTemplate)).not.toThrow()
    const structuredInput = sectionize(cfg, workflowTemplate)
    expect(structuredInput.headInputs).toHaveLength(1)
    expect(structuredInput.headInputs[0].componentIndex).toBe(0)
  })
})
