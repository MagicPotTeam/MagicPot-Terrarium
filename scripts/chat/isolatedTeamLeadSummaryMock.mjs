// Single-use, bounded synthetic Responses fixture. No request bodies are retained.
import { createServer } from 'node:http'
import { TextDecoder } from 'node:util'

export const SUMMARY_DESIGNER = 'fixture-design-result-vt34qf-1'
export const SUMMARY_WRITER = 'fixture-writer-result-vt34qf-1'
export const SUMMARY_PROMPT = '汇总合成验收结果 vt34qf-1'
export const SUMMARY_OUTPUT = 'fixture-lead-summary-result-vt34qf-1'
export const SUMMARY_INPUT = `Team member results for the lead to use in its answer:\n\n设计师: ${SUMMARY_DESIGNER}\n\n文案: ${SUMMARY_WRITER}\n\n${SUMMARY_PROMPT}`
const MAX_BYTES = 64 * 1024
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
function valid(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const keys = ['model', 'input', 'instructions', 'store', ...(Object.hasOwn(body, 'stream') ? ['stream'] : []), ...(Object.hasOwn(body, 'temperature') ? ['temperature'] : [])]
  if (!exactKeys(body, keys) || body.model !== 'isolated-image-model' || body.instructions !== 'You are a helpful assistant.' || body.store !== false ||
      (Object.hasOwn(body, 'stream') && body.stream !== true) || (Object.hasOwn(body, 'temperature') && body.temperature !== 0.7)) return false
  if (!Array.isArray(body.input) || body.input.length !== 1) return false
  const item = body.input[0]
  return exactKeys(item, ['role', 'content']) && item.role === 'user' && Array.isArray(item.content) && item.content.length === 1 &&
    exactKeys(item.content[0], ['type', 'text']) && item.content[0].type === 'input_text' && item.content[0].text === SUMMARY_INPUT
}

export async function startIsolatedTeamLeadSummaryMock() {
  const stats = { received: 0, success: 0, rejected: 0, incomplete: 0, active: 0 }
  let used = false, closing
  const sockets = new Set()
  const server = createServer((req, res) => {
    stats.received++
    if (used) { stats.rejected++; res.writeHead(409, { connection: 'close' }).end(); return }
    used = true // Consume before any asynchronous body read, even on malformed input.
    stats.active++
    let finished = false, bytes = 0, chunks = []
    const finish = kind => { if (finished) return; finished = true; chunks = []; stats.active--; stats[kind]++ }
    req.on('aborted', () => finish('incomplete'))
    req.on('error', () => finish('incomplete'))
    res.on('close', () => { if (!finished) finish('incomplete') })
    req.setTimeout(5000, () => req.destroy())
    if (req.method !== 'POST' || req.url !== '/v1/responses') { finish('rejected'); res.writeHead(404, { connection: 'close' }).end(); return }
    const length = req.headers['content-length']
    if (length && (!/^\d+$/.test(length) || BigInt(length) > BigInt(MAX_BYTES))) { finish('rejected'); res.writeHead(413, { connection: 'close' }).end(); return }
    req.on('data', chunk => {
      if (finished) return
      bytes += chunk.length
      if (bytes > MAX_BYTES) { finish('rejected'); res.writeHead(413, { connection: 'close' }).end(); req.resume(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (finished) return
      let body
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); chunks = [] } catch { finish('rejected'); res.writeHead(400).end(); return }
      if (!valid(body)) { finish('rejected'); res.writeHead(400).end(); return }
      const payload = { id: 'resp_synthetic_summary', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: SUMMARY_OUTPUT }] }] }
      res.on('finish', () => finish('success'))
      res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' })
      res.end(body.stream ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: SUMMARY_OUTPUT })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n` : JSON.stringify(payload))
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.headersTimeout = 6000
  server.requestTimeout = 6000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    observations: () => ({ ...stats }),
    close: () => {
      if (!closing) closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve({ ...stats })))
      return closing
    },
    // Caller may explicitly destroy owned sockets after bounded waiting; incomplete stays visible.
    destroyOwnedSockets: () => { for (const socket of sockets) socket.destroy() }
  }
}
