import { describe, expect, it } from 'vitest'
import {
  assertStructuredOutputResult,
  LLM_STRUCTURED_OUTPUT_MAX_BYTES
} from './structuredOutputValidation'

const contract = {
  name: 'plan',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'string', minLength: 1 } }
  }
} as const

describe('assertStructuredOutputResult', () => {
  it('accepts provider JSON that matches the normalized schema', () => {
    expect(() =>
      assertStructuredOutputResult({ content: '{"value":"ok"}' }, contract)
    ).not.toThrow()
  })

  it('rejects malformed JSON and schema mismatches without exposing provider payloads', () => {
    expect(() => assertStructuredOutputResult({ content: 'not-json' }, contract)).toThrow(
      'invalid structured output JSON'
    )
    expect(() => assertStructuredOutputResult({ content: '{"value":3}' }, contract)).toThrow(
      'does not match the requested schema'
    )
    expect(() =>
      assertStructuredOutputResult({ content: '{"value":"ok","extra":true}' }, contract)
    ).toThrow('does not match the requested schema')
  })

  it('rejects external schema references before Ajv can resolve them', () => {
    expect(() =>
      assertStructuredOutputResult(
        { content: '{"value":"ok"}' },
        { ...contract, schema: { $ref: 'https://example.invalid/schema.json' } }
      )
    ).toThrow('Structured output contract is invalid')
  })

  it('isolates local schema ids between independently supplied contracts', () => {
    const first = {
      name: 'first',
      schema: { $id: 'local-contract', type: 'string' }
    }
    const second = {
      name: 'second',
      schema: { $id: 'local-contract', type: 'number' }
    }
    expect(() => assertStructuredOutputResult({ content: '"ok"' }, first)).not.toThrow()
    expect(() => assertStructuredOutputResult({ content: '1' }, second)).not.toThrow()
  })

  it('bounds provider output size and nesting before schema validation', () => {
    expect(() =>
      assertStructuredOutputResult(
        { content: `{"value":"${'x'.repeat(LLM_STRUCTURED_OUTPUT_MAX_BYTES)}"}` },
        contract
      )
    ).toThrow('too large')

    let nested = '"leaf"'
    for (let index = 0; index < 140; index += 1) nested = `{"value":${nested}}`
    expect(() => assertStructuredOutputResult({ content: nested }, contract)).toThrow('too complex')
  })

  it('is a no-op when the caller did not request structured output', () => {
    expect(() => assertStructuredOutputResult({ content: 'plain text' }, undefined)).not.toThrow()
  })
})
