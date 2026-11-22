/** Declarative display only: no HTML, CSS, script, URLs, file paths or service callbacks. */
export type AgentAppBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; title?: string; columns: string[]; rows: string[][] }
  | { kind: 'bar_chart'; title?: string; items: Array<{ label: string; value: number }> }
export type AgentAppField =
  | { kind: 'text'; id: string; label: string; required?: boolean }
  | { kind: 'number'; id: string; label: string; min: number; max: number }
  | { kind: 'select'; id: string; label: string; options: Array<{ id: string; label: string }> }
  | { kind: 'toggle'; id: string; label: string }
export type AgentAppDocument = { title: string; description?: string; blocks: AgentAppBlock[]; fields?: AgentAppField[] }
export type AgentAppValues = Record<string, string | number | boolean>
export const AGENT_APP_LIMITS = Object.freeze({ bytes: 65536, blocks: 12, fields: 8, answerCharacters: 2000, totalAnswerCharacters: 8000 })
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const text = (maxLength: number, minLength = 0) => ({ type: 'string', minLength, maxLength })
const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: 'array', items, minItems, maxItems })
const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' }
const label = text(120, 1)
const number = { type: 'number', minimum: -1000000000, maximum: 1000000000 }
const base = { id, label }
export const AGENT_APP_DOCUMENT_SCHEMA = object({
  title: text(200, 1), description: text(2000),
  blocks: array({ oneOf: [
    object({ kind: { const: 'text' }, text: text(4000, 1) }, ['kind', 'text']),
    object({ kind: { const: 'table' }, title: label, columns: array(label, 8, 1), rows: array(array(text(500), 8, 1), 20) }, ['kind', 'columns', 'rows']),
    object({ kind: { const: 'bar_chart' }, title: label, items: array(object({ label, value: { type: 'number', minimum: 0, maximum: 1000000000 } }, ['label', 'value']), 12, 1) }, ['kind', 'items'])
  ] }, AGENT_APP_LIMITS.blocks, 1),
  fields: array({ oneOf: [
    object({ ...base, kind: { const: 'text' }, required: { type: 'boolean' } }, ['kind', 'id', 'label']),
    object({ ...base, kind: { const: 'number' }, min: number, max: number }, ['kind', 'id', 'label', 'min', 'max']),
    object({ ...base, kind: { const: 'select' }, options: array(object({ id, label }, ['id', 'label']), 12, 2) }, ['kind', 'id', 'label', 'options']),
    object({ ...base, kind: { const: 'toggle' } }, ['kind', 'id', 'label'])
  ] }, AGENT_APP_LIMITS.fields)
}, ['title', 'blocks'])

const fail = (): never => { throw new Error('Invalid bounded declarative app document or feedback.') }
function record(value: unknown, keys: string[], required = keys): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  if (Object.getOwnPropertySymbols(value).length) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).some((key) => !keys.includes(key) || !descriptors[key].enumerable || !('value' in descriptors[key])) || required.some((key) => !Object.hasOwn(descriptors, key))) fail()
}
function string(value: unknown, max: number, nonblank = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (nonblank && !value.trim())) fail()
}
function list(value: unknown, max: number, min = 0): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid bounded declarative app array.')
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Object.getOwnPropertyNames(value).length !== value.length + 1 || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) fail()
  for (let i = 0; i < value.length; i++) if (!Object.getOwnPropertyDescriptor(value, String(i))?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, String(i))!)) fail()
}
function finite(value: unknown, min = -1000000000, max = 1000000000): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail()
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value) || Object.hasOwn(Object.prototype, value) || value === 'prototype') fail()
}
export function parseAgentAppDocument(value: unknown): AgentAppDocument {
  record(value, ['title', 'description', 'blocks', 'fields'], ['title', 'blocks'])
  string(value.title, 200, true)
  if (Object.hasOwn(value, 'description')) string(value.description, 2000)
  list(value.blocks, AGENT_APP_LIMITS.blocks, 1)
  for (const block of value.blocks) {
    record(block, ['kind', 'text', 'title', 'columns', 'rows', 'items'], ['kind'])
    if (block.kind === 'text') { record(block, ['kind', 'text']); string(block.text, 4000, true) }
    else if (block.kind === 'table') {
      record(block, ['kind', 'title', 'columns', 'rows'], ['kind', 'columns', 'rows'])
      list(block.columns, 8, 1); block.columns.forEach((column) => string(column, 120, true))
      list(block.rows, 20)
      for (const row of block.rows) { list(row, block.columns.length, block.columns.length); row.forEach((cell) => string(cell, 500)) }
    } else if (block.kind === 'bar_chart') {
      record(block, ['kind', 'title', 'items'], ['kind', 'items']); list(block.items, 12, 1)
      for (const item of block.items) { record(item, ['label', 'value']); string(item.label, 120, true); finite(item.value, 0) }
    } else fail()
    if (Object.hasOwn(block, 'title')) string(block.title, 120, true)
  }
  if (Object.hasOwn(value, 'fields')) {
    list(value.fields, AGENT_APP_LIMITS.fields)
    const ids = new Set<string>()
    for (const field of value.fields) {
      record(field, ['kind', 'id', 'label', 'required', 'min', 'max', 'options'], ['kind', 'id', 'label'])
      identifier(field.id); string(field.label, 120, true)
      if (ids.has(field.id)) fail(); ids.add(field.id)
      if (field.kind === 'text') {
        record(field, ['kind', 'id', 'label', 'required'], ['kind', 'id', 'label'])
        if (Object.hasOwn(field, 'required') && typeof field.required !== 'boolean') fail()
      } else if (field.kind === 'number') {
        record(field, ['kind', 'id', 'label', 'min', 'max']); finite(field.min); finite(field.max, field.min)
      } else if (field.kind === 'select') {
        record(field, ['kind', 'id', 'label', 'options']); list(field.options, 12, 2)
        const options = new Set<string>()
        for (const option of field.options) { record(option, ['id', 'label']); identifier(option.id); string(option.label, 120, true); if (options.has(option.id)) fail(); options.add(option.id) }
      } else if (field.kind === 'toggle') record(field, ['kind', 'id', 'label'])
      else fail()
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > AGENT_APP_LIMITS.bytes) fail()
  return structuredClone(value) as AgentAppDocument
}
export function parseAgentAppValues(document: AgentAppDocument, value: unknown): AgentAppValues {
  const fields = document.fields ?? []
  record(value, fields.map((field) => field.id))
  let characters = 0
  for (const field of fields) {
    const input = value[field.id]
    if (field.kind === 'text') { string(input, AGENT_APP_LIMITS.answerCharacters, field.required); characters += input.length }
    else if (field.kind === 'number') finite(input, field.min, field.max)
    else if (field.kind === 'toggle') { if (typeof input !== 'boolean') fail() }
    else if (!field.options.some((option) => option.id === input)) fail()
  }
  if (characters > AGENT_APP_LIMITS.totalAnswerCharacters) fail()
  return structuredClone(value) as AgentAppValues
}
