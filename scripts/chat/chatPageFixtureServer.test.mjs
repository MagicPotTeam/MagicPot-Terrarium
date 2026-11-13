import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createChatPageFixtureServer } from './chatPageFixtureServer.mjs'

function request(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${server.origin}${path}`, { method: options.method ?? 'GET', headers: options.headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}
function rawRequest(server, text) {
  const url = new URL(server.origin)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), '127.0.0.1', () => socket.write(text))
    let data = ''
    socket.on('data', chunk => { data += chunk })
    socket.on('close', () => resolve(data))
    socket.on('error', reject)
  })
}
function upgrade(server) {
  const url = new URL(server.origin)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), '127.0.0.1', () => socket.write(`GET ${server.scriptPath} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`))
    let data = ''
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

test('close destroys an incomplete open connection', async () => {
  const server = await createChatPageFixtureServer({ html: () => '', script: '' })
  const url = new URL(server.origin)
  const socket = net.connect(Number(url.port), '127.0.0.1')
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write('GET /unfinished HTTP/1.1\r\n')
  const disconnected = new Promise(resolve => socket.once('close', resolve))
  await server.close()
  await disconnected
  assert.equal(socket.destroyed, true)
})

test('strict in-memory loopback transport with sticky redacted violations and close', async () => {
  const server = await createChatPageFixtureServer({ html: path => `<script src="${path}"></script>`, script: 'fixture-bundle-marker' })
  try {
    const page = await request(server, server.htmlPath)
    assert.equal(page.status, 200)
    assert.equal(page.body, `<script src="${server.scriptPath}"></script>`)
    assert.match(page.headers['content-type'], /^text\/html/)
    assert.equal(page.headers['x-content-type-options'], 'nosniff')
    assert.equal(page.headers['cache-control'], 'no-store')
    for (const directive of ["default-src 'none'", "connect-src 'none'", "worker-src 'none'", "form-action 'none'", "frame-src 'none'"]) assert.ok(page.headers['content-security-policy'].includes(directive))
    assert.ok(page.headers['content-security-policy'].includes(`script-src ${server.origin}${server.scriptPath}`))
    const script = await request(server, server.scriptPath)
    assert.equal(script.body, 'fixture-bundle-marker')
    assert.match(script.headers['content-type'], /^text\/javascript/)
    for (const [path, options] of [
      ['/private-secret', {}], [server.scriptPath + '?secret=value', {}],
      [server.scriptPath, { method: 'HEAD' }], [server.scriptPath, { method: 'POST', body: 'secret-body' }],
      [server.scriptPath, { headers: { host: 'wrong.example' } }],
      [server.scriptPath, { headers: { 'x-secret-header': 'secret-value' } }],
      [server.scriptPath, { headers: { 'content-length': '1' }, body: 'x' }]
    ]) {
      const response = await request(server, path, options)
      assert.equal(response.status, 403)
      assert.ok(!response.body.includes('fixture-bundle-marker'))
    }
    assert.match(await upgrade(server), /^HTTP\/1\.1 403/)
    const audit = server.violations()
    assert.equal(audit['<other>'], 1)
    assert.equal(audit[server.scriptPath], 7)
    assert.ok(!JSON.stringify(audit).includes('secret'))
    assert.throws(() => { audit['<other>'] = 0 }, TypeError)
    assert.deepEqual(server.violations(), audit)
    const host = new URL(server.origin).host
    for (const raw of [
      `GET ${server.scriptPath} HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\n\r\n`,
      `GET ${server.scriptPath} HTTP/1.1\r\nHost: ${host}\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n`,
      `GET ${server.scriptPath} HTTP/1.1\r\nHost: ${host}\r\nExpect: 100-continue\r\n\r\n`,
      `CONNECT example.com:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`
    ]) {
      const response = await rawRequest(server, raw)
      assert.match(response, /^HTTP\/1\.1 403/)
      assert.ok(!response.includes('fixture-bundle-marker'))
    }
    await rawRequest(server, 'not-http\r\n\r\n')
    assert.equal(server.violations()[server.scriptPath], 10)
    assert.equal(server.violations()['<other>'], 2)
    assert.equal(server.violations()['<malformed>'], 1)
  } finally { await server.close(); await server.close() }
  await assert.rejects(request(server, server.htmlPath))
})
