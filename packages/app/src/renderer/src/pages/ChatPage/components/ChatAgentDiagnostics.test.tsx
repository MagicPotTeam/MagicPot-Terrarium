import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDiagnosticsResponse } from '@shared/agentDiagnostics'
import ChatAgentDiagnostics from './ChatAgentDiagnostics'
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcLLMProxy: { inspectAgentCapabilities: inspect } })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const result = (name = 'web_search'): AgentDiagnosticsResponse => ({
  checkedAt: 1000,
  scope: 'local-catalog',
  tools: [{ name, registered: true }],
  modelInvocationTested: false,
  toolExecutionTested: false,
  network: { checked: false, kind: 'dns-only', results: [] }
})
const base = {
  request: { conversationId: 'session-a' },
  messages: [],
  running: false,
  enabled: true
}
const key = (text: string) => 'chat.agent_diagnostics.' + text
beforeEach(() => {
  inspect.mockReset()
  inspect.mockResolvedValue(result())
})

describe('current-thread capability panel', () => {
  it('treats a malformed response as an unavailable check rather than success', async () => {
    inspect.mockResolvedValueOnce({ scope: 'local-catalog', tools: 'PRIVATE_BAD_SHAPE' })
    render(<ChatAgentDiagnostics {...base} />)
    fireEvent.click(screen.getByRole('button', { name: key('open') }))
    await screen.findByText(key('error'))
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: key('check_dns') })).toBeDisabled()
  })

  it('does nothing while closed and only checks DNS on explicit request', async () => {
    render(<ChatAgentDiagnostics {...base} />)
    expect(inspect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: key('open') }))
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1))
    expect(inspect.mock.calls[0][0]).toEqual({ conversationId: 'session-a', checkDns: false })
    const dns = screen.getByRole('button', { name: key('check_dns') })
    await waitFor(() => expect(dns).toBeEnabled())
    fireEvent.click(dns)
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2))
    expect(inspect.mock.calls[1][0].checkDns).toBe(true)
    expect(screen.getByText(key('notice'))).toBeInTheDocument()
  })
  it('never sends hidden skill instructions or resources with a catalogue inspection', async () => {
    render(
      <ChatAgentDiagnostics
        {...base}
        request={
          {
            conversationId: 'a',
            skillRuntime: {
              skillId: 'skill',
              bindings: [{ appId: 'app', toolNames: [] }],
              instructions: { systemPrompt: 'PRIVATE_PROMPT' },
              resources: ['PRIVATE_RESOURCE']
            }
          } as never
        }
      />
    )
    fireEvent.click(screen.getByRole('button', { name: key('open') }))
    await waitFor(() => expect(inspect).toHaveBeenCalledOnce())
    expect(JSON.stringify(inspect.mock.calls)).not.toContain('PRIVATE')
  })
  it('ignores a late result after the current thread changes', async () => {
    let oldResolve!: (value: AgentDiagnosticsResponse) => void
    inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResolve = resolve
        })
    )
    const view = render(<ChatAgentDiagnostics {...base} />)
    fireEvent.click(screen.getByRole('button', { name: key('open') }))
    await waitFor(() => expect(inspect).toHaveBeenCalledOnce())
    inspect.mockResolvedValueOnce(result('new.thread.tool'))
    view.rerender(<ChatAgentDiagnostics {...base} request={{ conversationId: 'session-b' }} />)
    await screen.findByText(/new.thread.tool/)
    await act(async () => oldResolve(result('OLD_THREAD_TOOL')))
    expect(screen.queryByText(/OLD_THREAD_TOOL/)).not.toBeInTheDocument()
    expect(screen.getByText(/new.thread.tool/)).toBeInTheDocument()
  })
  it('does not display sensitive exception text or retain an old success on failure', async () => {
    render(<ChatAgentDiagnostics {...base} />)
    fireEvent.click(screen.getByRole('button', { name: key('open') }))
    await screen.findByText(/web_search/)
    inspect.mockRejectedValueOnce(new Error('PRIVATE_RESPONSE_BODY'))
    fireEvent.click(screen.getByRole('button', { name: key('refresh') }))
    await screen.findByText(key('error'))
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument()
    expect(screen.queryByText(/web_search/)).not.toBeInTheDocument()
  })
  it('reports policy blocks and uncertain receipts without replay controls', async () => {
    inspect.mockResolvedValueOnce({
      ...result(),
      network: {
        checked: true,
        kind: 'dns-only',
        results: [
          { host: 'api.duckduckgo.com', status: 'blocked_address', reason: 'reserved-benchmark' }
        ]
      }
    })
    render(
      <ChatAgentDiagnostics
        {...base}
        messages={[
          {
            role: 'assistant',
            content: '',
            toolHistory: [
              {
                runId: 'r',
                toolCallId: 'c',
                toolName: 'comfyui.generate',
                status: 'running',
                args: { key: 'PRIVATE_ARGS' },
                content: 'PRIVATE_CONTENT'
              }
            ]
          }
        ]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: key('open') }))
    await screen.findByText(key('fake_ip'))
    expect(screen.getByText(/receipt_unknown/)).toBeInTheDocument()
    expect(screen.getByText(key('replay_warning'))).toBeInTheDocument()
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument()
    expect(inspect).toHaveBeenCalledOnce()
  })
  it('does not crash the composer for an invalid saved capability configuration', async () => {
    render(<ChatAgentDiagnostics {...base} request={{ profileId: 'x'.repeat(300) }} />)
    fireEvent.click(screen.getByRole('button', { name: key('open') }))
    await screen.findByText(key('error'))
    expect(inspect).not.toHaveBeenCalled()
  })
  it('does not represent remote capabilities as locally disabled tools', async () => {
    inspect.mockResolvedValueOnce({ ...result(), scope: 'external-unverified', tools: [] })
    render(<ChatAgentDiagnostics {...base} />)
    fireEvent.click(screen.getByRole('button', { name: key('open') }))
    await screen.findByText(key('external'))
    expect(screen.queryByText(key('none'))).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: key('check_dns') })).toBeDisabled()
  })
})
