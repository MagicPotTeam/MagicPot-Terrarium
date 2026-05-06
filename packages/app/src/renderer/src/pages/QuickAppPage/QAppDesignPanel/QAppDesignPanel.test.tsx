import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { describe, it, vi, expect, beforeEach } from 'vitest'
import { ThemeProvider } from '@mui/material'
import QAppDesignPanel from './QAppDesignPanel'
import { QAppContextProvider } from '../components/QAppContext'
import { theme } from '@renderer/theme'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import layoutSlice from '@renderer/store/slices/layoutSlice'
import comfyProcessSlice from '@renderer/store/slices/comfyProcess'
import comfyStatusSlice from '@renderer/store/slices/comfyStatus'
import projectConfigSlice from '@renderer/store/slices/projectConfigSlice'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import type { QAppCategory } from '@shared/qApp/category'

const createMockStore = () =>
  configureStore({
    reducer: {
      [layoutSlice.name]: layoutSlice.reducer,
      [comfyProcessSlice.name]: comfyProcessSlice.reducer,
      [comfyStatusSlice.name]: comfyStatusSlice.reducer,
      [projectConfigSlice.name]: projectConfigSlice.reducer
    }
  })

vi.mock(import('konva'), () => {
  return {}
})

vi.mock(import('react-konva'), () => {
  return {}
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: vi.fn(),
    useLocation: vi.fn(() => ({
      pathname: '/qappdesign',
      search: '',
      hash: '',
      key: 'test',
      state: null
    }))
  }
})

vi.mock('@renderer/store/hooks/comfyStatus', () => ({
  useComfyStatus: () => ({ state: { objectInfos: {} } })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {},
    buildEnv: {},
    configUtils: {
      comfySubDir: () => 'blueprints',
      getQAppDir: () => 'C:/fake/user-data/qApps',
      getBuiltinQAppDir: () => 'C:/fake/app-root/qApps'
    }
  })
}))

vi.mock('react-i18next', async () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      (
        ({
          'qapp.design.load_workflow': 'Load Workflow',
          'qapp.design.load_qapp_as_template': 'Load Quick App as Template',
          'qapp.design.set_custom_node_urls': 'Set Custom Node URLs',
          'qapp.design.set_auto_inputs': 'Configure Auto Inputs',
          'qapp.design.open_qapps_folder': 'Open qApps Folder',
          'qapp.design.edit_qapp_title': 'Edit Quick App',
          'qapp.design.edit_qapp_name': 'Quick app name',
          'qapp.design.save.category_label': 'Quick app category',
          'qapp.design.save.category_image': 'Image',
          'qapp.design.save.category_video': 'Video',
          'qapp.design.save.category_model3d': '3D',
          'qapp.design.save.category_inspection': 'Inspection',
          'project.delete_title': 'Confirm Delete',
          'qapp.design.delete_desc': 'Delete this quick app?',
          'project.cancel': 'Cancel',
          'project.save': 'Save',
          'project.delete_confirm': 'Delete'
        }) as Record<string, string>
      )[key] ??
      options?.defaultValue ??
      key
  })
}))

const workflowJson = JSON.stringify({ '1': { class_type: 'TestNode', inputs: {} } })
vi.mock('@renderer/components/LoadFileButton', () => ({
  __esModule: true,
  default: (props: { children: React.ReactNode; onLoad: (text: string) => void }) => (
    <button onClick={() => props.onLoad(workflowJson)}>{props.children}</button>
  )
}))

const qAppCfg = {
  inputs: [],
  autoInputs: [],
  customNodeUrls: [],
  outputNodeIds: []
}
const qwenQAppItem = {
  key: 'Qwen_多角度相机',
  name: 'Qwen_多角度相机',
  isBuiltin: false,
  isDirectory: false,
  category: 'image' as QAppCategory,
  manifest: {
    name: 'Qwen_多角度相机',
    version: '1.0.0',
    category: 'image' as QAppCategory
  }
}
const getQAppCfgMock = vi.fn(() => ({
  cfg: qAppCfg,
  workflow: JSON.parse(workflowJson),
  manifest: qwenQAppItem.manifest
}))
const listQAppCfgsMock = vi.fn(() => ({
  qApps: [qwenQAppItem]
}))
const deleteQAppCfgMock = vi.fn(() => ({}))
const saveQAppCfgMock = vi.fn(() => ({}))
const renameQAppCfgMock = vi.fn(() => ({}))
const openPathMock = vi.fn()
const navigateMock = vi.fn()
vi.mock('@renderer/pages/QuickAppPage/QAppDesignPanel/ButtonQAppLoad', () => ({
  __esModule: true,
  ButtonQAppLoad: (props: {
    children: React.ReactNode
    onLoaded: (key: string) => Promise<void>
  }) => <button onClick={async () => await props.onLoaded('test')}>{props.children}</button>
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcQApp: {
      getQAppCfg: getQAppCfgMock,
      listQAppCfgs: listQAppCfgsMock,
      deleteQAppCfg: deleteQAppCfgMock,
      saveQAppCfg: saveQAppCfgMock,
      renameQAppCfg: renameQAppCfgMock
    },
    svcShell: {
      openPath: openPathMock
    }
  })
}))

