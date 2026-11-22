import { HTML_BRIDGE_PROTOCOL } from './agentThreadHtmlDocument'
import { connect } from 'node:net'
import { app } from 'electron'
import { lstatSync, realpathSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { openIsolatedHtmlHost, validateHtmlHostDocument, type HtmlAppHost } from './agentThreadHtmlHost'

export const HTML_CHILD_FLAG = '--magicpot-isolated-html-child'
export const HTML_CHILD_FRAME_LIMIT = 2 * 1024 * 1024
const FRAME_PREFIX = 'MAGICPOT_HTML_V1 '
/** Must be selected by the early app bootstrap before importing any normal application module. */
export function startHtmlChildRuntime(): void {
  if (app.isReady() || !process.argv.includes(HTML_CHILD_FLAG)) throw new Error('HTML child requires its early dedicated entry.')
  const nonce = process.env.MAGICPOT_HTML_CHILD_NONCE, root = process.env.MAGICPOT_HTML_CHILD_PROFILE, pipe = process.env.MAGICPOT_HTML_CHILD_PIPE
  const pipePrefix = String.raw`\\.\pipe\magicpot-html-`
  if (!pipe?.startsWith(pipePrefix) || !/^[a-f0-9]{32}$/.test(pipe.slice(pipePrefix.length))) throw new Error('HTML child local pipe unavailable.')
  if (!nonce || !/^[a-f0-9]{64}$/.test(nonce) || !root || !path.isAbsolute(root)) throw new Error('HTML child launch contract unavailable.')
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(realpathSync.native(root)).toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('HTML child profile is not a canonical owned directory.')
  app.setPath('userData', root)
  for (const name of ['sessionData', 'logs', 'crashDumps'] as const) { const dir = path.join(root, name); mkdirSync(dir); app.setPath(name, dir) }
  // Process-local Chromium switches: never applied to the normal application.
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND')
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('disable-component-update')
  app.commandLine.appendSwitch('disable-domain-reliability')
  app.commandLine.appendSwitch('no-pings')
  app.disableHardwareAcceleration()
  const channel = connect(pipe)
  let host: HtmlAppHost | undefined, busy = false, ending = false, buffer = Buffer.alloc(0), sequence = 0
  const send = (type: string, data: unknown, seq = sequence) => {
    if (ending) return
    const frame = Buffer.from(`${FRAME_PREFIX}${JSON.stringify({ nonce, type, sequence: seq, data })}\n`)
    if (frame.length > 96 * 1024 || channel.writableLength + frame.length > 128 * 1024) { quit(1); return }
    channel.write(frame)
  }
  const quit = (code: number) => {
    if (ending) return
    ending = true; clearTimeout(idle); host?.close(); buffer = Buffer.alloc(0); channel.destroy(); app.exit(code)
  }
  const idle = setTimeout(() => quit(1), 15000)
  channel.on('end', () => quit(0)); channel.on('close', () => quit(0)); channel.on('error', () => quit(1))
  app.on('window-all-closed', () => undefined)
  app.on('render-process-gone', () => quit(1))
  channel.on('data', (chunk: Buffer) => {
    if (ending) return
    if (buffer.length + chunk.length > HTML_CHILD_FRAME_LIMIT) { quit(1); return }
    buffer = Buffer.concat([buffer, chunk])
    const newline = buffer.indexOf(10)
    if (newline < 0) return
    if (busy || newline !== buffer.length - 1) { quit(1); return } // One ordered request at a time, no queued bursts.
    let request: { nonce?: unknown; sequence?: unknown; action?: unknown; document?: unknown }
    try { request = JSON.parse(buffer.subarray(0, newline).toString('utf8')) }
    catch { quit(1); return }
    buffer = Buffer.alloc(0)
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.nonce !== nonce || request.sequence !== sequence + 1 || typeof request.action !== 'string' || !['open', 'update', 'snapshot', 'close'].includes(request.action)) { quit(1); return }
    sequence++; const current = sequence
    if (request.action === 'close') { send('closed', { reason: 'requested' }, current); quit(0); return }
    if (request.action === 'open' ? Boolean(host) : !host) { quit(1); return }
    if (request.action === 'snapshot') {
      if (!host) { quit(1); return }
      busy = true
      void host.captureState().then(state => send('snapshot', state, current)).catch(() => { send('failed', { reason: 'HTML state snapshot failed' }, current); quit(1) }).finally(() => { busy = false })
      return
    }
    try { validateHtmlHostDocument(request.document as Parameters<typeof validateHtmlHostDocument>[0]) } catch { quit(1); return }
    busy = true; clearTimeout(idle)
    void (async () => {
      try {
        const document = request.document as Parameters<typeof validateHtmlHostDocument>[0]
        if (request.action === 'open') host = await openIsolatedHtmlHost(document, {
          hidden: process.argv.includes('--magicpot-html-test-hidden'),
          onState: (state) => send('state', state),
          onEvent: (event) => send('event', event),
          onClosed: (reason) => { send('closed', { reason }); quit(reason === 'closed' ? 0 : 1) }
        })
        else await host!.update(document)
        if (!ending) send('ready', { revision: document.revision }, current)
      } catch { send('failed', { reason: 'HTML child could not display the document.' }, current); quit(1) }
      finally { busy = false }
    })()
  })
  channel.once('connect', () => send('booted', { protocol: 1, dnsBlocked: true, bridgeProtocol: HTML_BRIDGE_PROTOCOL }))
}
