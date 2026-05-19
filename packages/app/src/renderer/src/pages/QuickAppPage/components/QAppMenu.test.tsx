import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import QAppMenu, { QAppCategory } from './QAppMenu'

const setCurrentQAppKeyMock = vi.fn()
const navigateMock = vi.fn()
const listQAppCfgsMock = vi.fn()
const deleteQAppMock = vi.fn(() => Promise.resolve({ success: true }))
const { mockLayoutState } = vi.hoisted(() => ({
  mockLayoutState: {
    openTabs: [] as unknown[],
    activeTabId: undefined as string | undefined
  }
}))

const alphaItem = {
  key: 'alpha',
  name: 'alpha',
  isBuiltin: false,
  isDirectory: false
} as const

const defaultQApps = [
  alphaItem,
  {
    key: 'Wan2_2_T2V',
    name: 'Wan2_2_T2V',
    isBuiltin: false,
    isDirectory: false
  },
  {
    key: 'Wan2_2_I2V',
    name: 'Wan2_2_I2V',
    isBuiltin: false,
    isDirectory: false
  },
  {
    key: 'GenericVideoBoundaryFrames',
    name: 'GenericVideoBoundaryFrames',
    isBuiltin: false,
    isDirectory: false
  }
]

const explicitVideoCategoryQApps = [
  {
    key: 'custom-neutral-name',
    name: 'custom-neutral-name',
    category: 'video',
    isBuiltin: false,
    isDirectory: false
  }
]

const nestedQApps = [
  {
    key: 'Qwen',
    name: 'Qwen',
    isBuiltin: false,
    isDirectory: true,
    children: [alphaItem]
  }
]

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: vi.fn(),
    notifySuccess: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {},
    buildEnv: {
      env: {
        packageVersion: '1.0.101'
      }
    }
  })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      layout: mockLayoutState
    })
}))

