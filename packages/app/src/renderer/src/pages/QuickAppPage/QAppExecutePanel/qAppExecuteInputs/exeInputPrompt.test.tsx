/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { createRef } from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import buildExeInputPrompt from './exeInputPrompt'
import type { ExeInputRef } from './types'

const setValueMock = vi.fn()
const notifyWarningMock = vi.fn()
const generatePromptMock = vi.fn()
const selectFileMock = vi.fn()
const fileToDataUrlMock = vi.fn()
const getDroppedImageDropErrorMock = vi.fn()
const getDroppedImageFileMock = vi.fn()

let mockInputState: string | undefined = 'source prompt'
let mockPromptSettings = {
  usePromptTranslation: true,
  promptTranslationSystemPrompt: 'Translate the following prompt to English.',
  promptTranslationUserPrompt: '',
  promptTranslationProfileId: 'quick-translate',
  useImageInterrogation: false,
  imageInterrogationSystemPrompt: 'Describe {{description}}',
  imageInterrogationUserPrompt: '',
  imageInterrogationProfileId: 'vision-profile'
}

vi.mock('../../components/QAppContext', () => ({
  useQAppInputState: (_key: string, initialValue: string) => [
    mockInputState ?? initialValue,
    setValueMock
  ]
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {}
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyWarning: notifyWarningMock
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'qapp.prompt.buttons.translation') return 'Translate'
      if (key === 'qapp.prompt.buttons.image_interrogation') return 'Interrogate'
      if (key === 'qapp.prompt.errors.prompt_required') return 'Please enter a prompt first.'
      if (key === 'qapp.prompt.errors.missing_profile') return 'Missing profile.'
      if (key === 'qapp.prompt.errors.missing_profile_with_vision') {
        return 'Missing vision profile.'
      }
      if (key === 'qapp.prompt.errors.image_required') return 'Please select an image.'
      if (key === 'qapp.prompt.errors.image_convert_failed') return 'Failed to convert image.'
      if (key === 'qapp.prompt.errors.translation_failed') {
        return `Prompt translation failed: ${params?.error ?? ''}`
      }
      if (key === 'qapp.prompt.errors.image_interrogation_failed') {
        return `Prompt interrogation failed: ${params?.error ?? ''}`
      }
      if (key === 'qapp.prompt.default_description') return 'generate an image'
      return key
    }
  })
}))

vi.mock('./api/LLM', () => ({
  defaultCliFromProfile: () => ({
    generatePrompt: generatePromptMock
  })
}))

vi.mock('./qAppPromptSettings', () => ({
  getQAppPromptSettings: () => mockPromptSettings
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  selectFile: (...args: unknown[]) => selectFileMock(...args),
  fileToDataUrl: (...args: unknown[]) => fileToDataUrlMock(...args)
}))

vi.mock('@renderer/utils/droppedImageUtils', () => ({
  getDroppedImageDropError: (...args: unknown[]) => getDroppedImageDropErrorMock(...args),
  getDroppedImageFile: (...args: unknown[]) => getDroppedImageFileMock(...args)
}))

vi.mock('@renderer/components/inputs/InputTextAreaFunctional', () => ({
  default: (props: {
    value: string
    buttons?: {
      text: string
      onClick: () => Promise<void>
      onDrop?: (event: React.DragEvent<HTMLDivElement>) => Promise<void>
    }[]
    label: string
  }) =>
    React.createElement(
      'div',
      null,
      React.createElement('div', { 'data-testid': 'prompt-label' }, props.label),
      React.createElement('div', { 'data-testid': 'prompt-value' }, props.value),
      ...(props.buttons ?? []).map((button) =>
        React.createElement(
          'button',
          {
            key: button.text,
            type: 'button',
            onClick: () => {
              void button.onClick()
            },
            onDrop: button.onDrop
              ? (event: React.DragEvent<HTMLButtonElement>) => {
                  void button.onDrop!(event as unknown as React.DragEvent<HTMLDivElement>)
                }
              : undefined,
            onDragOver: button.onDrop
              ? (event: React.DragEvent<HTMLButtonElement>) => {
                  event.preventDefault()
                }
              : undefined
          },
          button.text
        )
      )
    )
}))

