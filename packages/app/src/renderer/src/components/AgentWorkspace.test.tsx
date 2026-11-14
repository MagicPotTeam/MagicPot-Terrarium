import React from 'react'
import { createPortal } from 'react-dom'
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentWorkspace from './AgentWorkspace'
import AgentThreadSubRow from './AgentThreadSubRow'
import { forgetPaneTitles } from './agentPaneTitleMemory'
import zhRenderer from '@shared/locales/zh-CN/renderer.json'
import enRenderer from '@shared/locales/en-US/renderer.json'
import {
  clearScopedActiveLoadingSessionIds,
  clearScopedChatPageRunLifecycles,
  clearScopedExternalLoadingSessionIds,
  dispatchScopedChatRunEvent,
  readScopedChatRun,
  scopedStorageKey,
  startScopedChatRun,
  STORAGE_KEY_EXTERNAL_LOADING_IDS,
  updateScopedExternalLoadingSessionId
} from '@renderer/pages/ChatPage/chatPageShared'
import { PROJECT_TRACE_CAPTURE_STATE_EVENT } from '@renderer/features/projectTrace/projectTraceRuntime'

const chatPageUnmountMock = vi.fn()
/** Sub-rows the mocked chat page of a scope renders into its thread-list host (as ChatPage does). */
const mockSubRowLabels: { current: Record<string, string[]> } = { current: {} }
const chatPageMock = vi.fn((props?: unknown) => {
  const typedProps = props as {
    active?: boolean
    storageScope?: string
    threadSubRowsHost?: HTMLElement | null
  }
  const subRowLabels = mockSubRowLabels.current[typedProps.storageScope ?? ''] ?? []

  React.useEffect(
    () => () => {
      chatPageUnmountMock(typedProps.storageScope)
    },
    [typedProps.storageScope]
  )

  return (
    <div
      data-testid="mock-chat-page"
      data-active={String(typedProps.active ?? true)}
      data-storage-scope={typedProps.storageScope}
    >
      <div data-chat-scroll-container="true" data-testid="mock-conversation-scroll">
        <span data-testid="mock-message-content">mock message</span>
      </div>
      <div data-testid="mock-composer">
        <textarea data-testid="mock-composer-input" />
      </div>
      {typedProps.threadSubRowsHost &&
        createPortal(
          subRowLabels.map((label, index) => (
            <AgentThreadSubRow key={label} label={label} selected={index === 0} onSelect={() => {}} />
          )),
          typedProps.threadSubRowsHost
        )}
    </div>
  )
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.new_conversation') return '新对话'
      if (key === 'agent_workspace.threads_none_selected') {
        return `agent_workspace.threads_none_selected:${String(options?.count ?? '')}`
      }
      if (key === 'agent_workspace.chat_label') {
        return zhRenderer.agent_workspace.chat_label.replace('{{index}}', String(options?.index))
      }
      if (key === 'agent_workspace.trace_recording') {
        return zhRenderer.agent_workspace.trace_recording
      }
      return key
    },
    i18n: {
      resolvedLanguage: 'zh-CN'
    }
  })
}))

vi.mock('@renderer/pages/ChatPage/ChatPage', () => ({
  default: (props: unknown) => chatPageMock(props)
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: vi.fn(),
    notifyInfo: vi.fn(),
    notifySuccess: vi.fn(),
    notifyWarning: vi.fn(),
    closeMessage: vi.fn()
  })
}))

vi.mock('@renderer/features/projectTrace/projectTraceCapture', () => ({
  finalizeActiveProjectTraceCapture: vi.fn()
}))

vi.mock('@renderer/features/projectTrace/ProjectTraceManagerPanel', () => ({
  default: (props: { projectId?: string; projectName?: string }) => (
    <div
      data-testid="mock-trace-panel"
      data-project-id={props.projectId}
      data-project-name={props.projectName}
    >
      mock trace panel
    </div>
  )
}))

const loadAllSessionsMock = vi.fn()

vi.mock('@renderer/pages/ChatPage/chatStorage', () => ({
  loadAllSessions: (...args: unknown[]) => loadAllSessionsMock(...args)
}))

const THREAD_LIST_STATE_KEY = 'agent.workspace.threadsCollapsed.project-1'
const CURRENT_SESSION_KEY = 'chat.currentSessionId.project-1.agent-1'
const testTheme = createTheme()

const renderWorkspace = (projectName?: string) =>
  render(
    <ThemeProvider theme={testTheme}>
      <AgentWorkspace projectId="project-1" projectName={projectName} />
    </ThemeProvider>
  )

/** The thread list starts collapsed; this renders with the person's stored "expanded" choice. */
const renderWorkspaceWithThreadList = () => {
  localStorage.setItem(THREAD_LIST_STATE_KEY, '0')
  return renderWorkspace()
}

const storePanes = (count: number) =>
  localStorage.setItem(
    'agent.workspace.project-1',
    JSON.stringify(
      Array.from({ length: count }, (_, index) => ({ id: `agent-${index + 1}`, enabled: true }))
    )
  )

const getThreadRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-agent-thread-row]')
]

type WorkspaceMenuProps = {
  traceRecording: boolean
  onToggleTrace: () => void
  onOpenCanvasTarget: () => void
}

/** The "+" menu actions the workspace handed to the most recently rendered ChatPage. */
const latestWorkspaceMenu = (): WorkspaceMenuProps =>
  (chatPageMock.mock.calls.at(-1)?.[0] as { workspaceMenu: WorkspaceMenuProps }).workspaceMenu

const waitForThreadSummary = (title: string) =>
  waitFor(() => expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(title))

/** A row with nothing to report: muted dot named "idle", regular title, no unread marker. */
const expectIdleRegularRow = (row: HTMLElement) => {
  const status = within(row).getByTestId('agent-thread-status')
  expect(status).toHaveAttribute('data-status', 'idle')
  expect(status).toHaveAttribute('aria-label', 'agent_workspace.status_idle')
  expect(status).toHaveAttribute('role', 'img')
  expect(getComputedStyle(within(row).getByTestId('agent-thread-title')).fontWeight).toBe('400')
  expect(row.querySelector('[data-status="unread"]')).toBeNull()
}

/** Normalizes a CSS colour the way jsdom reports computed colours. */
const cssColor = (value: string): string => {
  const probe = document.createElement('span')
  probe.style.backgroundColor = value
  return probe.style.backgroundColor
}

