// Synthetic loopback-only OpenAI-compatible fixture. No request logging, proxying or persistence.
import { createServer } from 'node:http'

export const FIXTURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const MAX_BODY = 128 * 1024
const json = (res, status, data) => {
  if (res.fixtureStream && status === 200 && data?.choices?.[0]) {
    const { message, finish_reason } = data.choices[0]
    const delta = { ...message }
    delete delta.role
    if (delta.tool_calls)
      delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason }] })}\n\ndata: [DONE]\n\n`
    )
    return
  }
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}
const completion = (message, finish_reason = 'stop') => ({
  id: 'fixture',
  object: 'chat.completion',
  created: 0,
  model: 'fixture-model',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }]
})

export async function startTeamMockProvider({ image = FIXTURE_PNG } = {}) {
  if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,') || image.length > 100_000)
    throw new Error('invalid synthetic fixture image')
  const observed = { summaries: [] }
  const server = createServer((req, res) => {
    if (
      req.method !== 'POST' ||
      !['/v1/chat/completions', '/v1/images/generations'].includes(req.url)
    ) {
      json(res, 404, { error: 'fixture route not found' })
      req.resume()
      return
    }
    let bytes = 0,
      tooLarge = false
    const chunks = []
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY) {
        tooLarge = true
        chunks.length = 0
        json(res, 413, { error: 'request too large' })
        return
      }
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        json(res, 400, { error: 'invalid json' })
        return
      }
      if (req.url === '/v1/images/generations') {
        json(res, 200, {
          created: 0,
          data: [{ b64_json: image.slice('data:image/png;base64,'.length) }]
        })
        return
      }
      if (!body || !Array.isArray(body.messages)) {
        json(res, 400, { error: 'unsupported fixture request' })
        return
      }
      res.fixtureStream = body.stream === true
      const messages = body.messages
      const user = [...messages].reverse().find((message) => message?.role === 'user')
      const text = typeof user?.content === 'string' ? user.content : ''
      if (text.includes('汇总团队结果')) {
        const memberContext = text.includes('Team member results for the lead to use in its answer:') && /(?:^|\n)designer:\s*设计结果(?:\n|$)/.test(text) && /(?:^|\n)writer:\s*文案结果(?:\n|$)/.test(text)
        if (!memberContext) {
          json(res, 422, { error: 'both member results required' })
          return
        }
        observed.summaries.push({ userText: text })
        json(res, 200, completion({ content: '团队汇总：设计结果和文案结果' }))
        return
      }
      if (text.includes('设计海报')) {
        json(
          res,
          200,
          completion({
            content: '设计结果',
            images: [{ type: 'image_url', image_url: { url: image } }]
          })
        )
        return
      }
      if (
        messages.some(
          (message) =>
            message?.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes('保存工作笔记')
        )
      ) {
        if (
          messages.some(
            (message) => message?.role === 'tool' && message.tool_call_id === 'fixture-scratchpad'
          ) ||
          messages.some(
            (message) =>
              message?.role === 'user' &&
              typeof message.content === 'string' &&
              message.content.includes('current-state-not-replay-authority')
          )
        ) {
          json(res, 200, completion({ content: '文案结果' }))
          return
        }
        const args = { action: 'set', key: 'fixture', value: 'approved-value', expectedRevision: 0 }
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          json(res, 200, completion({ content: JSON.stringify({ toolName: 'scratchpad', args }) }))
          return
        }
        const matches = (Array.isArray(body.tools) ? body.tools : []).filter((tool) => {
          const f = tool?.function,
            props = f?.parameters?.properties
          return (
            tool?.type === 'function' &&
            /^mp_tool_\d+$/.test(f?.name ?? '') &&
            props &&
            ['action', 'key', 'value', 'expectedRevision'].every((key) => Object.hasOwn(props, key))
          )
        })
        if (matches.length !== 1) {
          json(res, 400, { error: 'unique scratchpad tool required' })
          return
        }
        json(
          res,
          200,
          completion(
            {
              content: null,
              tool_calls: [
                {
                  id: 'fixture-scratchpad',
                  type: 'function',
                  function: { name: matches[0].function.name, arguments: JSON.stringify(args) }
                }
              ]
            },
            'tool_calls'
          )
        )
        return
      }
      json(res, 400, { error: 'unknown fixture scenario' })
    })
    req.on('error', () => {
      if (!res.destroyed) res.destroy()
    })
  })
  server.requestTimeout = 10000
  server.headersTimeout = 12000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    server.close()
    throw new Error('unexpected fixture listener address')
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    observed,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
