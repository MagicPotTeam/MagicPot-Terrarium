import React from 'react'
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentWorkspace from './AgentWorkspace'
import {
  clearScopedActiveLoadingSessionIds,
  clearScopedExternalLoadingSessionIds,
  scopedStorageKey,
  STORAGE_KEY_EXTERNAL_LOADING_IDS,
  updateScopedExternalLoadingSessionId
} from '@renderer/pages/ChatPage/chatPageShared'

const chatPageUnmountMock = vi.fn()
const chatPageMock = vi.fn((props?: unknown) => {
  const typedProps = props as { active?: boolean; storageScope?: string }

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
    </div>
  )
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.new_conversation') return '新对话'
      if (key === 'agent_workspace.image_reply') return '图片回复'
      if (key === 'agent_workspace.latest_reply') return '最新回复'
      if (key === 'agent_workspace.latest_prompt') return '最新提问'
      if (key === 'agent_workspace.conversation_created') return '会话已创建'
      if (key === 'agent_workspace.empty_conversation') return '暂无内容'
      if (key === 'agent_workspace.chat_label') {
        return `Agent 线程 ${String(options?.index ?? '')}`.trim()
      }
      if (key === 'menu.trace') return '追踪'
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

const renderWorkspace = () =>
  render(
    <ThemeProvider theme={createTheme()}>
      <AgentWorkspace projectId="project-1" />
    </ThemeProvider>
  )

describe('AgentWorkspace', () => {
  beforeEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    clearScopedActiveLoadingSessionIds()
    clearScopedExternalLoadingSessionIds()
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
      expect(screen.getByText('画布执行已开始。')).toBeInTheDocument()
    })
  })

  it('shows the running spinner when an external loading session is active', async () => {
    updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', true)

    renderWorkspace()

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument()
    })
  })

  it('clears the spinner immediately while the completion preview refresh is deferred', async () => {
    updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', true)
    renderWorkspace()
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
    expect(screen.getByTestId('agent-thread-status')).toHaveAttribute('data-status', 'unread')

    await act(async () => {
      resolvePreview?.([])
      await Promise.resolve()
    })
  })

  it('marks the active thread unread when its scoped external run completes', async () => {
    updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', true)
    renderWorkspace()

    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument())

    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', false)
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: 'project-1.agent-1' }
        })
      )
    })

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
      expect(screen.getByTestId('agent-thread-status')).toHaveAttribute('data-status', 'unread')
    })
  })

  it('baselines historical inactive threads as read', async () => {
    localStorage.setItem(
      'agent.workspace.project-1',
      JSON.stringify([
        { id: 'agent-1', enabled: true },
        { id: 'agent-2', enabled: true }
      ])
    )
    loadAllSessionsMock.mockImplementation((scope: string) =>
      Promise.resolve([
        {
          id: `${scope}-session`,
          title: scope,
          messages: [{ role: 'assistant', content: scope }]
        }
      ])
    )

    const { container } = renderWorkspace()
    await waitFor(() => {
      const row = container.querySelector('[data-agent-workspace-scope="project-1.agent-2"]')
      expect(row?.querySelector('[data-status="read"]')).not.toBeNull()
      expect(row?.querySelector('[data-status="unread"]')).toBeNull()
    })
  })

  it('keeps a completed unread thread unread on hover', async () => {
    localStorage.setItem(
      'agent.workspace.project-1',
      JSON.stringify([
        { id: 'agent-1', enabled: true },
        { id: 'agent-2', enabled: true }
      ])
    )
    loadAllSessionsMock.mockImplementation((scope: string) =>
      Promise.resolve([
        {
          id: `${scope}-session`,
          title: scope,
          messages: [{ role: 'assistant', content: scope }]
        }
      ])
    )

    const { container } = renderWorkspace()
    const secondRow = await waitFor(() => {
      const row = container.querySelector('[data-agent-workspace-scope="project-1.agent-2"]')
      expect(row).not.toBeNull()
      expect(row?.querySelector('[data-status="read"]')).not.toBeNull()
      return row as HTMLElement
    })

    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-2', 'run-2', true)
      updateScopedExternalLoadingSessionId('project-1.agent-2', 'run-2', false)
    })
    await waitFor(() => expect(secondRow.querySelector('[data-status="unread"]')).not.toBeNull())

    fireEvent.mouseEnter(secondRow)
    expect(secondRow.querySelector('[data-status="unread"]')).not.toBeNull()
    expect(secondRow.querySelector('[data-status="read"]')).toBeNull()
    expect(localStorage.getItem('agent.workspace.active.project-1')).toBe('agent-1')
  })

  it('keeps a completed unread thread unread when its row is clicked to activate it', async () => {
    localStorage.setItem(
      'agent.workspace.project-1',
      JSON.stringify([
        { id: 'agent-1', enabled: true },
        { id: 'agent-2', enabled: true }
      ])
    )
    loadAllSessionsMock.mockImplementation((scope: string) =>
      Promise.resolve([
        {
          id: `${scope}-session`,
          title: scope,
          messages: [{ role: 'assistant', content: scope }]
        }
      ])
    )

    const { container } = renderWorkspace()
    const secondRow = await waitFor(() => {
      const row = container.querySelector('[data-agent-workspace-scope="project-1.agent-2"]')
      expect(row?.querySelector('[data-status="read"]')).not.toBeNull()
      return row as HTMLElement
    })

    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-2', 'run-2', true)
      updateScopedExternalLoadingSessionId('project-1.agent-2', 'run-2', false)
    })
    await waitFor(() => expect(secondRow.querySelector('[data-status="unread"]')).not.toBeNull())

    fireEvent.click(secondRow)
    expect(secondRow.querySelector('[data-status="unread"]')).not.toBeNull()
    expect(secondRow.querySelector('[data-status="read"]')).toBeNull()
    expect(localStorage.getItem('agent.workspace.active.project-1')).toBe('agent-2')
  })

  it('keeps a completed unread thread unread on keyboard row activation', async () => {
    localStorage.setItem(
      'agent.workspace.project-1',
      JSON.stringify([
        { id: 'agent-1', enabled: true },
        { id: 'agent-2', enabled: true }
      ])
    )
    loadAllSessionsMock.mockImplementation((scope: string) =>
      Promise.resolve([
        {
          id: `${scope}-session`,
          title: scope,
          messages: [{ role: 'assistant', content: scope }]
        }
      ])
    )

    const { container } = renderWorkspace()
    const secondRow = await waitFor(() => {
      const row = container.querySelector('[data-agent-workspace-scope="project-1.agent-2"]')
      expect(row?.querySelector('[data-status="read"]')).not.toBeNull()
      return row as HTMLElement
    })

    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-2', 'run-2', true)
      updateScopedExternalLoadingSessionId('project-1.agent-2', 'run-2', false)
    })
    await waitFor(() => expect(secondRow.querySelector('[data-status="unread"]')).not.toBeNull())

    fireEvent.keyDown(secondRow, { key: 'Enter' })
    expect(secondRow.querySelector('[data-status="unread"]')).not.toBeNull()
    expect(secondRow.querySelector('[data-status="read"]')).toBeNull()
    expect(localStorage.getItem('agent.workspace.active.project-1')).toBe('agent-2')
  })

  it('clears unread on pointer interaction inside the conversation area only', async () => {
    const { container } = renderWorkspace()
    await waitFor(() => expect(screen.getByText('画布执行已开始。')).toBeInTheDocument())

    const row = container.querySelector(
      '[data-agent-workspace-scope="project-1.agent-1"]'
    ) as HTMLElement
    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'conversation-click', true)
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'conversation-click', false)
    })
    await waitFor(() => expect(row.querySelector('[data-status="unread"]')).not.toBeNull())

    fireEvent.pointerDown(screen.getByTestId('mock-message-content'))
    expect(row.querySelector('[data-status="read"]')).not.toBeNull()
    expect(row.querySelector('[data-status="unread"]')).toBeNull()
  })

  it('clears unread when the conversation scroll container scrolls', async () => {
    const { container } = renderWorkspace()
    await waitFor(() => expect(screen.getByText('画布执行已开始。')).toBeInTheDocument())

    const row = container.querySelector(
      '[data-agent-workspace-scope="project-1.agent-1"]'
    ) as HTMLElement
    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'conversation-scroll', true)
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'conversation-scroll', false)
    })
    await waitFor(() => expect(row.querySelector('[data-status="unread"]')).not.toBeNull())

    fireEvent.scroll(screen.getByTestId('mock-conversation-scroll'))
    expect(row.querySelector('[data-status="read"]')).not.toBeNull()
    expect(row.querySelector('[data-status="unread"]')).toBeNull()
  })

  it('keeps unread through composer click, typing, and nested composer scrolling', async () => {
    const { container } = renderWorkspace()
    await waitFor(() => expect(screen.getByText('画布执行已开始。')).toBeInTheDocument())

    const row = container.querySelector(
      '[data-agent-workspace-scope="project-1.agent-1"]'
    ) as HTMLElement
    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'composer-interactions', true)
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'composer-interactions', false)
    })
    await waitFor(() => expect(row.querySelector('[data-status="unread"]')).not.toBeNull())

    const composer = screen.getByTestId('mock-composer')
    const input = screen.getByTestId('mock-composer-input')
    fireEvent.pointerDown(input)
    fireEvent.change(input, { target: { value: 'draft' } })
    fireEvent.scroll(input)
    fireEvent.scroll(composer)

    expect(row.querySelector('[data-status="unread"]')).not.toBeNull()
    expect(row.querySelector('[data-status="read"]')).toBeNull()
  })

  it('records fast running-to-completed transitions without waiting for preview refresh', async () => {
    const { container } = renderWorkspace()
    await waitFor(() => expect(screen.getByText('画布执行已开始。')).toBeInTheDocument())

    const row = container.querySelector(
      '[data-agent-workspace-scope="project-1.agent-1"]'
    ) as HTMLElement
    act(() => {
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'fast-run', true)
      updateScopedExternalLoadingSessionId('project-1.agent-1', 'fast-run', false)
    })

    await waitFor(() => expect(row.querySelector('[data-status="unread"]')).not.toBeNull())
  })

  it('clears a terminated run spinner without marking the thread unread', async () => {
    updateScopedExternalLoadingSessionId('project-1.agent-1', 'terminated-run', true)
    const { container } = renderWorkspace()
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
    expect(row.querySelector('[data-status="read"]')).not.toBeNull()
    expect(row.querySelector('[data-status="unread"]')).toBeNull()
  })

  it('ignores legacy persisted external loading ids after a refresh', async () => {
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_EXTERNAL_LOADING_IDS, 'project-1.agent-1'),
      JSON.stringify(['stale-session'])
    )

    renderWorkspace()

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    })
  })

  it('uses the assistant model name instead of the latest-reply label in pane previews', async () => {
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

    const { container } = renderWorkspace()

    await waitFor(() => {
      expect(screen.getAllByText('Model-specific answer').length).toBeGreaterThan(0)
    })

    const addButton = container.querySelector('[data-testid="AddIcon"]')?.parentElement
    expect(addButton).toBeTruthy()
    fireEvent.click(addButton as Element)

    await waitFor(() => {
      expect(screen.getAllByText('gpt-5.5').length).toBeGreaterThan(0)
    })
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

    await waitFor(() => {
      expect(screen.getByText('对话 4')).toBeInTheDocument()
    })

    const addButton = container.querySelector('[data-testid="AddIcon"]')?.parentElement
    expect(addButton).toBeTruthy()
    fireEvent.click(addButton as Element)

    await waitFor(() => {
      expect(screen.getAllByText('对话 4').length).toBeGreaterThan(0)
      expect(screen.getByText('最新回复')).toBeInTheDocument()
    })
    expect(screen.queryByText('图片回复')).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: '对话 4' })).not.toBeInTheDocument()
  })

  it('dispatches scope termination before closing a pane', async () => {
    const terminateScope = vi.fn()
    window.addEventListener('chat:terminate-scope', terminateScope as EventListener)

    const { container } = renderWorkspace()

    const closeIcon = container.querySelector('[data-testid="CloseIcon"]')
    expect(closeIcon?.parentElement).toBeTruthy()

    fireEvent.click(closeIcon!.parentElement as Element)

    expect(terminateScope).toHaveBeenCalledTimes(1)
    expect((terminateScope.mock.calls[0]?.[0] as CustomEvent<{ scope?: string }>).detail).toEqual({
      scope: 'project-1.agent-1'
    })

    window.removeEventListener('chat:terminate-scope', terminateScope as EventListener)
  })

  it('swallows preview refresh failures from chat storage', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadAllSessionsMock.mockRejectedValueOnce(new DOMException('Broken record', 'NotReadableError'))

    const { container } = renderWorkspace()

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[AgentWorkspace] Failed to refresh pane previews',
        expect.any(DOMException)
      )
    })

    expect(
      container.querySelector('[data-agent-workspace-scope="project-1.agent-1"]')
    ).toBeInTheDocument()
  })

  it('does not treat attachment drags as pane reordering', async () => {
    renderWorkspace()

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
    renderWorkspace()

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

  it('opens trace as a dialog between skill and target actions without the trace icon', async () => {
    renderWorkspace()

    const traceButton = screen.getByTestId('agent-workspace-trace-button')
    const targetButton = screen.getByText('agent_workspace.check')

    expect(
      traceButton.compareDocumentPosition(targetButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(traceButton.querySelector('[data-testid="TimelineIcon"]')).toBeNull()

    fireEvent.click(traceButton)

    expect(screen.getByTestId('mock-trace-panel')).toHaveAttribute('data-project-id', 'project-1')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('keeps opened chat panes mounted and switches visibility without a reload', async () => {
    const { container } = renderWorkspace()

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

    const { container } = renderWorkspace()

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
      expect(screen.getByText('project-1.agent-1 preview')).toBeInTheDocument()
      expect(screen.getByText('project-1.agent-2 preview')).toBeInTheDocument()
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
})
