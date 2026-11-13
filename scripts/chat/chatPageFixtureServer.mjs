import http from 'node:http'
import { randomBytes } from 'node:crypto'

/** In-memory fixture transport only; loopback is not an OS isolation boundary. */
export async function createChatPageFixtureServer({ html, script }) {
  if (typeof html !== 'function' || typeof script !== 'string') throw new TypeError('Expected an HTML factory and in-memory script string')
  const token = randomBytes(32).toString('hex')
  const htmlPath = `/${token}/index.html`
  const scriptPath = `/${token}/bundle.js`
  const document = html(scriptPath)
  if (typeof document !== 'string') throw new TypeError('HTML factory must return a string')
  const resources = new Map([[htmlPath, ['text/html; charset=utf-8', document]], [scriptPath, ['text/javascript; charset=utf-8', script]]])
  const violations = new Map()
  const sockets = new Set()
  let expectedHost = ''
  let closing = false
  const record = (req) => {
    // Do not retain query strings, headers, request bodies, or arbitrary attacker-controlled paths.
    const raw = typeof req.url === 'string' ? req.url.split('?')[0] : ''
    const path = resources.has(raw) ? raw : '<other>'
    violations.set(path, (violations.get(path) ?? 0) + 1)
  }
  const reject = (req, res) => {
    record(req)
    res.writeHead(403, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' })
    res.end()
  }
  const server = http.createServer((req, res) => {
    const allowedHeaders = new Set(['host', 'connection', 'accept', 'accept-encoding', 'accept-language', 'user-agent', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'])
    const names = req.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase())
    const counts = new Map()
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
    const valid = !closing && req.method === 'GET' && resources.has(req.url) && req.headers.host === expectedHost &&
      [...counts].every(([name, count]) => allowedHeaders.has(name) && count === 1) && !req.headers['transfer-encoding'] && !req.headers['content-length'] && !req.headers.upgrade
    if (!valid) return reject(req, res)
    const [type, body] = resources.get(req.url)
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Security-Policy': `default-src 'none'; script-src http://${expectedHost}${scriptPath}; connect-src 'none'; worker-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      Connection: 'close'
    })
    res.end(body)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('checkContinue', (req, res) => reject(req, res))
  server.on('checkExpectation', (req, res) => reject(req, res))
  server.on('connect', (req, socket) => { record(req); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') })
  server.on('upgrade', (req, socket) => { record(req); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') })
  server.on('clientError', (_error, socket) => { violations.set('<malformed>', (violations.get('<malformed>') ?? 0) + 1); socket.destroy() })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  expectedHost = `127.0.0.1:${address.port}`
  let closed
  return Object.freeze({
    origin: `http://${expectedHost}`,
    htmlPath,
    scriptPath,
    violations: () => Object.freeze(Object.fromEntries(violations)),
    close: () => {
      if (!closed) {
        closing = true
        closed = new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
          for (const socket of sockets) socket.destroy()
        })
      }
      return closed
    }
  })
}
