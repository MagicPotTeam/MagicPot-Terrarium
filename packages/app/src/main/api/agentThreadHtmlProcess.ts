import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import { HTML_BRIDGE_PROTOCOL } from './agentThreadHtmlDocument'
import { verifyHtmlBootstrap } from './agentThreadHtmlAssets'
import { spawnSync } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createWindowsJobObjectConfinementAdapter, resolveWindowsCommandJobHelper } from '../magicAgentPlatform2/toolHost/windowsJobObjectConfinement'
import { validateHtmlHostDocument, type HtmlAppDocument, type HtmlAppEvent, type HtmlAppState } from './agentThreadHtmlHost'

const FLAG = '--magicpot-isolated-html-child', PREFIX = 'MAGICPOT_HTML_V1 '
let occupied = 0
export type IsolatedHtmlProcess = { update(document: HtmlAppDocument): Promise<void>; captureState?(): Promise<HtmlAppState>; close(): Promise<{ confirmed: boolean }>; readonly closed: boolean }
/** App-owned native child, never model-selected executable/argv/environment. Windows first. */
export async function openHtmlProcess(document: HtmlAppDocument, options: {
  /** Main-owned test display policy; never sourced from model arguments. */
  hidden?: boolean
  /** Main-only durable run fence; must commit synchronously before OS spawn. */
  beforeSpawn?: () => void
  onState?(state: HtmlAppState): void
  signal: AbortSignal; assertLive(): void; onEvent(event: HtmlAppEvent): void; onClosed(confirmed: boolean): void
}): Promise<IsolatedHtmlProcess> {
  options.assertLive(); options.signal.throwIfAborted(); validateHtmlHostDocument(document)
  if (process.platform !== 'win32') throw new Error('Isolated HTML execution has only been admitted with verified Windows process-tree resource confinement.')
  if (occupied >= 4) throw new Error('HTML process capacity exhausted or prior termination is unconfirmed.')
  const helper = resolveWindowsCommandJobHelper()
  if (!helper) throw new Error('Verified HTML process resource confinement is unavailable.')
  const capability = spawnSync(helper, ['--capabilities'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 2000, maxBuffer: 1024 })
  if (capability.error || capability.status !== 0 || capability.stdout.trim() !== 'magicpot-command-job:atomic-job-list-empty-v2') throw new Error('HTML execution requires the current atomically assigned Job Object helper; rebuild native assets.')
  const confinement = createWindowsJobObjectConfinementAdapter('win32', [helper])
  if (!confinement) throw new Error('Verified HTML process resource confinement is unavailable.')
  const root = realpathSync.native(app.getAppPath())
  // Missing/stale pre-bootstrap builds must fail before starting a normal app instance.
  verifyHtmlBootstrap(root)
  const profile = realpathSync.native(mkdtempSync(path.join(app.getPath('temp'), 'magicpot-html-child-')))
  const nonce = randomBytes(32).toString('hex'), pipe = String.raw`\\.\pipe\magicpot-html-` + randomBytes(16).toString('hex')
  const env: NodeJS.ProcessEnv = { MAGICPOT_HTML_CHILD_NONCE: nonce, MAGICPOT_HTML_CHILD_PROFILE: profile, MAGICPOT_HTML_CHILD_PIPE: pipe, MAGICPOT_JOB_COMPLETION_NONCE: randomBytes(32).toString('hex') }
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
  occupied++
  let channel: Socket | undefined, accepting = false
  const server = createServer(socket => {
    if (!accepting || channel || closed) { socket.destroy(); return }
    channel = socket; server.close()
    socket.on('data', receive)
    socket.on('error', aborted); socket.on('close', aborted)
  })
  server.maxConnections = 1
  let child: ReturnType<typeof import('node:child_process')['spawn']>, spawnAttempted = false
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve) })
    options.assertLive(); options.signal.throwIfAborted()
    const signal = options.signal
    signal.throwIfAborted()
    verifyHtmlBootstrap(root)
    const spawn = confinement.prepare({ metadata: { maxMemoryBytes: 1024 * 1024 * 1024, maxCpuTimeMs: 120000, maxProcessCount: 24 } })
    options.beforeSpawn?.()
    options.assertLive(); options.signal.throwIfAborted()
    spawnAttempted = true
    child = spawn(process.execPath, [...(app.isPackaged ? [] : [root]), FLAG, ...(options.hidden ? ['--magicpot-html-test-hidden'] : [])], { shell: false, windowsHide: true, cwd: path.dirname(process.execPath), env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    server.close()
    // A thrown injected/adapter spawn is not evidence no process was created.
    // Before the spawn call we can prove absence; afterward retain quarantine.
    if (!spawnAttempted) { occupied--; try { rmSync(profile, { recursive: true, force: true }) } catch { /* Cleanup failure cannot suppress proven absence. */ } }
    try { options.onClosed(!spawnAttempted) } catch { /* Main callback failure cannot reset uncertainty. */ }
    throw error
  }
  let closed = false, closing: Promise<{ confirmed: boolean }> | undefined, sequence = 0, revision = document.revision, booted = false, released = false, nativeEmpty = false, noChild = false, stderrCarry = '', output = Buffer.alloc(0), received = 0, diagnostics = 0
  let resolveClosed!: () => void
  const actualClosed = new Promise<void>((resolve) => { resolveClosed = resolve })
  let pending: { type: 'ready' | 'snapshot'; sequence: number; resolve(value?: HtmlAppState): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined
  const pendingFail = () => { const owned = pending; pending = undefined; if (owned) { clearTimeout(owned.timer); owned.reject(new Error('Isolated HTML process did not acknowledge the operation.')) } }
  const finalize = (confirmed: boolean) => {
    if (released) return
    released = true; closed = true; channel?.destroy(); server.close(); pendingFail(); clearTimeout(lifetime); options.signal.removeEventListener('abort', aborted)
    if (confirmed) { occupied--; try { rmSync(profile, { recursive: true, force: true }) } catch { /* Temporary profile may need later cleanup. */ } }
    try { options.onClosed(confirmed) } catch { /* Callback cannot release uncertain capacity. */ }
  }
  const close = (): Promise<{ confirmed: boolean }> => {
    if (closing) return closing
    if (released) return Promise.resolve({ confirmed: nativeEmpty || noChild })
    closed = true; channel?.destroy(); server.close(); pendingFail()
    closing = (async () => {
      // Pipe loss asks the isolated browser to exit, allowing its native supervisor
      // to terminate the job and report ActiveProcesses==0. Forced kill is unknown.
      const force = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* retain unknown */ } }, 3000)
      let timer: ReturnType<typeof setTimeout> | undefined
      const observedClose = await Promise.race([actualClosed.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 8500) })])
      clearTimeout(timer); clearTimeout(force)
      const confirmed = observedClose && (nativeEmpty || noChild)
      finalize(confirmed); return { confirmed }
    })()
    return closing
  }
  const aborted = () => { void close() }
  const lifetime = setTimeout(aborted, 15 * 60 * 1000)
  child.once('close', () => { resolveClosed(); finalize(nativeEmpty || noChild) })
  child.once('error', () => { if (!child.pid) { noChild = true; resolveClosed(); finalize(true) } else void close() })
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.length
    // Always scan a bounded tail for the supervisor receipt, even when noisy
    // descendants exhausted their diagnostic budget before shutdown.
    stderrCarry += chunk.subarray(Math.max(0, chunk.length - 4096)).toString('utf8')
    let at: number
    while ((at = stderrCarry.indexOf('\n')) >= 0) {
      const line = stderrCarry.slice(0, at).trim(); stderrCarry = stderrCarry.slice(at + 1)
      if (line === `MAGICPOT_JOB_EMPTY ${env.MAGICPOT_JOB_COMPLETION_NONCE}`) nativeEmpty = true
    }
    if (stderrCarry.length > 4096) stderrCarry = stderrCarry.slice(-512)
    if (diagnostics > 1024 * 1024) void close()
  })
  child.stdout?.on('data', (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 1024 * 1024) void close() })
  function receive(chunk: Buffer) {
    if (closed) return
    received += chunk.length
    if (received > 8 * 1024 * 1024 || output.length + chunk.length > 256 * 1024) { void close(); return }
    output = Buffer.concat([output, chunk])
    let at: number
    while (!closed && (at = output.indexOf(10)) >= 0) {
      const line = output.subarray(0, at).toString('utf8'); output = output.subarray(at + 1)
      if (!line.startsWith(PREFIX)) continue // Runtime diagnostics are never model events.
      try {
        const message = JSON.parse(line.slice(PREFIX.length))
        if (message.nonce !== nonce || !Number.isSafeInteger(message.sequence)) throw new Error('Invalid child identity.')
        if (message.type === 'booted' && !booted && message.sequence === 0 && message.data?.dnsBlocked === true && message.data?.bridgeProtocol === HTML_BRIDGE_PROTOCOL) booted = true
        else if (message.type === 'ready' && pending?.type === 'ready' && message.sequence === pending.sequence && message.data?.revision === revision) { const owned = pending; pending = undefined; clearTimeout(owned.timer); owned.resolve() }
        else if (message.type === 'snapshot' && pending?.type === 'snapshot' && message.sequence === pending.sequence) {
          const state = message.data
          if (state?.revision !== revision || !Number.isSafeInteger(state.stateRevision) || state.stateRevision < 0 || !state.value || typeof state.value !== 'object' || Array.isArray(state.value)) throw new Error('Invalid HTML snapshot frame.')
          const value = cloneBoundedMcpJson(state.value, 65536) as Record<string, unknown>
          const owned = pending; pending = undefined; clearTimeout(owned.timer); owned.resolve({ revision, stateRevision: state.stateRevision, value })
        }
        else if (message.type === 'state') {
          if (message.sequence >= 1 && message.sequence < sequence) continue // An earlier drain may cross the snapshot/update request.
          const state = message.data
          if (message.sequence !== sequence || state?.revision !== revision || !Number.isSafeInteger(state.stateRevision) || state.stateRevision < 1 || !state.value || typeof state.value !== 'object' || Array.isArray(state.value)) throw new Error('Invalid HTML state frame.')
          const value = cloneBoundedMcpJson(state.value, 65536) as Record<string, unknown>
          options.assertLive(); options.signal.throwIfAborted(); options.onState?.({ revision, stateRevision: state.stateRevision, value })
        }
        else if (message.type === 'event') {
          const event = message.data
          if (message.sequence !== sequence || event?.revision !== revision || event?.origin !== 'app' || event?.untrustedData !== true || event?.grantsPermission !== false || typeof event.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(event.name) || Buffer.byteLength(JSON.stringify(event)) > 16384) continue
          options.assertLive(); options.signal.throwIfAborted(); options.onEvent(event)
        } else if (['failed', 'closed'].includes(message.type)) void close()
        else throw new Error('Unexpected child frame.')
      } catch { void close(); return }
    }
  }
  accepting = true
  options.signal.addEventListener('abort', aborted, { once: true })
  if (options.signal.aborted) aborted()
  const command = async (action: 'open' | 'update', next: HtmlAppDocument) => {
    options.assertLive(); options.signal.throwIfAborted(); validateHtmlHostDocument(next)
    if (closed || pending || next.revision < revision) throw new Error('HTML process closed, busy or stale.')
    if (!Number.isSafeInteger(next.revision) || next.revision <= revision && action === 'update') throw new Error('HTML update revision must increase.')
    sequence++; revision = next.revision
    const frame = Buffer.from(`${JSON.stringify({ nonce, sequence, action, document: next })}\n`)
    if (frame.length > 2 * 1024 * 1024) throw new Error('HTML process request too large.')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pendingFail(); void close() }, 12000)
      pending = { type: 'ready', sequence, resolve: () => resolve(), reject, timer }
      if (!channel || channel.destroyed) { pendingFail(); void close(); return }
      try { channel.write(frame) } catch { pendingFail(); void close() }
    })
    options.assertLive(); options.signal.throwIfAborted()
  }
  try {
    const start = Date.now()
    while (!booted && !closed && Date.now() - start < 10000) await new Promise(resolve => setTimeout(resolve, 25))
    if (!booted || closed) throw new Error('Isolated HTML child did not boot.')
    await command('open', document)
  } catch (error) { await close(); throw error }
  const captureState = async (): Promise<HtmlAppState> => {
    options.assertLive(); options.signal.throwIfAborted()
    if (closed || pending || !channel || channel.destroyed) throw new Error('HTML state capture is closed or busy.')
    sequence++
    const state = await new Promise<HtmlAppState>((resolve, reject) => {
      const timer = setTimeout(() => { pendingFail(); void close() }, 4000)
      pending = { type: 'snapshot', sequence, resolve: value => value ? resolve(value) : reject(new Error('HTML snapshot missing.')), reject, timer }
      try { channel!.write(JSON.stringify({ nonce, sequence, action: 'snapshot' }) + '\n') } catch { pendingFail(); void close() }
    })
    options.assertLive(); options.signal.throwIfAborted(); return state
  }
  return { update: (next) => command('update', next), captureState, close, get closed() { return closed } }
}
