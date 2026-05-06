/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { createRef } from 'react'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import buildExeInputComfyVideo from './exeInputComfyVideo'
import type { ExeInputRef } from './types'

const setValueMock = vi.fn()
let mockInputState = ''

vi.mock('../../components/QAppContext', () => ({
  useQAppInputState: () => [mockInputState, setValueMock]
}))

vi.mock('../../hooks/useQAppLabel', () => ({
  useQAppLabel: (label: string) => `label:${label}`
}))

vi.mock('@renderer/components/inputs/InputComfyVideo', () => ({
  default: (props: { label: string; placeholder: string }) =>
    React.createElement('div', {
      'data-testid': 'video-input',
      'data-label': props.label,
      'data-placeholder': props.placeholder
    })
}))

describe('buildExeInputComfyVideo', () => {
  beforeEach(() => {
    setValueMock.mockReset()
    mockInputState = ''
  })

  it('validates and writes the uploaded video path back into the workflow', () => {
    mockInputState = 'uploaded-video.mp4'

    const workflow = {
      1: {
        class_type: 'LoadVideo',
        inputs: {
          video: 'default-video.mp4'
        }
      }
    } as any

    const Component = buildExeInputComfyVideo(
      {
        label: 'video-input',
        component: 'InputComfyVideo',
        slot: '$.1.inputs.video'
      },
      workflow
    )

    const ref = createRef<ExeInputRef>()
    const { getByTestId } = render(
      <Component ref={ref} objectInfos={{} as any} config={{} as any} buildEnv={{} as any} />
    )

    expect(getByTestId('video-input')).toHaveAttribute('data-label', 'label:video-input')
    expect(getByTestId('video-input')).toHaveAttribute('data-placeholder', 'label:video-input...')
    expect(ref.current?.validate(workflow)).toBe('')

    const nextWorkflow = {
      1: {
        class_type: 'LoadVideo',
        inputs: {
          video: 'default-video.mp4'
        }
      }
    } as any

    ref.current?.modifyWorkflow(nextWorkflow)
    expect(nextWorkflow[1].inputs.video).toBe('uploaded-video.mp4')
  })

  it('requires a value before running the workflow', () => {
    const workflow = {
      1: {
        class_type: 'LoadVideo',
        inputs: {
          video: ''
        }
      }
    } as any

    const Component = buildExeInputComfyVideo(
      {
        label: 'video-input',
        component: 'InputComfyVideo',
        slot: '$.1.inputs.video'
      },
      workflow
    )

    const ref = createRef<ExeInputRef>()
    render(<Component ref={ref} objectInfos={{} as any} config={{} as any} buildEnv={{} as any} />)

    expect(ref.current?.validate(workflow)).toBe('Please load a video first.')
  })
})
