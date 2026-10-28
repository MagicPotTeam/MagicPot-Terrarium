import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { ThemeProvider } from '@mui/material'
import MainPage from './MainPage'
import { theme } from '@renderer/theme'
import layoutSlice from '@renderer/store/slices/layoutSlice'
import { useNavigate } from 'react-router-dom'
import { PROJECT_CANVAS_ROUTE_PATH } from '../ProjectCanvasPage/projectCanvasRouting'
import {
  createProjectRecord,
  listProjects,
  saveProjects,
  updateProjectAnalysisDetails,
  PROJECTS_STORAGE_KEY
} from './projectStore'

const { listProfiles, chat, runTools } = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  chat: vi.fn(),
  runTools: vi.fn()
}))
const navigateMock = vi.fn()

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({ svcLLMProxy: { listProfiles, chat, runTools } })
}))
vi.mock('../ProjectCanvasPage/ProjectCanvasPage', () => ({ default: () => null }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; id?: string }) =>
      (
        ({
          'project.my': 'My Projects',
          'project.new': 'New Project',
          'project.delete_title': 'Delete Project',
          'project.delete_desc': 'Delete this project?',
          'project.delete_dont_ask': "Don't ask again",
          'project.cancel': 'Cancel',
          'project.delete_confirm': 'Delete'
        }) as Record<string, string>
      )[key] ??
      options?.defaultValue?.replace('{{id}}', options.id ?? '') ??
      key
  })
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: vi.fn() }
})

