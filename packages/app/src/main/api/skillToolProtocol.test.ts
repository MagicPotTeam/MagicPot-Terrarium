import { describe, expect, it } from 'vitest'
import { classifySkillToolPrefix, parseSkillToolInvocation } from './skillToolProtocol'

const allowed = new Set(['files.read'])
const path = String.raw`D:\owned\中文 文档 {draft}.docx`
const invocation = {
  toolName: 'files.read',
  args: { path, maxBytes: 1048576, nested: { quote: '"}' } }
}
const json = JSON.stringify(invocation)

describe('leading tool-frame dispatch', () => {
  it.each([
    json,
    json + ' 抱歉，我无法读取 DOCX。',
    ' \n' + json + '\nI will read it now.',
    '```json\n' + json + '\n```\nSorry, cannot read.',
    '```JSON\r\n' + json + '\r\n```',
    '```\n' + json + '\n```',
    JSON.stringify({ args: invocation.args, toolName: 'files.read' })
  ])('extracts exactly one invocation without changing path or nested values %#', (content) => {
    expect(parseSkillToolInvocation(content, allowed)).toEqual({ kind: 'tool', invocation })
  })
  it.each([
    'Here is an example: ' + json,
    '```python\nprint(1)\n```',
    '{"answer":"example","toolName":"files.read","args":{}}',
    '{"toolName":"files.read","args":{},"explanation":"example"}',
    '{"toolName":"not.bound","args":{}}',
    'No file needs reading.',
    '{}',
    ''
  ])('does not execute ordinary prose, JSON examples, or unbound calls %#', (content) => {
    expect(parseSkillToolInvocation(content, allowed)).toEqual({ kind: 'text' })
  })
  it.each([json + json, json + '\n```json\n' + json + '\n```', json + '\nNext call: ' + json])(
    'rejects ambiguous multiple frames without choosing a command %#',
    (content) => {
      expect(parseSkillToolInvocation(content, allowed)).toEqual({
        kind: 'invalid',
        reason: 'ambiguous'
      })
    }
  )
  it.each([
    String.raw`{"toolName":"files.read","args":{"path":"D:\owned\中文.docx"}}`,
    '{"toolName":"files.read","args":',
    '```json\n' + json,
    '{"toolName":"files.read","args":{"path":"' + 'x'.repeat(512 * 1024) + '"}}'
  ])('flags malformed, truncated or oversized tool frames for bounded correction %#', (content) => {
    expect(parseSkillToolInvocation(content, allowed)).toEqual({
      kind: 'invalid',
      reason: 'malformed'
    })
  })
  it('does not leak a partial JSON fence prefix', () => {
    for (const content of ['`', '``', '```', '```j', '```js', '```jso', '```json'])
      expect(classifySkillToolPrefix(content)).toBe('pending')
    expect(classifySkillToolPrefix('```json\n{"toolName":')).toBe('tool')
    expect(classifySkillToolPrefix('```json\n{"answer":')).toBe('text')
  })
})