beforeEach(() => {
  navigateMock.mockClear()
  getQAppCfgMock.mockClear()
  listQAppCfgsMock.mockReset()
  deleteQAppCfgMock.mockReset()
  saveQAppCfgMock.mockReset()
  renameQAppCfgMock.mockReset()
  openPathMock.mockReset()
  listQAppCfgsMock.mockResolvedValue({
    qApps: [qwenQAppItem]
  })
  deleteQAppCfgMock.mockResolvedValue({})
  saveQAppCfgMock.mockResolvedValue({})
  renameQAppCfgMock.mockResolvedValue({})
  vi.mocked(useNavigate).mockReturnValue(navigateMock)
  vi.mocked(useLocation).mockReturnValue({
    pathname: '/qappdesign',
    search: '',
    hash: '',
    key: 'test',
    state: null
  } as ReturnType<typeof useLocation>)
})

describe('QAppDesignPanel', () => {
  it('should render', async () => {
    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <QAppDesignPanel />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    expect(await screen.findByText('Load Workflow')).toBeTruthy()
  })

  it('clicking load workflow shows the design panel form', async () => {
    const { default: Tested } = await import('./QAppDesignPanel')

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <Tested />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    const btn = await screen.findByText('Load Workflow')

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()

    const file = new File([workflowJson], 'test.json', { type: 'application/json' })
    if (!file.text) {
      file.text = async () => workflowJson
    }

    act(() => {
      fireEvent.click(btn)
    })

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [file],
        configurable: true
      })
      fireEvent.change(fileInput)
    })

    await waitFor(() => {
      expect(screen.getAllByText('Set Custom Node URLs').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Configure Auto Inputs').length).toBeGreaterThan(0)
    })
  })

  it('shows the design footer category selector and saves its value', async () => {
    const { default: Tested } = await import('./QAppDesignPanel')

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <Tested />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    const btn = await screen.findByText('Load Workflow')
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([workflowJson], 'test.json', { type: 'application/json' })
    if (!file.text) {
      file.text = async () => workflowJson
    }

    act(() => {
      fireEvent.click(btn)
    })

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [file],
        configurable: true
      })
      fireEvent.change(fileInput)
    })

    const categorySelect = await screen.findByLabelText('Quick app category')
    fireEvent.mouseDown(categorySelect)
    fireEvent.click(await screen.findByRole('option', { name: 'Video' }))

    fireEvent.click(screen.getByRole('button', { name: 'qapp.design.save.button' }))
    const nameInput = await screen.findByLabelText('qapp.design.save.label')
    fireEvent.change(nameInput, {
      target: { value: 'my-video-app' }
    })
    fireEvent.blur(nameInput)
    const saveButtons = screen.getAllByRole('button', { name: 'qapp.design.save.button' })
    fireEvent.click(saveButtons[saveButtons.length - 1])

    await waitFor(() => {
      expect(saveQAppCfgMock).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'my-video-app',
          manifest: {
            category: 'video'
          }
        })
      )
    })
  })

  it('clicking the bundled multi-angle camera entry loads the bundled qApp', async () => {
    const { default: Tested } = await import('./QAppDesignPanel')

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <Tested />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    const entry = await screen.findByText('Qwen 多角度相机')
    act(() => {
      fireEvent.click(entry)
    })

    await waitFor(() => {
      expect(getQAppCfgMock).toHaveBeenCalledWith({ key: 'Qwen_多角度相机' })
    })
  })

  it('clicking the quick app card body opens the quick app editor', async () => {
    const { default: Tested } = await import('./QAppDesignPanel')

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <Tested />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    const entry = await screen.findByText('Qwen 多角度相机')
    const card = entry.closest('.MuiCard-root') as HTMLElement
    expect(card).toBeTruthy()

    act(() => {
      fireEvent.click(card)
    })

    await waitFor(() => {
      expect(getQAppCfgMock).toHaveBeenCalledWith({ key: 'Qwen_多角度相机' })
      expect(screen.getAllByText('Set Custom Node URLs').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Configure Auto Inputs').length).toBeGreaterThan(0)
    })
  })

  it('auto-loads the multi-angle qApp when the route state provides a key', async () => {
    getQAppCfgMock.mockClear()
    const { default: Tested } = await import('./QAppDesignPanel')
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/qappdesign',
      search: '',
      hash: '',
      key: 'test',
      state: { loadQAppKey: 'Qwen_多角度相机' }
    } as never)

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <MemoryRouter
              initialEntries={[
                {
                  pathname: '/qappdesign',
                  state: { loadQAppKey: 'Qwen_多角度相机' }
                }
              ]}
            >
              <Tested />
            </MemoryRouter>
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    await waitFor(() => {
      expect(getQAppCfgMock).toHaveBeenCalledWith({ key: 'Qwen_多角度相机' })
    })
  })

  it('keeps the workflow import action before the bundled quick app cards', async () => {
    const { default: Tested } = await import('./QAppDesignPanel')

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <Tested />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    expect(screen.queryByText('Open App Builder')).toBeNull()
    const loadWorkflow = await screen.findByText('Load Workflow')
    const bundledApp = screen.getByText(/Qwen/)

    expect(
      loadWorkflow.compareDocumentPosition(bundledApp) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('opens the bundled qApps folder from the toolbar action', async () => {
    const { default: Tested } = await import('./QAppDesignPanel')

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <Tested />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    const openFolderButton = await screen.findByRole('button', { name: 'Open qApps Folder' })
    fireEvent.click(openFolderButton)

    expect(openPathMock).toHaveBeenCalledWith('C:/fake/app-root/qApps')
  })

  it('saves category changes from the quick app edit dialog', async () => {
    listQAppCfgsMock.mockResolvedValueOnce({ qApps: [qwenQAppItem] }).mockResolvedValueOnce({
      qApps: [
        {
          ...qwenQAppItem,
          key: 'video-app',
          name: 'video-app',
          category: 'video' as QAppCategory
        }
      ]
    })

    const { default: Tested } = await import('./QAppDesignPanel')

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <Tested />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    const entry = await screen.findByText('Qwen 多角度相机')
    const card = entry.closest('.MuiCard-root') as HTMLElement
    expect(card).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: 'Edit quick app' }))

    const dialog = await screen.findByRole('dialog', { name: 'Edit Quick App' })
    fireEvent.change(within(dialog).getByLabelText('Quick app name'), {
      target: { value: 'video-app' }
    })

    fireEvent.mouseDown(within(dialog).getByLabelText('Quick app category'))
    fireEvent.click(await screen.findByRole('option', { name: 'Video' }))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(renameQAppCfgMock).toHaveBeenCalledWith({
        key: 'Qwen_多角度相机',
        name: 'video-app'
      })
    })

    expect(saveQAppCfgMock).toHaveBeenCalledWith({
      key: 'video-app',
      cfg: qAppCfg,
      workflow: JSON.parse(workflowJson),
      manifest: {
        ...qwenQAppItem.manifest,
        name: 'video-app',
        category: 'video'
      }
    })
  })

  it('removes the card from the grid after deleting its qApp file', async () => {
    listQAppCfgsMock
      .mockResolvedValueOnce({ qApps: [qwenQAppItem] })
      .mockResolvedValueOnce({ qApps: [] })

    const { default: Tested } = await import('./QAppDesignPanel')

    render(
      <Provider store={createMockStore()}>
        <ThemeProvider theme={theme}>
          <QAppContextProvider>
            <Tested />
          </QAppContextProvider>
        </ThemeProvider>
      </Provider>
    )

    const entry = await screen.findByText('Qwen 多角度相机')
    const card = entry.closest('.MuiCard-root') as HTMLElement
    expect(card).toBeTruthy()

    fireEvent.click(within(card).getAllByRole('button')[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteQAppCfgMock).toHaveBeenCalledWith({ key: 'Qwen_多角度相机' })
      expect(screen.queryByText('Qwen 多角度相机')).toBeNull()
    })
  })
})
