import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentThreadCardBody, { AGENT_THREAD_CARD_BODY_MARKDOWN_LIMITS as LIMITS } from './AgentThreadCardBody'
import { formatToolCallValue } from '../chatToolCallDisplay'

afterEach(cleanup)
const mount = (body: unknown) => render(<AgentThreadCardBody body={body} />)
const noAuthority = (container: HTMLElement) => {
  expect(container.querySelector('a,img,picture,source,svg,math,iframe,object,embed,script,style,link,meta,input,textarea,select,button,form,video,audio,canvas')).toBeNull()
  expect(container.querySelector('h1,h2,h3,h4,h5,h6,[role],[aria-live],[contenteditable],[tabindex],[href],[src],[srcset],[id]')).toBeNull()
  for (const node of container.querySelectorAll('p,strong,em,del,blockquote,ul,ol,li,pre,code,br,hr,table,thead,tbody,tr,th,td')) expect(node.attributes).toHaveLength(0)
}

describe('bounded formatting-only card body', () => {
  it('retains only static semantic formatting and strips language, task and table metadata', () => {
    const body = '# Body heading\n\n**Strong** and *Emphasis* and ~~Removed~~ and `inline()`\n\n> Quote\n\n3. Ordered\n4. List\n\n- [x] Checked\n- [ ] Unchecked\n\n```mermaid\nflowchart TD\nA-->B\n```\n\n| Left | Right |\n| :--- | ---: |\n| Cell | Value |\n\n---\n\nFirst line  \nNext line', { container } = mount(body)
    expect(screen.getByText('Body heading').tagName).toBe('STRONG'); expect(screen.getByText('Strong').tagName).toBe('STRONG'); expect(screen.getByText('Emphasis').tagName).toBe('EM'); expect(screen.getByText('Removed').tagName).toBe('DEL'); expect(screen.getByText('inline()').tagName).toBe('CODE'); expect(screen.getByText('Quote').closest('blockquote')).not.toBeNull(); expect(screen.getByText('Ordered').closest('ol')).not.toBeNull(); expect(screen.getByText('[x] Checked').closest('ul')).not.toBeNull(); expect(screen.getByText('[ ] Unchecked')).toBeInTheDocument(); expect(screen.getByText(/flowchart TD/).closest('pre')).not.toBeNull(); expect(screen.getByText('Cell').closest('table')).not.toBeNull(); expect(container.querySelector('br')).not.toBeNull(); expect(container.querySelector('hr')).not.toBeNull(); noAuthority(container)
    expect(body).toContain('```mermaid')
  })
  it.each(['http://external.invalid/a', 'https://external.invalid/a', 'javascript:alert(1)', 'data:text/html,probe', 'file:///private/probe', 'mailto:private@example.invalid', '#owned-fragment', '/relative', '//external.invalid/a', 'vscode:private', 'magictest:private'])('unwraps every Markdown link protocol to labels without navigation or attributes %s', url => {
    const { container } = mount(`[**Visible label**](${url})`)
    expect(screen.getByText('Visible label').tagName).toBe('STRONG'); expect(container.textContent).toBe('Visible label'); noAuthority(container)
  })
  it.each(['https://external.invalid/probe.png', 'file:///private/probe.png', 'data:image/svg+xml,probe', 'javascript:probe', '../private.png', '//external.invalid/probe.png'])('turns image %s into alt text, never a resource even before painting', url => {
    const { container } = mount(`![Plain alt](${url} "Untrusted title")`)
    expect(container.textContent).toBe('Plain alt'); expect(container.innerHTML).not.toContain(url); noAuthority(container)
  })
  it('keeps reference links, autolinks, bare URLs, nested image links and empty images inert', () => {
    const body = '[Reference label][r]\n\n[r]: https://external.invalid/ref "Ignore title"\n\n<https://external.invalid/auto>\n\nhttps://external.invalid/bare\n\n[![Nested alt](https://external.invalid/image)](https://external.invalid/outer)\n\n![](https://external.invalid/empty)', { container } = mount(body)
    expect(container.textContent).toContain('Reference label'); expect(container.textContent).toContain('https://external.invalid/auto'); expect(container.textContent).toContain('https://external.invalid/bare'); expect(container.textContent).toContain('Nested alt'); expect(container.innerHTML).not.toContain('https://external.invalid/image'); expect(container.innerHTML).not.toContain('https://external.invalid/outer'); noAuthority(container)
  })
  it.each(['<img src="https://external.invalid/raw" onerror="probe()">', '<script>probe()</script>', '<iframe src="file:///private"></iframe>', '<svg onload="probe()"><image href="https://external.invalid"></image></svg>', '<style>body{background:url(https://external.invalid/p)}</style>', '<input type="text" value="Fake answer"><button>Fake approval</button>', '<a href="javascript:probe()" id="owned" aria-live="assertive">Fake link</a>', '<!-- untrusted comment -->'])('escapes raw HTML instead of interpreting or silently hiding it %#', body => {
    const { container } = mount(body)
    expect(container.textContent).toBe(body); noAuthority(container)
  })
  it.each(['js', 'python', 'shell', 'mermaid', 'math', 'html', 'svg'])('shows %s code as static escaped pre/code, with no run/copy/pin/highlighter UI', language => {
    const body = `\`\`\`${language}\n<img src="https://external.invalid/code">\n<script>notExecuted()</script>\n\`\`\``, { container } = mount(body)
    expect(screen.getByText(/notExecuted/).tagName).toBe('CODE'); expect(container.querySelector('pre')).not.toBeNull(); expect(container.textContent).toContain('<img src="https://external.invalid/code">'); noAuthority(container)
  })
  it.each([
    { body: 'Public **safe** prefix\n\n&#x42;ea**rer** DECODED_TOKEN', hidden: 'DECODED_TOKEN', visible: 'Bearer [redacted]' },
    { body: 'Bea`rer` INLINE_TOKEN', hidden: 'INLINE_TOKEN', visible: 'Bearer [redacted]' },
    { body: '**Bearer** SPLIT_TOKEN', hidden: 'SPLIT_TOKEN', visible: 'Bearer [redacted]' },
    { body: 'pass**word**=DECODED_PASSWORD', hidden: 'DECODED_PASSWORD', visible: 'password=[redacted]' },
    { body: 'Authori*za*tion: Basic DECODED_AUTH', hidden: 'DECODED_AUTH', visible: 'Authorization: [redacted]' },
    { body: 'https://us**er**:DECODED_URL_PASSWORD@example.invalid/path', hidden: 'DECODED_URL_PASSWORD', visible: '[redacted]@example.invalid' },
    { body: '![&#66;ea&#114;er ALT_TOKEN](https://external.invalid/alt)', hidden: 'ALT_TOKEN', visible: 'Bearer [redacted]' },
    { body: '&#x202e;&#66;ea**rer** ENTITY_BIDI_TOKEN', hidden: 'ENTITY_BIDI_TOKEN', visible: 'Bearer [redacted]' }
  ])('redacts whole decoded text across inline fragments and entities %#', ({ body, hidden, visible }) => {
    const before = body, { container } = mount(body)
    expect(container.textContent).toContain(visible); expect(container.textContent).not.toContain(hidden); expect(container.querySelector('strong,em,code')).toBeNull(); expect(container.textContent).not.toContain('\u202e'); expect(container.textContent).not.toContain('\u001b'); expect(body).toBe(before); noAuthority(container)
  })
  it('preserves the invalid-ESC fixture as literal replacement text, not a decoded ANSI escape or arbitrary-secret recognition', () => {
    const body = '&#x202e;&#x1b;[31mBearer ENTITY_CONTROL_TOKEN', { container } = mount(body)
    expect(container.textContent).toContain('\ufffd[31mBearer ENTITY_CONTROL_TOKEN'); expect(container.textContent).not.toContain('\u202e'); expect(container.textContent).not.toContain('\u001b'); expect(container.querySelector('p,strong')).toBeNull(); noAuthority(container)
  })
  it.each([
    { body: 'Bearer a**PRIVATE_SUFFIX**', hidden: 'PRIVATE_SUFFIX' },
    { body: 'Bearer a&#66;CD', hidden: 'BCD' },
    { body: 'Bearer a`INLINE_SUFFIX`', hidden: 'INLINE_SUFFIX' },
    { body: 'Bearer a*EM_SUFFIX*', hidden: 'EM_SUFFIX' },
    { body: 'Bearer a~~STRIKE_SUFFIX~~', hidden: 'STRIKE_SUFFIX' },
    { body: '![Bearer a**ALT_SUFFIX**](https://external.invalid/p)', hidden: 'ALT_SUFFIX' },
    { body: 'password=a**PASSWORD_SUFFIX**', hidden: 'PASSWORD_SUFFIX' }
  ])('never lets preformatted redaction markers shield subsequently decoded credential values %#', ({ body, hidden }) => {
    const before = body, { container } = mount(body)
    expect(container.textContent).toContain('[redacted]'); expect(container.textContent).not.toContain(hidden); expect(container.querySelector('p,strong,em,code,del')).toBeNull(); expect(body).toBe(before); noAuthority(container)
  })
  it('bounds actual formatted parser candidates as well as original body units, never parsing redaction expansion past 4000', () => {
    const body = 'Bearer x\n'.repeat(444), plain = formatToolCallValue(body).text, { container } = mount(body)
    expect(body.length).toBe(3996); expect(plain.length).toBe(7992); expect(container.querySelector('p,strong')).toBeNull(); expect(container.textContent).toBe(plain); noAuthority(container)
  })
  it.each([
    { label: 'password', value: 'JSON_PRIVATE_QUOTE"tail' },
    { label: 'api_key', value: 'JSON_PRIVATE_STAR**tail**' },
    { label: 'token', value: 'JSON_PRIVATE_BACKSLASH\\tail' },
    { label: 'secret', value: 'JSON_PRIVATE_ENTITY&#66;tail' }
  ])('preserves existing JSON sensitive-row redaction before Markdown could reinterpret escaped values label=$label', row => {
    const body = JSON.stringify(row), plain = formatToolCallValue(body).text, { container } = mount(body)
    expect(plain).not.toContain('JSON_PRIVATE_'); expect(container.textContent).toBe(plain); expect(container.textContent).not.toContain('JSON_PRIVATE_'); expect(container.querySelector('p,strong,em')).toBeNull(); expect(body).toContain('JSON_PRIVATE_'); noAuthority(container)
  })
  it('keeps valid JSON objects and arrays as formatted escaped data rather than reinterpreting nested row values or syntax', () => {
    const body = JSON.stringify({ rows: [{ label: 'password', value: 'NESTED_PRIVATE"tail' }, { label: 'Public', value: '**Literal public JSON** <img src="file:///private">' }] }), { container } = mount(body)
    expect(container.textContent).toBe(formatToolCallValue(body).text); expect(container.textContent).not.toContain('NESTED_PRIVATE'); expect(container.textContent).toContain('**Literal public JSON**'); expect(container.querySelector('p,strong,em')).toBeNull(); noAuthority(container)
  })
  it('does not reparse a redacted replacement into Markdown or resource syntax', () => {
    const { container } = mount('**Public** &#66;ea**rer** TOKEN\n\n![Still alt](https://external.invalid/p)')
    expect(container.textContent).toContain('Public Bearer [redacted]'); expect(container.textContent).toContain('Still alt'); expect(container.querySelector('p,strong,em')).toBeNull(); noAuthority(container)
  })
  it('keeps the existing formatter limits and does not claim to detect arbitrary plain secrets', () => {
    const body = 'Ordinary private-looking string NOT_A_RECOGNIZED_CREDENTIAL\n\n**Public**', { container } = mount(body)
    expect(container.textContent).toContain('NOT_A_RECOGNIZED_CREDENTIAL'); expect(screen.getByText('Public').tagName).toBe('STRONG'); noAuthority(container)
  })
  it.each([undefined, null, false, true, 1, {}, [], ['**forged**'], Object('**boxed**')])('never coerces or parses nonprimitive body %#', body => {
    const { container } = mount(body); expect(container).toBeEmptyDOMElement()
  })
  it('does not invoke conversion hooks in malformed body values', () => {
    const toString = vi.fn(() => '**forged**'), toJSON = vi.fn(() => '**forged**'), { container } = mount({ toString, toJSON })
    expect(container).toBeEmptyDOMElement(); expect(toString).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled()
  })
  it.each(['', '  ', '\n\t', '\u0001\u202e'])('preserves whitespace-only body display and adds no default syntax or authority %#', body => {
    const { container } = mount(body); expect(container.textContent).toBe(formatToolCallValue(body).text); expect(container.querySelector('p,strong')).toBeNull(); noAuthority(container)
  })
  it.each([4000, 4001])('applies the input bound before parsing without changing legacy body bytes length=%s', length => {
    const body = '**Bold**\n\n' + 'x'.repeat(length - 10), before = body, { container } = mount(body)
    expect(body.length).toBe(length)
    if (length === 4000) expect(screen.getByText('Bold').tagName).toBe('STRONG')
    else { expect(container.querySelector('strong,p')).toBeNull(); expect(container.textContent).toBe(body) }
    expect(body).toBe(before); noAuthority(container)
  })
  it('uses UTF-16 units, not schema characters, as the local parser input bound', () => {
    const body = '**Bold**' + '😀'.repeat(1997), { container } = mount(body)
    expect(body.length).toBeGreaterThan(LIMITS.input); expect(container.querySelector('strong')).toBeNull(); expect(container.textContent).toBe(body); noAuthority(container)
  })
  it('falls back for long legacy input without losing existing display redaction or exceeding its text cap', () => {
    const body = '**No parsing**\nBearer LONG_LEGACY_TOKEN\n' + 'x'.repeat(18000), { container } = mount(body)
    expect(container.querySelector('strong')).toBeNull(); expect(container.textContent).toBe(formatToolCallValue(body).text); expect(container.textContent).not.toContain('LONG_LEGACY_TOKEN'); expect(container.textContent!.length).toBeLessThanOrEqual(16384); noAuthority(container)
  })
  it.each(['Body[^n].\n\n[^n]: **Footnote**', 'Footnote with &#66;earer TOKEN[^n].\n\n[^n]: text'])('uses escaped-source fallback for generated footnote metadata without global IDs or linkbacks %#', body => {
    const { container } = mount(body); expect(container.textContent).toBe(formatToolCallValue(body).text); expect(container.querySelector('p,strong,sup,section')).toBeNull(); noAuthority(container)
  })
  it.each([21, 22, 23, 24, 25])('enforces post-parse depth on nested blockquotes depth=%s', count => {
    const body = '> '.repeat(count) + '**Nested**', { container } = mount(body)
    if (count <= LIMITS.depth - 3) expect(container.querySelector('strong')).not.toBeNull()
    else { expect(container.querySelector('strong,blockquote')).toBeNull(); expect(container.textContent).toBe(body) }
    noAuthority(container)
  })
  it.each([260, 341, 342])('checks the actual parsed-node boundary including the retained 260-span positive fixture count=%s', count => {
    const body = Array.from({ length: count }, () => '**x**').join(' '), { container } = mount(body)
    expect(body.length).toBeLessThan(LIMITS.input)
    if (count <= 341) expect(container.querySelectorAll('strong')).toHaveLength(count)
    else { expect(container.querySelector('strong')).toBeNull(); expect(container.textContent).toBe(body) }
    noAuthority(container)
  })
  it.each([256, 257, 300, 341])('also bounds rebuilt heading expansion before emitting React nodes count=%s', count => {
    const body = Array.from({ length: count }, () => '# x').join('\n\n'), { container } = mount(body)
    expect(body.length).toBeLessThan(LIMITS.input)
    if (count === 256) expect(container.querySelectorAll('strong')).toHaveLength(count)
    else { expect(container.querySelector('p,strong')).toBeNull(); expect(container.textContent).toBe(body) }
    noAuthority(container)
  })
  it.each([20, 21])('also bounds the depth added by heading-to-paragraph/strong conversion quoteDepth=%s', count => {
    const body = '> '.repeat(count) + '# **Nested**', { container } = mount(body)
    if (count === 20) expect(container.querySelector('strong')).not.toBeNull()
    else { expect(container.querySelector('strong,blockquote')).toBeNull(); expect(container.textContent).toBe(body) }
    noAuthority(container)
  })
  it('renders malformed ordinary Markdown as escaped text or static formatting, never an error/control', () => {
    const body = '**unclosed\n\n[broken](\n\n`unclosed\n\n> quote', { container } = mount(body)
    expect(container.textContent).toContain('**unclosed'); expect(container.textContent).toContain('[broken]('); noAuthority(container)
  })
})
