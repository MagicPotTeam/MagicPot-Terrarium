import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startIsolatedTeamLeadSummaryMock, SUMMARY_INPUT, SUMMARY_OUTPUT } from './isolatedTeamLeadSummaryMock.mjs'

const body = () => ({ model: 'isolated-image-model', input: [{ role: 'user', content: [{ type: 'input_text', text: SUMMARY_INPUT }] }], instructions: 'You are a helpful assistant.', store: false })
async function post(mock, value) {
  const response = await fetch(mock.baseURL + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  return { status: response.status, text: await response.text() }
}
async function withMock(fn) {
  const mock = await startIsolatedTeamLeadSummaryMock()
  try { await fn(mock) } finally { mock.destroyOwnedSockets(); await mock.close() }
}

test('exact unary request succeeds once and rejects replay', async () => withMock(async mock => {
  const first = await post(mock, body())
  assert.equal(first.status, 200); assert.equal(JSON.parse(first.text).output[0].content[0].text, SUMMARY_OUTPUT)
  assert.equal((await post(mock, body())).status, 409)
  assert.deepEqual(mock.observations(), { received: 2, success: 1, rejected: 1, incomplete: 0, active: 0 })
}))

test('exact stream emits synthetic text', async () => withMock(async mock => {
  const result = await post(mock, { ...body(), stream: true, temperature: 0.7 })
  assert.equal(result.status, 200); assert(result.text.includes(SUMMARY_OUTPUT)); assert(result.text.includes('response.completed'))
}))

test('all extra text, user turns, tools, images and top-level fields reject without retry', async () => {
  for (const mutate of [
    x => x.input.push(x.input[0]),
    x => x.input[0].content.push({ type: 'input_text', text: 'extra' }),
    x => { x.input[0].content[0].text += 'extra' },
    x => { x.tools = [] },
    x => x.input[0].content.push({ type: 'input_image', image_url: 'data:image/png;base64,AA==' }),
    x => { x.extra = true },
    x => { x.instructions = 'other' }
  ]) await withMock(async mock => {
    const input = body(); mutate(input)
    assert.equal((await post(mock, input)).status, 400)
    assert.equal((await post(mock, body())).status, 409)
    assert.deepEqual(mock.observations(), { received: 2, success: 0, rejected: 2, incomplete: 0, active: 0 })
  })
})

test('first incomplete request consumes slot; concurrent request rejects and close records incomplete', async () => withMock(async mock => {
  const url = new URL(mock.baseURL + '/responses')
  const request = http.request(url, { method: 'POST', headers: { 'content-length': '1000' } })
  request.on('error', () => {})
  request.flushHeaders(); request.write('{')
  const deadline = Date.now() + 2000
  while (mock.observations().received === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(mock.observations().active, 1)
  assert.equal((await post(mock, body())).status, 409)
  const closing = mock.close()
  assert.equal(mock.observations().active, 1)
  request.destroy()
  const result = await closing
  assert.equal(result.received, 2)
  assert.equal(result.success, 0)
  assert.equal(result.rejected, 1)
  assert.equal(result.active + result.incomplete, 1, 'Unfinished request must remain visible as active or incomplete')
}))

test('oversized body fails closed', async () => withMock(async mock => {
  const response = await fetch(mock.baseURL + '/responses', { method: 'POST', body: 'x'.repeat(65537) })
  assert.equal(response.status, 413)
  assert.equal(mock.observations().rejected, 1)
}))
