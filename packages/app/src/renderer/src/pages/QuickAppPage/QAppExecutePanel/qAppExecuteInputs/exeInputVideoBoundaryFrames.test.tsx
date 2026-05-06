/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { createRef } from 'react'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import buildExeInputVideoBoundaryFrames, {
  getVideoBoundaryFramesValidationMessage
} from './exeInputVideoBoundaryFrames'
import type { ExeInputRef } from './types'

const setValueMock = vi.fn()
let mockInputState = {
  videoFileName: '',
  firstFrameValue: '',
  lastFrameValue: ''
}

vi.mock('../../components/QAppContext', () => ({
  useQAppInputState: () => [mockInputState, setValueMock]
}))

vi.mock('../../hooks/useQAppLabel', () => ({
  useQAppLabel: (label: string) => `label:${label}`
}))

vi.mock('@renderer/components/inputs/InputVideoBoundaryFrames', () => ({
  default: (props: { label: string; placeholder: string }) =>
    React.createElement('div', {
      'data-testid': 'video-boundary-input',
      'data-label': props.label,
      'data-placeholder': props.placeholder
    })
}))

describe('buildExeInputVideoBoundaryFrames', () => {
  beforeEach(() => {
    setValueMock.mockReset()
    mockInputState = {
      videoFileName: '',
      firstFrameValue: '',
      lastFrameValue: ''
    }
  })

  it('builds a readable validation message for missing boundary frames', () => {
    expect(getVideoBoundaryFramesValidationMessage('video-boundary')).toBe(
      '请先加载 video-boundary'
    )
  })

  it('falls back to empty defaults when the workflow slot value is not a string', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const workflow = {
      1: { class_type: 'LoadImage', inputs: { image: { filename: 'frame.png' } } },
      2: { class_type: 'LoadImage', inputs: { image: ['node', 0] } }
    } as any

    const builder = () =>
      buildExeInputVideoBoundaryFrames(
        {
          label: 'video-boundary',
          component: 'InputVideoBoundaryFrames',
          firstFrameSlot: '$.1.inputs.image',
          lastFrameSlot: '$.2.inputs.image'
        },
        workflow
      )

    expect(builder).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('validates and writes both boundary frame slots back into the workflow', () => {
    mockInputState = {
      videoFileName: 'demo.mp4',
      firstFrameValue: 'first-frame.png',
      lastFrameValue: 'last-frame.png'
    }

    const workflow = {
      1: { class_type: 'LoadImage', inputs: { image: 'first-default.png' } },
      2: { class_type: 'LoadImage', inputs: { image: 'last-default.png' } }
    } as any

    const Component = buildExeInputVideoBoundaryFrames(
      {
        label: 'video-boundary',
        component: 'InputVideoBoundaryFrames',
        firstFrameSlot: '$.1.inputs.image',
        lastFrameSlot: '$.2.inputs.image'
      },
      workflow
    )

    const ref = createRef<ExeInputRef>()
    const { getByTestId } = render(
      <Component ref={ref} objectInfos={{} as any} config={{} as any} buildEnv={{} as any} />
    )

    expect(getByTestId('video-boundary-input')).toHaveAttribute(
      'data-label',
      'label:video-boundary'
    )
    expect(getByTestId('video-boundary-input')).toHaveAttribute(
      'data-placeholder',
      'label:video-boundary...'
    )
    expect(ref.current?.validate(workflow)).toBe('')

    const nextWorkflow = {
      1: { class_type: 'LoadImage', inputs: { image: 'first-default.png' } },
      2: { class_type: 'LoadImage', inputs: { image: 'last-default.png' } }
    } as any

    ref.current?.modifyWorkflow(nextWorkflow)

    expect(nextWorkflow[1].inputs.image).toBe('first-frame.png')
    expect(nextWorkflow[2].inputs.image).toBe('last-frame.png')
  })

  it('works for a generic non-Wan video workflow contract as well', () => {
    mockInputState = {
      videoFileName: 'scene-cut.mp4',
      firstFrameValue: 'scene-cut-first.png',
      lastFrameValue: 'scene-cut-last.png'
    }

    const workflow = {
      a: { class_type: 'GenericVideoBoundaryInput', inputs: { image: 'first-default.png' } },
      b: { class_type: 'GenericVideoBoundaryInput', inputs: { image: 'last-default.png' } },
      c: {
        class_type: 'CreateVideo',
        inputs: { images: ['a', 0] }
      }
    } as any

    const Component = buildExeInputVideoBoundaryFrames(
      {
        label: 'generic-video',
        component: 'InputVideoBoundaryFrames',
        firstFrameSlot: '$.a.inputs.image',
        lastFrameSlot: '$.b.inputs.image'
      },
      workflow
    )

    const ref = createRef<ExeInputRef>()
    render(<Component ref={ref} objectInfos={{} as any} config={{} as any} buildEnv={{} as any} />)

    expect(ref.current?.validate(workflow)).toBe('')

    const nextWorkflow = {
      a: { class_type: 'GenericVideoBoundaryInput', inputs: { image: 'first-default.png' } },
      b: { class_type: 'GenericVideoBoundaryInput', inputs: { image: 'last-default.png' } },
      c: {
        class_type: 'CreateVideo',
        inputs: { images: ['a', 0] }
      }
    } as any

    ref.current?.modifyWorkflow(nextWorkflow)

    expect(nextWorkflow.a.inputs.image).toBe('scene-cut-first.png')
    expect(nextWorkflow.b.inputs.image).toBe('scene-cut-last.png')
  })
})