vi.mock('@renderer/hooks/useComfyEvent', () => ({
  useComfyEventCallback: () => undefined
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcQApp: {
      listQAppCfgs: listQAppCfgsMock,
      getQAppCfg: vi.fn(),
      saveQAppCfg: vi.fn(),
      deleteQApp: deleteQAppMock,
      renameQAppCfg: vi.fn()
    }
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'workspace.hunyuan_hint_title': 'Hunyuan3D lives in Quick Apps',
          'workspace.hunyuan_hint':
            'Select Hunyuan3D from the right-side Quick Apps list. Its Tencent Cloud credentials are configured in Settings > Quick App API.',
          'qapp.names.hunyuan3d_quick_app': 'Hunyuan3D'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

const renderMenu = (activeCategory: QAppCategory) =>
  render(
    <ThemeProvider theme={theme}>
      <QAppMenu
        currentQAppKey=""
        setCurrentQAppKey={setCurrentQAppKeyMock}
        activeCategory={activeCategory}
      />
    </ThemeProvider>
  )

const renderInlineMenu = () =>
  render(
    <ThemeProvider theme={theme}>
      <QAppMenu
        currentQAppKey="alpha"
        setCurrentQAppKey={setCurrentQAppKeyMock}
        activeCategory="image"
        renderExpandedContent={() => <button type="button">expanded control</button>}
      />
    </ThemeProvider>
  )

const renderNestedInlineMenu = () =>
  render(
    <ThemeProvider theme={theme}>
      <QAppMenu
        currentQAppKey="alpha"
        setCurrentQAppKey={setCurrentQAppKeyMock}
        activeCategory="image"
        renderExpandedContent={() => <button type="button">expanded control</button>}
      />
    </ThemeProvider>
  )

const renderInlineDropMenu = () =>
  render(
    <ThemeProvider theme={theme}>
      <QAppMenu
        currentQAppKey="alpha"
        setCurrentQAppKey={setCurrentQAppKeyMock}
        activeCategory="image"
        renderExpandedContent={() => (
          <div
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            drop child
          </div>
        )}
      />
    </ThemeProvider>
  )

const renderRunnableMenu = (isRunning: boolean, onRunClick = vi.fn()) => ({
  onRunClick,
  ...render(
    <ThemeProvider theme={theme}>
      <QAppMenu
        currentQAppKey="alpha"
        setCurrentQAppKey={setCurrentQAppKeyMock}
        activeCategory="image"
        onRunClick={onRunClick}
        isRunning={isRunning}
      />
    </ThemeProvider>
  )
})

beforeEach(() => {
  setCurrentQAppKeyMock.mockClear()
  navigateMock.mockClear()
  listQAppCfgsMock.mockReset()
  deleteQAppMock.mockReset()
  mockLayoutState.openTabs = []
  mockLayoutState.activeTabId = undefined
  localStorage.clear()
  listQAppCfgsMock.mockResolvedValue({
    qApps: defaultQApps
  })
  deleteQAppMock.mockResolvedValue({ success: true })
})

describe('QAppMenu', () => {
  it('renders cached quick apps immediately while a fresh list is loading', async () => {
    const pendingRefresh = createDeferred<{ qApps: typeof defaultQApps }>()
    listQAppCfgsMock.mockReturnValueOnce(pendingRefresh.promise)
    localStorage.setItem('qapp.menu.cachedItems.v1', JSON.stringify(defaultQApps))

    renderMenu('image')

    expect(screen.getByText('alpha')).toBeTruthy()

    await act(async () => {
      pendingRefresh.resolve({ qApps: defaultQApps })
      await Promise.resolve()
    })

    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('defaults project quick apps to all selected when the project has no saved selection', async () => {
    mockLayoutState.activeTabId = 'tab-project-1'

    renderMenu('image')

    expect(await screen.findByText('alpha')).toBeTruthy()
    expect(localStorage.getItem('qapp.selected.tab-project-1')).toBeNull()
  })

  it('surfaces the built-in Hunyuan3D quick app for the 3D category', async () => {
    renderMenu('model3d')

    const hunyuanButton = await screen.findByRole('button', { name: 'Hunyuan3D' })
    expect(hunyuanButton).toBeTruthy()

    fireEvent.click(hunyuanButton)

    expect(await screen.findByText('概念设计')).toBeTruthy()
    expect(await screen.findByText('格式转换')).toBeTruthy()
  })

  it('uses explicit quick app categories instead of falling back to name heuristics', async () => {
    listQAppCfgsMock.mockResolvedValueOnce({ qApps: explicitVideoCategoryQApps })

    renderMenu('video')

    expect(await screen.findByText('custom-neutral-name')).toBeTruthy()
  })

  it('keeps a deleted quick app removed when an older refresh resolves later', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const staleRefresh = createDeferred<{ qApps: typeof defaultQApps }>()

    listQAppCfgsMock
      .mockResolvedValueOnce({ qApps: defaultQApps })
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce({ qApps: defaultQApps.filter((item) => item.key !== alphaItem.key) })

    renderMenu('image')

    expect(await screen.findByText('alpha')).toBeTruthy()

    fireEvent.contextMenu(screen.getByText('alpha'))
    const deleteMenuItem = await screen.findByText('qapp.menu.delete')

    act(() => {
      window.dispatchEvent(new Event('qapp:refresh-list'))
    })
    await waitFor(() => {
      expect(listQAppCfgsMock).toHaveBeenCalledTimes(2)
    })

    fireEvent.click(deleteMenuItem)

    await waitFor(() => {
      expect(deleteQAppMock).toHaveBeenCalledWith({ key: 'alpha' })
      expect(listQAppCfgsMock).toHaveBeenCalledTimes(3)
      expect(screen.queryByText('alpha')).toBeNull()
    })

    await act(async () => {
      staleRefresh.resolve({ qApps: defaultQApps })
      await Promise.resolve()
    })

    expect(screen.queryByText('alpha')).toBeNull()

    confirmSpy.mockRestore()
  })

  it('allows collapsing the selected inline quick app from its row', async () => {
    renderInlineMenu()

    const alphaButton = (await screen.findAllByRole('button', { name: 'alpha' }))[0]

    setCurrentQAppKeyMock.mockClear()

    fireEvent.click(alphaButton)

    expect(setCurrentQAppKeyMock).toHaveBeenCalledWith('')
  })

  it('keeps the parent directory expanded when interacting with nested inline controls', async () => {
    listQAppCfgsMock.mockResolvedValueOnce({ qApps: nestedQApps })

    renderNestedInlineMenu()

    expect(await screen.findByText('Qwen')).toBeTruthy()
    const expandedControl = await screen.findByRole('button', { name: 'expanded control' })

    fireEvent.click(expandedControl)

    expect(screen.getByText('Qwen')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'expanded control' })).toBeTruthy()
  })

  it('clears the menu drag highlight when a nested drop target handles the drop', async () => {
    renderInlineDropMenu()

    const dropChild = await screen.findByText('drop child')
    const menuRoot = dropChild.closest('[data-dragging-over]')

    expect(menuRoot).toBeTruthy()
    expect(menuRoot).toHaveAttribute('data-dragging-over', 'false')

    fireEvent.dragOver(dropChild, {
      dataTransfer: {
        files: [],
        getData: () => ''
      }
    })

    expect(menuRoot).toHaveAttribute('data-dragging-over', 'true')

    fireEvent.drop(dropChild, {
      dataTransfer: {
        files: [],
        getData: () => ''
      }
    })

    expect(menuRoot).toHaveAttribute('data-dragging-over', 'false')
  })

  it('keeps the normal quick app run button as a run action while running', async () => {
    const { onRunClick } = renderRunnableMenu(true)

    const playIcon = await screen.findByTestId('PlayArrowIcon')
    const runButton = playIcon.closest('button')

    expect(runButton).toBeTruthy()

    fireEvent.click(runButton!)

    expect(onRunClick).toHaveBeenCalledWith('alpha')
  })

  it('restores the matching Hunyuan3D quick app and parameters from an internal 3d drag', async () => {
    const paramsEvents: Array<{ apiAction?: string; texturePrompt?: string; modelUrl?: string }> =
      []
    const mediaEvents: Array<{ textureRefImages?: Array<{ url?: string }> }> = []
    const switchEvents: Array<{ qAppKey?: string }> = []
    const handleParamsUpdated = (event: Event) => {
      paramsEvents.push(
        ((
          event as CustomEvent<{
            params?: { apiAction?: string; texturePrompt?: string; modelUrl?: string }
          }>
        ).detail?.params || {}) as {
          apiAction?: string
          texturePrompt?: string
          modelUrl?: string
        }
      )
    }
    const handleMediaStateUpdated = (event: Event) => {
      mediaEvents.push(
        ((event as CustomEvent<{ mediaState?: { textureRefImages?: Array<{ url?: string }> } }>)
          .detail?.mediaState || {}) as {
          textureRefImages?: Array<{ url?: string }>
        }
      )
    }
    const handleQAppSwitch = (event: Event) => {
      switchEvents.push(
        ((event as CustomEvent<{ qAppKey?: string }>).detail || {}) as { qAppKey?: string }
      )
    }

    window.addEventListener('hy3d:params-updated', handleParamsUpdated)
    window.addEventListener('hy3d:media-state-updated', handleMediaStateUpdated)
    window.addEventListener('qapp:switch', handleQAppSwitch)

    try {
      renderMenu('image')

      const alphaButton = await screen.findByText('alpha')
      const menuRoot = alphaButton.closest('[data-dragging-over]') as HTMLElement | null
      expect(menuRoot).toBeTruthy()
      vi.useFakeTimers()

      fireEvent.drop(menuRoot as HTMLElement, {
        dataTransfer: {
          files: [],
          getData: (type: string) =>
            type === QAPP_IMAGE_DRAG_MIME
              ? JSON.stringify({
                  objectUrl: 'blob:model3d-card',
                  itemTypes: ['model3d'],
                  hy3dQuickAppKey: '~builtin/hunyuan3d/texture',
                  hy3dParams: {
                    apiAction: 'SubmitTextureTo3DJob',
                    modelUrl: 'https://example.com/source-model.glb',
                    texturePrompt: 'aged bronze'
                  },
                  hy3dMediaState: {
                    conceptImages: [],
                    textureRefImages: [
                      {
                        type: 'image',
                        url: 'https://example.com/texture-ref.png'
                      }
                    ],
                    profileRefImage: null
                  }
                })
              : ''
        }
      })

      await vi.advanceTimersByTimeAsync(300)

      expect(setCurrentQAppKeyMock).toHaveBeenCalledWith('~builtin/hunyuan3d/texture')
      expect(switchEvents).toEqual([{ qAppKey: '~builtin/hunyuan3d/texture' }])
      expect(paramsEvents).toHaveLength(1)
      expect(paramsEvents[0]).toMatchObject({
        apiAction: 'SubmitTextureTo3DJob',
        texturePrompt: 'aged bronze',
        modelUrl: 'https://example.com/source-model.glb'
      })
      expect(mediaEvents[0]?.textureRefImages?.[0]?.url).toBe('https://example.com/texture-ref.png')
    } finally {
      vi.useRealTimers()
      window.removeEventListener('hy3d:params-updated', handleParamsUpdated)
      window.removeEventListener('hy3d:media-state-updated', handleMediaStateUpdated)
      window.removeEventListener('qapp:switch', handleQAppSwitch)
    }
  })
})
