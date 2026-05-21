import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentWorkspace from './AgentWorkspace'
import {
  clearScopedExternalLoadingSessionIds,
  scopedStorageKey,
  STORAGE_KEY_EXTERNAL_LOADING_IDS
} from '@renderer/pages/ChatPage/chatPageShared'
import { updateScopedExternalLoadingSessionId } from '@renderer/pages/ChatPage/chatPageShared'

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
      mock chat page
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
    localStorage.clear()
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

  it('shows the running spinner when an external loading session is active', async () => {
    updateScopedExternalLoadingSessionId('project-1.agent-1', 'session-1', true)

    renderWorkspace()

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument()
    })
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

    renderWorkspace()

    await waitFor(() => {
      expect(screen.getByText('Model-specific answer')).toBeInTheDocument()
      expect(screen.getByText('gpt-5.5')).toBeInTheDocument()
    })
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

    const firstPaneButton = Array.from(
      container.querySelectorAll('[data-agent-workspace-scope="project-1.agent-1"]')
    ).find((element) => element.tagName.toLowerCase() === 'button')
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
      expect(loadAllSessionsMock).toHaveBeenCalledWith('project-1.agent-1')
      expect(loadAllSessionsMock).toHaveBeenCalledWith('project-1.agent-2')
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
