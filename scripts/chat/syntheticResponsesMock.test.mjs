import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { MAX_REQUEST_BYTES, startSyntheticResponsesMock } from './syntheticResponsesMock.mjs'

const A = 'data:image/png;base64,QUFB'
const B = 'data:image/png;base64,QkJC'
const body = (images, extra = {}) => JSON.stringify({ input: [{ role: 'user', content: images.map(image_url => ({ type: 'input_image', image_url })) }], ...extra })
const post = (url, data) => fetch(url + '/responses', { method: 'POST', body: data })

test('unary and stream preserve image occurrences without recording payload', async () => {
  const mock = await startSyntheticResponsesMock({ syntheticImageLabels: [{ image: A, label: 'a' }, { image: B, label: 'b' }] })
  try {
    const secret = 'private-sentinel-not-for-logs'
    const data = body([B, A, B, 'https://synthetic.invalid/x'], { secret })
    const [one, two] = await Promise.all([post(mock.baseURL, data), post(mock.baseURL, body([A], { stream: true }))])
    assert.equal(one.status, 200)
    assert.equal((await one.json()).output[0].content[0].text, 'ok')
    const stream = await two.text()
    const events = stream.trim().split('\n\n').map(line => JSON.parse(line.slice(6)))
    assert.deepEqual(events.map(event => event.type), ['response.output_text.delta', 'response.completed'])
    const seen = mock.observations()
    assert.deepEqual(seen.find(x => x.imageCount === 4), { bytes: Buffer.byteLength(data), imageCount: 4, imageLabels: ['b', 'a', 'b', 'unknown'] })
    assert.ok(!JSON.stringify(seen).includes(secret))
    assert.ok(!JSON.stringify(seen).includes(A))
    assert.ok(!JSON.stringify(seen).includes('synthetic.invalid'))
    seen[0].imageLabels.push('mutated')
    assert.ok(!JSON.stringify(mock.observations()).includes('mutated'))
    assert.equal((await fetch(mock.baseURL + '/other')).status, 404)
    assert.equal((await fetch(mock.baseURL + '/responses')).status, 405)
    assert.equal((await post(mock.baseURL, '{')).status, 400)
  } finally { await mock.close(); await mock.close() }
  assert.deepEqual(mock.observations(), [])
})

test('byte limit including multibyte text; over-limit content length rejected', async () => {
  const mock = await startSyntheticResponsesMock()
  try {
    const prefix = '{"input":[],"x":"é'
    const suffix = '"}'
    const exact = prefix + 'a'.repeat(MAX_REQUEST_BYTES - Buffer.byteLength(prefix + suffix)) + suffix
    assert.equal(Buffer.byteLength(exact), MAX_REQUEST_BYTES)
    assert.equal((await post(mock.baseURL, exact)).status, 200)
    assert.equal(mock.observations()[0].bytes, MAX_REQUEST_BYTES)
    const response = await post(mock.baseURL, exact + 'a').catch(() => null)
    assert.ok(response === null || response.status === 413)
    assert.equal(mock.observations().length, 1)
  } finally { await mock.close() }
})

test('chunked request over budget rejected and close destroys active sockets', async () => {
  const mock = await startSyntheticResponsesMock()
  try {
    const url = new URL(mock.baseURL + '/responses')
    const req = http.request(url, { method: 'POST' })
    const result = new Promise(resolve => { req.on('response', res => { res.resume(); resolve(res.statusCode) }); req.on('error', () => resolve('closed')) })
    const chunk = Buffer.alloc(1024 * 1024, 97)
    for (let i = 0; i < 29 && !req.destroyed; i++) req.write(chunk)
    req.end()
    assert.ok([413, 'closed'].includes(await result))
    assert.equal(mock.observations().length, 0)
    const held = http.request(url, { method: 'POST' })
    held.on('error', () => {})
    held.write('{')
    await once(held, 'socket')
    const closed = new Promise(resolve => held.once('close', () => resolve(true)))
    await mock.close()
    assert.ok(held.destroyed || await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(false), 1000))]))
  } finally { await mock.close() }
})

test('observations are bounded and invalid mappings fail closed', async () => {
  await assert.rejects(startSyntheticResponsesMock({ syntheticImageLabels: [{ image: 'https://example.invalid/private', label: 'x' }] }))
  const mock = await startSyntheticResponsesMock()
  try {
    for (let i = 0; i < 64; i++) assert.equal((await post(mock.baseURL, body([]))).status, 200)
    assert.equal((await post(mock.baseURL, body([]))).status, 503)
    assert.equal(mock.observations().length, 64)
  } finally { await mock.close() }
})

test('concurrency limit rejects a fifth in-flight request', async () => {
  const mock = await startSyntheticResponsesMock()
  const held = []
  try {
    for (let i = 0; i < 4; i++) {
      const req = http.request(new URL(mock.baseURL + '/responses'), { method: 'POST' })
      req.on('error', () => {})
      req.write('{')
      held.push(req)
      await once(req, 'socket')
    }
    // Requests use distinct sockets; wait for the server to receive their headers.
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await post(mock.baseURL, body([]))).status, 503)
    assert.equal(mock.observations().length, 0)
  } finally {
    await mock.close()
    for (const req of held) req.destroy()
  }
})
