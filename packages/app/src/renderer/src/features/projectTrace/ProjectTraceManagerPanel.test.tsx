import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import {
  createProjectRecord,
  listProjects,
  saveProjects,
  updateProjectAnalysisDetails
} from '../../pages/MainPage/projectStore'
import ProjectTraceManagerPanel from './ProjectTraceManagerPanel'

const mocks = vi.hoisted(() => ({
  list: vi.fn(async () => ({ traces: [] })),
  profiles: vi.fn(async () => ({ profiles: [] })),
  chat: vi.fn(),
  notify: vi.fn()
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
  })
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcProjectTrace: { listProjectTraces: mocks.list },
    svcLLMProxy: { listProfiles: mocks.profiles, chat: mocks.chat }
  })
}))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: DEFAULT_CONFIG }) }))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: mocks.notify,
    notifyError: mocks.notify,
    notifyWarning: mocks.notify,
    notifyInfo: mocks.notify
  })
}))
vi.mock('./projectTraceProjectRef', () => ({
  resolveCanvasProjectTraceProjectRef: async (id: string) => ({ projectId: id })
}))
vi.mock('./ProjectOneShotPanel', () => ({
  default: ({ projectId }: { projectId: string }) => <div data-testid="once-panel">{projectId}</div>
}))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('project trace product entry', () => {
  it('opens the actual manual comparison entry without mounting legacy side effects', () => {
    saveProjects([createProjectRecord({ id: 'project-a', name: 'A', createdAt: 1 })])
    const close = vi.fn()
    render(<ProjectTraceManagerPanel projectId="project-a" compact onClose={close} />)
    expect(screen.getByTestId('once-panel').textContent).toBe('project-a')
    expect(screen.queryByText('Legacy trace records and realtime controls')).toBeNull()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.chat).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'general.close' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('preserves legacy controls only on explicit navigation and hides them after manual adoption', async () => {
    localStorage.setItem(
      'ai_engine_projects',
      JSON.stringify([{ id: 'project-old', name: 'Old', createdAt: 1 }])
    )
    render(<ProjectTraceManagerPanel projectId="project-old" />)
    expect(screen.getByTestId('once-panel')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Legacy trace records and realtime controls' })
    )
    await waitFor(() => expect(mocks.list).toHaveBeenCalled())
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(mocks.chat).not.toHaveBeenCalled()
    act(() => {
      updateProjectAnalysisDetails('project-old', {
        introduction: 'New intent',
        analysisProfileId: 'reference-only'
      })
    })
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1))
    expect(screen.getByRole('tab').getAttribute('aria-selected')).toBe('true')
    expect(listProjects()[0].analysisMode).toBe('manual')
    expect(mocks.chat).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Return to manual comparison' }))
    expect(screen.getByTestId('once-panel').textContent).toBe('project-old')
  })

  it('isolates project switches and handles an empty project registry', () => {
    const { rerender } = render(<ProjectTraceManagerPanel />)
    expect(screen.getByText('Create or select a project first.')).toBeTruthy()
    act(() => {
      saveProjects([
        createProjectRecord({ id: 'project-a', name: 'A', createdAt: 1 }),
        createProjectRecord({ id: 'project-b', name: 'B', createdAt: 2 })
      ])
    })
    expect(screen.getByTestId('once-panel').textContent).toBe('project-a')
    rerender(<ProjectTraceManagerPanel projectId="project-b" />)
    expect(screen.getByTestId('once-panel').textContent).toBe('project-b')
    expect(mocks.chat).not.toHaveBeenCalled()
  })
})
