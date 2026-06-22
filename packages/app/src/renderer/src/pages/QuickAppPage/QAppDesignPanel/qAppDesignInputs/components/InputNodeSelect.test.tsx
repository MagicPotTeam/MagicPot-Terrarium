import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { describe, expect, it, vi } from 'vitest'
import { theme } from '@renderer/theme'
import InputNodeSelect from './InputNodeSelect'
import type { ObjectInfoMap, Workflow } from '@shared/comfy/types'

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyWarning: vi.fn(),
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    notifyInfo: vi.fn(),
    closeMessage: vi.fn()
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      (
        ({
          'qapp.design.node': 'Node',
          'qapp.design.field': 'Field'
        }) as Record<string, string>
      )[key] ??
      options?.defaultValue ??
      key
  })
}))

const workflow: Workflow = {
  '1': {
    class_type: 'TextNode',
    inputs: {
      text: 'hello'
    },
    _meta: {
      title: 'Text Node'
    }
  },
  '3': {
    class_type: 'ImageScaleToTotalPixels',
    inputs: {
      resize_mode: 'nearest-exact'
    },
    _meta: {
      title: '图像完美像素'
    }
  },
  '35': {
    class_type: 'UNetLoader',
    inputs: {
      unet_name: 'model.safetensors'
    },
    _meta: {
      title: 'UNet Loader'
    }
  }
}

const objectInfos: ObjectInfoMap = {}

describe('InputNodeSelect', () => {
  it('keeps the dropdowns and allows selecting a node by typing its ID', async () => {
    const onChange = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <InputNodeSelect
          label="Slot"
          value="$.1.inputs.text"
          onChange={onChange}
          workflow={workflow}
          objectInfos={objectInfos}
          mode="field"
        />
      </ThemeProvider>
    )

    expect(screen.getByLabelText('Node')).toBeTruthy()
    expect(screen.getByLabelText('Field')).toBeTruthy()

    onChange.mockClear()
    const nodeInput = screen.getByLabelText('Node') as HTMLInputElement
    fireEvent.focus(nodeInput)
    fireEvent.change(nodeInput, { target: { value: '3' } })
    expect(nodeInput.value).toBe('3')

    fireEvent.change(nodeInput, { target: { value: '35' } })
    expect(nodeInput.value).toBe('UNet Loader (#35)')
    expect(nodeInput.value).not.toBe('图像完美像素 (#3)5')

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith('$.35.inputs.unet_name')
    })
  })
})
