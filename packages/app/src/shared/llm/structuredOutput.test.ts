import { describe, expect, it } from 'vitest'
import {
  LLM_STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES,
  normalizeLLMStructuredOutput
} from './structuredOutput'

describe('normalizeLLMStructuredOutput', () => {
  it('detaches a bounded schema and preserves strictness', () => {
    const schema: Record<string, unknown> & {
      properties: Record<string, unknown>
    } = {
      type: 'object',
      properties: { value: { type: 'string' } }
    }
    const result = normalizeLLMStructuredOutput({ name: 'example_output', schema, strict: true })!
    expect(result).toEqual({ name: 'example_output', schema, strict: true })
    expect(result.schema).not.toBe(schema)
    schema.properties = {}
    expect(result.schema).toEqual({
      type: 'object',
      properties: { value: { type: 'string' } }
    })
  })

  it('rejects malformed names, schemas and oversized payloads', () => {
    expect(() => normalizeLLMStructuredOutput({ name: '', schema: {} })).toThrow()
    expect(() => normalizeLLMStructuredOutput({ name: 'has space', schema: {} })).toThrow()
    expect(() => normalizeLLMStructuredOutput({ name: 'valid', schema: [] })).toThrow()
    expect(() =>
      normalizeLLMStructuredOutput({ name: 'valid', schema: {}, strict: 'yes' })
    ).toThrow()
    const large = { value: 'x'.repeat(LLM_STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES) }
    expect(() => normalizeLLMStructuredOutput({ name: 'valid', schema: large })).toThrow()
  })

  it('rejects schema references that escape the detached document', () => {
    expect(() =>
      normalizeLLMStructuredOutput({
        name: 'external_ref',
        schema: { type: 'object', properties: { value: { $ref: 'https://example.test/schema' } } }
      })
    ).toThrow(/external reference/i)
    expect(() =>
      normalizeLLMStructuredOutput({
        name: 'external_dynamic_ref',
        schema: { $dynamicRef: 'other-schema' }
      })
    ).toThrow(/external reference/i)
  })

  it('rejects excessively deep or large schema graphs', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let index = 0; index < 70; index += 1) deep = { allOf: [deep] }
    expect(() => normalizeLLMStructuredOutput({ name: 'deep', schema: deep })).toThrow(
      /deeply nested/i
    )

    // Repeated scalar entries keep the JSON under the 32 KiB byte budget while
    // still exercising the traversal node cap.
    const manyNodes = { allOf: Array.from({ length: 10_001 }, () => 0) }
    expect(() => normalizeLLMStructuredOutput({ name: 'many_nodes', schema: manyNodes })).toThrow(
      /too many nodes/i
    )
  })

  it('does not create a contract when omitted', () => {
    expect(normalizeLLMStructuredOutput(undefined)).toBeUndefined()
  })
})
