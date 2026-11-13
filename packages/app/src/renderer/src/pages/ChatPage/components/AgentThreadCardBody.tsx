import React from 'react'
import { Box } from '@mui/material'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent, Root, RootContent, Text } from 'hast'
import { AGENT_THREAD_INTERACTION_LIMITS } from '@shared/api/agentThreadInteraction'
import { formatToolCallValue } from '../chatToolCallDisplay'

export const AGENT_THREAD_CARD_BODY_MARKDOWN_LIMITS = {
  input: AGENT_THREAD_INTERACTION_LIMITS.body,
  nodes: 1024,
  depth: 24
} as const

const elements = ['p', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td']
const allowed = new Set(elements)
const blocks = new Set(['p', 'blockquote', 'ul', 'ol', 'li', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'])
const text = (value: string): Text => ({ type: 'text', value })
const element = (tagName: string, children: ElementContent[]): Element => ({ type: 'element', tagName, properties: {}, children })
type Raw = { type: 'raw'; value: string }

/** Last fixed parser pass. Nothing supplied by the model becomes a React prop. */
function formattingOnlyBody() {
  return (root: Root) => {
    let nodes = 1
    const clean = (node: RootContent | Raw, depth: number): ElementContent[] => {
      if (++nodes > AGENT_THREAD_CARD_BODY_MARKDOWN_LIMITS.nodes || depth > AGENT_THREAD_CARD_BODY_MARKDOWN_LIMITS.depth) throw new Error('Body formatting bound')
      if (node.type === 'text' || node.type === 'raw') return [text(node.value)]
      if (node.type !== 'element') throw new Error('Unsupported body node')
      // Footnotes generate global IDs, aria references and linkbacks. Keep their source literal instead.
      if (node.tagName === 'sup' || node.tagName === 'section') throw new Error('Body footnotes use plain text')
      if (node.tagName === 'img') return [text(typeof node.properties.alt === 'string' ? node.properties.alt : '')]
      if (node.tagName === 'input') {
        if (node.properties.type !== 'checkbox' || node.properties.disabled !== true) throw new Error('Unsupported body control')
        return [text(node.properties.checked === true ? '[x]' : '[ ]')]
      }
      const children = node.children.flatMap(child => clean(child, depth + 1))
      if (node.tagName === 'a') return children
      // A body heading cannot replace or compete with the original accessible card title.
      if (/^h[1-6]$/.test(node.tagName)) return [element('p', [element('strong', children)])]
      if (!allowed.has(node.tagName)) throw new Error('Unsupported body element')
      // Discard ALL original properties, data, positions, classes, IDs, styles and URLs.
      return [element(node.tagName, children)]
    }
    const children = root.children.flatMap(child => clean(child, 1))
    // Heading normalization adds nodes/depth; validate emitted content independently.
    let emitted = 1
    const checkOutput = (items: readonly ElementContent[], depth: number): void => {
      for (const node of items) {
        if (++emitted > AGENT_THREAD_CARD_BODY_MARKDOWN_LIMITS.nodes || depth > AGENT_THREAD_CARD_BODY_MARKDOWN_LIMITS.depth) throw new Error('Body output formatting bound')
        if (node.type === 'element') checkOutput(node.children, depth + 1)
      }
    }
    checkOutput(children, 1)
    const visibleText = (items: readonly RootContent[]): string => items.map(node => {
      if (node.type === 'text') return node.value
      if (node.type !== 'element') return ''
      if (node.tagName === 'br' || node.tagName === 'hr') return '\n'
      const value = visibleText(node.children)
      return blocks.has(node.tagName) ? `\n${value}\n` : value
    }).join('')
    // Entity decoding and inline formatting can reveal a credential spanning text nodes.
    // Redact the WHOLE decoded display, not tiny runs; never reinterpret the replacement.
    const decoded = visibleText(children)
    const redacted = formatToolCallValue(decoded).text
    root.children = redacted === decoded ? children : [text(redacted)]
  }
}

function bodyContent(body: unknown): React.ReactNode {
  if (typeof body !== 'string') return null
  const plain = formatToolCallValue(body).text
  if (!plain) return null
  if (body.length > AGENT_THREAD_CARD_BODY_MARKDOWN_LIMITS.input || plain.length > AGENT_THREAD_CARD_BODY_MARKDOWN_LIMITS.input || !plain.trim()) return plain
  // Preserve existing parsed-JSON sensitive-key/label-value-row redaction before
  // Markdown unescaping could turn valid JSON into unrecognized, leaking text.
  if (body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
    try {
      JSON.parse(body)
      return plain
    } catch {
      // Non-JSON Markdown lists/links still follow the bounded formatting path.
    }
  }
  try {
    // Installed Markdown is a synchronous, hook-free parse/runSync/post function.
    // Call it before mounting so parser/transform errors fall back to escaped text.
    // Parse bounded original syntax privately. Pre-redacted markers could hide token
    // suffixes from the decoded pass; only whole-text-redacted clean output can mount.
    return Markdown({ children: body, remarkPlugins: [remarkGfm], rehypePlugins: [formattingOnlyBody], allowedElements: elements, urlTransform: () => undefined })
  } catch {
    return plain
  }
}

/** Formatting-only body. No resources, links, controls, HTML execution or tool authority. */
export default function AgentThreadCardBody({ body }: { body: unknown }) {
  const content = bodyContent(body)
  if (content === null) return null
  return <Box component="div" sx={{ fontSize: '0.875rem', lineHeight: 1.43, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', my: 1, '& p': { my: 0.5 }, '& ul, & ol': { my: 0.5, pl: 2.5 }, '& pre': { m: 0.5, p: 1, overflowX: 'auto', bgcolor: 'action.hover', whiteSpace: 'pre-wrap' }, '& code': { fontFamily: 'monospace' }, '& blockquote': { ml: 1, pl: 1, borderLeft: '2px solid', borderColor: 'divider' }, '& table': { width: '100%', borderCollapse: 'collapse' }, '& th, & td': { border: '1px solid', borderColor: 'divider', px: 0.5, py: 0.25, textAlign: 'left' } }}>{content}</Box>
}
