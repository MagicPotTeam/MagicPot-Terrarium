import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ cleanupFailure: false, profileRoot: '', prepare: vi.fn(), spawn: vi.fn(), verify: vi.fn(), capability: vi.fn(), helper: vi.fn(), children: [] as any[], pipeSockets: [] as any[] }))
vi.mock('node:fs', async () => { const actual = await vi.importActual<typeof import('node:fs')>('node:fs'); return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => { if (h.cleanupFailure) throw new Error('locked temp profile'); return actual.rmSync(...args) } } })
vi.mock('electron', () => ({ app: { getAppPath: () => h.profileRoot, getPath: () => h.profileRoot, isPackaged: true } }))
vi.mock('node:child_process', () => ({ spawnSync: h.capability }))
vi.mock('./agentThreadHtmlAssets', () => ({ verifyHtmlBootstrap: h.verify }))
vi.mock('../magicAgentPlatform2/toolHost/windowsJobObjectConfinement', () => ({ resolveWindowsCommandJobHelper: h.helper, createWindowsJobObjectConfinementAdapter: () => ({ prepare: h.prepare }) }))
import { openHtmlProcess } from './agentThreadHtmlProcess'
const document = { title: 'app', html: '<h1>ok</h1>', revision: 1 }
let root = ''
function childFixture(ack = true, bridgeProtocol = 'magicpot-html-bridge/v3') {
  h.spawn.mockImplementation((_command, _args, opts) => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
    h.children.push(child)
    const socket = connect(opts.env.MAGICPOT_HTML_CHILD_PIPE); h.pipeSockets.push(socket)
    const frame = (type: string, sequence: number, data: unknown) => socket.write(`MAGICPOT_HTML_V1 ${JSON.stringify({ nonce: opts.env.MAGICPOT_HTML_CHILD_NONCE, type, sequence, data })}\n`)
    socket.once('connect', () => frame('booted', 0, { dnsBlocked: true, bridgeProtocol }))
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString(); let at: number
      while ((at = buffer.indexOf('\n')) >= 0) { const req = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); if (req.action === 'snapshot') frame('snapshot', req.sequence, { revision: document.revision, stateRevision: 1, value: { answer: 42 } }); else frame('ready', req.sequence, { revision: req.document.revision }) }
    })
    socket.on('error', () => undefined)
    socket.once('close', () => { if (ack) child.stderr.write(`MAGICPOT_JOB_EMPTY ${opts.env.MAGICPOT_JOB_COMPLETION_NONCE}\n`); child.emit('close', 0) })
    return child
  })
}
beforeEach(() => {
  h.cleanupFailure = false
  root = realpathSync.native(mkdtempSync(tmpdir() + '/html-process-unit-')); h.profileRoot = root
  h.verify.mockReset(); h.helper.mockReset().mockReturnValue('C:/verified/helper.exe'); h.capability.mockReset().mockReturnValue({ status: 0, stdout: 'magicpot-command-job:atomic-job-list-empty-v2' }); h.prepare.mockReset().mockImplementation(() => h.spawn); h.spawn.mockReset(); h.children.length = 0; h.pipeSockets.length = 0
})
afterEach(() => { h.cleanupFailure = false; h.pipeSockets.forEach(socket => socket.destroy()); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
describe.runIf(process.platform === 'win32')('owned isolated HTML process launcher', () => {
  it('rejects missing atomic helper or stale bootstrap before spawning any application', async () => {
    const options = { signal: new AbortController().signal, assertLive: () => undefined, onEvent: vi.fn(), onClosed: vi.fn() }
    h.capability.mockReturnValue({ status: 0, stdout: 'old-helper' })
    await expect(openHtmlProcess(document, options)).rejects.toThrow('current atomically')
    h.capability.mockReturnValue({ status: 0, stdout: 'magicpot-command-job:atomic-job-list-empty-v2' }); h.verify.mockImplementation(() => { throw new Error('stale manifest') })
    await expect(openHtmlProcess(document, options)).rejects.toThrow('stale manifest'); expect(h.spawn).not.toHaveBeenCalled()
  })
  it('rejects an older bootstrap without the gated bridge before sending model HTML', async () => {
    childFixture(true, 'magicpot-html-bridge/v1')
    await expect(openHtmlProcess(document, { signal: new AbortController().signal, assertLive: () => undefined, onEvent: vi.fn(), onClosed: vi.fn() })).rejects.toThrow('did not boot')
  })
  it('runs the durable admission before spawn and confirms absence only when cancellation occurs before the call', async () => {
    const controller = new AbortController(), onClosed = vi.fn(), beforeSpawn = vi.fn(() => controller.abort())
    await expect(openHtmlProcess(document, { signal: controller.signal, beforeSpawn, assertLive: () => controller.signal.throwIfAborted(), onEvent: vi.fn(), onClosed })).rejects.toThrow()
    expect(beforeSpawn).toHaveBeenCalledOnce(); expect(h.spawn).not.toHaveBeenCalled(); expect(onClosed).toHaveBeenCalledWith(true)
    childFixture(); const ordered = vi.fn(() => expect(h.spawn).not.toHaveBeenCalled())
    const host = await openHtmlProcess(document, { signal: new AbortController().signal, beforeSpawn: ordered, assertLive: () => undefined, onEvent: vi.fn(), onClosed: vi.fn() })
    expect(ordered).toHaveBeenCalledOnce(); expect(await host.close()).toEqual({ confirmed: true })
  })
  it('reports proven absence even if temp-profile cleanup throws before spawn', async () => {
    const controller = new AbortController(), onClosed = vi.fn()
    await expect(openHtmlProcess(document, { signal: controller.signal, beforeSpawn: () => { h.cleanupFailure = true; controller.abort() }, assertLive: () => controller.signal.throwIfAborted(), onEvent: vi.fn(), onClosed })).rejects.toThrow()
    expect(h.spawn).not.toHaveBeenCalled(); expect(onClosed).toHaveBeenCalledExactlyOnceWith(true)
  })
  it('uses fixed argv/resource caps, real private pipe and requires receipt plus close before releasing', async () => {
    childFixture(); const closed = vi.fn(), controller = new AbortController()
    const host = await openHtmlProcess(document, { hidden: true, signal: controller.signal, assertLive: () => controller.signal.throwIfAborted(), onEvent: vi.fn(), onClosed: closed })
    expect(h.prepare).toHaveBeenCalledWith({ metadata: { maxMemoryBytes: 1073741824, maxCpuTimeMs: 120000, maxProcessCount: 24 } })
    const [, args, opts] = h.spawn.mock.calls[0]
    expect(args).toEqual(['--magicpot-isolated-html-child', '--magicpot-html-test-hidden']); expect(opts.cwd).not.toBe(h.profileRoot); expect(opts.shell).toBe(false)
    expect(Object.keys(opts.env)).not.toContain('OPENAI_API_KEY')
    await host.update({ ...document, revision: 2 }); await expect(host.update({ ...document, revision: 2 })).rejects.toThrow('increase')
    expect(await host.close()).toEqual({ confirmed: true }); expect(closed).toHaveBeenCalledWith(true); expect(h.children[0].kill).not.toHaveBeenCalled()
  })
  it('correlates explicit final-state capture without emitting an event and rejects state after cancellation', async () => {
    childFixture(); const onState = vi.fn(), onEvent = vi.fn(), controller = new AbortController()
    const host = await openHtmlProcess(document, { signal: controller.signal, assertLive: () => controller.signal.throwIfAborted(), onState, onEvent, onClosed: vi.fn() })
    expect(await host.captureState!()).toEqual({ revision: 1, stateRevision: 1, value: { answer: 42 } }); expect(onEvent).not.toHaveBeenCalled()
    const env = h.spawn.mock.calls[0][2].env
    h.pipeSockets[0].write(`MAGICPOT_HTML_V1 ${JSON.stringify({ nonce: env.MAGICPOT_HTML_CHILD_NONCE, type: 'state', sequence: 1, data: { revision: 1, stateRevision: 1, value: { stale: true } } })}\n`)
    await new Promise(resolve => setImmediate(resolve)); expect(onState).not.toHaveBeenCalled()
    controller.abort(); await expect(host.captureState!()).rejects.toThrow(); expect(await host.close()).toEqual({ confirmed: true })
  })
  it('cancels after start through owned pipe and prevents subsequent event callbacks', async () => {
    childFixture(); const controller = new AbortController(), receive = vi.fn()
    const host = await openHtmlProcess(document, { signal: controller.signal, assertLive: () => controller.signal.throwIfAborted(), onEvent: receive, onClosed: vi.fn() })
    controller.abort(); expect(await host.close()).toEqual({ confirmed: true }); expect(receive).not.toHaveBeenCalled()
  })
  it('keeps valid native closure receipts after more than 1MiB of pipe event traffic', async () => {
    childFixture(); const receive = vi.fn(), host = await openHtmlProcess(document, { signal: new AbortController().signal, assertLive: () => undefined, onEvent: receive, onClosed: vi.fn() })
    const nonce = h.spawn.mock.calls[0][2].env.MAGICPOT_HTML_CHILD_NONCE, socket: Socket = h.pipeSockets[0]
    for (let i = 0; i < 150; i++) {
      socket.write(`MAGICPOT_HTML_V1 ${JSON.stringify({ nonce, type: 'event', sequence: 1, data: { name: 'event', data: 'x'.repeat(7500), revision: 1, origin: 'app', untrustedData: true, grantsPermission: false } })}\n`)
      await new Promise(resolve => setImmediate(resolve))
    }
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(150))
    expect(await host.close()).toEqual({ confirmed: true })
  })
  it('still recognizes a supervisor receipt after noisy diagnostics force shutdown', async () => {
    childFixture(); const onClosed = vi.fn()
    const host = await openHtmlProcess(document, { signal: new AbortController().signal, assertLive: () => undefined, onEvent: vi.fn(), onClosed })
    h.children[0].stdout.write(Buffer.alloc(1024 * 1024 + 1, 120))
    expect(await host.close()).toEqual({ confirmed: true }); expect(onClosed).toHaveBeenCalledWith(true)
  })
  it.each(['nonce', 'oversize', 'replayed-ready'])('closes invalid child %s frames without emitting app results', async kind => {
    childFixture(); const onEvent = vi.fn(), onClosed = vi.fn()
    const host = await openHtmlProcess(document, { signal: new AbortController().signal, assertLive: () => undefined, onEvent, onClosed })
    const env = h.spawn.mock.calls[0][2].env, socket: Socket = h.pipeSockets[0]
    if (kind === 'oversize') socket.write(Buffer.alloc(258 * 1024, 120))
    else socket.write(`MAGICPOT_HTML_V1 ${JSON.stringify({ nonce: kind === 'nonce' ? 'wrong' : env.MAGICPOT_HTML_CHILD_NONCE, type: 'ready', sequence: 1, data: { revision: 1 } })}\n`)
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledWith(true))
    expect(host.closed).toBe(true); expect(onEvent).not.toHaveBeenCalled()
  })
  it('treats native close without the supervisor receipt as unknown and retains global capacity', async () => {
    childFixture(false)
    for (let i = 0; i < 4; i++) {
      const host = await openHtmlProcess(document, { signal: new AbortController().signal, assertLive: () => undefined, onEvent: vi.fn(), onClosed: vi.fn() })
      expect(await host.close()).toEqual({ confirmed: false })
    }
    await expect(openHtmlProcess(document, { signal: new AbortController().signal, assertLive: () => undefined, onEvent: vi.fn(), onClosed: vi.fn() })).rejects.toThrow('capacity')
  })
})
