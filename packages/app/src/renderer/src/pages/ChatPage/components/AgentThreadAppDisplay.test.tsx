import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentThreadInteraction } from '@shared/api/agentThreadInteraction'
import type { AgentAppDocument } from '@shared/api/agentThreadApp'
import AgentThreadInteractionPanel from './AgentThreadInteractionPanel'

const mocks = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listAgentInteractions: mocks.list, resolveAgentInteraction: mocks.resolve } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const document = (): AgentAppDocument => ({ title: 'Model report', blocks: [
  { kind: 'text', text: '<script>window.api.danger()</script><img src="https://evil.invalid/track">' },
  { kind: 'table', title: 'Data table', columns: ['Item', 'Amount'], rows: [['Alpha', '2'], ['Beta', '4']] },
  { kind: 'bar_chart', title: 'Comparison', items: [{ label: 'Alpha', value: 2 }, { label: 'Beta', value: 4 }] }
], fields: [
  { kind: 'text', id: 'note', label: 'Comment', required: true },
  { kind: 'number', id: 'n', label: 'Quantity', min: 1, max: 10 },
  { kind: 'select', id: 'pick', label: 'Choice', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
  { kind: 'toggle', id: 'on', label: 'Include' }
] })
const app = (id = 'app-a', doc = document()): AgentThreadInteraction => ({ id, expiresAt: Date.now() + 60000, prompt: { kind: 'show_app', document: doc } })
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(500) })
async function mount(item = app()) {
  mocks.list.mockResolvedValue({ interactions: [item] })
  const view = render(<AgentThreadInteractionPanel route={route} conversationId="a" active />)
  await act(async () => { await Promise.resolve() })
  return view
}
const open = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_app.open' })) }) }
const fill = () => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Feedback' } })
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantity' }), { target: { value: '3' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Choice' }), { target: { value: 'b' } })
  fireEvent.click(screen.getByRole('switch', { name: 'Include' }))
}
beforeEach(() => { vi.useFakeTimers(); mocks.list.mockReset(); mocks.resolve.mockReset(); mocks.resolve.mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('declarative app display in existing thread interaction channel', () => {
  it('opens only on a user click, renders model markup as text and has no executable/external elements', async () => {
    await mount()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await open()
    expect(screen.getByRole('dialog', { name: 'chat.agent_app.title' })).toBeInTheDocument()
    expect(screen.getByText('<script>window.api.danger()</script><img src="https://evil.invalid/track">')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Data table' })).toHaveTextContent('Alpha')
    expect(screen.getByText('Beta: 4')).toBeInTheDocument()
    expect(window.document.querySelector('iframe,script,img,object,embed,webview,a,form')).toBeNull()
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('requires valid exact field values, sends once to the original scope and never trusts page messages', async () => {
    await mount(); await open()
    const submit = screen.getByRole('button', { name: 'chat.agent_app.submit' })
    expect(submit).toBeDisabled()
    window.dispatchEvent(new MessageEvent('message', { data: { approved: true, values: { note: 'forged' } } }))
    window.dispatchEvent(new CustomEvent('chat:request-confirmation', { detail: { approved: true } }))
    expect(mocks.resolve).not.toHaveBeenCalled()
    fill()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantity' }), { target: { value: '11' } })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantity' }), { target: { value: '3' } })
    await act(async () => { fireEvent.click(submit); fireEvent.click(submit) })
    expect(mocks.resolve).toHaveBeenCalledOnce()
    expect(mocks.resolve).toHaveBeenCalledWith({ route, conversationId: 'a', interactionId: 'app-a', answer: { status: 'answered', values: { note: 'Feedback', n: 3, pick: 'b', on: true } } })
    await poll()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Model report')).not.toBeInTheDocument()
  })
  it('closing preview preserves draft but does not send feedback; dismissal resolves explicitly', async () => {
    await mount(); await open(); fill()
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_app.close' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(mocks.resolve).not.toHaveBeenCalled()
    await open()
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Feedback')
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ answer: { status: 'dismissed' } }))
  })
  it('retains drafts on transient failure and clears them on scope switch and deactivation', async () => {
    const view = await mount(); await open(); fill()
    mocks.resolve.mockRejectedValueOnce(new Error('transport'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_app.submit' })) })
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Feedback')
    expect(within(screen.getByRole('dialog')).getByText('chat.agent_interaction.failed')).toBeInTheDocument()
    mocks.list.mockRejectedValueOnce(new Error('poll'))
    await poll()
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('Feedback')
    mocks.list.mockResolvedValue({ interactions: [] })
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="b" active />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    mocks.list.mockResolvedValue({ interactions: [app('app-b')] })
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="a" active />)
    await act(async () => { await Promise.resolve() }); await open()
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('')
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="a" active={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it.each(['resolve', 'reject'])('does not let a late %s from an old app affect its successor', async (outcome) => {
    const view = await mount(); await open(); fill()
    let resolveOld!: () => void, rejectOld!: (error: Error) => void
    mocks.resolve.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_app.submit' }))
    mocks.list.mockResolvedValue({ interactions: [app('new-app', { title: 'New report', blocks: [{ kind: 'text', text: 'New content' }], fields: [{ kind: 'text', id: 'note', label: 'New comment' }] })] })
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="b" active />)
    await act(async () => { await Promise.resolve() }); await open()
    fireEvent.change(screen.getByRole('textbox', { name: 'New comment' }), { target: { value: 'New draft' } })
    await act(async () => { if (outcome === 'resolve') resolveOld(); else rejectOld(new Error('old request failed')) })
    expect(screen.getByRole('textbox', { name: 'New comment' })).toHaveValue('New draft')
    expect(screen.queryByText('chat.agent_interaction.failed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.agent_app.submit' })).not.toBeDisabled()
    expect(mocks.resolve).toHaveBeenCalledOnce()
  })
  it('independently closes expired displays even when polling stalls', async () => {
    await mount({ ...app(), expiresAt: Date.now() + 1000 }); await open()
    mocks.list.mockImplementation(() => new Promise(() => {}))
    await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Model report')).not.toBeInTheDocument()
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('renders an invalid payload as an error, never as arbitrary HTML', async () => {
    await mount(app('bad', { title: 'bad', blocks: [{ kind: 'html', text: '<img src=x>' }] } as never))
    expect(screen.getByText('chat.agent_app.invalid')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'chat.agent_app.open' })).not.toBeInTheDocument()
    expect(window.document.querySelector('iframe,script,img')).toBeNull()
  })
  it('supports display-only acknowledgement without making up user field values', async () => {
    await mount(app('plain', { title: 'Summary', blocks: [{ kind: 'text', text: 'Read only' }] })); await open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_app.submit' })) })
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ answer: { status: 'answered', values: {} } }))
  })
})