describe('AgentWorkspace', () => {
  beforeEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    clearScopedActiveLoadingSessionIds()
    clearScopedExternalLoadingSessionIds()
    clearScopedChatPageRunLifecycles()
    forgetPaneTitles()
    mockSubRowLabels.current = {}
    chatPageMock.mockClear()
    chatPageUnmountMock.mockClear()
    loadAllSessionsMock.mockReset()
    loadAllSessionsMock.mockResolvedValue([
      {
        id: 'session-1',
        title: '画布检查',
        messages: [
          {
            role: 'user',
            content: '画布执行已开始。'
          }
        ]
      }
    ])
  })

  it('keeps the workspace heading on one line in a header that holds only the title and subtitle', () => {
    renderWorkspace('海报项目')
    const heading = screen.getByText('agent_workspace.title')
    expect(getComputedStyle(heading).whiteSpace).toBe('nowrap')
    expect(getComputedStyle(heading).textOverflow).toBe('ellipsis')
    // No skills button host, no buttons, nothing but the two text lines.
    expect(document.getElementById('agent-workspace-skill-portal')).toBeNull()
    const header = heading.parentElement!.parentElement!
    expect(header.querySelector('button, [role="button"]')).toBeNull()
    expect(header.children).toHaveLength(1)
    expect(header).toHaveTextContent(/^agent_workspace\.title海报项目$/)
  })

  it('keeps trace and canvas target out of the header and hands them to the conversation menu', async () => {
    expect(zhRenderer.agent_workspace.canvas_target).toBe('画布目标')
    expect(enRenderer.agent_workspace.canvas_target).toBe('Canvas target')
    expect(zhRenderer.agent_workspace.trace_start).toBe('开始追踪')
    expect(enRenderer.agent_workspace.trace_start).toBe('Start trace')
    expect(zhRenderer.agent_workspace.trace_stop).toBe('停止追踪')
    expect(enRenderer.agent_workspace.trace_stop).toBe('Stop trace')
    expect(zhRenderer.agent_workspace.check).toBe('目标')
    expect(enRenderer.agent_workspace.check).toBe('Target')
    const listener = vi.fn()
    window.addEventListener('canvas:run-target-request', listener)
    try {
      renderWorkspace()
      const header = screen.getByText('agent_workspace.title').closest('div')!.parentElement!
      expect(header.querySelector('button')).toBeNull()
      expect(screen.queryByTestId('agent-workspace-trace-button')).not.toBeInTheDocument()

      const menu = latestWorkspaceMenu()
      expect(menu.traceRecording).toBe(false)
      act(() => menu.onOpenCanvasTarget())
      expect(listener).toHaveBeenCalledTimes(1)
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ canvasId: 'project-1' })
      await waitFor(() => expect(loadAllSessionsMock).toHaveBeenCalled())
    } finally {
      window.removeEventListener('canvas:run-target-request', listener)
    }
  })

  it('mounts ChatPage immediately with the workspace shell', async () => {
    renderWorkspace()

    expect(chatPageMock).toHaveBeenCalled()
    expect(screen.queryByTestId('agent-workspace-pane-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('mock-chat-page')).toHaveAttribute(
      'data-storage-scope',
      'project-1.agent-1'
    )

    await waitFor(() => {
      expect(loadAllSessionsMock).toHaveBeenCalledWith('project-1.agent-1')
    })
    // The thread is named after its conversation, never after the latest message.
    await waitForThreadSummary('画布检查')
    expect(screen.queryByText('画布执行已开始。')).not.toBeInTheDocument()
  })

  it('shows a visible status dot and the title in a thread row, with no per-row close control', async () => {
    renderWorkspaceWithThreadList()
    await waitForThreadSummary('画布检查')
    const row = document.querySelector('[data-agent-workspace-scope="project-1.agent-1"][role="button"]')
    expect(row).not.toBeNull()
    expect(row?.querySelector('[aria-label="agent_workspace.close_thread"]')).toBeNull()
    expect(row?.querySelector('[data-testid="CloseIcon"]')).toBeNull()
    expect(row?.textContent).toBe('画布检查')
    expect(row?.textContent).not.toContain('最新提问')
    const status = screen.getByTestId('agent-thread-status')
    expect(row).toContainElement(status)
    expect(getComputedStyle(status).width).toBe('7px')
    expect(getComputedStyle(status).height).toBe('7px')
    expect(getComputedStyle(status).borderRadius).toBe('50%')
    expect(getComputedStyle(status).backgroundColor).toBe(
      cssColor(testTheme.palette.text.secondary)
    )
    expect(status).toHaveAttribute('data-status', 'idle')
    expect(status).toHaveAttribute('aria-label', 'agent_workspace.status_idle')
  })

  it('shows the running indicator when an external loading session is active', async () => {
    updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', true)

    renderWorkspaceWithThreadList()

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument()
    })
    const status = screen.getByRole('progressbar')
    expect(status).toHaveAttribute('data-testid', 'agent-thread-status')
    expect(status).toHaveAttribute('data-status', 'running')
    expect(status).toHaveAttribute('aria-label', 'agent_workspace.status_running')
    expect(getComputedStyle(status).backgroundColor).toBe(cssColor(testTheme.palette.success.main))
  })

  it('clears the running indicator immediately while the completion preview refresh is deferred', async () => {
    updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', true)
    renderWorkspaceWithThreadList()
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument())

    let resolvePreview: ((sessions: unknown[]) => void) | undefined
    loadAllSessionsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve
        })
    )

    act(() => {
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: 'project-1.agent-1' }
        })
      )
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', false)
    })

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('agent-thread-status')).toHaveAttribute('data-status', 'idle')

    await act(async () => {
      resolvePreview?.([])
      await Promise.resolve()
    })
  })

  it('leaves the active thread regular weight and idle after its reply finishes', async () => {
    const { container } = renderWorkspaceWithThreadList()
    await waitForThreadSummary('画布检查')
    const row = container.querySelector(
      '[data-agent-workspace-scope="project-1.agent-1"][role="button"]'
    ) as HTMLElement

    // A reply reported through the loading state (canvas runs).
    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', true)
    })
    await waitFor(() => expect(within(row).getByRole('progressbar')).toBeInTheDocument())
    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', false)
    })
    await waitFor(() => expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument())
    expectIdleRegularRow(row)

    // A reply reported through the run lifecycle, which still records the run as not yet read.
    act(() => {
      startScopedChatRun('project-1.agent-1', 'session-1', 'run-active')
    })
    await waitFor(() => expect(within(row).getByRole('progressbar')).toBeInTheDocument())
    act(() => {
      dispatchScopedChatRunEvent('project-1.agent-1', 'session-1', {
        runId: 'run-active',
        status: 'completed'
      })
    })
    await waitFor(() => expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument())
    expect(readScopedChatRun('project-1.agent-1', 'session-1').unread).toBe(true)
    expectIdleRegularRow(row)
    expect(within(row).getByTestId('agent-thread-status')).toHaveAttribute(
      'data-run-status',
      'completed'
    )

    // Reading the conversation changes nothing either: there is no unread state to clear.
    fireEvent.pointerDown(screen.getByTestId('mock-message-content'))
    fireEvent.scroll(screen.getByTestId('mock-conversation-scroll'))
    expectIdleRegularRow(row)
  })

  it('leaves a background thread regular weight and idle after its reply finishes', async () => {
    storePanes(2)
    loadAllSessionsMock.mockImplementation((scope: string) =>
      Promise.resolve([
        {
          id: `${scope}-session`,
          title: scope,
          messages: [{ role: 'assistant', content: scope }]
        }
      ])
    )

    const { container } = renderWorkspaceWithThreadList()
    const secondRow = await waitFor(() => {
      const row = container.querySelector(
        '[data-agent-workspace-scope="project-1.agent-2"][role="button"]'
      )
      expect(row?.querySelector('[data-status="idle"]')).not.toBeNull()
      return row as HTMLElement
    })
    expect(secondRow).not.toHaveAttribute('aria-current')

    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-2', 'run-2', true)
      updateScopedExternalLoadingSessionId('project-1.agent-2', 'run-2', false)
    })
    expectIdleRegularRow(secondRow)

    act(() => {
      startScopedChatRun('project-1.agent-2', 'project-1.agent-2-session', 'run-background')
    })
    await waitFor(() => expect(within(secondRow).getByRole('progressbar')).toBeInTheDocument())
    act(() => {
      dispatchScopedChatRunEvent('project-1.agent-2', 'project-1.agent-2-session', {
        runId: 'run-background',
        status: 'completed'
      })
    })
    await waitFor(() =>
      expect(within(secondRow).queryByRole('progressbar')).not.toBeInTheDocument()
    )
    expectIdleRegularRow(secondRow)
    // A later full refresh of the previews keeps it that way.
    act(() => {
      window.dispatchEvent(new CustomEvent('chat:preview-refresh'))
    })
    await waitFor(() => expect(loadAllSessionsMock.mock.calls.length).toBeGreaterThan(2))
    expectIdleRegularRow(secondRow)

    // Opening the thread afterwards is an ordinary selection.
    fireEvent.click(secondRow)
    expect(localStorage.getItem('agent.workspace.active.project-1')).toBe('agent-2')
    expect(secondRow).toHaveAttribute('aria-current', 'true')
    expectIdleRegularRow(secondRow)
    expect(container.querySelector('[data-status="unread"]')).toBeNull()
  })

  it('makes a thread row bold only while conversations are listed under it', async () => {
    storePanes(2)
    mockSubRowLabels.current = { 'project-1.agent-1': ['主对话', '配色疑问'] }
    renderWorkspaceWithThreadList()
    await waitForThreadSummary('画布检查')
    const titles = () => screen.getAllByTestId('agent-thread-title')
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-agent-thread-sub-rows="agent-1"] [data-agent-thread-sub-row]')
      ).toHaveLength(2)
    )
    // Upstream's label row of a multi-agent session: the row that heads a group is 600.
    expect(getComputedStyle(titles()[0]).fontWeight).toBe('600')
    expect(getComputedStyle(titles()[1]).fontWeight).toBe('400')
    for (const subRow of document.querySelectorAll('[data-agent-thread-sub-row]')) {
      expect(getComputedStyle(subRow).fontWeight).not.toBe('600')
    }

    // Without sub-rows the same row is regular again.
    mockSubRowLabels.current = {}
    fireEvent.click(getThreadRows()[1])
    await waitFor(() => expect(document.querySelector('[data-agent-thread-sub-row]')).toBeNull())
    expect(getComputedStyle(titles()[0]).fontWeight).toBe('400')
    expect(getComputedStyle(titles()[1]).fontWeight).toBe('400')
  })

  it('clears a terminated run spinner', async () => {
    updateScopedExternalLoadingSessionId('project-1.agent-1', 'terminated-run', true)
    const { container } = renderWorkspaceWithThreadList()
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument())

    const row = container.querySelector(
      '[data-agent-workspace-scope="project-1.agent-1"]'
    ) as HTMLElement
    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'terminated-run', false, false)
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: 'project-1.agent-1' }
        })
      )
    })

    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument())
    expect(row.querySelector('[data-status="idle"]')).not.toBeNull()
  })

  it('ignores legacy persisted external loading ids after a refresh', async () => {
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_EXTERNAL_LOADING_IDS, 'project-1.agent-1'),
      JSON.stringify(['stale-session'])
    )

    renderWorkspaceWithThreadList()

    await waitFor(() => {
      expect(screen.getByTestId('agent-thread-status')).toHaveAttribute('data-status', 'idle')
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    })
  })

  it('keeps pane titles without model subtitle, card portal or per-row close control in either selection', async () => {
    loadAllSessionsMock.mockResolvedValue([
      {
        id: 'session-model-preview',
        title: 'Model preview',
        messages: [
          {
            role: 'assistant',
            content: 'Model-specific answer',
            modelName: 'gpt-5.5'
          }
        ]
      }
    ])

    const { container } = renderWorkspaceWithThreadList()

    await waitForThreadSummary('Model preview')

    const addButton = container.querySelector('[data-testid="AddIcon"]')?.parentElement
    expect(addButton).toBeTruthy()
    fireEvent.click(addButton as Element)

    await waitFor(() => {
      expect(loadAllSessionsMock).toHaveBeenCalledWith('project-1.agent-2')
      expect(container.querySelectorAll('[role="button"][data-agent-workspace-scope]')).toHaveLength(2)
    })
    const rows = [...container.querySelectorAll<HTMLElement>('[role="button"][data-agent-workspace-scope]')]
    await waitFor(() => expect(rows[1]).toHaveTextContent('Model preview'))
    for (const row of rows) {
      expect(row).toHaveTextContent('Model preview')
      expect(row).not.toHaveTextContent('Model-specific answer')
      expect(row).not.toHaveTextContent('gpt-5.5')
      expect(row).not.toHaveTextContent('最新回复')
      expect(row.querySelector('[data-testid="agent-workspace-chat-controls-slot"]')).toBeNull()
      expect(row.querySelector('[id^="agent-workspace-chat-controls-"]')).toBeNull()
      // Closing moved to one row at the end of the list that acts on the active thread.
      expect(row.querySelector('[data-testid="CloseIcon"]')).toBeNull()
    }
    expect(container.querySelectorAll('[data-testid="CloseIcon"]')).toHaveLength(1)
    expect(screen.getByTestId('agent-thread-close-current')).toHaveTextContent(
      'agent_workspace.close_thread'
    )
    fireEvent.click(rows[0])
    for (const row of rows) {
      expect(row).not.toHaveTextContent('gpt-5.5')
      expect(row.querySelector('[data-testid="agent-workspace-chat-controls-slot"]')).toBeNull()
    }
  })

  it('does not render pane preview thumbnails for image replies', async () => {
    loadAllSessionsMock.mockResolvedValue([
      {
        id: 'session-image-preview',
        title: 'Image preview',
        messages: [
          {
            role: 'assistant',
            content: '对话 4',
            attachments: [{ type: 'image', url: 'blob:missing-preview' }]
          }
        ]
      }
    ])

    const { container } = renderWorkspace()

    await waitForThreadSummary('Image preview')

    const addButton = container.querySelector('[data-testid="AddIcon"]')?.parentElement
    expect(addButton).toBeTruthy()
    fireEvent.click(addButton as Element)

    await waitFor(() => {
      expect(screen.getAllByText('Image preview').length).toBeGreaterThan(0)
      expect(screen.queryByText('最新回复')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('图片回复')).not.toBeInTheDocument()
    expect(screen.queryByText('对话 4')).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '对话 4' })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Image preview' })).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('dispatches scope termination before closing a pane', async () => {
    const terminateScope = vi.fn()
    window.addEventListener('chat:terminate-scope', terminateScope as EventListener)

    const { container } = renderWorkspaceWithThreadList()

    const closeIcon = container.querySelector('[data-testid="CloseIcon"]')
    expect(closeIcon?.parentElement).toBeTruthy()

    fireEvent.click(closeIcon!.parentElement as Element)

    expect(terminateScope).toHaveBeenCalledTimes(1)
    expect((terminateScope.mock.calls[0]?.[0] as CustomEvent<{ scope?: string }>).detail).toEqual({
      scope: 'project-1.agent-1'
    })

    window.removeEventListener('chat:terminate-scope', terminateScope as EventListener)
  })

  it.each(['Enter', ' '])('closes the active thread from the keyboard with %s on the close row', async key => {
    const terminateScope = vi.fn()
    window.addEventListener('chat:terminate-scope', terminateScope as EventListener)
    try {
      renderWorkspaceWithThreadList()
      const close = screen.getByRole('button', {name: 'agent_workspace.close_thread'})
      expect(close.tagName).toBe('BUTTON')
      close.focus()
      await userEvent.keyboard(key === 'Enter' ? '{Enter}' : ' ')
      expect(terminateScope).toHaveBeenCalledTimes(1)
      expect((terminateScope.mock.calls[0]?.[0] as CustomEvent<{scope?:string}>).detail).toEqual({scope:'project-1.agent-1'})
      expect(screen.queryByRole('button', {name:'agent_workspace.close_thread'})).not.toBeInTheDocument()
    } finally {
      window.removeEventListener('chat:terminate-scope', terminateScope as EventListener)
    }
  })

  it('swallows preview refresh failures from chat storage', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadAllSessionsMock.mockRejectedValueOnce(new DOMException('Broken record', 'NotReadableError'))

    const { container } = renderWorkspace()

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[AgentWorkspace] Failed to load pane preview',
        'agent-1',
        expect.any(DOMException)
      )
    })

    expect(
      container.querySelector('[data-agent-workspace-scope="project-1.agent-1"]')
    ).toBeInTheDocument()
  })

  it('does not treat attachment drags as pane reordering', async () => {
    renderWorkspaceWithThreadList()

    const workspaceRoot = await waitFor(() => {
      const root = document.querySelector('[data-agent-workspace-root="project-1"]')
      expect(root).not.toBeNull()
      return root as HTMLElement
    })
    const firstPaneRow = workspaceRoot.querySelector('[draggable="true"]')
    expect(firstPaneRow).not.toBeNull()

    const attachmentDataTransfer = {
      types: ['application/x-ai-image'],
      effectAllowed: 'copy',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => '')
    }

    const dragOverEvent = createEvent.dragOver(firstPaneRow as HTMLElement, {
      dataTransfer: attachmentDataTransfer
    })
    fireEvent(firstPaneRow as HTMLElement, dragOverEvent)

    expect(dragOverEvent.defaultPrevented).toBe(false)
    expect(attachmentDataTransfer.dropEffect).toBe('none')
  })

  it('keeps pane reordering active for its dedicated drag payload', async () => {
    renderWorkspaceWithThreadList()

    const workspaceRoot = await waitFor(() => {
      const root = document.querySelector('[data-agent-workspace-root="project-1"]')
      expect(root).not.toBeNull()
      return root as HTMLElement
    })
    const firstPaneRow = workspaceRoot.querySelector('[draggable="true"]')
    expect(firstPaneRow).not.toBeNull()

    const reorderDataTransfer = {
      types: ['application/x-magicpot-agent-thread-reorder'],
      effectAllowed: 'move',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => '')
    }

    const dragOverEvent = createEvent.dragOver(firstPaneRow as HTMLElement, {
      dataTransfer: reorderDataTransfer
    })
    fireEvent(firstPaneRow as HTMLElement, dragOverEvent)

    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(reorderDataTransfer.dropEffect).toBe('move')
  })

  it('passes the current canvas route into ChatPage', async () => {
    renderWorkspace()

    await waitFor(() => {
      expect(chatPageMock).toHaveBeenCalled()
    })

    expect(chatPageMock.mock.calls[0]?.[0]).toMatchObject({
      storageScope: 'project-1.agent-1',
      route: {
        channel: 'canvas',
        scopeType: 'thread',
        scopeId: 'project-1',
        threadId: 'agent-1'
      }
    })
  })

  it('gives the open thread a sub-row host under its row only while the list is open', async () => {
    renderWorkspaceWithThreadList()
    await waitForThreadSummary('画布检查')
    const propsOf = () =>
      chatPageMock.mock.calls.at(-1)?.[0] as {
        threadSubRowsHost: HTMLElement | null
        onThreadSubRowChange: (title: string | null) => void
      }
    const host = document.querySelector<HTMLElement>('[data-agent-thread-sub-rows="agent-1"]')!
    expect(host).toBeInTheDocument()
    await waitFor(() => expect(propsOf().threadSubRowsHost).toBe(host))
    // Directly under the thread's own row, inside the list, and empty until a chat page fills it.
    expect(host.previousElementSibling).toBe(getThreadRows()[0])
    expect(screen.getByTestId('agent-thread-list')).toContainElement(host)
    expect(host).toBeEmptyDOMElement()

    fireEvent.click(screen.getByTestId('agent-thread-toggle'))
    expect(screen.queryByTestId('agent-thread-list')).not.toBeInTheDocument()
    await waitFor(() => expect(propsOf().threadSubRowsHost).toBeNull())
  })

  it('appends the open sub-row title to the toolbar summary', async () => {
    renderWorkspace()
    await waitForThreadSummary('画布检查')
    const propsOf = () =>
      chatPageMock.mock.calls.at(-1)?.[0] as {
        onThreadSubRowChange: (title: string | null) => void
      }
    const handler = propsOf().onThreadSubRowChange
    act(() => handler('配色疑问'))
    expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent('画布检查 · 配色疑问')
    expect(screen.getByTestId('agent-thread-toggle')).toHaveAttribute('title', '画布检查 · 配色疑问')
    // The callback keeps its identity, so the chat page is not re-subscribed on every render.
    expect(propsOf().onThreadSubRowChange).toBe(handler)
    act(() => handler(null))
    expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(/^画布检查$/)
  })

  it('opens the trace dialog from the conversation menu action', async () => {
    renderWorkspace()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => latestWorkspaceMenu().onToggleTrace())

    expect(screen.getByTestId('mock-trace-panel')).toHaveAttribute('data-project-id', 'project-1')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows a text-only status line under the toolbar while a trace is recording', async () => {
    renderWorkspace()
    expect(screen.queryByTestId('agent-workspace-status-line')).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(
        new CustomEvent(PROJECT_TRACE_CAPTURE_STATE_EVENT, {
          detail: { projectId: 'project-1', active: true, traceId: 'trace-1', mode: 'realtime' }
        })
      )
    })

    const statusLine = screen.getByTestId('agent-workspace-status-line')
    expect(statusLine).toHaveAttribute('role', 'status')
    expect(statusLine).toHaveTextContent('正在记录追踪')
    expect(statusLine.querySelector('button')).toBeNull()
    expect(
      screen.getByTestId('agent-thread-toolbar').compareDocumentPosition(statusLine) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(latestWorkspaceMenu().traceRecording).toBe(true)

    // The same menu action now stops the recording instead of opening the dialog.
    await act(async () => latestWorkspaceMenu().onToggleTrace())
    expect(screen.queryByTestId('agent-workspace-status-line')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(latestWorkspaceMenu().traceRecording).toBe(false)
  })

  it('keeps opened chat panes mounted and switches visibility without a reload', async () => {
    const { container } = renderWorkspaceWithThreadList()

    await waitFor(() => {
      expect(chatPageMock).toHaveBeenCalled()
    })

    const addButton = container.querySelector('[data-testid="AddIcon"]')?.parentElement
    expect(addButton).toBeTruthy()

    fireEvent.click(addButton as Element)

    await waitFor(() => {
      expect(
        screen
          .getAllByTestId('mock-chat-page')
          .some((element) => element.getAttribute('data-storage-scope') === 'project-1.agent-2')
      ).toBe(true)
    })

    expect(chatPageUnmountMock).not.toHaveBeenCalledWith('project-1.agent-1')

    const firstPaneButton = container.querySelector(
      '[data-agent-workspace-scope="project-1.agent-1"][role="button"]'
    )
    expect(firstPaneButton).toBeTruthy()

    fireEvent.click(firstPaneButton as Element)

    await waitFor(() => {
      const mountedPanes = screen.getAllByTestId('mock-chat-page')
      const firstPane = mountedPanes.find(
        (element) => element.getAttribute('data-storage-scope') === 'project-1.agent-1'
      )
      const secondPane = mountedPanes.find(
        (element) => element.getAttribute('data-storage-scope') === 'project-1.agent-2'
      )

      expect(firstPane?.getAttribute('data-active')).toBe('true')
      expect(secondPane?.getAttribute('data-active')).toBe('false')
    })

    expect(chatPageUnmountMock).not.toHaveBeenCalled()
  })

  it('refreshes only the pane matching a scoped preview event', async () => {
    loadAllSessionsMock.mockImplementation((scope: string) =>
      Promise.resolve([
        {
          id: `${scope}-session`,
          title: scope,
          messages: [{ role: 'assistant', content: `${scope} preview` }]
        }
      ])
    )

    const { container } = renderWorkspaceWithThreadList()

    await waitFor(() => {
      expect(chatPageMock).toHaveBeenCalled()
    })

    const addButton = container.querySelector('[data-testid="AddIcon"]')?.parentElement
    expect(addButton).toBeTruthy()

    fireEvent.click(addButton as Element)

    await waitFor(() => {
      expect(
        screen
          .getAllByTestId('mock-chat-page')
          .some((element) => element.getAttribute('data-storage-scope') === 'project-1.agent-2')
      ).toBe(true)
    })

    await waitFor(() => {
      expect(screen.getAllByTestId('agent-thread-title').map((title) => title.textContent)).toEqual(
        ['project-1.agent-1', 'project-1.agent-2']
      )
    })
    loadAllSessionsMock.mockClear()

    window.dispatchEvent(
      new CustomEvent('chat:preview-refresh', {
        detail: { scope: 'project-1.agent-2' }
      })
    )

    await waitFor(() => {
      expect(loadAllSessionsMock).toHaveBeenCalledTimes(1)
    })
    expect(loadAllSessionsMock).toHaveBeenCalledWith('project-1.agent-2')
    expect(loadAllSessionsMock).not.toHaveBeenCalledWith('project-1.agent-1')
  })

  it('ignores scoped preview events from another workspace', async () => {
    renderWorkspace()

    await waitFor(() => {
      expect(chatPageMock).toHaveBeenCalled()
    })

    loadAllSessionsMock.mockClear()

    window.dispatchEvent(
      new CustomEvent('chat:preview-refresh', {
        detail: { scope: 'project-2.agent-1' }
      })
    )

    expect(loadAllSessionsMock).not.toHaveBeenCalled()
  })

  it('ignores create-pane events without the current project id', async () => {
    renderWorkspace()

    await waitFor(() => {
      expect(chatPageMock).toHaveBeenCalled()
    })

    window.dispatchEvent(new CustomEvent('agent-workspace:create-pane', { detail: {} }))
    window.dispatchEvent(
      new CustomEvent('agent-workspace:create-pane', {
        detail: { projectId: 'project-2' }
      })
    )

    expect(screen.getAllByTestId('mock-chat-page')).toHaveLength(1)
  })

  describe('session toolbar and in-place thread list', () => {
    const titledSessions = (scope: string) =>
      Promise.resolve([
        { id: `${scope}-session`, title: `Thread ${scope.split('-').pop()}`, messages: [] }
      ])

    it('starts as two flat rows: the header and a 34px toolbar, with the list collapsed', async () => {
      renderWorkspace()
      await waitForThreadSummary('画布检查')

      const root = document.querySelector<HTMLElement>('[data-agent-workspace-root="project-1"]')!
      const toolbar = screen.getByTestId('agent-thread-toolbar')
      const toggle = screen.getByTestId('agent-thread-toggle')
      const paneHost = root.querySelector<HTMLElement>(':scope > [data-agent-workspace-scope]')!

      // Column top to transcript: header, then the toolbar section, then the pane host.
      expect([...root.children].indexOf(paneHost)).toBe(2)
      expect(root.children[1]).toContainElement(toolbar)
      expect(root.children[1].children).toHaveLength(1)
      expect(screen.queryByTestId('agent-thread-list')).not.toBeInTheDocument()
      expect(getThreadRows()).toHaveLength(0)

      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(toggle).not.toHaveAttribute('aria-controls')
      expect(getComputedStyle(toolbar).minHeight).toBe('34px')
      expect(getComputedStyle(toolbar).padding).toBe('2px 6px')
      for (const element of [toolbar, toggle]) {
        expect(['0', '0px']).toContain(getComputedStyle(element).borderRadius)
        expect(getComputedStyle(element).boxShadow).toBe('none')
      }
      expect(getComputedStyle(root.children[0]).minHeight).toBe('49.9px')
      expect(localStorage.getItem(THREAD_LIST_STATE_KEY)).toBe('1')
    })

    it('toggles the list in place under the toolbar and keeps it open after picking a thread', async () => {
      storePanes(2)
      loadAllSessionsMock.mockImplementation(titledSessions)
      renderWorkspace()
      await waitForThreadSummary('Thread 1')

      const toggle = screen.getByTestId('agent-thread-toggle')
      fireEvent.click(toggle)

      const list = screen.getByTestId('agent-thread-list')
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(toggle).toHaveAttribute('aria-controls', list.id)
      expect(screen.getByTestId('agent-thread-toolbar').nextElementSibling).toBe(list)
      expect(localStorage.getItem(THREAD_LIST_STATE_KEY)).toBe('0')

      const rows = getThreadRows()
      expect(rows.map((row) => row.textContent)).toEqual(['Thread 1', 'Thread 2'])
      expect(rows[0]).toHaveAttribute('aria-current', 'true')
      expect(rows[1]).not.toHaveAttribute('aria-current')
      for (const row of rows) {
        expect(['0', '0px']).toContain(getComputedStyle(row).borderRadius)
        expect(getComputedStyle(row).boxShadow).toBe('none')
        expect(getComputedStyle(row).padding).toBe('7px 10px')
      }
      expect(getComputedStyle(rows[0]).backgroundColor).not.toBe(
        getComputedStyle(rows[1]).backgroundColor
      )

      fireEvent.click(rows[1])

      await waitForThreadSummary('Thread 2')
      expect(screen.getByTestId('agent-thread-list')).toBeInTheDocument()
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(getThreadRows()[1]).toHaveAttribute('aria-current', 'true')
      const activeScopes = screen
        .getAllByTestId('mock-chat-page')
        .filter((element) => element.getAttribute('data-active') === 'true')
        .map((element) => element.getAttribute('data-storage-scope'))
      expect(activeScopes).toEqual(['project-1.agent-2'])

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByTestId('agent-thread-list')).not.toBeInTheDocument()
    })

    it('closes the list with Escape and returns focus to the toolbar toggle', async () => {
      renderWorkspaceWithThreadList()
      await waitForThreadSummary('画布检查')
      const toggle = screen.getByTestId('agent-thread-toggle')

      const row = getThreadRows()[0]
      row.focus()
      fireEvent.keyDown(row, { key: 'Escape' })

      expect(screen.queryByTestId('agent-thread-list')).not.toBeInTheDocument()
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(toggle).toHaveFocus()
    })

    it('caps a long list at min(38vh, 280px) with its own scroll box', async () => {
      storePanes(12)
      loadAllSessionsMock.mockImplementation(titledSessions)
      renderWorkspaceWithThreadList()

      await waitFor(() => expect(getThreadRows()).toHaveLength(12))
      const list = screen.getByTestId('agent-thread-list')
      const listClass = [...list.classList].find((name) => name.startsWith('css-'))!
      const listRule = [...document.querySelectorAll('style')]
        .map((style) => style.textContent ?? '')
        .join('\n')
        .split('}')
        .find((rule) => rule.includes(`.${listClass}{`))
      expect(listRule).toContain('max-height:min(38vh, 280px)')
      expect(getComputedStyle(list).overflowY).toBe('auto')
      expect(getComputedStyle(list).overflowX).toBe('hidden')
      // The close row is the last child of the same scroll box, after every thread.
      expect(list.lastElementChild).toBe(screen.getByTestId('agent-thread-close-current'))
      // Twelve thread rows, each followed by its (empty) sub-row host, then the close row.
      expect(list.children).toHaveLength(25)
      expect(list.querySelectorAll('[data-agent-thread-sub-rows]')).toHaveLength(12)
    })

    it('names a team thread after the lead conversation, never after a member or the latest reply', async () => {
      const lead = { id: 'lead', title: '合成团队验收组长', createdAt: 1, messages: [] }
      const designer = {
        id: 'designer',
        title: '设计师',
        createdAt: 2,
        teamLeadId: 'lead',
        teamMemberName: '设计师',
        messages: []
      }
      const writer = {
        id: 'writer',
        title: '文案',
        createdAt: 3,
        teamLeadId: 'lead',
        teamMemberName: '文案',
        messages: [
          { role: 'user', content: '写一句宣传语' },
          { role: 'assistant', content: 'ok', modelName: 'isolated-image-model' }
        ]
      }
      loadAllSessionsMock.mockResolvedValue([lead, designer, writer])

      renderWorkspaceWithThreadList()
      await waitForThreadSummary('合成团队验收组长')
      expect(getThreadRows()[0]).toHaveTextContent('合成团队验收组长')

      // A member conversation becomes the open one and a reply arrives in the lead.
      localStorage.setItem(CURRENT_SESSION_KEY, 'writer')
      loadAllSessionsMock.mockResolvedValue([
        { ...lead, messages: [{ role: 'assistant', content: 'ok' }] },
        designer,
        writer
      ])
      act(() => {
        window.dispatchEvent(
          new CustomEvent('chat:preview-refresh', { detail: { scope: 'project-1.agent-1' } })
        )
      })
      await waitFor(() => expect(loadAllSessionsMock.mock.calls.length).toBeGreaterThan(1))
      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent('合成团队验收组长')
      expect(getThreadRows()[0].textContent).toBe('合成团队验收组长')
      expect(screen.queryByText('文案')).not.toBeInTheDocument()
      expect(screen.queryByText('ok')).not.toBeInTheDocument()
    })

    it('prefers the root conversation that is open in the pane and falls back to the newest one', async () => {
      loadAllSessionsMock.mockResolvedValue([
        { id: 'older', title: 'Older conversation', createdAt: 1, messages: [] },
        { id: 'newer', title: 'Newer conversation', createdAt: 2, messages: [] },
        { id: 'member', title: 'Member', createdAt: 3, teamLeadId: 'newer', messages: [] }
      ])

      renderWorkspace()
      await waitForThreadSummary('Newer conversation')

      localStorage.setItem(CURRENT_SESSION_KEY, 'older')
      act(() => {
        window.dispatchEvent(
          new CustomEvent('chat:preview-refresh', { detail: { scope: 'project-1.agent-1' } })
        )
      })
      await waitForThreadSummary('Older conversation')
    })

    it('closes the active thread from the red last row and keeps the list open on the next thread', async () => {
      storePanes(2)
      loadAllSessionsMock.mockImplementation(titledSessions)
      const terminateScope = vi.fn()
      window.addEventListener('chat:terminate-scope', terminateScope as EventListener)
      try {
        renderWorkspaceWithThreadList()
        await waitFor(() => expect(getThreadRows()).toHaveLength(2))
        fireEvent.click(getThreadRows()[1])
        await waitForThreadSummary('Thread 2')

        const close = screen.getByTestId('agent-thread-close-current')
        expect(getComputedStyle(close).color).toBe(cssColor(testTheme.palette.error.main))
        fireEvent.click(close)

        expect(terminateScope).toHaveBeenCalledTimes(1)
        expect(
          (terminateScope.mock.calls[0]?.[0] as CustomEvent<{ scope?: string }>).detail
        ).toEqual({ scope: 'project-1.agent-2' })
        await waitForThreadSummary('Thread 1')
        expect(getThreadRows().map((row) => row.textContent)).toEqual(['Thread 1'])
        expect(screen.getByTestId('agent-thread-list')).toBeInTheDocument()
        expect(screen.getByTestId('agent-thread-close-current')).toBeInTheDocument()
      } finally {
        window.removeEventListener('chat:terminate-scope', terminateScope as EventListener)
      }
    })

    it('draws one divider under the region and one above the list, never two together', async () => {
      storePanes(2)
      loadAllSessionsMock.mockImplementation(titledSessions)
      renderWorkspace()
      await waitForThreadSummary('Thread 1')
      const divider = `1px solid ${cssColor(testTheme.palette.divider)}`
      const border = (element: Element, side: 'Top' | 'Bottom') => {
        const style = getComputedStyle(element)
        // jsdom reports an unset border as an empty style.
        return ['', 'none'].includes(style[`border${side}Style`])
          ? 'none'
          : `${style[`border${side}Width`]} ${style[`border${side}Style`]} ${style[`border${side}Color`]}`
      }
      const region = screen.getByTestId('agent-thread-toolbar').parentElement!
      const toolbar = screen.getByTestId('agent-thread-toolbar')

      // Closed: the region's bottom divider is the only line.
      expect(border(region, 'Bottom')).toBe(divider)
      expect(border(region, 'Top')).toBe('none')
      expect(border(toolbar, 'Bottom')).toBe('none')

      fireEvent.click(screen.getByTestId('agent-thread-toggle'))
      const list = screen.getByTestId('agent-thread-list')
      expect(border(region, 'Bottom')).toBe(divider)
      expect(border(toolbar, 'Bottom')).toBe('none')
      expect(border(list, 'Top')).toBe(divider)
      expect(border(list, 'Bottom')).toBe('none')
      for (const row of getThreadRows()) {
        expect(border(row, 'Bottom')).toBe(divider)
        expect(border(row, 'Top')).toBe('none')
      }
      // The last row leaves the closing line to the region.
      const close = screen.getByTestId('agent-thread-close-current')
      expect(list.lastElementChild).toBe(close)
      expect(border(close, 'Bottom')).toBe('none')
      expect(border(close, 'Top')).toBe('none')

      // A status line that follows starts right under that single divider.
      act(() => {
        window.dispatchEvent(
          new CustomEvent(PROJECT_TRACE_CAPTURE_STATE_EVENT, {
            detail: { projectId: 'project-1', active: true, traceId: 'trace-1', mode: 'capture' }
          })
        )
      })
      const statusLine = screen.getByTestId('agent-workspace-status-line')
      expect(region.nextElementSibling).toBe(statusLine)
      expect(border(statusLine, 'Top')).toBe('none')
      expect(border(statusLine, 'Bottom')).toBe(divider)
      expect(border(region, 'Bottom')).toBe(divider)
    })

    it('numbers threads that have no conversation title by their position', async () => {
      expect(zhRenderer.agent_workspace.chat_label).toBe('对话 {{index}}')
      expect(enRenderer.agent_workspace.chat_label).toBe('Conversation {{index}}')
      // agent-1 was closed earlier; the open panes are the 1st and 2nd rows whatever their ids.
      localStorage.setItem(
        'agent.workspace.project-1',
        JSON.stringify([
          { id: 'agent-1', enabled: false },
          { id: 'agent-3', enabled: true },
          { id: 'agent-7', enabled: true },
          { id: 'agent-8', enabled: true }
        ])
      )
      localStorage.setItem('agent.workspace.active.project-1', 'agent-3')
      loadAllSessionsMock.mockImplementation((scope: string) =>
        Promise.resolve(
          scope === 'project-1.agent-3'
            ? [] // no conversation yet
            : scope === 'project-1.agent-7'
              ? [{ id: 's', title: '新对话', messages: [] }] // a conversation that still has the default name
              : [{ id: 's', title: '海报配色', messages: [] }]
        )
      )
      renderWorkspaceWithThreadList()
      await waitFor(() =>
        expect(getThreadRows().map((row) => row.textContent)).toEqual(['对话 1', '对话 2', '海报配色'])
      )
      expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(/^对话 1$/)
      expect(screen.queryByText('新对话')).not.toBeInTheDocument()

      // Reordering renumbers: the label follows the position, not the pane.
      const dataTransfer = {
        types: ['application/x-magicpot-agent-thread-reorder'],
        effectAllowed: 'move',
        dropEffect: 'none',
        setData: vi.fn(),
        getData: vi.fn(() => '')
      }
      const [first, second] = getThreadRows()
      fireEvent.dragStart(second, { dataTransfer })
      fireEvent.dragOver(first, { dataTransfer })
      fireEvent.drop(first, { dataTransfer })
      fireEvent.dragEnd(second, { dataTransfer })
      await waitFor(() =>
        expect(getThreadRows().map((row) => row.getAttribute('data-agent-thread-row'))).toEqual([
          'agent-7',
          'agent-3',
          'agent-8'
        ])
      )
      expect(getThreadRows().map((row) => row.textContent)).toEqual(['对话 1', '对话 2', '海报配色'])
      expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(/^对话 2$/)
    })

    it('labels a new thread at once and never flashes a placeholder while titles load', async () => {
      let resolveSessions: ((sessions: unknown[]) => void) | undefined
      loadAllSessionsMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSessions = resolve
          })
      )
      renderWorkspaceWithThreadList()
      // The title is not known yet: no numbered label and no "新对话" in its place.
      await waitFor(() => expect(loadAllSessionsMock).toHaveBeenCalled())
      expect(getThreadRows().map((row) => row.textContent)).toEqual([''])
      expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(/^$/)
      await act(async () => {
        resolveSessions?.([{ id: 'session-1', title: '画布检查', messages: [] }])
      })
      await waitForThreadSummary('画布检查')

      // A thread created here is known to have no conversation: it is numbered immediately.
      loadAllSessionsMock.mockImplementation((scope: string) =>
        Promise.resolve(
          scope === 'project-1.agent-1' ? [{ id: 'session-1', title: '画布检查', messages: [] }] : []
        )
      )
      fireEvent.click(screen.getByRole('button', { name: 'agent_workspace.new_chat' }))
      expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(/^对话 2$/)
      expect(getThreadRows().map((row) => row.textContent)).toEqual(['画布检查', '对话 2'])
      fireEvent.click(screen.getByRole('button', { name: 'agent_workspace.new_chat' }))
      expect(getThreadRows().map((row) => row.textContent)).toEqual(['画布检查', '对话 2', '对话 3'])
      await waitFor(() => expect(loadAllSessionsMock).toHaveBeenCalledWith('project-1.agent-3'))
      await act(async () => {
        await Promise.resolve()
      })
      expect(getThreadRows().map((row) => row.textContent)).toEqual(['画布检查', '对话 2', '对话 3'])
      expect(screen.queryByText('新对话')).not.toBeInTheDocument()
    })

    it('keeps the previous title when the workspace is mounted again, until the real one is known', async () => {
      const first = renderWorkspaceWithThreadList()
      await waitForThreadSummary('画布检查')
      first.unmount()

      let resolveSessions: ((sessions: unknown[]) => void) | undefined
      loadAllSessionsMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSessions = resolve
          })
      )
      renderWorkspaceWithThreadList()
      // Synchronously, before the conversations are read again.
      expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(/^画布检查$/)
      expect(getThreadRows().map((row) => row.textContent)).toEqual(['画布检查'])
      await waitFor(() => expect(resolveSessions).toBeDefined())
      await act(async () => {
        resolveSessions?.([{ id: 'session-1', title: '画布检查（改名）', messages: [] }])
      })
      await waitForThreadSummary('画布检查（改名）')
    })

    it('moves focus to New when the last thread is closed, and leaves it alone otherwise', async () => {
      storePanes(2)
      loadAllSessionsMock.mockImplementation(titledSessions)
      renderWorkspaceWithThreadList()
      await waitFor(() => expect(getThreadRows()).toHaveLength(2))
      const add = screen.getByRole('button', { name: 'agent_workspace.new_chat' })

      // One thread remains: the close row is still there and keeps the focus.
      const close = screen.getByTestId('agent-thread-close-current')
      act(() => close.focus())
      fireEvent.click(close)
      await waitFor(() => expect(getThreadRows()).toHaveLength(1))
      expect(add).not.toHaveFocus()
      expect(screen.getByTestId('agent-thread-close-current')).toHaveFocus()

      // The last thread: the list disappears, so the focus goes to the one way forward.
      fireEvent.click(screen.getByTestId('agent-thread-close-current'))
      await waitFor(() => expect(screen.queryByTestId('agent-thread-list')).not.toBeInTheDocument())
      expect(getThreadRows()).toHaveLength(0)
      expect(screen.getByTestId('agent-thread-toggle')).toBeDisabled()
      expect(add).toHaveFocus()
      expect(document.activeElement).not.toBe(document.body)
    })

    it('reorders threads by dragging one row onto another', async () => {
      storePanes(3)
      loadAllSessionsMock.mockImplementation(titledSessions)
      renderWorkspaceWithThreadList()
      await waitFor(() => expect(getThreadRows()).toHaveLength(3))

      const dataTransfer = {
        types: ['application/x-magicpot-agent-thread-reorder'],
        effectAllowed: 'move',
        dropEffect: 'none',
        setData: vi.fn(),
        getData: vi.fn(() => '')
      }
      const [first, , third] = getThreadRows()
      fireEvent.dragStart(third, { dataTransfer })
      fireEvent.dragOver(first, { dataTransfer })
      fireEvent.drop(first, { dataTransfer })
      fireEvent.dragEnd(third, { dataTransfer })

      expect(dataTransfer.setData).toHaveBeenCalledWith(
        'application/x-magicpot-agent-thread-reorder',
        'agent-3'
      )
      await waitFor(() =>
        expect(getThreadRows().map((row) => row.getAttribute('data-agent-thread-row'))).toEqual([
          'agent-3',
          'agent-1',
          'agent-2'
        ])
      )
      expect(
        (JSON.parse(localStorage.getItem('agent.workspace.project-1')!) as { id: string }[]).map(
          (pane) => pane.id
        )
      ).toEqual(['agent-3', 'agent-1', 'agent-2'])
    })

    it('summarises an empty column and offers the new-thread button with a name', async () => {
      localStorage.setItem(
        'agent.workspace.project-1',
        JSON.stringify([{ id: 'agent-1', enabled: false }])
      )
      renderWorkspaceWithThreadList()

      expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(
        'agent_workspace.no_threads'
      )
      expect(screen.getByTestId('agent-thread-toggle')).toBeDisabled()
      expect(screen.getByTestId('agent-thread-toggle')).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByTestId('agent-thread-list')).not.toBeInTheDocument()

      const add = screen.getByRole('button', { name: 'agent_workspace.new_chat' })
      expect(getComputedStyle(add).width).toBe('26px')
      expect(getComputedStyle(add).height).toBe('26px')
      fireEvent.click(add)

      await waitFor(() => expect(getThreadRows()).toHaveLength(1))
      expect(screen.getByTestId('agent-thread-toggle')).toHaveAttribute('aria-expanded', 'true')
    })

    it('shows the project name as a muted subtitle and omits it when empty', () => {
      const { unmount } = renderWorkspace('Poster campaign')
      const subtitle = screen.getByTestId('agent-workspace-subtitle')
      expect(subtitle).toHaveTextContent('Poster campaign')
      expect(getComputedStyle(subtitle).fontSize).toBe('11px')
      expect(getComputedStyle(subtitle).textOverflow).toBe('ellipsis')
      expect(getComputedStyle(screen.getByText('agent_workspace.title')).fontSize).toBe('13px')
      expect(getComputedStyle(screen.getByText('agent_workspace.title')).fontWeight).toBe('600')
      unmount()

      renderWorkspace('   ')
      expect(screen.queryByTestId('agent-workspace-subtitle')).not.toBeInTheDocument()
    })

    it('ships every toolbar and list string in both locales', () => {
      const keys = [
        'close_thread',
        'thread_list',
        'no_threads',
        'threads_none_selected',
        'new_chat',
        'status_running',
        'status_queued',
        'status_waiting_tool',
        'status_failed',
        'status_cancelled',
        'status_interrupted',
        'status_idle'
      ] as const
      for (const key of keys) {
        expect(zhRenderer.agent_workspace[key]).toMatch(/[㐀-鿿]/)
        expect(enRenderer.agent_workspace[key]).toMatch(/^[\x20-\x7e·]+$/)
      }
      // Upstream rows have no unread marker, so there is no label for one.
      expect(zhRenderer.agent_workspace).not.toHaveProperty('status_unread')
      expect(enRenderer.agent_workspace).not.toHaveProperty('status_unread')
      expect(JSON.stringify(zhRenderer.agent_workspace)).not.toContain('有新回复')
      expect(zhRenderer.agent_workspace.close_thread).toBe('关闭当前线程')
      expect(enRenderer.agent_workspace.close_thread).toBe('Close this thread')
      expect(zhRenderer.agent_workspace.threads_none_selected).toContain('{{count}}')
      expect(enRenderer.agent_workspace.threads_none_selected).toContain('{{count}}')
    })
  })
})
