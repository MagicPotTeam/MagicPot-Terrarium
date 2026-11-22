import { describe, expect, it, vi } from 'vitest'
import { assertMcpArguments, cloneBoundedMcpJson, prepareMcpSchema } from './agentThreadMcp'
const schema = () => ({ type: 'object', required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 5 }, count: { type: 'integer', minimum: 0, maximum: 4 }, flag: { type: 'boolean' }, choice: { type: 'string', enum: ['a', 'b'] }, items: { type: 'array', maxItems: 3, items: { type: 'number', exclusiveMinimum: 0 } } }, additionalProperties: false })
describe('bounded passive MCP input/schema boundary', () => {
  it('validates simple schema without coercion or defaults and detaches nested inputs', () => {
    const input = { message: 'hello', items: [1, 2] }, copy = cloneBoundedMcpJson(input, 1000)
    input.items[0] = 99
    expect(copy).toEqual({ message: 'hello', items: [1, 2] })
    expect(() => assertMcpArguments(prepareMcpSchema(schema()), copy)).not.toThrow()
  })
  it.each([
    {}, { message: '' }, { message: 'toolong' }, { message: 2 }, { message: 'x', count: '2' }, { message: 'x', count: 5 }, { message: 'x', count: 1.5 },
    { message: 'x', flag: 1 }, { message: 'x', choice: 'c' }, { message: 'x', extra: 'no' }, { message: 'x', items: [0] }, { message: 'x', items: [1, 2, 3, 4] }
  ])('rejects invalid args %#', (input) => expect(() => assertMcpArguments(prepareMcpSchema(schema()), input)).toThrow())
  it.each(['$ref', 'pattern', 'patternProperties', 'format', 'oneOf', 'anyOf', 'allOf', '$dynamicRef', 'if', 'unevaluatedProperties'])('fails closed on unsupported schema keyword %s rather than ignoring it', (keyword) => {
    expect(() => prepareMcpSchema({ type: 'object', [keyword]: 'untrusted' })).toThrow('unsupported')
  })
  it('does not execute accessors or toJSON, permits only plain bounded JSON', () => {
    const getter = vi.fn(() => 'secret')
    const input = Object.defineProperty({}, 'x', { enumerable: true, get: getter })
    expect(() => cloneBoundedMcpJson(input, 1000)).toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(() => cloneBoundedMcpJson({ toJSON: getter }, 1000)).toThrow()
    expect(() => cloneBoundedMcpJson(JSON.parse('{"__proto__":{"admin":true}}'), 1000)).toThrow()
    expect(() => cloneBoundedMcpJson(Object.create({ x: 1 }), 1000)).toThrow()
    expect(() => cloneBoundedMcpJson([Infinity], 1000)).toThrow()
    expect(() => cloneBoundedMcpJson(new Array(5), 1000)).toThrow()
    expect(() => cloneBoundedMcpJson('中'.repeat(100), 200)).toThrow('byte')
    const cycle: unknown[] = []; cycle.push(cycle)
    expect(() => cloneBoundedMcpJson(cycle, 1000)).toThrow('depth')
  })
  it('bounds schema and rejects malformed object/array definitions', () => {
    expect(() => prepareMcpSchema({ type: 'object', properties: { x: { type: 'array' } } })).toThrow()
    expect(() => prepareMcpSchema({ type: 'string' })).toThrow()
    expect(() => prepareMcpSchema({ type: 'object', properties: { x: { type: 'integer', minimum: '0' } } })).toThrow()
    expect(() => prepareMcpSchema({ type: 'object', description: 'x'.repeat(24001) })).toThrow()
  })
})
