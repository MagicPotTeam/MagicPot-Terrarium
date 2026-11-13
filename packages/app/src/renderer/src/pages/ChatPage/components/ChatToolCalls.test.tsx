import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import type { ToolHistoryEntry } from '@shared/llm/types'
import ChatToolCalls from './ChatToolCalls'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const entry: ToolHistoryEntry = {
  runId: 'run',
  toolCallId: 'call',
  toolName: 'web_search',
  args: { query: 'Electron documentation', max_results: 3 },
  status: 'completed',
  content: 'SEARCH_RESULT_BODY'
}

describe('inline tool calls', () => {
  it.each([false, true])('formats only strict provided body and never promotes body headings or tasks into accessible title or controls live=%s', live => {
    const body = '# Not the card title\n\n**Saved strong** and *Saved emphasis*\n\n> Saved quote\n\n- [x] Saved task\n\n```js\nnotExecuted()\n```', card = { title: '**Original accessible title**', icon: '*I*', subtitle: '*Literal subtitle*', footer: '**Literal footer**', body }, content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false }), source = { ...entry, toolName: 'show_card', content }, before = JSON.stringify(source)
    const { container } = render(<ChatToolCalls history={[source]} live={live} />)
    expect(screen.getByRole('heading', { name: card.title })).toHaveAccessibleName(card.title); expect(screen.getAllByRole('heading')).toHaveLength(1); expect(screen.getByText('Not the card title').tagName).toBe('STRONG'); expect(screen.getByText('Saved strong').tagName).toBe('STRONG'); expect(screen.getByText('Saved emphasis').tagName).toBe('EM'); expect(screen.getByText('Saved quote').closest('blockquote')).not.toBeNull(); expect(screen.getByText(/\[x\] Saved task/).closest('li')).not.toBeNull(); expect(screen.getByText('notExecuted()').tagName).toBe('CODE')
    expect(screen.getByText(card.subtitle).querySelector('em')).toBeNull(); expect(screen.getByText(card.footer).querySelector('strong')).toBeNull(); expect(screen.getByText(card.icon)).toHaveAttribute('aria-hidden', 'true'); expect(container.querySelector('[data-testid="CheckIcon"]')).not.toBeNull(); expect(screen.getAllByRole('button')).toHaveLength(1); expect(container.querySelector('a,img,input,textarea,script,iframe')).toBeNull()
    fireEvent.click(screen.getByRole('button')); fireEvent.click(screen.getByRole('button')); expect(screen.getAllByRole('button')).toHaveLength(1); expect(JSON.stringify(source)).toBe(before)
  })
  it('redacts decoded body credentials and renders image alt as inert text without mutating a restored provided receipt', () => {
    const body = '**Saved public**\n\n![Public alt](https://external.invalid/probe)\n\n&#66;ea**rer** HISTORY_ENTITY_SECRET', content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Original body title', body }, untrustedData: true, grantsPermission: false }), source = { ...entry, toolName: 'show_card', content }, before = JSON.stringify(source)
    const { container } = render(<ChatToolCalls history={[source]} live={false} />)
    expect(container.textContent).toContain('Public alt'); expect(container.textContent).toContain('Bearer [redacted]'); expect(container.textContent).not.toContain('HISTORY_ENTITY_SECRET'); expect(container.querySelector('a,img,input,textarea,script')).toBeNull(); expect(screen.getAllByRole('button')).toHaveLength(1); expect(JSON.stringify(source)).toBe(before)
  })
  it.each([undefined, '', '  ', '\n\t', '\u0001\u202e'])('does not add icon spacing, a default or accessible-name changes for empty provided decoration %#', icon => {
    const card = { title: 'Undecorated heading', icon }, content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', content }]} live={false} />)
    const title = screen.getByRole('heading', { name: card.title }); expect(title.textContent).toBe(card.title); expect(title.querySelector('span')).toBeNull(); expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it.each([null, false, 1, [], {}, ['✓'], { src: 'https://external.invalid' }, 'x'.repeat(65), '😀'.repeat(33)])('keeps invalid saved icon receipts ordinary readonly data without provided upgrade or resource %#', icon => {
    const content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Invalid icon receipt', icon }, untrustedData: true, grantsPermission: false })
    const source = { ...entry, toolName: 'show_card', content }, before = JSON.stringify(source); render(<ChatToolCalls history={[source]} live={false} />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument(); expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('chat.tool_call.result')).toBeInTheDocument(); expect(screen.getAllByRole('button')).toHaveLength(1); expect(document.querySelector('img,a,script,input,textarea')).toBeNull(); expect(JSON.stringify(source)).toBe(before)
  })
  it.each([false, true].flatMap(live => (['running', 'failed', 'cancelled', 'unknown'] as const).map(status => [live, status] as const)))('never lets checkmark decoration promote an incomplete or invalid icon-like receipt live=%s inputstatus=%s', (live, status) => {
    const content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Not completed heading', icon: '✓' }, untrustedData: true, grantsPermission: false })
    // Raw unknown is deliberately invalid history input, unlike an old running row displayed as unknown.
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', status: status === 'unknown' ? 'unknown' as never : status, content }]} live={live} />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument(); expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(document.querySelector('[data-testid="CheckIcon"]')).toBeNull()
    if (status === 'unknown') { expect(screen.queryByRole('button')).not.toBeInTheDocument(); expect(screen.queryByRole('group')).not.toBeInTheDocument() }
    else { expect(screen.getByRole('button', { name: new RegExp(`status_${status === 'running' && !live ? 'unknown' : status}`) })).toBeInTheDocument(); expect(screen.getAllByRole('button')).toHaveLength(1) }
  })
  it.each([false, true].flatMap(live => ['answered', 'dismissed', 'timeout'].flatMap(status => ['primary', 'secondary', 'danger'].map(style => [live, status, style] as const))))('keeps restored icon+styled feedback outcomes readonly/no control-replay or provided upgrade live=%s outcome=%s style=%s', (live, status, style) => {
    const args = { title: 'Saved decorative choice', icon: '✓👩🏽‍💻', accent: 'success', actions: [{ id: 'approve', label: 'Never recreate this icon feedback', style }] }, content = JSON.stringify(status === 'answered' ? { status, actionId: 'approve' } : { status })
    const source = { ...entry, toolName: 'show_card', args, content }, before = JSON.stringify(source); render(<ChatToolCalls history={[source]} live={live} />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: args.actions[0].label })).not.toBeInTheDocument(); expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button')); expect(screen.getByText('chat.tool_call.result')).toBeInTheDocument(); expect(screen.getAllByRole('button')).toHaveLength(1); expect(JSON.stringify(source)).toBe(before)
  })
  it('redacts decorative icons before a strict unchanged accessible heading without rewriting saved data or replacing status icons', () => {
    const icon = '\u001b[31mBearer ICON_HISTORY_SECRET\u001b[0m\u202e', card = { title: 'Original accessible heading', icon, subtitle: '', footer: 'Closing', fields: [{ label: 'State', value: 'Not approval' }], accent: 'danger' }
    const source = { ...entry, toolName: 'show_card', args: card, content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false }) }, before = JSON.stringify(source)
    const { container } = render(<ChatToolCalls history={[source]} live={false} />), title = screen.getByRole('heading', { name: card.title }), mark = screen.getByText('Bearer [redacted]')
    expect(title.firstChild).toBe(mark); expect(mark).toHaveAttribute('aria-hidden', 'true'); expect(title).toHaveAccessibleName(card.title); expect(title.textContent).toBe('Bearer [redacted]' + card.title)
    expect(container.querySelector('[data-testid="CheckIcon"]')).not.toBeNull(); expect(title.querySelector('img,svg,a,script')).toBeNull(); fireEvent.click(screen.getByRole('button'))
    expect(document.body.textContent).not.toContain('ICON_HISTORY_SECRET'); expect(document.body.textContent).not.toContain('\u202e'); expect(JSON.stringify(source)).toBe(before); expect(card.icon).toBe(icon); expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it.each([false, true].flatMap(live => ['✓', '👩🏽‍💻', '<img src="https://external.invalid/i">'].map(icon => [live, icon] as const)))('renders only a strict provided decorative icon before title without changing accessible name or actual status live=%s icon=%s', (live, icon) => {
    const card = { title: 'Original provided heading', icon }, content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    const source = { ...entry, toolName: 'show_card', args: card, content }, before = JSON.stringify(source)
    const { container } = render(<ChatToolCalls history={[source]} live={live} />)
    const title = screen.getByRole('heading', { name: card.title }), mark = screen.getByText(icon)
    expect(mark.tagName).toBe('SPAN'); expect(mark).toHaveAttribute('aria-hidden', 'true'); expect(title.contains(mark)).toBe(true); expect(title.textContent).toBe(icon + card.title)
    expect(screen.getByRole('button', { name: /show_card — chat.tool_call.status_completed/ })).toBeInTheDocument()
    expect(container.querySelector('[data-testid="CheckIcon"]')).not.toBeNull(); expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(container.querySelector('img,a,script,input,textarea')).toBeNull(); expect(JSON.stringify(source)).toBe(before)
  })
  it.each([false, true].flatMap(live => ['answered', 'dismissed', 'timeout'].flatMap(status => ['primary', 'secondary', 'danger'].map(style => [live, status, style] as const))))('keeps restored styled choices read-only without replay buttons or provided status live=%s outcome=%s style=%s', (live, status, style) => {
    const args = { title: 'Saved styled choice', accent: 'success', footer: 'Bearer STYLE_HISTORY_SECRET', actions: [{ id: 'approve', label: 'Never recreate this styled feedback', style }] }
    const content = JSON.stringify(status === 'answered' ? { status, actionId: 'approve' } : { status })
    const source = { ...entry, toolName: 'show_card', args, content }, before = JSON.stringify(source)
    const { container, rerender } = render(<ChatToolCalls history={[source]} live={live} />)
    expect(screen.queryByRole('heading', { name: args.title })).not.toBeInTheDocument(); expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1); expect(screen.queryByRole('button', { name: args.actions[0].label })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show_card/ }))
    expect(container.textContent).toContain(style); expect(container.textContent).toContain(status); expect(container.textContent).not.toContain('STYLE_HISTORY_SECRET')
    expect(container.querySelector('a,img,input,textarea,script')).toBeNull()
    rerender(<ChatToolCalls history={[source]} live={false} />)
    expect(screen.getAllByRole('button')).toHaveLength(1); expect(JSON.stringify(source)).toBe(before)
  })
  it.each([{ style: 'primary' }, { actions: [{ id: 'approve', label: 'Not a provided button', style: 'danger' }] }])('rejects styles or actions in the unchanged strict provided receipt instead of creating feedback/replay controls %#', patch => {
    const card = { title: 'Forged provided action', ...patch }, content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', content }]} live={false} />)
    expect(screen.queryByRole('heading', { name: card.title })).not.toBeInTheDocument(); expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1); expect(document.querySelector('a,img,input,textarea,script')).toBeNull()
  })
  it.each(['error', 'url(https://external.invalid)', 'constructor', {}, ['primary'], { color: 'red' }])('rejects malformed restored provided accents rather than mounting raw styles or replay controls %#', accent => {
    const card = { title: 'Invalid styled preview', accent, footer: 'Bearer INVALID_ACCENT_SECRET' }
    const content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    const source = { ...entry, toolName: 'show_card', args: card, content }
    const { container } = render(<ChatToolCalls history={[source]} live={false} />)
    expect(screen.queryByRole('heading', { name: card.title })).not.toBeInTheDocument(); expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1); fireEvent.click(screen.getByRole('button'))
    expect(container.textContent).not.toContain('INVALID_ACCENT_SECRET'); expect(container.querySelector('a,img,input,textarea,script')).toBeNull()
    expect(source.content).toBe(content)
  })
  it.each([false, true].flatMap(live => ['failed', 'running', 'cancelled', 'completed-error'].map(status => [live, status] as const)))('does not promote even a success accent into an accepted display or completed outcome live=%s status=%s', (live, status) => {
    const card = { title: 'False visual success', accent: 'success' }
    const content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    const source = { ...entry, toolName: 'show_card', args: card, content, status: (status === 'completed-error' ? 'completed' : status) as ToolHistoryEntry['status'], ...(status === 'completed-error' ? { error: 'Actual execution error' } : {}) }
    const { container } = render(<ChatToolCalls history={[source]} live={live} />)
    expect(screen.queryByRole('heading', { name: card.title })).not.toBeInTheDocument(); expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1); expect(container.querySelector('a,img,input,textarea,script')).toBeNull()
    // Existing outer tool status remains independent, even for a stored completed+error record.
    if (status === 'completed-error') expect(screen.getByRole('button', { name: /chat.tool_call.status_completed/ })).toBeInTheDocument()
    else expect(screen.queryByRole('button', { name: /chat.tool_call.status_completed/ })).not.toBeInTheDocument()
  })
  it('keeps an omitted accent absent and preserves the original provided preview without manufacturing neutral borders', () => {
    const card = { title: 'Original unchanged preview' }, content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', content }]} live={false} />)
    const title = screen.getByRole('heading', { name: card.title })
    expect(getComputedStyle(title.parentElement!).borderStyle).not.toBe('solid'); expect(Object.hasOwn(card, 'accent')).toBe(false)
  })
  it.each((['light', 'dark'] as const).flatMap(mode => ['primary', 'info', 'success', 'warning', 'danger', 'neutral'].map(accent => [mode, accent] as const)))('renders only the provided card border/header accent, preserving independent real tool outcome mode=%s accent=%s', (mode, accent) => {
    const theme = createTheme({ palette: { mode, primary: { main: '#13579b' }, info: { main: '#2468ac' }, success: { main: '#3579bd' }, warning: { main: '#468ace' }, error: { main: '#579bdf' }, divider: 'rgb(12, 34, 56)', text: { primary: 'rgb(23, 45, 67)' } } })
    const tokens = { primary: '#13579b', info: '#2468ac', success: '#3579bd', warning: '#468ace', danger: '#579bdf', neutral: 'rgb(12, 34, 56)' }
    const card = { title: 'Untrusted visual hint', accent, footer: 'Bearer ACCENT_HISTORY_SECRET' }
    const content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    const source = { ...entry, toolName: 'show_card', args: card, content }
    const { container } = render(<ThemeProvider theme={theme}><ChatToolCalls history={[source]} live={false} /></ThemeProvider>)
    const title = screen.getByRole('heading', { name: card.title })
    expect(title.parentElement).toHaveStyle({ borderColor: tokens[accent as keyof typeof tokens] })
    expect(title).toHaveStyle({ color: accent === 'neutral' ? 'rgb(23, 45, 67)' : tokens[accent as keyof typeof tokens] })
    expect(screen.getByRole('button', { name: /show_card — chat.tool_call.status_completed/ })).toBeInTheDocument()
    expect(container.querySelector('[data-testid="CheckIcon"]')).toHaveStyle({ color: '#3579bd' })
    expect(screen.getAllByRole('button')).toHaveLength(1); expect(container.querySelector('a,img,input,textarea,script')).toBeNull()
    expect(container.textContent).not.toContain('ACCENT_HISTORY_SECRET'); expect(source.content).toBe(content)
    fireEvent.click(screen.getByRole('button')); expect(container.textContent).not.toContain('ACCENT_HISTORY_SECRET')
  })
  it.each([false, true].flatMap(live => ['answered', 'dismissed', 'timeout'].flatMap(status => [false, true].map(withAccent => [live, status, withAccent] as const))))('restores a footer choice as ordinary read-only details, not provided preview or answer replay live=%s outcome=%s accent=%s', (live, status, withAccent) => {
    const args = { title: 'Saved footer choice', ...(withAccent ? { accent: 'success' } : {}), footer: 'Bearer FOOTER_CHOICE_SECRET', actions: [{ id: 'approve', label: 'Never recreate this footer feedback button' }] }
    const content = JSON.stringify(status === 'answered' ? { status, actionId: 'approve' } : { status })
    const source = { ...entry, toolName: 'show_card', args, content }
    const { container, rerender } = render(<ChatToolCalls history={[source]} live={live} />)
    expect(screen.queryByRole('heading', { name: args.title })).not.toBeInTheDocument()
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: args.actions[0].label })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show_card/ }))
    expect(container.textContent).toContain(status); expect(container.textContent).toContain('Bearer [redacted]')
    expect(container.textContent).not.toContain('FOOTER_CHOICE_SECRET'); expect(container.querySelector('img,a,input,textarea,script')).toBeNull()
    rerender(<ChatToolCalls history={[source]} live={false} />)
    expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['chat.tool_call.arguments', 'chat.tool_call.result'])
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: args.actions[0].label })).not.toBeInTheDocument()
    expect(args.footer).toContain('FOOTER_CHOICE_SECRET'); expect(source.content).toBe(content)
  })
  it.each([1, '😀'.repeat(101)])('does not preview invalid footer receipts or turn footer data into controls %#', footer => {
    const receipt = { contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Invalid footer card', footer }, untrustedData: true, grantsPermission: false }
    const { container } = render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', content: JSON.stringify(receipt) }]} live={false} />)
    expect(screen.queryByRole('heading', { name: receipt.card.title })).not.toBeInTheDocument()
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1); expect(container.querySelector('img,a,input,textarea,script')).toBeNull()
  })
  it.each(['Authorization: Basic FOOTER_HISTORY_BASIC_SECRET', 'api_key=FOOTER_HISTORY_KEY_SECRET', 'https://user:FOOTER_HISTORY_URL_SECRET@example.invalid', '\u001b[31mBearer FOOTER_HISTORY_CONTROL_SECRET\u001b[0m\u202e'])('uses recognized display-only footer redaction patterns in previews/details without changing stored receipts %#', footer => {
    const card = { title: 'Footer patterns', footer }, content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false })
    const source = { ...entry, toolName: 'show_card', args: card, content }
    const { container } = render(<ChatToolCalls history={[source]} live={false} />)
    expect(container.textContent).toContain('[redacted]'); expect(container.textContent).not.toMatch(/FOOTER_HISTORY_(?:BASIC|KEY|URL|CONTROL)_SECRET/)
    fireEvent.click(screen.getByRole('button', { name: /show_card/ }))
    expect(container.textContent).not.toMatch(/FOOTER_HISTORY_(?:BASIC|KEY|URL|CONTROL)_SECRET/)
    expect(container.querySelector('img,a,input,textarea,script')).toBeNull(); expect(card.footer).toBe(footer); expect(source.content).toBe(content)
  })
  it.each([false, true].flatMap(live => ['bare', 'fields', 'subtitle', 'both'].map(variant => [live, variant] as const)))('previews footer below inert redacted context, not an answer live=%s context=%s', (live, variant) => {
    const footer = '<img src="https://external.invalid/footer"> Bearer FOOTER_HISTORY_SECRET'
    const card = { title: 'Footer provided card', ...(['subtitle', 'both'].includes(variant) ? { subtitle: 'Smaller context' } : {}), body: 'Body before fields', ...(['fields', 'both'].includes(variant) ? { fields: [{ label: 'Status', value: 'Read only' }] } : {}), footer }
    const source = { ...entry, toolName: 'show_card', args: card, content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card, untrustedData: true, grantsPermission: false }) }
    const { container } = render(<ChatToolCalls history={[source]} live={live} />)
    expect(screen.getByRole('heading', { name: card.title })).toBeInTheDocument()
    const footerText = screen.getByText('<img src="https://external.invalid/footer"> Bearer [redacted]')
    expect(screen.getByText(card.fields ? 'Status: Read only' : 'Body before fields').compareDocumentPosition(footerText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('img,a,script,input,textarea')).toBeNull()
    expect(container.textContent).not.toContain('FOOTER_HISTORY_SECRET')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /show_card/ }))
    expect(container.textContent).not.toContain('FOOTER_HISTORY_SECRET')
    expect(source.content).toContain('FOOTER_HISTORY_SECRET'); expect(card.footer).toBe(footer)
  })
  it.each([false, true].flatMap(live => ['answered', 'dismissed', 'timeout'].map(status => [live, status] as const)))('restores a lone-action outcome as read-only details, not a button or approval live=%s outcome=%s', (live, status) => {
    const args = { title: 'Saved single action', subtitle: 'Bearer SINGLE_HISTORY_SECRET', actions: [{ id: 'approve', label: 'Do not recreate this feedback button' }] }
    const content = JSON.stringify(status === 'answered' ? { status, actionId: 'approve' } : { status })
    const source = { ...entry, toolName: 'show_card', args, content }
    const { container, rerender } = render(<ChatToolCalls history={[source]} live={live} />)
    expect(screen.queryByRole('heading', { name: 'Saved single action' })).not.toBeInTheDocument()
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Do not recreate this feedback button' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show_card/ }))
    expect(container.textContent).toContain(status)
    expect(container.textContent).toContain('Bearer [redacted]')
    expect(container.textContent).not.toContain('SINGLE_HISTORY_SECRET')
    expect(container.querySelector('img,a,input,textarea,script')).toBeNull()
    rerender(<ChatToolCalls history={[source]} live={false} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Saved single action' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['chat.tool_call.arguments', 'chat.tool_call.result'])
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Do not recreate this feedback button' })).not.toBeInTheDocument()
    expect(args.subtitle).toContain('SINGLE_HISTORY_SECRET'); expect(source.content).toBe(content)
  })
  it.each([false, true])('previews a subtitle as redacted inert text in live/restored history without changing raw receipts live=%s', live => {
    const subtitle = '<img src="https://external.invalid/subtitle"> Bearer SUBTITLE_HISTORY_SECRET'
    const receipt = { contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Subtitle card', subtitle }, untrustedData: true, grantsPermission: false }
    const source = { ...entry, toolName: 'show_card', args: { title: 'Subtitle card', subtitle }, content: JSON.stringify(receipt) }
    const { container } = render(<ChatToolCalls history={[source]} live={live} />)
    expect(screen.getByRole('heading', { name: 'Subtitle card' })).toBeInTheDocument()
    expect(screen.getByText('<img src="https://external.invalid/subtitle"> Bearer [redacted]')).toBeInTheDocument()
    expect(container.querySelector('img,a,script,input,textarea')).toBeNull()
    expect(container.textContent).not.toContain('SUBTITLE_HISTORY_SECRET')
    fireEvent.click(screen.getByRole('button', { name: /show_card/ }))
    expect(container.textContent).not.toContain('SUBTITLE_HISTORY_SECRET')
    expect(source.content).toContain('SUBTITLE_HISTORY_SECRET')
  })
  it.each(['Authorization: Basic SUBTITLE_BASIC_SECRET', 'api_key=SUBTITLE_KEY_SECRET', 'https://user:SUBTITLE_URL_SECRET@example.invalid', '\u001b[31mBearer SUBTITLE_CONTROL_SECRET\u001b[0m\u202e'])('redacts recognized subtitle patterns on preview and expansion without sanitizing raw data %#', subtitle => {
    const receipt = { contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Subtitle patterns', subtitle }, untrustedData: true, grantsPermission: false }
    const source = { ...entry, toolName: 'show_card', args: { title: 'Subtitle patterns', subtitle }, content: JSON.stringify(receipt) }
    const { container } = render(<ChatToolCalls history={[source]} live={false} />)
    expect(screen.getByRole('heading', { name: 'Subtitle patterns' })).toBeInTheDocument()
    expect(container.textContent).toContain('[redacted]'); expect(container.textContent).not.toMatch(/SUBTITLE_(?:BASIC|KEY|URL|CONTROL)_SECRET/)
    fireEvent.click(screen.getByRole('button', { name: /show_card/ }))
    expect(container.textContent).not.toMatch(/SUBTITLE_(?:BASIC|KEY|URL|CONTROL)_SECRET/)
    expect(container.querySelector('img,a,script,input,textarea')).toBeNull()
    expect(source.content).toContain('SUBTITLE_')
  })
  it('starts compact and expands arguments/result in the same row', () => {
    render(<ChatToolCalls history={[entry]} live={false} />)
    const toggle = screen.getByRole('button', { name: /web_search/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('Electron documentation')
    expect(screen.queryByText('SEARCH_RESULT_BODY')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('chat.tool_call.arguments')).toBeInTheDocument()
    expect(screen.getByText('SEARCH_RESULT_BODY')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.queryByText('SEARCH_RESULT_BODY')).not.toBeInTheDocument()
  })
  it('updates a running row in place without losing its expanded state', () => {
    const running = { ...entry, status: 'running' as const, content: undefined }
    const view = render(<ChatToolCalls history={[running]} live />)
    fireEvent.click(screen.getByRole('button', { name: /web_search/ }))
    expect(screen.getByText('chat.tool_call.waiting')).toBeInTheDocument()
    view.rerender(<ChatToolCalls history={[entry]} live />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('SEARCH_RESULT_BODY')).toBeInTheDocument()
    expect(screen.queryByText('chat.tool_call.waiting')).not.toBeInTheDocument()
  })
  it('shows real search failures and never executes output as HTML', () => {
    render(
      <ChatToolCalls
        history={[
          {
            ...entry,
            status: 'failed',
            content: '<img src="https://external.invalid/probe" />',
            error: 'web_search [rate_limited] HTTP 429'
          }
        ]}
        live={false}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('web_search [rate_limited] HTTP 429')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src="https://external.invalid/probe" />')).toBeInTheDocument()
  })
  it('shows an unfinished saved call as unknown, not running or falsely cancelled', () => {
    render(
      <ChatToolCalls history={[{ ...entry, status: 'running', content: undefined }]} live={false} />
    )
    const button = screen.getByRole('button', { name: /chat.tool_call.status_unknown/ })
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    fireEvent.click(button)
    expect(screen.getByText('chat.tool_call.unknown_notice')).toBeInTheDocument()
    expect(screen.queryByText('chat.tool_call.status_cancelled')).not.toBeInTheDocument()
  })
  it('supports keyboard expansion and displays no independent diagnostics action', async () => {
    const user = userEvent.setup()
    render(<ChatToolCalls history={[entry]} live={false} />)
    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByText('SEARCH_RESULT_BODY')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it('redacts credentials in the summary and expanded detail without changing the receipt', () => {
    const value = {
      ...entry,
      args: { query: 'safe', token: 'PRIVATE_TOKEN' },
      content: '{"password":"PRIVATE_PASS"}'
    }
    render(<ChatToolCalls history={[value]} live={false} />)
    expect(document.body.textContent).not.toContain('PRIVATE_TOKEN')
    fireEvent.click(screen.getByRole('button'))
    expect(document.body.textContent).not.toContain('PRIVATE_PASS')
    expect(value.args.token).toBe('PRIVATE_TOKEN')
  })
  it('shows a completed display-only card as plain read-only content without expanding or replying', () => {
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', args: { title: 'NOT_THE_RETURNED_TITLE' }, content: JSON.stringify({
      contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Provided status card', body: '<img src="https://external.invalid/probe"> data only' }, untrustedData: true, grantsPermission: false
    }) }]} live={false} />)
    expect(screen.getByRole('heading', { name: 'Provided status card' })).toBeInTheDocument()
    expect(screen.getByText('<img src="https://external.invalid/probe"> data only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show_card/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(document.querySelector('img,a,input,textarea')).toBeNull()
    expect(screen.getByText('chat.tool_call.card_display_notice')).toBeInTheDocument()
    expect(screen.queryByText('chat.agent_interaction.submit')).not.toBeInTheDocument()
  })
  it('redacts display-only card content through the existing formatter without modifying the receipt', () => {
    const content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Authorization: Basic PRIVATE_CARD_AUTH', body: 'password=PRIVATE_CARD_PASSWORD\npublic status' }, untrustedData: true, grantsPermission: false })
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', content }]} live={false} />)
    expect(screen.getByRole('heading', { name: /Authorization: \[redacted\]/ })).toBeInTheDocument()
    expect(screen.getByText(/public status/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('PRIVATE_CARD_')
    expect(content).toContain('PRIVATE_CARD_AUTH')
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it.each(['running', 'failed', 'cancelled'] as const)('does not promote a %s card-like receipt to completed display', status => {
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', status, content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Unsettled card' }, untrustedData: true, grantsPermission: false }) }]} live={false} />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
  })
  it.each([
    { toolName: 'web_search', content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Wrong tool result' }, untrustedData: true, grantsPermission: false }) },
    { toolName: 'show_card', content: '{invalid json' },
    { toolName: 'show_card', content: JSON.stringify({ status: 'provided', card: { title: 'Unversioned result' } }) },
    { toolName: 'show_card', content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Oversize', body: 'x'.repeat(4001) }, untrustedData: true, grantsPermission: false }) },
    { toolName: 'show_card', error: 'Still failed', content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Not completed' }, untrustedData: true, grantsPermission: false }) },
    { toolName: 'show_card', content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Unsafe extension', url: 'https://external.invalid' }, untrustedData: true, grantsPermission: false }) }
  ])('falls back to ordinary read-only details for invalid/foreign display-like data %#', patch => {
    render(<ChatToolCalls history={[{ ...entry, ...patch }]} live={false} />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('chat.tool_call.result')).toBeInTheDocument()
    expect(document.querySelector('a,img,input,textarea')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it('restores a serialized display as inert text; expanding never answers, executes or changes it', () => {
    const serialized = JSON.stringify([{ ...entry, toolName: 'show_card', args: { title: 'IGNORE_ARGUMENT_TITLE' }, content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Restored model card', body: 'https://external.invalid/#do-not-open\n<script>untrusted()</script>' }, untrustedData: true, grantsPermission: false }) }])
    const restored = JSON.parse(serialized)
    render(<ChatToolCalls history={restored} live={false} />)
    expect(screen.getByRole('heading', { name: 'Restored model card' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button'))
    expect(JSON.stringify(restored)).toBe(serialized)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(document.querySelector('a,img,input,textarea,script')).toBeNull()
  })
  it('renders provided fields as inert key/value text with inline layout, contextual redaction and no reply controls', () => {
    const content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Structured read-only fields', fields: [{ label: 'Status', value: '<img src="https://external.invalid/field">', inline: true }, { label: 'password', value: 'PRIVATE_FIELD_PASSWORD' }, { label: 'Other', value: 'https://external.invalid/plain', inline: false }] }, untrustedData: true, grantsPermission: false })
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', content }]} live={false} />)
    expect(screen.getByRole('heading', { name: 'Structured read-only fields' })).toBeInTheDocument()
    expect(screen.getByText('Status: <img src="https://external.invalid/field">')).toBeInTheDocument()
    expect(screen.getByText('password: [redacted]')).toBeInTheDocument()
    expect(screen.getByText('Other: https://external.invalid/plain')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('PRIVATE_FIELD_PASSWORD')
    expect(content).toContain('PRIVATE_FIELD_PASSWORD')
    expect(document.querySelector('a,img,input,textarea,script')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('chat.tool_call.card_display_notice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(document.body.textContent).not.toContain('PRIVATE_FIELD_PASSWORD')
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it('keeps valid field receipts above 16KiB redacted on expansion without mutating serialized history', () => {
    const fields = [{ label: 'password', value: 'PRIVATE_LARGE_FIELD with spaces\nand a second line' }, ...Array.from({ length: 3 }, () => ({ label: 'Public', value: '\u0001'.repeat(1000) }))]
    const content = JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Large bounded fields', fields }, untrustedData: true, grantsPermission: false })
    expect(content.length).toBeGreaterThan(16384)
    expect(content.length).toBeLessThan(32768)
    const history = JSON.parse(JSON.stringify([{ ...entry, toolName: 'show_card', args: { title: 'Fields', fields }, content }]))
    const before = JSON.stringify(history)
    render(<ChatToolCalls history={history} live={false} />)
    expect(screen.getByRole('heading', { name: 'Large bounded fields' })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('PRIVATE_LARGE_FIELD')
    fireEvent.click(screen.getByRole('button'))
    expect(document.body.textContent).not.toContain('PRIVATE_LARGE_FIELD')
    expect(document.body.textContent).not.toContain('second line')
    expect(JSON.stringify(history)).toBe(before)
    expect(content).toContain('PRIVATE_LARGE_FIELD')
    expect(document.querySelector('a,img,input,textarea,script')).toBeNull()
  })
  it.each([null, [{ label: 'x', value: 'x', url: 'https://external.invalid' }], Array.from({ length: 9 }, () => ({ label: '', value: '' })), [{ label: '', value: '😀'.repeat(501) }]])('falls back without field preview for invalid bounded rows %#', fields => {
    render(<ChatToolCalls history={[{ ...entry, toolName: 'show_card', content: JSON.stringify({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', card: { title: 'Not promoted', fields }, untrustedData: true, grantsPermission: false }) }]} live={false} />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('chat.tool_call.result')).toBeInTheDocument()
    expect(document.querySelector('a,img,input,textarea,script')).toBeNull()
  })
  it('renders nothing without actual tool records', () => {
    const view = render(<ChatToolCalls live={false} />)
    expect(view.container).toBeEmptyDOMElement()
  })
})
