import { describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import { AGENT_APP_DOCUMENT_SCHEMA, parseAgentAppDocument, parseAgentAppValues, type AgentAppDocument } from './agentThreadApp'
const document = (): AgentAppDocument => ({ title: 'Comparison', blocks: [
  { kind: 'text', text: '<script>not executable</script>' },
  { kind: 'table', columns: ['Name', 'Value'], rows: [['A', '10']] },
  { kind: 'bar_chart', items: [{ label: 'A', value: 10 }] }
], fields: [
  { kind: 'text', id: 'note', label: 'Note', required: true },
  { kind: 'number', id: 'count', label: 'Count', min: 1, max: 10 },
  { kind: 'select', id: 'choice', label: 'Choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { kind: 'toggle', id: 'include', label: 'Include' }
] })
const answers = () => ({ note: 'feedback only', count: 2, choice: 'a', include: false })
describe('declarative Agent app data contract', () => {
  it('agrees with model schema for valid data, clones it and treats markup/URLs as literal text', () => {
    const original = document(), result = parseAgentAppDocument(original)
    expect(new Ajv({ strict: false }).compile(AGENT_APP_DOCUMENT_SCHEMA)(result)).toBe(true)
    original.blocks[0] = { kind: 'text', text: 'changed' }
    expect(result.blocks[0]).toEqual({ kind: 'text', text: '<script>not executable</script>' })
    expect(parseAgentAppValues(result, answers())).toEqual(answers())
  })
  it.each([
    { html: '<script>evil()</script>' }, { css: 'body{background:url(https://evil)}' },
    { script: 'fetch("https://evil")' }, { url: 'file:///secrets' }, { title: '   ' }, { title: 'a'.repeat(201) },
    { blocks: [] }, { blocks: [{ kind: 'html', text: '<iframe>' }] }, { blocks: [{ kind: 'text', text: 'a', onClick: 'callTool' }] },
    { blocks: [{ kind: 'text', text: 'a', style: { color: 'red' } }] }, { blocks: [{ kind: 'table', columns: ['a'], rows: [['1', '2']] }] },
    { blocks: [{ kind: 'bar_chart', items: [{ label: 'x', value: -1 }] }] }, { blocks: [{ kind: 'bar_chart', items: [{ label: 'x', value: Infinity }] }] },
    { fields: [{ kind: 'number', id: 'n', label: 'n', min: 10, max: 0 }] },
    { fields: [{ kind: 'select', id: 'n', label: 'n', options: [{ id: 'a', label: 'a' }, { id: 'a', label: 'b' }] }] },
    { fields: [{ kind: 'text', id: 'x', label: 'x' }, { kind: 'toggle', id: 'x', label: 'x' }] },
    { fields: [{ kind: 'text', id: '__proto__', label: 'x' }] }, { fields: [{ kind: 'text', id: 'constructor', label: 'x' }] },
    { fields: [{ kind: 'text', id: 'toString', label: 'x' }] }
  ])('rejects unknown capabilities, invalid shape and unsafe bounds %#', (change) => {
    expect(() => parseAgentAppDocument({ ...document(), ...change })).toThrow()
  })
  it('rejects total UTF8 capacity overflow even if individual cell bounds are valid', () => {
    const block = { kind: 'table' as const, columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rows: Array.from({ length: 20 }, () => Array(8).fill('中'.repeat(500))) }
    expect(() => parseAgentAppDocument({ title: 'large', blocks: [block] })).toThrow()
  })
  it('rejects getters, inherited fields, sparse arrays, array extras and hidden toJSON without invoking them', () => {
    const getter = vi.fn(() => 'evil')
    const input = document(); Object.defineProperty(input, 'title', { enumerable: true, get: getter })
    expect(() => parseAgentAppDocument(input)).toThrow(); expect(getter).not.toHaveBeenCalled()
    expect(() => parseAgentAppDocument(Object.create(document()))).toThrow()
    const sparse = new Array(2); sparse[1] = { kind: 'text', text: 'a' }
    expect(() => parseAgentAppDocument({ title: 'sparse', blocks: sparse })).toThrow()
    const hidden = document(); Object.defineProperty(hidden.blocks, 'toJSON', { value: getter })
    expect(() => parseAgentAppDocument(hidden)).toThrow(); expect(getter).not.toHaveBeenCalled()
    expect(() => parseAgentAppDocument(JSON.parse('{"title":"x","blocks":[{"kind":"text","text":"x"}],"__proto__":{}}'))).toThrow()
  })
  it.each([{ count: '2' }, { count: 11 }, { count: NaN }, { note: ' ' }, { note: 'x'.repeat(2001) }, { include: 'false' }, { choice: 'unknown' }, { approved: true }, { code: 'run' }])('only accepts exact bounded feedback fields %#', (change) => {
    expect(() => parseAgentAppValues(document(), { ...answers(), ...change })).toThrow()
  })
  it('requires every declared value, bounds total feedback and supports an empty acknowledgement', () => {
    expect(() => parseAgentAppValues(document(), {})).toThrow()
    expect(parseAgentAppValues({ title: 'plain', blocks: [{ kind: 'text', text: 'data' }] }, {})).toEqual({})
    const doc = parseAgentAppDocument({ title: 'many', blocks: [{ kind: 'text', text: 'data' }], fields: Array.from({ length: 8 }, (_, n) => ({ kind: 'text', id: `f${n}`, label: 'field' })) })
    expect(() => parseAgentAppValues(doc, Object.fromEntries(doc.fields!.map((field) => [field.id, 'a'.repeat(2000)])))).toThrow()
  })
})
