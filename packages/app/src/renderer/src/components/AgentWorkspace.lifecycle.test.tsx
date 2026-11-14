import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AgentWorkspace from './AgentWorkspace'
import { forgetPaneTitles } from './agentPaneTitleMemory'
import {
  clearScopedActiveLoadingSessionIds,
  clearScopedChatPageRunLifecycles,
  clearScopedExternalLoadingSessionIds,
  dispatchScopedChatRunEvent,
  readScopedChatRun,
  startScopedChatRun
} from '@renderer/pages/ChatPage/chatPageShared'

const SCOPE = 'project-lifecycle.agent-1'
const OTHER_SCOPE = 'other-project.agent-1'
const SESSION_ID = 'same-session-id'

const fixture = vi.hoisted(() => ({
  chatPageMock: vi.fn(),
  loadAllSessionsMock: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; index?: number }) => {
      if (key === 'agent_workspace.chat_label') return `Agent thread ${options?.index ?? ''}`.trim()
      return options?.defaultValue || key
    },
    i18n: { resolvedLanguage: 'en' }
  })
}))

vi.mock('@renderer/pages/ChatPage/ChatPage', () => ({
  default: (props: { active?: boolean; storageScope?: string }) => {
    fixture.chatPageMock(props)
    return (
      <div
        data-testid="lifecycle-chat-page"
        data-active={String(props.active ?? true)}
        data-storage-scope={props.storageScope}
      />
    )
  }
}))

vi.mock('@renderer/pages/ChatPage/chatStorage', () => ({
  loadAllSessions: (...args: unknown[]) => fixture.loadAllSessionsMock(...args)
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
  default: () => <div data-testid="lifecycle-trace-panel" />
}))

const lifecycleTheme = createTheme()

const renderWorkspace = () =>
  render(
    <ThemeProvider theme={lifecycleTheme}>
      <AgentWorkspace projectId="project-lifecycle" />
    </ThemeProvider>
  )

/** Normalizes a CSS colour the way jsdom reports computed colours. */
const cssColor = (value: string): string => {
  const probe = document.createElement('span')
  probe.style.backgroundColor = value
  return probe.style.backgroundColor
}

const getPaneRow = (): HTMLElement => {
  const row = document.querySelector(`[data-agent-workspace-scope="${SCOPE}"][role="button"]`)
  if (!(row instanceof HTMLElement)) throw new Error('Agent lifecycle pane row is not mounted')
  return row
}

const getPaneStatus = (): HTMLElement => {
  const status = getPaneRow().querySelector('[data-testid="agent-thread-status"]')
  if (!(status instanceof HTMLElement))
    throw new Error('Agent lifecycle status indicator is not mounted')
  return status
}

const waitForPane = async (): Promise<void> => {
  await waitFor(() => {
    expect(fixture.loadAllSessionsMock).toHaveBeenCalledWith(SCOPE)
    expect(screen.getByTestId('lifecycle-chat-page')).toHaveAttribute('data-storage-scope', SCOPE)
    expect(getPaneStatus()).toBeInTheDocument()
  })
}

const dispatchStatus = (
  runId: string,
  status: 'waiting-tool' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
) => dispatchScopedChatRunEvent(SCOPE, SESSION_ID, { runId, status })

beforeEach(() => {
  forgetPaneTitles()
  localStorage.clear()
  // The thread list starts collapsed; these tests read the status dot of a list row.
  localStorage.setItem('agent.workspace.threadsCollapsed.project-lifecycle', '0')
  clearScopedChatPageRunLifecycles()
  clearScopedActiveLoadingSessionIds()
  clearScopedExternalLoadingSessionIds()
  fixture.chatPageMock.mockClear()
  fixture.loadAllSessionsMock.mockReset()
  fixture.loadAllSessionsMock.mockResolvedValue([
    {
      id: SESSION_ID,
      title: 'Lifecycle fixture',
      messages: [{ role: 'assistant', content: 'Existing session preview' }]
    }
  ])
})

afterEach(() => {
  cleanup()
  clearScopedChatPageRunLifecycles()
  clearScopedActiveLoadingSessionIds()
  clearScopedExternalLoadingSessionIds()
  localStorage.clear()
})

