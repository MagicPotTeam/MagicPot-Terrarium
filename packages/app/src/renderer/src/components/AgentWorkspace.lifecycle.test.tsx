import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AgentWorkspace from './AgentWorkspace'
import {
  clearScopedActiveLoadingSessionIds,
  clearScopedChatPageRunLifecycles,
  clearScopedExternalLoadingSessionIds,
  dispatchScopedChatRunEvent,
  markScopedChatRunRead,
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

const renderWorkspace = () =>
  render(
    <ThemeProvider theme={createTheme()}>
      <AgentWorkspace projectId="project-lifecycle" />
    </ThemeProvider>
  )

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
  localStorage.clear()
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
    'renders the %s state without manufacturing unread output',
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
      expect(getPaneStatus()).not.toHaveAttribute('data-status', 'unread')
      expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
        runId: `run-${status}`,
        status,
        unread: false
      })
    }
  )

  it('keeps completed in data-run-status while mark-read changes only unread presentation', async () => {
    renderWorkspace()
    await waitForPane()

    await act(async () => {
      startScopedChatRun(SCOPE, SESSION_ID, 'completed-run')
      dispatchStatus('completed-run', 'completed')
    })

    await waitFor(() => {
      expect(getPaneStatus()).toHaveAttribute('data-run-status', 'completed')
      expect(getPaneStatus()).toHaveAttribute('data-status', 'unread')
    })
    expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
      status: 'completed',
      unread: true
    })

    await act(async () => {
      markScopedChatRunRead(SCOPE, SESSION_ID, 'completed-run')
    })

    await waitFor(() => {
      expect(getPaneStatus()).toHaveAttribute('data-run-status', 'completed')
      expect(getPaneStatus()).toHaveAttribute('data-status', 'read')
    })
    expect(readScopedChatRun(SCOPE, SESSION_ID)).toMatchObject({
      runId: 'completed-run',
      status: 'completed',
      unread: false
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
    expect(getPaneStatus()).toHaveAttribute('data-status', 'read')
    expect(fixture.loadAllSessionsMock).not.toHaveBeenCalledWith(OTHER_SCOPE)
  })
})
