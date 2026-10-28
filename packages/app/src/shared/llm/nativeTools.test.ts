import { describe, expect, it } from 'vitest'
import {
  buildNativeToolDefinitions,
  extractNativeToolResult,
  prepareNativeToolBatch,
  projectNativeToolTurns,
  isNativeToolsUnsupportedError
} from './nativeTools'
const tools = [
  {
    name: 'files.read',
    description: 'read',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
]
const call = {
  id: 'call_1',
  name: 'files.read',
  wireName: 'mp_tool_0',
  arguments: '{"path":"a.txt"}'
}
describe('native tool protocol boundaries', () => {
  it('maps dotted names without collisions and leaves schemas unchanged', () => {
    const input = [...tools, { ...tools[0], name: 'files_read' }]
    const original = JSON.stringify(input)
    const out = buildNativeToolDefinitions(input, 'responses')
    expect(out.map((x) => x.name)).toEqual(['mp_tool_0', 'mp_tool_1'])
    expect(JSON.stringify(input)).toBe(original)
    expect(out[0].strict).toBe(false)
  })
  it.each(['[]', 'null', '"a"', '{', '1'])(
    'rejects non-object/malformed arguments %s',
    (argumentsText) => {
      expect(() => prepareNativeToolBatch([{ ...call, arguments: argumentsText }], tools)).toThrow()
    }
  )
  it.each(['', 'contains space', '\n', 'x'.repeat(257)])('rejects invalid call id', (id) => {
    expect(() => prepareNativeToolBatch([{ ...call, id }], tools)).toThrow(/id/)
  })
  it('rejects duplicate call ids, unbound aliases, and oversized argument payloads', () => {
    expect(() => prepareNativeToolBatch([call, call], tools)).toThrow(/duplicate/)
    expect(() => prepareNativeToolBatch([{ ...call, wireName: 'other' }], tools)).toThrow(/unbound/)
    expect(() =>
      prepareNativeToolBatch([{ ...call, arguments: 'x'.repeat(600000) }], tools)
    ).toThrow(/budget/)
  })
  it('does not execute a truncated tool response', () => {
    expect(() =>
      extractNativeToolResult(
        {
          status: 'incomplete',
          output: [
            {
              type: 'function_call',
              call_id: call.id,
              name: call.wireName,
              arguments: call.arguments
            }
          ]
        },
        tools,
        'responses'
      )
    ).toThrow(/Incomplete/)
  })
  it('requires exact results and refuses mismatched response items', () => {
    expect(() =>
      projectNativeToolTurns([{ content: '', calls: [call], results: [] }], 'responses')
    ).toThrow(/paired/)
    expect(() =>
      projectNativeToolTurns(
        [{ content: '', calls: [call], results: [{ callId: 'other', output: 'result' }] }],
        'responses'
      )
    ).toThrow(/paired/)
    expect(() =>
      projectNativeToolTurns(
        [
          {
            content: '',
            calls: [call],
            results: [{ callId: call.id, output: 'result' }],
            responseItems: []
          }
        ],
        'responses'
      )
    ).toThrow(/match/)
  })
  it.each([500, 401, 403, 429])('never treats HTTP %i as a capability fallback', (statusCode) => {
    expect(isNativeToolsUnsupportedError({ statusCode, message: 'tools is not supported' })).toBe(
      false
    )
  })
  it('only accepts an explicit capability rejection, not arbitrary schema problems', () => {
    expect(
      isNativeToolsUnsupportedError({ statusCode: 400, message: 'tools is not supported' })
    ).toBe(true)
    expect(
      isNativeToolsUnsupportedError({
        statusCode: 400,
        message: 'Invalid schema for function files.read'
      })
    ).toBe(false)
    expect(
      isNativeToolsUnsupportedError({
        statusCode: 400,
        message: 'tools is not supported',
        retryBlocked: true
      })
    ).toBe(false)
  })
})

describe('native response status integrity', () => {
  it.each(['failed', 'cancelled', 'in_progress', 'queued'])(
    'rejects explicit unfinished Responses status %s',
    (status) => {
      expect(() =>
        extractNativeToolResult(
          {
            status,
            output: [
              {
                type: 'function_call',
                call_id: call.id,
                name: call.wireName,
                arguments: call.arguments
              }
            ]
          },
          tools,
          'responses'
        )
      ).toThrow(/incomplete/i)
    }
  )
})
