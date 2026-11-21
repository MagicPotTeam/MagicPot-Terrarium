import React from 'react'
import { createPortal } from 'react-dom'
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
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
  scopedStorageKey,
  startScopedChatRun,
  STORAGE_KEY_EXTERNAL_LOADING_IDS,
  updateScopedExternalLoadingSessionId
} from '@renderer/pages/ChatPage/chatPageShared'
import {
  AgentColumnToastContext,
  type AgentColumnToastSink
} from '@renderer/hooks/agentColumnToastContext'

const chatPageUnmountMock = vi.fn()
/** Sub-rows the mocked chat page of a scope renders into its thread-list host (as ChatPage does). */
const mockSubRowLabels: { current: Record<string, string[]> } = { current: {} }
// The toast sink the last rendered pane sees through the column's context.
const paneToastSink: { current: AgentColumnToastSink | null } = { current: null }
const toastSinkOfPane = () => paneToastSink.current
const chatPageMock = vi.fn((props?: unknown) => {
  const typedProps = props as {
    active?: boolean
    storageScope?: string
    threadSubRowsHost?: HTMLElement | null
  }
  const subRowLabels = mockSubRowLabels.current[typedProps.storageScope ?? ''] ?? []
  paneToastSink.current = React.useContext(AgentColumnToastContext)

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
            <AgentThreadSubRow
              key={label}
              label={label}
              selected={index === 0}
              onSelect={() => {}}
            />
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
      // The column's toasts and trace messages read as a Chinese user reads them.
      if (key.startsWith('agent_workspace.toast.') || key.startsWith('agent_workspace.trace_')) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown> | undefined)?.[part],
            zhRenderer
          )
        if (typeof value === 'string') {
          return value.replace(/{{(\w+)}}/g, (_match, name: string) =>
            String(options?.[name] ?? '')
          )
        }
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

vi.mock('@renderer/features/projectTrace/ProjectTraceManagerPanel', async () => {
  const { AgentColumnToastContext: ToastContext } = await vi.importActual<
    typeof import('@renderer/hooks/agentColumnToastContext')
  >('@renderer/hooks/agentColumnToastContext')
  return {
    default: function MockTracePanel(props: { projectId?: string; projectName?: string }) {
      const sink = React.useContext(ToastContext)
      return (
        <div
          data-testid="mock-trace-panel"
          data-project-id={props.projectId}
          data-project-name={props.projectName}
          data-toast-sink={sink ? 'column' : 'none'}
        >
          mock trace panel
        </div>
      )
    }
  }
})

// The thread list reads a pane's stored conversations as summaries (this mock, named for the
// reader it replaced) and reads again only when the scope revision of the chat store moves.
const loadAllSessionsMock = vi.fn()
const scopeRevisionMock = vi.fn<(scope?: string) => number>()
let autoScopeRevision = 0

