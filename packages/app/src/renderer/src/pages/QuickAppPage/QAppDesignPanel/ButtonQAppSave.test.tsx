import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import { ButtonQAppSave } from './ButtonQAppSave'

const clearCachedQAppStateMock = vi.fn()
const saveQAppCfgMock = vi.fn()
const getQAppCfgMock = vi.fn()
const notifyErrorMock = vi.fn()
const notifyInfoMock = vi.fn()
const qAppCfg = {
  inputs: [],
  autoInputs: [],
  customNodeUrls: [],
  outputNodeIds: []
}
const workflow = {
  node1: {
    class_type: 'TestNode',
    inputs: {}
  }
}
const qAppContextValue = {
  qAppCfg,
  workflow,
  currentQAppKey: 'existing-qapp'
}

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material')
  return {
    ...actual,
    Select: ({
      children,
      value,
      onChange,
      ...props
    }: {
      children: React.ReactNode
      value: string
      onChange: (event: { target: { value: string } }) => void
    }) => (
      <select
        aria-label="qapp-category-select"
        value={value}
        onChange={(event) => onChange({ target: { value: event.target.value } })}
        {...props}
      >
        {children}
      </select>
    ),
    MenuItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
      <option value={value}>{children}</option>
    )
  }
})

vi.mock('../components/QAppContext', () => ({
  clearCachedQAppState: (...args: unknown[]) => clearCachedQAppStateMock(...args),
  useQAppContext: () => qAppContextValue
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: notifyErrorMock,
    notifyInfo: notifyInfoMock
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcQApp: {
      getQAppCfg: getQAppCfgMock,
      saveQAppCfg: saveQAppCfgMock
    }
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key
  })
}))

vi.mock('@renderer/components/ModalLayout', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null
}))

vi.mock('@renderer/components/inputs/InputText', () => ({
  __esModule: true,
  default: ({
    label,
    value,
    onChange
  }: {
    label: string
    value: string
    onChange: (value: string) => void
  }) => (
    <label>
      {label}
      <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}))

describe('ButtonQAppSave', () => {
  beforeEach(() => {
    clearCachedQAppStateMock.mockReset()
    saveQAppCfgMock.mockReset()
    getQAppCfgMock.mockReset()
    notifyErrorMock.mockReset()
    notifyInfoMock.mockReset()
    getQAppCfgMock.mockResolvedValue({
      cfg: qAppCfg,
      workflow,
      manifest: {
        name: 'existing-qapp',
        version: '1.0.0',
        category: 'image'
      }
    })
    saveQAppCfgMock.mockResolvedValue({})
  })

  it('submits the user-selected category when saving', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ButtonQAppSave />
      </ThemeProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'qapp.design.save.button' }))

    await waitFor(() => {
      expect(getQAppCfgMock).toHaveBeenCalledWith({ key: 'existing-qapp' })
    })

    await waitFor(() => {
      expect(screen.getByLabelText('qapp-category-select')).toHaveValue('image')
    })

    fireEvent.change(screen.getByLabelText('qapp.design.save.label'), {
      target: { value: 'my-video-app' }
    })

    fireEvent.change(screen.getByLabelText('qapp-category-select'), {
      target: { value: 'video' }
    })

    fireEvent.click(screen.getAllByRole('button', { name: 'qapp.design.save.button' })[1])

    await waitFor(() => {
      expect(saveQAppCfgMock).toHaveBeenCalledWith({
        key: 'my-video-app',
        cfg: qAppCfg,
        workflow,
        manifest: {
          category: 'video'
        }
      })
    })

    expect(clearCachedQAppStateMock).toHaveBeenCalledWith('my-video-app')
    expect(notifyInfoMock).toHaveBeenCalledWith('qapp.design.save.success')
    expect(notifyErrorMock).not.toHaveBeenCalled()
  })
})
