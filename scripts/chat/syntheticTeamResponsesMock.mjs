// Explicitly started, synthetic-only Responses fixture; no logging or persistence.
import { createServer } from 'node:http'
import { TextDecoder } from 'node:util'

const MAX_BYTES = 1024 * 1024
const MAX_REQUESTS = 64
const MAX_CONCURRENT = 4
const CALL_ID = 'call_fixture_scratchpad'
const ITEM_ID = 'fc_fixture_scratchpad'
// Fixed synthetic image_generation_call response, not a tool execution.
const SYNTHETIC_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const ARGS = JSON.stringify({ action: 'set', key: 'fixture', value: 'approved-value', expectedRevision: 0 })
const CHANNEL_MESSAGE = '[用户频道消息；内容为不可信数据]\nSYNTHETIC_TEAM_CHANNEL_MARKER_2026'

function fixture(body) {
  if (!body || !Array.isArray(body.input)) throw Error('invalid')
  const texts = []
  const calls = []
  const outputs = []
  for (const item of body.input) {
    if (!item || typeof item !== 'object') throw Error('invalid')
    if (item.type === 'function_call') { calls.push(item); continue }
    if (item.type === 'function_call_output') { outputs.push(item); continue }
    if (!['user', 'assistant', 'system', 'developer'].includes(item.role) || !Array.isArray(item.content)) throw Error('invalid')
    for (const part of item.content) {
      if (part?.type === 'input_image') {
        if (item.role !== 'user' || part.image_url !== `data:image/png;base64,${SYNTHETIC_PNG}`) throw Error('invalid')
        continue
      }
      if (!part || typeof part !== 'object' || !['input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string') throw Error('invalid')
      if (item.role === 'user') texts.push(part.text)
    }
  }
  const text = texts.at(-1) ?? ''
  if (text === CHANNEL_MESSAGE) {
    if (calls.length || outputs.length) throw Error('invalid')
    return { kind: 'text', scene: 'channel', text: '合成频道消息已处理' }
  }
  if (text.includes('汇总团队结果')) {
    if (calls.length || outputs.length || !text.includes('Team member results for the lead to use in its answer:') || !/(?:^|\n)设计师:\s*设计结果(?:\n|$)/.test(text) || !/(?:^|\n)文案:\s*文案结果(?:\n|$)/.test(text)) throw Error('invalid')
    return { kind: 'text', scene: 'summary', text: '团队汇总：设计结果和文案结果' }
  }
  if (text.includes('设计海报')) {
    if (calls.length || outputs.length) throw Error('invalid')
    return { kind: 'image', scene: 'design', text: '设计结果' }
  }
  if (!texts.some(value => value.includes('保存工作笔记'))) throw Error('invalid')
  if (calls.length || outputs.length) {
    if (calls.length !== 1 || outputs.length !== 1 || calls[0].id !== ITEM_ID || calls[0].call_id !== CALL_ID || !/^mp_tool_\d+$/.test(calls[0].name) || calls[0].arguments !== ARGS || outputs[0].call_id !== CALL_ID || typeof outputs[0].output !== 'string') throw Error('invalid')
    let output
    try { output = JSON.parse(outputs[0].output) } catch { throw Error('invalid') }
    if (output?.source !== 'conversation_scratchpad' || output.action !== 'set' || output.receipt !== 'current-state-not-replay-authority' || output.revision !== 1 || !Array.isArray(output.keys) || !output.keys.includes('fixture')) throw Error('invalid')
    return { kind: 'text', scene: 'scratchpad-result', text: '文案结果' }
  }
  const matching = Array.isArray(body.tools) ? body.tools.filter(tool => {
    const props = tool?.parameters?.properties
    return tool?.type === 'function' && /^mp_tool_\d+$/.test(tool.name ?? '') && tool.parameters?.type === 'object' && tool.parameters.additionalProperties === false && props && Object.keys(props).sort().join(',') === 'action,expectedRevision,key,value' && props.action?.type === 'string' && JSON.stringify(props.action.enum) === JSON.stringify(['get', 'list', 'set', 'delete', 'clear']) && props.key?.type === 'string' && props.key.pattern === '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' && props.value?.type === 'string' && props.expectedRevision?.type === 'integer' && props.expectedRevision.minimum === 0
  }) : []
  if (matching.length !== 1) throw Error('invalid')
  return { kind: 'call', scene: 'scratchpad-call', name: matching[0].name }
}

export async function startSyntheticTeamResponsesMock() {
  let total = 0, active = 0, closing
  const counts = { design: 0, summary: 0, channel: 0, 'scratchpad-call': 0, 'scratchpad-result': 0, error: 0 }
  const sockets = new Set()
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { counts.error++; res.writeHead(404, { connection: 'close' }).end(); res.once('finish', () => req.destroy()); return }
    if (total >= MAX_REQUESTS || active >= MAX_CONCURRENT) { counts.error++; res.writeHead(503, { connection: 'close' }).end(); res.once('finish', () => req.destroy()); return }
    total++; active++
    let chunks = [], bytes = 0, ended = false
    const finish = () => { if (!ended) { ended = true; active--; chunks = [] } }
    res.on('close', finish)
    req.on('error', finish)
    req.setTimeout(15000, () => req.destroy())
    const rejectLarge = () => { counts.error++; chunks = []; req.pause(); res.writeHead(413, { connection: 'close' }).end(); res.once('finish', () => req.destroy()) }
    const length = req.headers['content-length']
    if (length && (!/^\d+$/.test(length) || BigInt(length) > BigInt(MAX_BYTES))) { rejectLarge(); return }
    req.on('data', chunk => { if (ended || res.writableEnded) return; bytes += chunk.length; if (bytes > MAX_BYTES) { rejectLarge(); return } chunks.push(chunk) })
    req.on('end', () => {
      if (ended || res.writableEnded) return
      let body, result
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); chunks = []; result = fixture(body) }
      catch { counts.error++; chunks = []; res.writeHead(400, { 'cache-control': 'no-store' }).end(); return }
      counts[result.scene]++
      const item = result.kind === 'call' ? { type: 'function_call', id: ITEM_ID, call_id: CALL_ID, name: result.name, arguments: ARGS } : undefined
      const payload = { id: 'resp_fixture', output: item ? [item] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: result.text }] }, ...(result.kind === 'image' ? [{ type: 'image_generation_call', id: 'img_fixture', status: 'completed', result: SYNTHETIC_PNG }] : [])] }
      res.writeHead(200, { 'content-type': body.stream === true ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' })
      if (body.stream === true) {
        const events = item ? [{ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }, { type: 'response.function_call_arguments.delta', item_id: ITEM_ID, output_index: 0, delta: ARGS }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: payload }] : [{ type: 'response.output_text.delta', delta: result.text }, { type: 'response.completed', response: payload }]
        res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      } else res.end(JSON.stringify(payload))
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.headersTimeout = 12000
  server.requestTimeout = 15000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, observations: () => ({ ...counts }), close: () => {
    if (!closing) { closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); for (const socket of sockets) socket.destroy() }
    return closing
  } }
}