vi.mock('@renderer/pages/ChatPage/chatStorage', () => ({
  loadSessionPreviewSummaries: (...args: unknown[]) => loadAllSessionsMock(...args),
  getChatScopeRevision: (scope?: string) => scopeRevisionMock(scope)
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
    // A new revision on every call: every refresh reads the store, unless a test pins it.
    scopeRevisionMock.mockReset()
    scopeRevisionMock.mockImplementation(() => ++autoScopeRevision)
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

  it('keeps the workspace heading on one line in a header that holds the title block and the model slot', () => {
    renderWorkspace('海报项目')
    const heading = screen.getByText('agent_workspace.title')
    expect(getComputedStyle(heading).whiteSpace).toBe('nowrap')
    expect(getComputedStyle(heading).textOverflow).toBe('ellipsis')
    // No skills button host and no buttons of its own: the two text lines, then the slot that
    // the active conversation fills with its model pill.
    expect(document.getElementById('agent-workspace-skill-portal')).toBeNull()
    const header = screen.getByTestId('agent-workspace-header')
    expect(heading.parentElement!.parentElement).toBe(header)
    expect(header.querySelector('button, [role="button"]')).toBeNull()
    expect(Array.from(header.children)).toEqual([
      heading.parentElement,
      screen.getByTestId('agent-workspace-target-host'),
      screen.getByTestId('agent-workspace-model-host')
    ])
    expect(header).toHaveTextContent(/^agent_workspace\.title海报项目$/)
  })

  it('hands every pane one overlay layer that covers the column, header included', async () => {
    storePanes(2)
    renderWorkspace('海报项目')
    const host = screen.getByTestId('agent-workspace-overlay-host')
    const header = screen.getByTestId('agent-workspace-header')
    // Outside the header, over the whole column (a drawer's dimmed layer covers the header as
    // upstream's modal drawer does), and click-through while it is empty.
    expect(header).not.toContainElement(host)
    const style = getComputedStyle(host)
    expect(style.position).toBe('absolute')
    expect([style.top, style.left, style.right, style.bottom]).toEqual(['0px', '0px', '0px', '0px'])
    // The sheet itself starts below the header, whose height the layer hands on.
    expect(host.style.getPropertyValue('--agent-column-header-height')).toMatch(/^\d+(\.\d+)?px$/)
    expect(style.pointerEvents).toBe('none')
    expect(host).toBeEmptyDOMElement()
    await waitFor(() => {
      const latest = new Map<string, { overlayHost: HTMLElement | null }>()
      for (const [props] of chatPageMock.mock.calls) {
        const paneProps = props as { storageScope: string; overlayHost: HTMLElement | null }
        latest.set(paneProps.storageScope, paneProps)
      }
      expect(latest.size).toBe(2)
      for (const props of latest.values()) expect(props.overlayHost).toBe(host)
    })
    // While a drawer is open the header (model pill, target select) takes no input, so no
    // second drawer can be opened from it.
    expect(header).not.toHaveAttribute('inert')
    const drawer = document.createElement('div')
    act(() => host.append(drawer))
    await waitFor(() => expect(header).toHaveAttribute('inert'))
    act(() => drawer.remove())
    await waitFor(() => expect(header).not.toHaveAttribute('inert'))
  })

  it('wraps the header and hands every pane the same model slot, which stays empty without a pill', async () => {
    storePanes(2)
    renderWorkspace('海报项目')
    const header = screen.getByTestId('agent-workspace-header')
    const host = screen.getByTestId('agent-workspace-model-host')
    expect(getComputedStyle(header).flexWrap).toBe('wrap')
    expect(getComputedStyle(header).gap).toBe('8px')
    expect(getComputedStyle(header).padding).toBe('10px 12px')
    expect(getComputedStyle(host).maxWidth).toBe('100%')
    expect(host).toBeEmptyDOMElement()
    expect(screen.getByTestId('agent-workspace-target-host')).toBeEmptyDOMElement()

    await waitFor(() => {
      type PaneProps = {
        storageScope: string
        modelPillHost: HTMLElement | null
        teamTargetHost: HTMLElement | null
        active: boolean
      }
      const latest = new Map<string, PaneProps>()
      for (const [props] of chatPageMock.mock.calls) {
        latest.set((props as PaneProps).storageScope, props as PaneProps)
      }
      expect([...latest.keys()]).toEqual(['project-1.agent-1', 'project-1.agent-2'])
      for (const props of latest.values()) expect(props.modelPillHost).toBe(host)
      // The team target select of a thread with a team goes into the slot before the pill.
      for (const props of latest.values()) {
        expect(props.teamTargetHost).toBe(screen.getByTestId('agent-workspace-target-host'))
      }
      // Only one of them is active, so only one conversation fills the slot.
      expect([...latest.values()].filter((props) => props.active)).toHaveLength(1)
    })
  })

  it("has no trace or canvas target anywhere in the Agent column (owner's request)", async () => {
    renderWorkspace()
    const header = screen.getByText('agent_workspace.title').closest('div')!.parentElement!
    expect(header.querySelector('button')).toBeNull()
    expect(screen.queryByTestId('agent-workspace-trace-button')).not.toBeInTheDocument()
    await waitFor(() => expect(chatPageMock).toHaveBeenCalled())
    // The conversations get no workspace actions to put into a menu.
    for (const [props] of chatPageMock.mock.calls) expect(props).not.toHaveProperty('workspaceMenu')
    await waitFor(() => expect(loadAllSessionsMock).toHaveBeenCalled())
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
    const row = document.querySelector(
      '[data-agent-workspace-scope="project-1.agent-1"][role="button"]'
    )
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

  it('keeps the sub-rows of an inactive thread as a named group and lets its page activate it', async () => {
    storePanes(2)
    mockSubRowLabels.current = { 'project-1.agent-1': ['组长', '设计师'] }
    renderWorkspaceWithThreadList()
    await waitForThreadSummary('画布检查')
    const host = () =>
      document.querySelector<HTMLElement>('[data-agent-thread-sub-rows="agent-1"]')!
    await waitFor(() =>
      expect(host().querySelectorAll('[data-agent-thread-sub-row]')).toHaveLength(2)
    )
    // The group is named after its thread, so the rows of two team threads can be told apart.
    expect(host()).toHaveAttribute('role', 'group')
    expect(host()).toHaveAccessibleName('画布检查')
    expect(document.querySelector('[data-agent-thread-sub-rows="agent-2"]')).not.toHaveAttribute(
      'role'
    )

    fireEvent.click(getThreadRows()[1])
    await waitFor(() => expect(getThreadRows()[1]).toHaveAttribute('aria-current', 'true'))
    // The inactive thread keeps its rows and its bold label row.
    expect(host().querySelectorAll('[data-agent-thread-sub-row]')).toHaveLength(2)
    expect(getComputedStyle(screen.getAllByTestId('agent-thread-title')[0]).fontWeight).toBe('600')

    const firstPaneProps = () =>
      chatPageMock.mock.calls
        .map((call) => call[0] as { storageScope: string; active: boolean; onActivate: () => void })
        .filter((props) => props.storageScope === 'project-1.agent-1')
        .at(-1)!
    expect(firstPaneProps().active).toBe(false)
    act(() => firstPaneProps().onActivate())
    await waitFor(() => expect(getThreadRows()[0]).toHaveAttribute('aria-current', 'true'))
    expect(firstPaneProps().active).toBe(true)
  })

  it('makes a thread row bold only while conversations are listed under it', async () => {
    storePanes(2)
    mockSubRowLabels.current = { 'project-1.agent-1': ['主对话', '配色疑问'] }
    renderWorkspaceWithThreadList()
    await waitForThreadSummary('画布检查')
    const titles = () => screen.getAllByTestId('agent-thread-title')
    await waitFor(() =>
      expect(
        document.querySelectorAll(
          '[data-agent-thread-sub-rows="agent-1"] [data-agent-thread-sub-row]'
        )
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
      expect(
        container.querySelectorAll('[role="button"][data-agent-workspace-scope]')
      ).toHaveLength(2)
    })
    const rows = [
      ...container.querySelectorAll<HTMLElement>('[role="button"][data-agent-workspace-scope]')
    ]
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

  it.each(['Enter', ' '])(
    'closes the active thread from the keyboard with %s on the close row',
    async (key) => {
      const terminateScope = vi.fn()
      window.addEventListener('chat:terminate-scope', terminateScope as EventListener)
      try {
        renderWorkspaceWithThreadList()
        const close = screen.getByRole('button', { name: 'agent_workspace.close_thread' })
        expect(close.tagName).toBe('BUTTON')
        close.focus()
        await userEvent.keyboard(key === 'Enter' ? '{Enter}' : ' ')
        expect(terminateScope).toHaveBeenCalledTimes(1)
        expect(
          (terminateScope.mock.calls[0]?.[0] as CustomEvent<{ scope?: string }>).detail
        ).toEqual({ scope: 'project-1.agent-1' })
        expect(
          screen.queryByRole('button', { name: 'agent_workspace.close_thread' })
        ).not.toBeInTheDocument()
      } finally {
        window.removeEventListener('chat:terminate-scope', terminateScope as EventListener)
      }
    }
  )

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
    expect(screen.getByTestId('agent-thread-toggle')).toHaveAttribute(
      'title',
      '画布检查 · 配色疑问'
    )
    // The callback keeps its identity, so the chat page is not re-subscribed on every render.
    expect(propsOf().onThreadSubRowChange).toBe(handler)
    act(() => handler(null))
    expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(/^画布检查$/)
  })

  it("offers Refresh after New in the toolbar and runs the active pane's reload with it", async () => {
    renderWorkspace()
    const toolbar = screen.getByTestId('agent-thread-toolbar')
    const buttons = within(toolbar).getAllByRole('button')
    const refresh = within(toolbar).getByRole('button', { name: 'agent_workspace.refresh' })
    expect(buttons.at(-1)).toBe(refresh)
    expect(buttons.at(-2)).toBe(
      within(toolbar).getByRole('button', { name: 'agent_workspace.new_chat' })
    )
    const props = chatPageMock.mock.calls.at(-1)?.[0] as {
      onRegisterReload: (reload: (() => void) | null) => void
      statusLineHost: HTMLElement | null
    }
    // The pane draws its error line into the host under the toolbar.
    expect(props.statusLineHost).toBe(screen.getByTestId('agent-workspace-error-line-host'))
    const reload = vi.fn()
    act(() => props.onRegisterReload(reload))
    fireEvent.click(refresh)
    expect(reload).toHaveBeenCalledOnce()
    // Without a registered reload (the pane is gone), Refresh re-reads the thread list instead.
    act(() => props.onRegisterReload(null))
    const listener = vi.fn()
    window.addEventListener('chat:preview-refresh', listener)
    fireEvent.click(refresh)
    window.removeEventListener('chat:preview-refresh', listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('shows the messages its conversations raise as toasts of the column', async () => {
    renderWorkspace()
    await waitFor(() => expect(chatPageMock).toHaveBeenCalled())
    // Each pane is rendered inside the column's toast context.
    const sink = toastSinkOfPane()
    expect(sink).not.toBeNull()
    act(() => {
      sink?.push('warning', '团队状态冲突，已保留本地更改')
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/^警告：团队状态冲突，已保留本地更改×$/)
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

      // Column top to transcript: header, the toolbar section, the status line host (empty: it
      // draws nothing), then the pane host.
      expect([...root.children].indexOf(paneHost)).toBe(3)
      expect(root.children[2]).toBe(screen.getByTestId('agent-workspace-error-line-host'))
      expect(root.children[2]).toBeEmptyDOMElement()
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

      // The (empty) host of the error line follows that single divider and draws nothing.
      const errorHost = screen.getByTestId('agent-workspace-error-line-host')
      expect(region.nextElementSibling).toBe(errorHost)
      expect(border(errorHost, 'Bottom')).toBe('none')
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
        expect(getThreadRows().map((row) => row.textContent)).toEqual([
          '对话 1',
          '对话 2',
          '海报配色'
        ])
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
      expect(getThreadRows().map((row) => row.textContent)).toEqual([
        '对话 1',
        '对话 2',
        '海报配色'
      ])
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
      // The disclosure button is never left without a name while its summary is empty.
      const toggle = screen.getByTestId('agent-thread-toggle')
      expect(toggle).toHaveAccessibleName('agent_workspace.thread_list')
      expect(toggle).not.toHaveAttribute('title')
      await act(async () => {
        resolveSessions?.([{ id: 'session-1', title: '画布检查', messages: [] }])
      })
      await waitForThreadSummary('画布检查')
      expect(toggle).toHaveAccessibleName('画布检查')
      expect(toggle).toHaveAttribute('title', '画布检查')

      // A thread created here is known to have no conversation: it is numbered immediately.
      loadAllSessionsMock.mockImplementation((scope: string) =>
        Promise.resolve(
          scope === 'project-1.agent-1'
            ? [{ id: 'session-1', title: '画布检查', messages: [] }]
            : []
        )
      )
      fireEvent.click(screen.getByRole('button', { name: 'agent_workspace.new_chat' }))
      expect(screen.getByTestId('agent-thread-summary')).toHaveTextContent(/^对话 2$/)
      expect(getThreadRows().map((row) => row.textContent)).toEqual(['画布检查', '对话 2'])
      fireEvent.click(screen.getByRole('button', { name: 'agent_workspace.new_chat' }))
      expect(getThreadRows().map((row) => row.textContent)).toEqual([
        '画布检查',
        '对话 2',
        '对话 3'
      ])
      await waitFor(() => expect(loadAllSessionsMock).toHaveBeenCalledWith('project-1.agent-3'))
      await act(async () => {
        await Promise.resolve()
      })
      expect(getThreadRows().map((row) => row.textContent)).toEqual([
        '画布检查',
        '对话 2',
        '对话 3'
      ])
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

    it('replaces the composer with one muted line while no thread is open', async () => {
      localStorage.setItem(
        'agent.workspace.project-1',
        JSON.stringify([{ id: 'agent-1', enabled: false }])
      )
      renderWorkspace()

      const region = screen.getByTestId('agent-workspace-no-thread-composer')
      const line = region.querySelector('p')!
      expect(line).toHaveTextContent(/^agent_workspace\.no_thread_composer$/)
      expect(region.children).toHaveLength(1)
      expect(region.querySelector('button, textarea, input, [role="button"]')).toBeNull()
      expect(getComputedStyle(line).fontSize).toBe('12px')
      expect(getComputedStyle(line).color).toBe(testTheme.palette.text.secondary)
      expect(getComputedStyle(region).padding).toBe('8px')
      expect(getComputedStyle(region).borderTopWidth).toBe('1px')
      // The last region of the column, after the (empty) pane area.
      expect(region.previousElementSibling).toContainElement(
        screen.getByText('agent_workspace.no_active_conversation')
      )
      expect(screen.queryByTestId('mock-composer')).not.toBeInTheDocument()
      // No conversation, so nothing fills the model slot either.
      expect(screen.getByTestId('agent-workspace-model-host')).toBeEmptyDOMElement()

      expect(screen.getByTestId('agent-workspace-no-thread-composer')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'agent_workspace.new_chat' }))
      await waitFor(() => expect(screen.getByTestId('mock-composer')).toBeInTheDocument())
      expect(screen.queryByTestId('agent-workspace-no-thread-composer')).not.toBeInTheDocument()
    })

    it('keeps that line out of a column that has a thread', async () => {
      renderWorkspace()
      await waitForThreadSummary('画布检查')
      expect(screen.queryByTestId('agent-workspace-no-thread-composer')).not.toBeInTheDocument()
      expect(zhRenderer.agent_workspace.no_thread_composer).toBe('选择或新建一个线程开始对话')
      expect(enRenderer.agent_workspace.no_thread_composer).toBe(
        'Select or create a thread to start'
      )
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
      expect(getComputedStyle(screen.getByText('agent_workspace.title')).fontSize).toBe('14px')
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

  describe('reads of the chat store for the thread list', () => {
    const FIRST = 'project-1.agent-1'
    const SECOND = 'project-1.agent-2'
    let revisions: Record<string, number>
    let titles: Record<string, string>

    const shownTitles = () =>
      screen.getAllByTestId('agent-thread-title').map((title) => title.textContent)
    const settle = () =>
      act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

    beforeEach(() => {
      storePanes(2)
      revisions = {}
      titles = { [FIRST]: 'First thread', [SECOND]: 'Second thread' }
      scopeRevisionMock.mockImplementation((scope = 'default') => revisions[scope] ?? 0)
      loadAllSessionsMock.mockImplementation((scope: string) =>
        Promise.resolve([{ id: `${scope}-session`, title: titles[scope], createdAt: 1 }])
      )
    })

    it('reads a pane once and again only after its scope was written', async () => {
      const intervalSpy = vi.spyOn(window, 'setInterval')
      try {
        renderWorkspaceWithThreadList()
        await waitFor(() => expect(shownTitles()).toEqual(['First thread', 'Second thread']))
        expect(loadAllSessionsMock.mock.calls.map(([scope]) => scope).sort()).toEqual([
          FIRST,
          SECOND
        ])
        loadAllSessionsMock.mockClear()

        // Every kind of refresh while nothing was saved, including the 4 second poll.
        const pollTicks = intervalSpy.mock.calls
          .filter(([, delay]) => delay === 4000)
          .map(([tick]) => tick as () => void)
        expect(pollTicks.length).toBeGreaterThan(0)
        act(() => {
          pollTicks.at(-1)!()
          window.dispatchEvent(new CustomEvent('chat:preview-refresh'))
          window.dispatchEvent(
            new CustomEvent('chat:preview-refresh', {
              detail: { scope: FIRST, reason: 'preview-only' }
            })
          )
          window.dispatchEvent(new CustomEvent('send-to-agent'))
          window.dispatchEvent(new Event('storage'))
        })
        await settle()
        expect(loadAllSessionsMock).not.toHaveBeenCalled()
        expect(shownTitles()).toEqual(['First thread', 'Second thread'])

        // The run state does not come from the chat store and is still followed.
        act(() => {
          startScopedChatRun(SECOND, `${SECOND}-session`, 'run-while-cached')
        })
        await waitFor(() =>
          expect(within(getThreadRows()[1]).getByRole('progressbar')).toBeInTheDocument()
        )
        act(() => {
          dispatchScopedChatRunEvent(SECOND, `${SECOND}-session`, {
            runId: 'run-while-cached',
            status: 'completed'
          })
        })
        await waitFor(() =>
          expect(within(getThreadRows()[1]).queryByRole('progressbar')).not.toBeInTheDocument()
        )
        expect(loadAllSessionsMock).not.toHaveBeenCalled()

        // The second pane saves: its scope revision moves and its own event asks for a refresh.
        titles[SECOND] = 'Renamed thread'
        revisions[SECOND] = 1
        act(() => {
          window.dispatchEvent(
            new CustomEvent('chat:preview-refresh', {
              detail: { scope: SECOND, reason: 'storage-updated' }
            })
          )
        })
        await waitFor(() => expect(shownTitles()).toEqual(['First thread', 'Renamed thread']))
        expect(loadAllSessionsMock.mock.calls).toEqual([[SECOND]])

        // A save in the first pane is picked up by the next poll tick without any event.
        loadAllSessionsMock.mockClear()
        titles[FIRST] = 'First thread, renamed'
        revisions[FIRST] = 1
        act(() => pollTicks.at(-1)!())
        await waitFor(() =>
          expect(shownTitles()).toEqual(['First thread, renamed', 'Renamed thread'])
        )
        expect(loadAllSessionsMock.mock.calls).toEqual([[FIRST]])
      } finally {
        intervalSpy.mockRestore()
      }
    })

    it('reads again when a save lands while a read is still running', async () => {
      let releaseStaleRead!: () => void
      loadAllSessionsMock.mockImplementation((scope: string) => {
        const snapshot = [{ id: `${scope}-session`, title: titles[scope], createdAt: 1 }]
        if (scope !== SECOND || releaseStaleRead !== undefined) return Promise.resolve(snapshot)
        return new Promise((resolve) => {
          releaseStaleRead = () => resolve(snapshot)
        })
      })
      renderWorkspaceWithThreadList()
      await waitFor(() => expect(releaseStaleRead).toBeDefined())

      // The read took its snapshot before this save; its result must not be trusted afterwards.
      titles[SECOND] = 'Saved during the read'
      revisions[SECOND] = 1
      await act(async () => releaseStaleRead())
      await waitFor(() => expect(shownTitles()).toEqual(['First thread', 'Second thread']))

      act(() => {
        window.dispatchEvent(new CustomEvent('chat:preview-refresh', { detail: { scope: SECOND } }))
      })
      await waitFor(() => expect(shownTitles()).toEqual(['First thread', 'Saved during the read']))
    })

    it('does not keep a failed read and rechecks an unchanged scope after the safety interval', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const realNow = Date.now.bind(Date)
      let clockOffset = 0
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)
      try {
        loadAllSessionsMock.mockRejectedValueOnce(
          new DOMException('Broken record', 'NotReadableError')
        )
        loadAllSessionsMock.mockRejectedValueOnce(
          new DOMException('Broken record', 'NotReadableError')
        )
        renderWorkspaceWithThreadList()
        await waitFor(() => expect(loadAllSessionsMock).toHaveBeenCalledTimes(2))
        await settle()

        // Same revision, but the failed reads left nothing to reuse.
        act(() => {
          window.dispatchEvent(new CustomEvent('chat:preview-refresh'))
        })
        await waitFor(() => expect(shownTitles()).toEqual(['First thread', 'Second thread']))
        expect(loadAllSessionsMock).toHaveBeenCalledTimes(4)

        // A change the revision cannot see (a writer outside the chat storage module).
        loadAllSessionsMock.mockClear()
        titles[FIRST] = 'Changed behind the marker'
        act(() => {
          window.dispatchEvent(new CustomEvent('chat:preview-refresh'))
        })
        await settle()
        expect(loadAllSessionsMock).not.toHaveBeenCalled()
        clockOffset = 60_001
        act(() => {
          window.dispatchEvent(new CustomEvent('chat:preview-refresh'))
        })
        await waitFor(() =>
          expect(shownTitles()).toEqual(['Changed behind the marker', 'Second thread'])
        )
        // Each pane is read from the store itself, not from summaries kept in memory.
        expect(
          [...loadAllSessionsMock.mock.calls].sort(([a], [b]) => String(a).localeCompare(String(b)))
        ).toEqual([
          [FIRST, { fresh: true }],
          [SECOND, { fresh: true }]
        ])
      } finally {
        nowSpy.mockRestore()
        consoleError.mockRestore()
      }
    })
  })
})