const createDataTransfer = (files: File[] = []) =>
  ({
    files,
    getData: vi.fn(() => '')
  }) as unknown as DataTransfer

describe('buildExeInputPrompt', () => {
  beforeEach(() => {
    mockInputState = 'source prompt'
    mockPromptSettings = {
      usePromptTranslation: true,
      promptTranslationSystemPrompt: 'Translate the following prompt to English.',
      promptTranslationUserPrompt: '',
      promptTranslationProfileId: 'quick-translate',
      useImageInterrogation: false,
      imageInterrogationSystemPrompt: 'Describe {{description}}',
      imageInterrogationUserPrompt: '',
      imageInterrogationProfileId: 'vision-profile'
    }
    setValueMock.mockReset()
    notifyWarningMock.mockReset()
    generatePromptMock.mockReset()
    selectFileMock.mockReset()
    fileToDataUrlMock.mockReset()
    getDroppedImageDropErrorMock.mockReset()
    getDroppedImageFileMock.mockReset()
    generatePromptMock.mockResolvedValue('translated prompt')
    getDroppedImageDropErrorMock.mockReturnValue(null)
  })

  it('sends the current prompt as user input when the translation template has no placeholder', async () => {
    const workflow = {
      1: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'default prompt'
        }
      }
    } as any

    const Component = buildExeInputPrompt(
      {
        label: 'Prompt',
        component: 'InputPrompt',
        slot: '$.1.inputs.text'
      },
      workflow
    )

    const ref = createRef<ExeInputRef>()
    const { getByRole } = render(
      <Component ref={ref} objectInfos={{} as any} config={{} as any} buildEnv={{} as any} />
    )

    fireEvent.click(getByRole('button', { name: 'Translate' }))

    await waitFor(() => {
      expect(generatePromptMock).toHaveBeenCalledWith({
        prompt: 'source prompt',
        systemPrompt: 'Translate the following prompt to English.'
      })
    })
    expect(setValueMock).toHaveBeenCalledWith('translated prompt')
    expect(ref.current?.validate(workflow)).toBe('')
  })

  it('uses the preset prompt as editable initial input', () => {
    mockInputState = undefined
    const workflow = {
      1: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'a girl'
        }
      }
    } as any

    const Component = buildExeInputPrompt(
      {
        label: 'Prompt',
        component: 'InputPrompt',
        slot: '$.1.inputs.text',
        suffixPrompt: 'best quality, high detail'
      },
      workflow
    )

    const ref = createRef<ExeInputRef>()
    const { getByTestId, queryByText } = render(
      <Component ref={ref} objectInfos={{} as any} config={{} as any} buildEnv={{} as any} />
    )

    expect(queryByText('预设提示词')).toBeNull()
    expect(getByTestId('prompt-value').textContent).toBe('best quality, high detail, a girl')

    ref.current?.modifyWorkflow(workflow)

    expect(workflow[1].inputs.text).toBe('best quality, high detail, a girl')
  })

  it('keeps placeholder-based templates working as before', async () => {
    mockPromptSettings = {
      ...mockPromptSettings,
      promptTranslationSystemPrompt: '',
      promptTranslationUserPrompt: 'Translate this to English: {{prompt}}'
    }

    const workflow = {
      1: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'default prompt'
        }
      }
    } as any

    const Component = buildExeInputPrompt(
      {
        label: 'Prompt',
        component: 'InputPrompt',
        slot: '$.1.inputs.text'
      },
      workflow
    )

    const { getByRole } = render(
      <Component
        ref={createRef<ExeInputRef>()}
        objectInfos={{} as any}
        config={{} as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.click(getByRole('button', { name: 'Translate' }))

    await waitFor(() => {
      expect(generatePromptMock).toHaveBeenCalledWith({
        prompt: 'Translate this to English: source prompt'
      })
    })
  })

  it('does not call the model when the prompt is empty', async () => {
    mockInputState = '   '

    const workflow = {
      1: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: ''
        }
      }
    } as any

    const Component = buildExeInputPrompt(
      {
        label: 'Prompt',
        component: 'InputPrompt',
        slot: '$.1.inputs.text'
      },
      workflow
    )

    const { getByRole } = render(
      <Component
        ref={createRef<ExeInputRef>()}
        objectInfos={{} as any}
        config={{} as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.click(getByRole('button', { name: 'Translate' }))

    await waitFor(() => {
      expect(notifyWarningMock).toHaveBeenCalledWith('Please enter a prompt first.')
    })
    expect(generatePromptMock).not.toHaveBeenCalled()
  })

  it('uses the configured translation user prompt together with the system prompt', async () => {
    mockPromptSettings = {
      ...mockPromptSettings,
      promptTranslationSystemPrompt: 'Translate to English and keep tags.',
      promptTranslationUserPrompt: 'Source prompt: {{prompt}}'
    }

    const workflow = {
      1: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'default prompt'
        }
      }
    } as any

    const Component = buildExeInputPrompt(
      {
        label: 'Prompt',
        component: 'InputPrompt',
        slot: '$.1.inputs.text'
      },
      workflow
    )

    const { getByRole } = render(
      <Component
        ref={createRef<ExeInputRef>()}
        objectInfos={{} as any}
        config={{} as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.click(getByRole('button', { name: 'Translate' }))

    await waitFor(() => {
      expect(generatePromptMock).toHaveBeenCalledWith({
        prompt: 'Source prompt: source prompt',
        systemPrompt: 'Translate to English and keep tags.'
      })
    })
  })

  it('accepts dropped images on the interrogate button and writes the generated prompt', async () => {
    mockPromptSettings = {
      ...mockPromptSettings,
      usePromptTranslation: false,
      useImageInterrogation: true,
      imageInterrogationSystemPrompt: 'Describe {{description}} in detail.',
      imageInterrogationUserPrompt: 'Focus on {{description}} only.'
    }
    generatePromptMock.mockResolvedValue('interrogated prompt')
    const droppedFile = new File(['image'], 'drop.png', { type: 'image/png' })
    getDroppedImageFileMock.mockResolvedValue(droppedFile)
    fileToDataUrlMock.mockResolvedValue('data:image/png;base64,drop')

    const workflow = {
      1: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'default prompt'
        }
      }
    } as any

    const Component = buildExeInputPrompt(
      {
        label: 'Prompt',
        component: 'InputPrompt',
        slot: '$.1.inputs.text'
      },
      workflow
    )

    const { getByRole } = render(
      <Component
        ref={createRef<ExeInputRef>()}
        objectInfos={{} as any}
        config={{} as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.drop(getByRole('button', { name: 'Interrogate' }), {
      dataTransfer: createDataTransfer([droppedFile])
    })

    await waitFor(() => {
      expect(generatePromptMock).toHaveBeenCalledWith({
        prompt: 'Focus on generate an image only.',
        systemPrompt: 'Describe generate an image in detail.',
        imageObjUrl: 'data:image/png;base64,drop'
      })
    })
    expect(setValueMock).toHaveBeenCalledWith('interrogated prompt')
  })

  it('shows a drop validation warning instead of interrogating unsupported drags', async () => {
    mockPromptSettings = {
      ...mockPromptSettings,
      usePromptTranslation: false,
      useImageInterrogation: true
    }
    getDroppedImageDropErrorMock.mockReturnValue('Only image drops are supported.')

    const workflow = {
      1: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'default prompt'
        }
      }
    } as any

    const Component = buildExeInputPrompt(
      {
        label: 'Prompt',
        component: 'InputPrompt',
        slot: '$.1.inputs.text'
      },
      workflow
    )

    const { getByRole } = render(
      <Component
        ref={createRef<ExeInputRef>()}
        objectInfos={{} as any}
        config={{} as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.drop(getByRole('button', { name: 'Interrogate' }), {
      dataTransfer: createDataTransfer()
    })

    await waitFor(() => {
      expect(notifyWarningMock).toHaveBeenCalledWith('Only image drops are supported.')
    })
    expect(generatePromptMock).not.toHaveBeenCalled()
  })
})
