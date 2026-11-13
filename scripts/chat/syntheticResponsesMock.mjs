// Explicitly started, in-memory synthetic fixture. Never pass user data.
import http from 'node:http'
import { TextDecoder } from 'node:util'
import { createHash } from 'node:crypto'

export const MAX_REQUEST_BYTES = 28 * 1024 * 1024
const MAX_LABELS = 32
const MAX_LABEL_DATA_BYTES = MAX_REQUEST_BYTES
const MAX_OBSERVATIONS = 64
const MAX_CONCURRENT = 4
const TIMEOUT_MS = 15_000
const PAYLOAD = { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }

export async function startSyntheticResponsesMock({ syntheticImageLabels = [], observeImageHashes = false } = {}) {
  if (typeof observeImageHashes !== 'boolean') throw new TypeError('Invalid hash observation option')
  if (!Array.isArray(syntheticImageLabels) || syntheticImageLabels.length > MAX_LABELS) throw new TypeError('Invalid synthetic labels')
  const labels = new Map()
  let labelBytes = 0
  for (const entry of syntheticImageLabels) {
    if (!entry || typeof entry.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(entry.image) ||
        typeof entry.label !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(entry.label) || labels.has(entry.image)) {
      throw new TypeError('Invalid synthetic labels')
    }
    labelBytes += Buffer.byteLength(entry.image)
    if (labelBytes > MAX_LABEL_DATA_BYTES) throw new TypeError('Synthetic labels exceed budget')
    labels.set(entry.image, entry.label)
  }
  const observations = []
  const sockets = new Set()
  let active = 0
  let closing
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/responses' || req.method !== 'POST') {
      res.writeHead(req.url !== '/v1/responses' ? 404 : 405, { Connection: 'close' }).end()
      res.once('finish', () => req.destroy())
      return
    }
    if (active >= MAX_CONCURRENT || observations.length + active >= MAX_OBSERVATIONS) {
      res.writeHead(503, { Connection: 'close' }).end()
      res.once('finish', () => req.destroy())
      return
    }
    active++
    let done = false
    let bytes = 0
    let exceeded = false
    let chunks = []
    const finish = () => { if (!done) { done = true; active--; chunks = [] } }
    res.on('close', finish)
    req.on('error', finish)
    req.setTimeout(TIMEOUT_MS, () => { finish(); req.destroy() })
    const length = req.headers['content-length']
    if (length && (!/^\d+$/.test(length) || BigInt(length) > BigInt(MAX_REQUEST_BYTES))) {
      res.writeHead(413, { Connection: 'close' }).end()
      res.once('finish', () => req.destroy())
      return
    }
    req.on('data', (chunk) => {
      if (done || exceeded) return
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) {
        exceeded = true
        chunks = []
        req.pause()
        res.writeHead(413, { Connection: 'close' }).end()
        res.once('finish', () => req.destroy())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done || res.writableEnded) return
      let body
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
        chunks = []
        if (!body || typeof body !== 'object' || !Array.isArray(body.input)) throw new Error()
        const imageLabels = [], imageUrlSha256 = []
        for (const message of body.input) {
          if (!message || !Array.isArray(message.content)) throw new Error()
          for (const part of message.content) {
            if (!part || typeof part !== 'object' || typeof part.type !== 'string') throw new Error()
            if (part.type === 'input_image') {
              if (typeof part.image_url !== 'string' || imageLabels.length >= 1000) throw new Error()
              imageLabels.push(labels.get(part.image_url) ?? 'unknown')
              if (observeImageHashes) imageUrlSha256.push(createHash('sha256').update(part.image_url).digest('hex'))
            }
          }
        }
        observations.push({ bytes, imageCount: imageLabels.length, imageLabels, ...(observeImageHashes ? { imageUrlSha256 } : {}) })
      } catch {
        chunks = []
        res.writeHead(400).end()
        return
      }
      if (body.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: PAYLOAD })}\n\n`)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(PAYLOAD))
      }
    })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    observations: () => observations.map(({ bytes, imageCount, imageLabels, imageUrlSha256 }) => ({ bytes, imageCount, imageLabels: [...imageLabels], ...(imageUrlSha256 ? { imageUrlSha256: [...imageUrlSha256] } : {}) })),
    close: () => {
      if (!closing) {
        labels.clear()
        observations.length = 0
        closing = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        for (const socket of sockets) socket.destroy()
      }
      return closing
    }
  }
}