describe('AgentWorkspace real scoped run lifecycle DOM', () => {
  it.each([
    ['waiting-tool', 'waiting-tool'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted']
  ] as const)(
    'renders the %s state',
    async (_label, status) => {
      renderWorkspace()
      await waitForPane()

      await act(async () => {
        startScopedChatRun(SCOPE, SESSION_ID, `run-${status}`)
        dispatchStatus(`run-${status}`, status)
      })

      await waitFor(() => {
        expect(getPaneStatus()).toHaveAttribute('data-run-status', status)
        expect(getPaneStatus()).toHaveAttribute('data-status', status)
      })
      expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
        runId: `run-${status}`,
        status,
        unread: false
      })
    }
  )

  it.each([
    ['running', 'success', 'progressbar', 'agent_workspace.status_running'],
    ['waiting-tool', 'warning', 'img', 'agent_workspace.status_waiting_tool'],
    ['failed', 'error', 'img', 'agent_workspace.status_failed'],
    ['cancelled', 'muted', 'img', 'agent_workspace.status_cancelled'],
    ['interrupted', 'muted', 'img', 'agent_workspace.status_interrupted']
  ] as const)(
    'colours the %s dot with the %s tone and names it for assistive technology',
    async (status, tone, role, label) => {
      renderWorkspace()
      await waitForPane()

      await act(async () => {
        startScopedChatRun(SCOPE, SESSION_ID, `tone-${status}`)
        if (status !== 'running') dispatchStatus(`tone-${status}`, status)
      })

      await waitFor(() => expect(getPaneStatus()).toHaveAttribute('data-run-status', status))
      const expected =
        tone === 'muted' ? lifecycleTheme.palette.text.secondary : lifecycleTheme.palette[tone].main
      expect(getComputedStyle(getPaneStatus()).backgroundColor).toBe(cssColor(expected))
      expect(getComputedStyle(getPaneStatus()).width).toBe('7px')
      expect(getPaneStatus()).toHaveAttribute('role', role)
      expect(getPaneStatus()).toHaveAttribute('aria-label', label)
    }
  )

  it('shows a completed run as idle and keeps completed in data-run-status', async () => {
    renderWorkspace()
    await waitForPane()

    await act(async () => {
      startScopedChatRun(SCOPE, SESSION_ID, 'completed-run')
      dispatchStatus('completed-run', 'completed')
    })

    await waitFor(() => {
      expect(getPaneStatus()).toHaveAttribute('data-run-status', 'completed')
      expect(getPaneStatus()).toHaveAttribute('data-status', 'idle')
    })
    // The thread list has no unread marker: a finished reply looks like any idle thread.
    expect(getPaneStatus()).toHaveAttribute('aria-label', 'agent_workspace.status_idle')
    expect(getPaneStatus()).toHaveAttribute('role', 'img')
    expect(
      getComputedStyle(getPaneRow().querySelector('[data-testid="agent-thread-title"]')!).fontWeight
    ).toBe('400')
    expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
      runId: 'completed-run',
      status: 'completed'
    })
  })

  it('ignores an old run terminal event and duplicate running after a newer run terminal state', async () => {
    renderWorkspace()
    await waitForPane()

    await act(async () => {
      startScopedChatRun(SCOPE, SESSION_ID, 'old-run')
      startScopedChatRun(SCOPE, SESSION_ID, 'new-run')
    })

    await waitFor(() => expect(getPaneStatus()).toHaveAttribute('data-run-status', 'running'))

    let staleTerminal: ReturnType<typeof dispatchStatus> | undefined
    await act(async () => {
      staleTerminal = dispatchScopedChatRunEvent(SCOPE, SESSION_ID, {
        runId: 'old-run',
        status: 'failed'
      })
    })
    expect(staleTerminal).toBeNull()
    expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
      runId: 'new-run',
      status: 'running',
      unread: false
    })
    expect(getPaneStatus()).toHaveAttribute('data-run-status', 'running')

    await act(async () => {
      dispatchStatus('new-run', 'failed')
    })
    await waitFor(() => {
      expect(getPaneStatus()).toHaveAttribute('data-run-status', 'failed')
      expect(getPaneStatus()).toHaveAttribute('data-status', 'failed')
    })

    let duplicateRunning: ReturnType<typeof dispatchStatus> | undefined
    await act(async () => {
      duplicateRunning = dispatchStatus('new-run', 'running')
    })
    expect(duplicateRunning).toEqual(
      expect.objectContaining({ runId: 'new-run', status: 'failed', unread: false })
    )
    expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
      runId: 'new-run',
      status: 'failed',
      unread: false
    })
    expect(getPaneStatus()).toHaveAttribute('data-run-status', 'failed')
    expect(getPaneStatus()).toHaveAttribute('data-status', 'failed')
  })

  it('does not let another scope with the same session id change this pane', async () => {
    renderWorkspace()
    await waitForPane()

    expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
      runId: null,
      status: 'idle',
      unread: false
    })

    await act(async () => {
      startScopedChatRun(OTHER_SCOPE, SESSION_ID, 'other-scope-run')
      dispatchScopedChatRunEvent(OTHER_SCOPE, SESSION_ID, {
        runId: 'other-scope-run',
        status: 'completed'
      })
    })

    expect(readScopedChatRun(OTHER_SCOPE, SESSION_ID)).toMatchObject({
      runId: 'other-scope-run',
      status: 'completed',
      unread: true
    })
    expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
      runId: null,
      status: 'idle',
      unread: false
    })
    expect(getPaneStatus()).toHaveAttribute('data-run-status', 'idle')
    expect(getPaneStatus()).toHaveAttribute('data-status', 'idle')
    expect(fixture.loadAllSessionsMock).not.toHaveBeenCalledWith(OTHER_SCOPE)
  })
})
