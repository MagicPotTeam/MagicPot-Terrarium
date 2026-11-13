import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import type { AgentThreadInteraction } from '@shared/api/agentThreadInteraction'
import AgentThreadInteractionPanel from './AgentThreadInteractionPanel'

const mocks = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listAgentInteractions: mocks.list, resolveAgentInteraction: mocks.resolve } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const question = (id = 'question-a'): AgentThreadInteraction => ({ id, expiresAt: Date.now() + 60000, prompt: { kind: 'ask_user', question: `Question ${id}`, multiline: true } })
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(500) })
const mount = async (item = question()) => {
  mocks.list.mockResolvedValue({ interactions: [item] })
  const view = render(<AgentThreadInteractionPanel route={route} conversationId="a" active />)
  await act(async () => { await Promise.resolve() })
  return view
}
beforeEach(() => { vi.useFakeTimers(); mocks.list.mockReset(); mocks.resolve.mockReset(); mocks.resolve.mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Agent thread interaction UI', () => {
  it('formats only body Markdown while keeping every context and an approve-named choice inert until its exact click', async () => {
    const body = '**Body strong** and *Body emphasis* and ~~Body removed~~\n\n> Body quote\n\n- Body list\n\n```mermaid\nflowchart TD\nA-->B\n```\n\n| Key | Value |\n| --- | --- |\n| Body table | Data |', prompt = { kind: 'show_card' as const, title: '**Literal title**', icon: '*I*', subtitle: '*Literal subtitle*', footer: '**Literal footer**', fields: [{ label: '*Label*', value: '**Literal field**' }], body, accent: 'success' as const, actions: [{ id: 'approve', label: '**Explicit feedback**', style: 'primary' as const }] }
    await mount({ id: 'body-format', expiresAt: Date.now() + 60000, prompt })
    expect(screen.getByText('Body strong').tagName).toBe('STRONG'); expect(screen.getByText('Body emphasis').tagName).toBe('EM'); expect(screen.getByText('Body removed').tagName).toBe('DEL'); expect(screen.getByText('Body quote').closest('blockquote')).not.toBeNull(); expect(screen.getByText('Body list').closest('li')).not.toBeNull(); expect(screen.getByText('Body table').closest('td')).not.toBeNull()
    expect(screen.getByText(/flowchart TD/).tagName).toBe('CODE'); expect(screen.getByText(/flowchart TD/).closest('pre')).not.toBeNull()
    for (const text of [prompt.title, prompt.subtitle, prompt.footer, '*Label*: **Literal field**']) expect(screen.getByText(text).querySelector('strong,em')).toBeNull()
    expect(screen.getByText(prompt.icon)).toHaveAttribute('aria-hidden', 'true'); expect(screen.queryByRole('heading')).not.toBeInTheDocument(); expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(screen.getAllByRole('button')).toHaveLength(2); expect(document.querySelector('a,img,script,input,textarea,svg')).toBeNull(); expect(mocks.resolve).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: prompt.actions[0].label })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'body-format', answer: { status: 'answered', actionId: 'approve' } }); expect(prompt.body).toBe(body)
  })
  it('reduces body links, images and task boxes to read-only text without introducing another input or feedback button', async () => {
    const body = '[Visible label](https://external.invalid/link)\n\n![Visible alt](file:///private/probe.png)\n\n- [x] Body completed task\n- [ ] Body pending task\n\n<img src="https://external.invalid/raw">'
    await mount({ id: 'body-inert', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Original feedback title', body, actions: [{ id: 'a', label: 'Only offered feedback' }] } })
    expect(screen.getByText('Visible label')).toBeInTheDocument(); expect(screen.getByText('Visible alt')).toBeInTheDocument(); expect(screen.getByText(/\[x\] Body completed task/)).toBeInTheDocument(); expect(screen.getByText(/\[ \] Body pending task/)).toBeInTheDocument(); expect(screen.getByText('<img src="https://external.invalid/raw">')).toBeInTheDocument()
    expect(document.querySelector('a,img,input,textarea,script,iframe,svg')).toBeNull(); expect(screen.getAllByRole('button')).toHaveLength(2); expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('redacts entity-decoded and inline-split credentials from body display without rewriting feedback data', async () => {
    const body = 'Public **safe** prefix\n\n&#x42;ea**rer** ENTITY_BODY_SECRET', prompt = { kind: 'show_card' as const, title: 'Body redaction', body, actions: [{ id: 'a', label: 'Explicit feedback' }] }
    await mount({ id: 'body-decoded', expiresAt: Date.now() + 60000, prompt })
    expect(document.body.textContent).toContain('Bearer [redacted]'); expect(document.body.textContent).not.toContain('ENTITY_BODY_SECRET'); expect(screen.getByText(/Public safe prefix/).querySelector('strong')).toBeNull(); expect(prompt.body).toBe(body); expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it.each([undefined, null, false, 1, {}, [], ['✓'], Object('✓'), { toJSON: () => '✓' }, { toString: () => '✓' }, 'x'.repeat(65), '😀'.repeat(33), '', '  ', '\n\t', '\u0001\u202e'])('omits empty or forged live icon decoration without spacing, conversion, resources or default %#', async icon => {
    const prompt = { kind: 'show_card' as const, title: 'Original undecorated title', icon, actions: [{ id: 'a', label: 'A' }] }
    await mount({ id: 'icon-fallback', expiresAt: Date.now() + 60000, prompt } as never)
    const title = screen.getByText(prompt.title); expect(title.textContent).toBe(prompt.title); expect(title.querySelector('span')).toBeNull(); expect(title.querySelector('[aria-hidden]')).toBeNull()
    expect(document.querySelector('img,a,script,input,textarea')).toBeNull(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(screen.getAllByRole('button')).toHaveLength(2)
  })
  it('ignores inherited icon and never invokes malformed icon conversion hooks', async () => {
    const toJSON = vi.fn(() => '✓'), toString = vi.fn(() => '✓'), prompt = Object.assign(Object.create({ icon: 'INHERITED_ICON_IGNORE' }), { kind: 'show_card' as const, title: 'Own icon only', actions: [{ id: 'a', label: 'A' }] })
    const view = await mount({ id: 'icon-own', expiresAt: Date.now() + 60000, prompt })
    expect(screen.queryByText('INHERITED_ICON_IGNORE')).not.toBeInTheDocument(); expect(screen.getByText(prompt.title).querySelector('span')).toBeNull(); view.unmount()
    for (const icon of [{ toJSON, toString }, Object.assign(Object('✓'), { toJSON, toString })]) {
      const next = await mount({ id: 'icon-hooks', expiresAt: Date.now() + 60000, prompt: { ...prompt, icon } } as never)
      expect(screen.getByText(prompt.title).querySelector('span')).toBeNull(); next.unmount()
    }
    expect(toJSON).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it.each(['primary', 'secondary', 'danger'] as const)('redacts icon decoration only, preserving original title, fixed button styles and actual status independence style=%s', async style => {
    const icon = '\u001b[31mBearer ICON_UI_SECRET\u001b[0m\u202e', prompt = { kind: 'show_card' as const, title: 'Accessible unchanged title', icon, subtitle: '', footer: 'Closing context', fields: [{ label: 'State', value: 'Not approval' }], accent: 'success' as const, actions: [{ id: 'approve', label: 'Explicit feedback', style }] }
    await mount({ id: 'icon-styles', expiresAt: Date.now() + 60000, prompt })
    const mark = screen.getByText('Bearer [redacted]'), title = screen.getByText(prompt.title), button = screen.getByRole('button', { name: 'Explicit feedback' })
    expect(title).toHaveAccessibleName(''); expect(title.textContent).toBe('Bearer [redacted]' + prompt.title); expect(mark).toHaveAttribute('aria-hidden', 'true'); expect(title.firstChild).toBe(mark)
    expect(button).toHaveClass(style === 'secondary' ? 'MuiButton-outlined' : 'MuiButton-contained', style === 'danger' ? 'MuiButton-colorError' : 'MuiButton-colorPrimary')
    expect(screen.getByRole('region')).not.toHaveAttribute('icon'); expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('ICON_UI_SECRET'); expect(document.body.textContent).not.toContain('\u202e'); expect(prompt.icon).toBe(icon); expect(mocks.resolve).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(button) }); expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'icon-styles', answer: { status: 'answered', actionId: 'approve' } })
  })
  it.each(['dismiss', 'expiry'] as const)('keeps decorative icons passive during %s', async ending => {
    await mount({ id: 'icon-end', expiresAt: Date.now() + 10, prompt: { kind: 'show_card', title: 'Decorative icon lifetime', icon: '✓👩🏽‍💻', actions: [{ id: 'a', label: 'Explicit feedback', style: 'danger' }] } })
    expect(screen.getByText('✓👩🏽‍💻')).toHaveAttribute('aria-hidden', 'true'); expect(mocks.resolve).not.toHaveBeenCalled()
    if (ending === 'dismiss') { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) }); expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'icon-end', answer: { status: 'dismissed' } }) }
    else { await act(async () => { await vi.advanceTimersByTimeAsync(10) }); for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Explicit feedback' })); expect(mocks.resolve).not.toHaveBeenCalled() }
  })
  it.each(['resolve', 'reject'] as const)('does not duplicate an icon choice or let late %s affect a replacement scope', async ending => {
    const item: AgentThreadInteraction = { id: 'icon-old', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Old icon title', icon: '✓', actions: [{ id: 'approve', label: 'Old explicit feedback', style: 'primary' }] } }, view = await mount(item)
    let release!: () => void, reject!: (error: Error) => void
    mocks.resolve.mockImplementationOnce(() => new Promise<void>((resolve, fail) => { release = resolve; reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'Old explicit feedback' })); fireEvent.click(screen.getByRole('button', { name: 'Old explicit feedback' })); expect(mocks.resolve).toHaveBeenCalledOnce()
    mocks.list.mockResolvedValue({ interactions: [{ ...item, id: 'icon-new', prompt: { ...item.prompt, title: 'New icon title', icon: '👩🏽‍💻', actions: [{ id: 'no', label: 'New explicit feedback' }] } }] })
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="b" active />); await act(async () => { await Promise.resolve() })
    await act(async () => { if (ending === 'resolve') release(); else reject(new Error('old request failed')); await Promise.resolve() })
    expect(screen.getByText('👩🏽‍💻')).toHaveAttribute('aria-hidden', 'true'); expect(screen.getByText('New icon title')).toBeInTheDocument(); expect(screen.queryByText('Old icon title')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New explicit feedback' })).not.toBeDisabled(); expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(mocks.resolve).toHaveBeenCalledOnce()
  })
  it.each(['✓', '👩🏽‍💻', '<img src="https://external.invalid/i">'])('renders a decorative escaped text icon before the original live title, never status, resource or approval %#', async icon => {
    const prompt = { kind: 'show_card' as const, title: 'Original feedback title', icon, actions: [{ id: 'approve', label: 'Explicit feedback' }] }
    await mount({ id: 'icon-choice', expiresAt: Date.now() + 60000, prompt })
    const mark = screen.getByText(icon), title = screen.getByText(prompt.title)
    expect(mark.tagName).toBe('SPAN'); expect(mark).toHaveAttribute('aria-hidden', 'true'); expect(title.contains(mark)).toBe(true)
    expect(title.textContent).toBe(icon + prompt.title)
    expect(screen.getAllByRole('button')).toHaveLength(2); expect(mocks.resolve).not.toHaveBeenCalled(); expect(document.querySelector('img,a,script,input,textarea')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Explicit feedback' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'icon-choice', answer: { status: 'answered', actionId: 'approve' } })
    expect(prompt.icon).toBe(icon)
  })
  it.each((['light', 'dark'] as const).flatMap(mode => ['primary', 'secondary', 'danger'].map(style => [mode, style] as const)))('uses only fixed custom-theme button variants/colors independent of card accent mode=%s style=%s', async (mode, style) => {
    const theme = createTheme({ palette: { mode, primary: { main: '#13579b' }, error: { main: '#579bdf' }, success: { main: '#3579bd' } } })
    const prompt = { kind: 'show_card' as const, title: 'Button styling only', accent: 'success' as const, footer: 'Bearer STYLE_UI_SECRET', actions: [{ id: 'approve', label: 'Styled feedback', style }] }
    mocks.list.mockResolvedValue({ interactions: [{ id: 'theme-style', expiresAt: Date.now() + 60000, prompt }] })
    render(<ThemeProvider theme={theme}><AgentThreadInteractionPanel route={route} conversationId="a" active /></ThemeProvider>)
    await act(async () => { await Promise.resolve() })
    const button = screen.getByRole('button', { name: 'Styled feedback' }), color = style === 'danger' ? '#579bdf' : '#13579b'
    expect(button).toHaveClass(style === 'secondary' ? 'MuiButton-outlined' : 'MuiButton-contained', style === 'danger' ? 'MuiButton-colorError' : 'MuiButton-colorPrimary')
    // MUI uses these theme-bound CSS variables; JSDOM does not resolve var() to RGB.
    expect(getComputedStyle(button).getPropertyValue(style === 'secondary' ? '--variant-outlinedColor' : '--variant-containedBg').trim()).toBe(color)
    expect(screen.getByRole('region')).toHaveStyle({ borderColor: '#3579bd' })
    expect(screen.getAllByRole('button')).toHaveLength(2); expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('STYLE_UI_SECRET'); expect(prompt.footer).toContain('STYLE_UI_SECRET')
    expect(mocks.resolve).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(button) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'theme-style', answer: { status: 'answered', actionId: 'approve' } })
  })
  it.each([undefined, null, false, 1, {}, [], Object('primary'), { toJSON: () => 'primary' }, { toString: () => 'primary' }, 'link', 'error', 'Primary', 'primary ', '#f00', 'url(https://external.invalid)', 'constructor', '__proto__'])('never forwards forged button style or turns it into URL/answer authority %#', async style => {
    const prompt = { kind: 'show_card' as const, title: 'Forged style fallback', actions: [{ id: 'a', label: 'Original feedback', style }] }
    mocks.list.mockResolvedValue({ interactions: [{ id: 'forged-style', expiresAt: Date.now() + 60000, prompt }] })
    render(<AgentThreadInteractionPanel route={route} conversationId="a" active />)
    await act(async () => { await Promise.resolve() })
    const button = screen.getByRole('button', { name: 'Original feedback' })
    expect(button).toHaveClass('MuiButton-outlined', 'MuiButton-colorPrimary'); expect(button).not.toHaveAttribute('href'); expect(button).not.toHaveAttribute('style')
    expect(document.querySelector('a,img,input,textarea,script')).toBeNull(); expect(mocks.resolve).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(button) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'forged-style', answer: { status: 'answered', actionId: 'a' } })
    expect(prompt.actions[0].style).toBe(style)
  })
  it('ignores inherited button style and keeps mixed omitted choices and dismissal independent', async () => {
    const actions = [{ id: 'a', label: 'Primary feedback', style: 'primary' as const }, { id: 'b', label: 'Original feedback' }, Object.assign(Object.create({ style: 'danger' }), { id: 'c', label: 'Inherited ignored' })]
    await mount({ id: 'mixed-styles', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Mixed style data', actions } })
    expect(screen.getByRole('button', { name: 'Primary feedback' })).toHaveClass('MuiButton-contained', 'MuiButton-colorPrimary')
    for (const name of ['Original feedback', 'Inherited ignored']) expect(screen.getByRole('button', { name })).toHaveClass('MuiButton-outlined', 'MuiButton-colorPrimary')
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(Object.hasOwn(actions[1], 'style')).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'mixed-styles', answer: { status: 'dismissed' } })
  })
  it.each(['primary', 'secondary', 'danger'] as const)('renders fixed action style without changing explicit feedback or dismissal style=%s', async style => {
    const prompt = { kind: 'show_card' as const, title: 'Button style is not approval', actions: [{ id: 'approve', label: 'Send feedback', style }] }
    await mount({ id: 'styled-choice', expiresAt: Date.now() + 60000, prompt })
    const button = screen.getByRole('button', { name: 'Send feedback' })
    expect(button).toHaveClass(style === 'secondary' ? 'MuiButton-outlined' : 'MuiButton-contained')
    expect(button).toHaveClass(style === 'danger' ? 'MuiButton-colorError' : 'MuiButton-colorPrimary')
    expect(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })).not.toHaveClass('MuiButton-contained')
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(document.querySelector('a,img,input,textarea,script')).toBeNull()
    await act(async () => { fireEvent.click(button) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'styled-choice', answer: { status: 'answered', actionId: 'approve' } })
    expect(prompt.actions[0].style).toBe(style)
  })
  it.each(['error', 'red', 'url(https://external.invalid)', 'constructor', { color: 'red' }])('never forwards a forged live accent to CSS, attributes or response data %#', async accent => {
    const theme = createTheme({ palette: { divider: 'rgb(13, 35, 57)' } })
    const prompt = { kind: 'show_card' as const, title: 'Untrusted hint', accent, actions: [{ id: 'ack', label: 'Dismiss by choice' }] }
    mocks.list.mockResolvedValue({ interactions: [{ id: 'forged-accent', expiresAt: Date.now() + 60000, prompt }] })
    render(<ThemeProvider theme={theme}><AgentThreadInteractionPanel route={route} conversationId="a" active /></ThemeProvider>)
    await act(async () => { await Promise.resolve() })
    const region = screen.getByRole('region')
    expect(region).toHaveStyle({ borderColor: 'rgb(13, 35, 57)' }); expect(region).not.toHaveAttribute('accent')
    expect(document.querySelector('a,img,input,textarea,script')).toBeNull(); expect(mocks.resolve).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(prompt.accent).toBe(accent)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'forged-accent', answer: { status: 'dismissed' } })
  })
  it.each(['bare', 'fields', 'subtitle', 'footer', 'all'])('maps a valid accent only to display styling with all optional contexts %#', async variant => {
    const prompt = { kind: 'show_card' as const, title: 'Fixed palette choice', accent: 'danger' as const, ...(['fields', 'all'].includes(variant) ? { fields: [{ label: 'Status', value: 'Not tool status' }] } : {}), ...(['subtitle', 'all'].includes(variant) ? { subtitle: '<b>Context only</b>' } : {}), ...(['footer', 'all'].includes(variant) ? { footer: 'Bearer ACCENT_CONTEXT_SECRET' } : {}), actions: [{ id: 'approve', label: 'Feedback only' }, { id: 'no', label: 'No feedback' }] }
    await mount({ id: 'context-accent', expiresAt: Date.now() + 60000, prompt })
    expect(screen.getByText(prompt.title)).toBeInTheDocument(); expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(document.querySelector('b,a,img,input,textarea,script')).toBeNull(); expect(document.body.textContent).not.toContain('ACCENT_CONTEXT_SECRET')
    expect(mocks.resolve).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'No feedback' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'context-accent', answer: { status: 'answered', actionId: 'no' } })
  })
  it.each((['light', 'dark'] as const).flatMap(mode => ['primary', 'info', 'success', 'warning', 'danger', 'neutral'].map(accent => [mode, accent] as const)))('uses fixed custom-theme card border/title accent without changing buttons, status or explicit reply mode=%s accent=%s', async (mode, accent) => {
    const theme = createTheme({ palette: { mode, primary: { main: '#13579b' }, info: { main: '#2468ac' }, success: { main: '#3579bd' }, warning: { main: '#468ace' }, error: { main: '#579bdf' }, divider: 'rgb(12, 34, 56)', text: { primary: 'rgb(23, 45, 67)' } } })
    const tokens = { primary: '#13579b', info: '#2468ac', success: '#3579bd', warning: '#468ace', danger: '#579bdf', neutral: 'rgb(12, 34, 56)' }
    const prompt = { kind: 'show_card' as const, title: 'Visual accent is not a result', accent, subtitle: 'Bearer ACCENT_UI_SECRET', footer: '<b>Feedback only</b>', actions: [{ id: 'approve', label: 'Explicit feedback' }] }
    mocks.list.mockResolvedValue({ interactions: [{ id: 'accent-choice', expiresAt: Date.now() + 60000, prompt }] })
    render(<ThemeProvider theme={theme}><AgentThreadInteractionPanel route={route} conversationId="a" active /></ThemeProvider>)
    await act(async () => { await Promise.resolve() })
    const region = screen.getByRole('region'), title = screen.getByText(prompt.title)
    expect(region).toHaveStyle({ borderColor: tokens[accent as keyof typeof tokens] })
    expect(title).toHaveStyle({ color: accent === 'neutral' ? 'rgb(23, 45, 67)' : tokens[accent as keyof typeof tokens] })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2); expect(document.querySelector('a,img,input,textarea,script')).toBeNull()
    expect(document.body.textContent).not.toContain('ACCENT_UI_SECRET'); expect(prompt.subtitle).toContain('ACCENT_UI_SECRET')
    expect(mocks.resolve).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Explicit feedback' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'accent-choice', answer: { status: 'answered', actionId: 'approve' } })
  })
  it.each([1, 4].flatMap(count => ['bare', 'fields', 'subtitle', 'both'].map(variant => [count, variant] as const)))('renders a plain redacted footer after context but before explicit buttons actions=%s context=%s', async (count, variant) => {
    const footer = '<img src="https://external.invalid/footer"> Bearer FOOTER_LIVE_SECRET'
    const prompt = { kind: 'show_card' as const, title: 'Footer choice', body: 'Body context', ...(['fields', 'both'].includes(variant) ? { fields: [{ label: 'Status', value: 'Read only' }] } : {}), ...(['subtitle', 'both'].includes(variant) ? { subtitle: 'Smaller context' } : {}), footer, actions: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: `Feedback ${i}` })) }
    await mount({ id: 'footer-card', expiresAt: Date.now() + 60000, prompt })
    const footerText = screen.getByText('<img src="https://external.invalid/footer"> Bearer [redacted]')
    expect(screen.getByText(prompt.fields ? 'Status: Read only' : 'Body context').compareDocumentPosition(footerText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(footerText.compareDocumentPosition(screen.getByRole('button', { name: 'Feedback 0' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.body.textContent).not.toContain('FOOTER_LIVE_SECRET')
    expect(document.querySelector('img,a,script,input,textarea')).toBeNull()
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(prompt.footer).toBe(footer)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Feedback 0' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'footer-card', answer: { status: 'answered', actionId: 'a0' } })
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it.each(['Authorization: Basic FOOTER_BASIC_SECRET', 'api_key=FOOTER_KEY_SECRET', 'https://user:FOOTER_URL_SECRET@example.invalid', '\u001b[31mBearer FOOTER_CONTROL_SECRET\u001b[0m\u202e'])('renders recognized footer patterns redacted without rewriting original data or autoconfirming %#', async footer => {
    const prompt = { kind: 'show_card' as const, title: 'Footer patterns', footer, actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    await mount({ id: 'footer-pattern', expiresAt: Date.now() + 60000, prompt })
    expect(document.body.textContent).toContain('[redacted]')
    expect(document.body.textContent).not.toMatch(/FOOTER_(?:BASIC|KEY|URL|CONTROL)_SECRET/)
    expect(document.querySelector('img,a,script,input,textarea')).toBeNull()
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(prompt.footer).toBe(footer)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'footer-pattern', answer: { status: 'dismissed' } })
  })
  it.each((['dismiss', 'expiry'] as const).flatMap(kind => [false, true].map(withAccent => [kind, withAccent] as const)))('never treats footer single-action %s as consent or an affirmative answer accent=%s', async (kind, withAccent) => {
    await mount({ id: 'footer-terminal', expiresAt: Date.now() + 10, prompt: { kind: 'show_card', title: 'Footer terminal', ...(withAccent ? { accent: 'success' as const } : {}), footer: 'Not approval', actions: [{ id: 'approve', label: 'Explicit feedback' }] } })
    expect(mocks.resolve).not.toHaveBeenCalled()
    if (kind === 'dismiss') {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
      expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'footer-terminal', answer: { status: 'dismissed' } })
    } else {
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Explicit feedback' })); expect(mocks.resolve).not.toHaveBeenCalled()
    }
  })
  it.each([false, true])('does not let a late footer choice resolution consume a replacement conversation accent=%s', async withAccent => {
    const item: AgentThreadInteraction = { id: 'footer-old', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Old footer', ...(withAccent ? { accent: 'danger' as const } : {}), footer: 'Old closing context', actions: [{ id: 'a', label: 'Old feedback' }] } }
    const view = await mount(item)
    let release!: () => void
    mocks.resolve.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const button = screen.getByRole('button', { name: 'Old feedback' }); fireEvent.click(button); fireEvent.click(button)
    expect(mocks.resolve).toHaveBeenCalledTimes(1); expect(button).toBeDisabled()
    mocks.list.mockResolvedValue({ interactions: [{ ...item, id: 'footer-new', prompt: { kind: 'show_card', title: 'New footer', ...(withAccent ? { accent: 'info' as const } : {}), footer: 'New closing context', actions: [{ id: 'a', label: 'New feedback' }] } }] })
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="b" active />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { release(); await Promise.resolve() })
    expect(screen.getByText('New closing context')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New feedback' })).not.toBeDisabled()
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'footer-old', answer: { status: 'answered', actionId: 'a' } })
  })
  it.each(['bare', 'fields', 'subtitle', 'both'] as const)('requires an explicit click on the lone action and keeps dismissal independent context=%s', async variant => {
    const prompt = { kind: 'show_card' as const, title: 'Single explicit button', actions: [{ id: 'approve', label: 'Feedback only, not approval' }],
      ...(['fields', 'both'].includes(variant) ? { fields: [{ label: 'Status', value: '<img src="https://external.invalid">' }] } : {}),
      ...(['subtitle', 'both'].includes(variant) ? { subtitle: 'Bearer SINGLE_UI_SECRET' } : {}) }
    await mount({ id: 'single-button', expiresAt: Date.now() + 60000, prompt })
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })).toBeInTheDocument()
    expect(document.querySelector('img,a,input,textarea,script')).toBeNull()
    expect(document.body.textContent).not.toContain('SINGLE_UI_SECRET')
    await poll()
    expect(mocks.resolve).not.toHaveBeenCalled()
    let release!: () => void
    mocks.resolve.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const button = screen.getByRole('button', { name: 'Feedback only, not approval' })
    fireEvent.click(button); fireEvent.click(button)
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'single-button', answer: { status: 'answered', actionId: 'approve' } })
    expect(button).toBeDisabled()
    await act(async () => { release(); await Promise.resolve() })
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    await poll(); expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it.each(['dismiss', 'expiry'] as const)('never treats lone-action %s as an affirmative response', async kind => {
    await mount({ id: 'single-terminal', expiresAt: Date.now() + 10, prompt: { kind: 'show_card', title: 'One is not automatic', actions: [{ id: 'approve', label: 'Explicit feedback' }] } })
    expect(mocks.resolve).not.toHaveBeenCalled()
    if (kind === 'dismiss') {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
      expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'single-terminal', answer: { status: 'dismissed' } })
    } else {
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Explicit feedback' }))
      expect(mocks.resolve).not.toHaveBeenCalled()
    }
  })
  it('does not let a late single-action resolution consume a replacement conversation', async () => {
    const item: AgentThreadInteraction = { id: 'single-old', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Old single', actions: [{ id: 'approve', label: 'Old feedback' }] } }
    const view = await mount(item)
    let release!: () => void
    mocks.resolve.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Old feedback' }))
    mocks.list.mockResolvedValue({ interactions: [{ ...item, id: 'single-new', prompt: { kind: 'show_card', title: 'New single', actions: [{ id: 'approve', label: 'New feedback' }] } }] })
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="b" active />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { release(); await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'New feedback' })).not.toBeDisabled()
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'single-old', answer: { status: 'answered', actionId: 'approve' } })
  })
  it('renders the smaller choice subtitle as inert redacted context and returns no subtitle or authority in the answer', async () => {
    const subtitle = '<img src="https://external.invalid/subtitle"> Bearer SUBTITLE_LIVE_SECRET'
    await mount({ id: 'subtitle-card', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Subtitle choice', ...{ subtitle }, actions: [{ id: 'approve', label: 'Feedback only' }, { id: 'no', label: 'Other feedback' }] } })
    expect(screen.getByText('<img src="https://external.invalid/subtitle"> Bearer [redacted]')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('SUBTITLE_LIVE_SECRET')
    expect(document.querySelector('img,a,script,input,textarea')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Feedback only' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'subtitle-card', answer: { status: 'answered', actionId: 'approve' } })
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it.each(['Authorization: Basic SUBTITLE_BASIC_SECRET', 'api_key=SUBTITLE_KEY_SECRET', 'https://user:SUBTITLE_URL_SECRET@example.invalid', '\u001b[31mBearer SUBTITLE_CONTROL_SECRET\u001b[0m\u202e'])('renders recognized subtitle patterns redacted, without autoanswer or markup %#', async subtitle => {
    const prompt = { kind: 'show_card' as const, title: 'Subtitle patterns', subtitle, actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }
    await mount({ id: 'subtitle-pattern', expiresAt: Date.now() + 60000, prompt })
    expect(document.body.textContent).toContain('[redacted]')
    expect(document.body.textContent).not.toMatch(/SUBTITLE_(?:BASIC|KEY|URL|CONTROL)_SECRET/)
    expect(document.querySelector('img,a,script,input,textarea')).toBeNull()
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(prompt.subtitle).toBe(subtitle)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'subtitle-pattern', answer: { status: 'dismissed' } })
  })
  it('renders a free-text prompt and submits to its exact conversation without a new chat turn', async () => {
    await mount()
    expect(screen.getByText('chat.agent_interaction.notice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.agent_interaction.submit' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Blue' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.submit' })) })
    expect(mocks.resolve).toHaveBeenCalledWith({ route, conversationId: 'a', interactionId: 'question-a', answer: { status: 'answered', text: 'Blue' } })
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    // An old in-flight polling response cannot resurrect an answered prompt.
    await poll()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it('renders cards as text only and returns only the selected action ID', async () => {
    await mount({ id: 'card', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Choose', body: '<img src="https://example.invalid/tracker">', actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } })
    expect(document.querySelector('img')).toBeNull()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'B' })) })
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ interactionId: 'card', answer: { status: 'answered', actionId: 'b' } }))
  })
  it('shows read-only key/value rows next to existing choices, redacts sensitive values and submits only the chosen ID', async () => {
    const fields = [{ label: 'Status', value: '<img src="https://external.invalid">', inline: true }, { label: 'password', value: 'PRIVATE_CHOICE_FIELD with spaces\nand newline' }, { label: 'Next', value: 'https://external.invalid/plain', inline: false }]
    await mount({ id: 'choice-fields', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Choice fields', fields, actions: [{ id: 'approve', label: 'Feedback yes' }, { id: 'no', label: 'Feedback no' }] } })
    expect(screen.getByText('Status: <img src="https://external.invalid">')).toBeInTheDocument()
    expect(screen.getByText('password: [redacted]')).toBeInTheDocument()
    expect(screen.getByText('Next: https://external.invalid/plain')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('PRIVATE_CHOICE_FIELD')
    expect(document.body.textContent).not.toContain('newline')
    expect(fields[1].value).toContain('PRIVATE_CHOICE_FIELD')
    expect(document.querySelector('img,a,input,textarea,script')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Feedback yes' })) })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'choice-fields', answer: { status: 'answered', actionId: 'approve' } })
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    await poll()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it.each(['dismiss', 'expiry'] as const)('keeps choice fields read-only and never submits field values on %s', async kind => {
    await mount({ id: 'field-lifetime', expiresAt: Date.now() + 10, prompt: { kind: 'show_card', title: 'Lifetime', fields: [{ label: 'Status', value: 'Read only', inline: true }, { label: 'Next', value: 'No form' }], actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } })
    expect(screen.getByText('Status: Read only')).toBeInTheDocument()
    expect(screen.getByText('Next: No form')).toBeInTheDocument()
    expect(document.querySelector('input,textarea,a,img,script')).toBeNull()
    if (kind === 'dismiss') {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
      expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'a', interactionId: 'field-lifetime', answer: { status: 'dismissed' } })
    } else {
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'A' }))
      expect(mocks.resolve).not.toHaveBeenCalled()
    }
  })
  it('prevents duplicate fielded-choice submissions and a late resolution cannot affect a replacement conversation', async () => {
    const item: AgentThreadInteraction = { id: 'field-a', expiresAt: Date.now() + 60000, prompt: { kind: 'show_card', title: 'Old choice', fields: [{ label: 'Status', value: 'Old context' }], actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }
    const view = await mount(item)
    let release!: () => void
    mocks.resolve.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'A' })); fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(mocks.resolve).toHaveBeenCalledOnce()
    expect(mocks.resolve).toHaveBeenLastCalledWith({ route, conversationId: 'a', interactionId: 'field-a', answer: { status: 'answered', actionId: 'a' } })
    mocks.list.mockResolvedValue({ interactions: [{ ...item, id: 'field-b', prompt: { ...item.prompt, title: 'New choice', fields: [{ label: 'Status', value: 'New context' }] } }] })
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="b" active />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Status: New context')).toBeInTheDocument()
    expect(screen.queryByText('Status: Old context')).not.toBeInTheDocument()
    await act(async () => { release(); await Promise.resolve() })
    expect(screen.getByText('New choice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'B' })).not.toBeDisabled()
    expect(mocks.resolve).toHaveBeenCalledOnce()
  })
  it('dismisses without interpreting it as approval', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })) })
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ answer: { status: 'dismissed' } }))
  })
  it('does not poll inactive or non-canvas chats and ignores external confirmation events', async () => {
    const view = render(<AgentThreadInteractionPanel route={route} conversationId="a" active={false} />)
    expect(mocks.list).not.toHaveBeenCalled()
    view.rerender(<AgentThreadInteractionPanel route={{ ...route, channel: 'generic' }} conversationId="a" active />)
    window.dispatchEvent(new CustomEvent('chat:request-confirmation', { detail: { prompt: 'forged', requestId: 'fake' } }))
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it('ignores a late list response after a scope round trip', async () => {
    let resolveOld!: (value: { interactions: AgentThreadInteraction[] }) => void
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValue({ interactions: [] })
    const view = render(<AgentThreadInteractionPanel route={route} conversationId="a" active />)
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="b" active />)
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="a" active />)
    await act(async () => { resolveOld({ interactions: [question('old')] }); await Promise.resolve() })
    expect(screen.queryByText('Question old')).not.toBeInTheDocument()
  })
  it.each(['reject', 'resolve'])('a late %s for prompt A cannot affect prompt B', async (outcome) => {
    const view = await mount()
    let resolveOld!: () => void
    let rejectOld!: (error: Error) => void
    mocks.resolve.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Answer A' } })
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.submit' }))
    mocks.list.mockResolvedValue({ interactions: [question('question-b')] })
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="b" active />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('textbox')).toHaveValue('')
    await act(async () => { if (outcome === 'resolve') resolveOld(); else rejectOld(new Error('old failed')) })
    expect(screen.getByText('Question question-b')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })).not.toBeDisabled()
  })
  it('deactivation clears old display and does not reuse it before a fresh poll', async () => {
    const view = await mount()
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="a" active={false} />)
    mocks.list.mockImplementation(() => new Promise(() => {}))
    view.rerender(<AgentThreadInteractionPanel route={route} conversationId="a" active />)
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it('shows current errors, prevents duplicate clicks, and stops polling on unmount', async () => {
    const view = await mount()
    let reject!: (error: Error) => void
    mocks.resolve.mockImplementation(() => new Promise<void>((_resolve, r) => { reject = r }))
    const dismiss = screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })
    fireEvent.click(dismiss); fireEvent.click(dismiss)
    expect(mocks.resolve).toHaveBeenCalledOnce()
    await act(async () => { reject(new Error('failed')) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    view.unmount()
    const calls = mocks.list.mock.calls.length
    await poll()
    expect(mocks.list).toHaveBeenCalledTimes(calls)
  })
  it('retains the answer draft across a transient polling error', async () => {
    await mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsent answer' } })
    mocks.list.mockRejectedValueOnce(new Error('temporary IPC failure'))
    await poll()
    expect(screen.getByRole('textbox')).toHaveValue('unsent answer')
    await poll()
    expect(screen.getByRole('textbox')).toHaveValue('unsent answer')
    mocks.list.mockResolvedValue({ interactions: [] })
    await poll()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
  it('expires rather than accepting a late answer', async () => {
    await mount({ ...question(), expiresAt: Date.now() + 10 })
    await act(async () => { await vi.advanceTimersByTimeAsync(11) })
    expect(screen.getByRole('button', { name: 'chat.agent_interaction.dismiss' })).toBeDisabled()
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
})