const renderPage = () => {
  const store = configureStore({ reducer: { [layoutSlice.name]: layoutSlice.reducer } })
  const view = render(
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <MainPage />
      </ThemeProvider>
    </Provider>
  )
  return { store, ...view }
}
const create = () => fireEvent.click(screen.getByRole('button', { name: 'New Project' }))
const expectNoModelWork = () => {
  expect(listProfiles).not.toHaveBeenCalled()
  expect(chat).not.toHaveBeenCalled()
  expect(runTools).not.toHaveBeenCalled()
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(useNavigate).mockReturnValue(navigateMock)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Latest product requirement: creation opens the canvas immediately. Introduction/model
// editing belongs to the project/trace panel, covered by ProjectDetailsDialog and
// ProjectOneShotPanel tests; it must not be forced back into the creation path.
describe('MainPage immediate project creation', () => {
  it('does not create a project or call a model merely by opening the home page', () => {
    const { store } = renderPage()
    expect(listProjects()).toEqual([])
    expect(store.getState().layout.openTabs).toEqual([])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(navigateMock).not.toHaveBeenCalled()
    expectNoModelWork()
  })

  it('creates and opens immediately without a details dialog, metadata lookup or generation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1711324800000)
    const { store } = renderPage()
    create()
    const [project] = listProjects()
    expect(project).toMatchObject({
      name: '1',
      introduction: '',
      analysisMode: 'manual',
      createdAt: 1711324800000
    })
    expect(project.id).toMatch(/^tab-project-/)
    expect(project.analysisProfileId).toBeUndefined()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-open-overlay')).not.toBeInTheDocument()
    expect(store.getState().layout.activeTabId).toBe(project.id)
    expect(store.getState().layout.openTabs).toEqual([
      {
        id: project.id,
        label: '1',
        routePath: `${PROJECT_CANVAS_ROUTE_PATH}?id=${project.id}`,
        closable: true
      }
    ])
    expect(navigateMock).toHaveBeenCalledExactlyOnceWith(
      `${PROJECT_CANVAS_ROUTE_PATH}?id=${project.id}`
    )
    expect(JSON.parse(localStorage.getItem('ai_engine_projects') ?? '[]')).toEqual([
      { id: project.id, name: '1', createdAt: 1711324800000 }
    ])
    expect(localStorage.getItem(PROJECTS_STORAGE_KEY)).not.toMatch(/api_key|base_url|access_token/)
    expectNoModelWork()
  })

  it('keeps existing projects and opens no tab on failed creation, then creates once on explicit retry', () => {
    const original = createProjectRecord({ id: 'existing', name: 'Existing', createdAt: 100 })
    saveProjects([original])
    const { store } = renderPage()
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY)
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private storage details')
    })
    create()
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to save project changes.')
    expect(document.body.textContent).not.toContain('private storage details')
    expect(localStorage.getItem(PROJECTS_STORAGE_KEY)).toBe(raw)
    expect(store.getState().layout.openTabs).toEqual([])
    expect(navigateMock).not.toHaveBeenCalled()
    writes.mockRestore()
    create()
    expect(listProjects()).toHaveLength(2)
    expect(listProjects().find((project) => project.id === original.id)).toEqual(original)
    expect(store.getState().layout.openTabs).toHaveLength(1)
    expectNoModelWork()
  })

  it('preserves separately configured introduction/model binding across reopening and inline rename', () => {
    const { unmount } = renderPage()
    create()
    const [created] = listProjects()
    act(() => {
      updateProjectAnalysisDetails(created.id, {
        introduction: 'First line\nSecond line',
        analysisProfileId: 'existing-api-profile'
      })
    })
    unmount()
    navigateMock.mockClear()
    const { store } = renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Renamed' }
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(listProjects()[0]).toMatchObject({
      id: created.id,
      name: 'Renamed',
      introduction: 'First line\nSecond line',
      analysisProfileId: 'existing-api-profile',
      analysisMode: 'manual',
      canvasStorageKey: created.canvasStorageKey,
      chatStorageScopePrefix: created.chatStorageScopePrefix
    })
    expect(store.getState().layout.openTabs).toEqual([])
    expect(navigateMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Renamed'))
    expect(store.getState().layout.activeTabId).toBe(created.id)
    expectNoModelWork()
  })

  it('cancels inline rename without changing saved metadata or opening a project', () => {
    const original = createProjectRecord({ id: 'rename-cancel', name: 'Original', createdAt: 100 })
    saveProjects([original])
    const { store } = renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Discard' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(listProjects()[0]).toEqual(original)
    expect(store.getState().layout.openTabs).toEqual([])
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('keeps saved name and tabs unchanged when inline rename cannot persist', () => {
    const original = createProjectRecord({ id: 'rename-failure', name: 'Original', createdAt: 100 })
    saveProjects([original])
    const { store } = renderPage()
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private-storage-detail')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not saved' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(screen.getByText('Original')).toBeInTheDocument()
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to save project changes.')
    expect(document.body.textContent).not.toContain('private-storage-detail')
    expect(localStorage.getItem(PROJECTS_STORAGE_KEY)).toBe(raw)
    expect(store.getState().layout.openTabs).toEqual([])
  })

  it('keeps deletion pending on persistence failure and succeeds on explicit retry', async () => {
    saveProjects([createProjectRecord({ id: 'delete-failure', name: 'Keep me', createdAt: 100 })])
    const { store } = renderPage()
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Project' }))
    fireEvent.click(screen.getByRole('checkbox'))
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private-storage-detail')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Keep me')).toBeInTheDocument()
    expect(document.body.textContent).toContain('Unable to save project changes.')
    expect(document.body.textContent).not.toContain('private-storage-detail')
    expect(localStorage.getItem(PROJECTS_STORAGE_KEY)).toBe(raw)
    expect(localStorage.getItem('confirmDeleteProject')).toBeNull()
    expect(store.getState().layout.openTabs).toEqual([])
    writes.mockRestore()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(listProjects()).toEqual([])
    expect(localStorage.getItem('confirmDeleteProject')).toBe('false')
  })

  it('leaves absent legacy optional fields absent after a name-only rename', () => {
    localStorage.setItem(
      'ai_engine_projects',
      JSON.stringify([{ id: 'legacy', name: 'Legacy', createdAt: 100 }])
    )
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Legacy renamed' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    const [project] = listProjects()
    expect(project.name).toBe('Legacy renamed')
    expect(project).not.toHaveProperty('analysisMode')
    expect(project).not.toHaveProperty('introduction')
    expect(project).not.toHaveProperty('analysisProfileId')
    expectNoModelWork()
  })

  it('uses distinct identities on successive clicks even when timestamps and random IDs coincide', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1711324800000)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000000'
    )
    renderPage()
    create()
    create()
    const projects = listProjects()
    expect(projects).toHaveLength(2)
    expect(new Set(projects.map((project) => project.id)).size).toBe(2)
    expect(projects.map((project) => project.name)).toEqual(['2', '1'])
    expectNoModelWork()
  })

  it.each(['Enter', ' '])('supports the %s keyboard action without a creation dialog', (key) => {
    renderPage()
    fireEvent.keyDown(screen.getByRole('button', { name: 'New Project' }), { key })
    expect(listProjects()).toHaveLength(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(navigateMock).toHaveBeenCalledTimes(1)
    expectNoModelWork()
  })

  it('rebases an inline rename on current storage and preserves a project added after render', () => {
    const original = createProjectRecord({ id: 'rename-current', name: 'Original', createdAt: 100 })
    saveProjects([original])
    renderPage()

    const external = createProjectRecord({
      id: 'external-added',
      name: 'Added elsewhere',
      createdAt: 200
    })
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        external,
        { ...original, introduction: 'Current intro', analysisProfileId: 'current-profile' }
      ])
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Renamed' }
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    expect(listProjects()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: original.id,
          name: 'Renamed',
          introduction: 'Current intro',
          analysisProfileId: 'current-profile'
        }),
        expect.objectContaining({ id: external.id, name: external.name })
      ])
    )
  })

  it('rebases deletion on current storage and preserves a project added after render', () => {
    const original = createProjectRecord({
      id: 'delete-current',
      name: 'Delete me',
      createdAt: 100
    })
    saveProjects([original])
    renderPage()

    const external = createProjectRecord({
      id: 'external-added',
      name: 'Added elsewhere',
      createdAt: 200
    })
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([external, original]))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(listProjects()).toEqual([
      expect.objectContaining({ id: external.id, name: external.name })
    ])
  })

  it('does not overwrite newer introduction and model metadata during a rebased rename', () => {
    const original = createProjectRecord({
      id: 'metadata-current',
      name: 'Original',
      createdAt: 100
    })
    saveProjects([original])
    renderPage()
    const current = {
      ...original,
      introduction: 'Newer introduction',
      analysisProfileId: 'newer-profile',
      updatedAt: 300
    }
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([current]))

    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Renamed' }
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    expect(listProjects()[0]).toMatchObject({
      id: original.id,
      name: 'Renamed',
      introduction: 'Newer introduction',
      analysisProfileId: 'newer-profile'
    })
  })
  it('opens an existing project immediately without losing its configuration or calling a model', () => {
    saveProjects([
      createProjectRecord({
        id: 'tab-project-42',
        name: 'Project 42',
        createdAt: 1711324800000,
        introduction: 'Preserve this',
        analysisProfileId: 'missing-but-preserved-profile'
      })
    ])
    const { store } = renderPage()
    fireEvent.click(screen.getByText('Project 42'))
    expect(screen.queryByTestId('project-open-overlay')).not.toBeInTheDocument()
    expect(store.getState().layout.activeTabId).toBe('tab-project-42')
    expect(navigateMock).toHaveBeenCalledWith(`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`)
    expect(listProjects()[0]).toMatchObject({
      introduction: 'Preserve this',
      analysisProfileId: 'missing-but-preserved-profile'
    })
    expectNoModelWork()
  })
})
