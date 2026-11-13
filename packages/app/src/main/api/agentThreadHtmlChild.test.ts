import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ socket: undefined as any, start: vi.fn(), update: vi.fn(), close: vi.fn(), exit: vi.fn(), path: vi.fn(), switch: vi.fn() }))
vi.mock('node:net', () => ({ connect: () => h.socket }))
vi.mock('electron', () => ({ app: { isReady: () => false, setPath: h.path, commandLine: { appendSwitch: h.switch }, disableHardwareAcceleration: vi.fn(), on: vi.fn(), exit: h.exit } }))
vi.mock('./agentThreadHtmlHost', async original => ({ ...(await original()), openIsolatedHtmlHost: h.start }))
import { HTML_CHILD_FLAG, HTML_CHILD_FRAME_LIMIT, startHtmlChildRuntime } from './agentThreadHtmlChild'
const nonce = 'a'.repeat(64), document = { title: 'App', html: '<p>ok</p>', revision: 1 }, argv = [...process.argv]
let root = ''
const packet = (extra: object = {}) => JSON.stringify({ nonce, sequence: 1, action: 'open', document, ...extra }) + '\n'
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'html-child-unit-')))
  vi.stubEnv('MAGICPOT_HTML_CHILD_PROFILE', root); vi.stubEnv('MAGICPOT_HTML_CHILD_NONCE', nonce); vi.stubEnv('MAGICPOT_HTML_CHILD_PIPE', String.raw`\\.\pipe\magicpot-html-` + 'b'.repeat(32))
  process.argv = [...argv, HTML_CHILD_FLAG, '--magicpot-html-test-hidden']
  h.socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn(), writableLength: 0 })
  h.update.mockReset().mockResolvedValue(undefined); h.start.mockReset().mockResolvedValue({ update: h.update, close: h.close, closed: false })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); process.argv = [...argv]; rmSync(root, { recursive: true, force: true }) })
const start = () => { startHtmlChildRuntime(); h.socket.emit('connect') }
const feed = (value: string | Buffer) => h.socket.emit('data', Buffer.from(value))
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
describe('isolated child named-pipe admission', () => {
  it('sets only its dedicated profile and DNS policy before boot, and accepts fragmented ordered frames', async () => {
    start(); expect(h.path).toHaveBeenCalledWith('userData', root); expect(h.switch).toHaveBeenCalledWith('host-resolver-rules', 'MAP * ~NOTFOUND')
    expect(h.socket.write.mock.calls[0][0].toString()).toContain('booted')
    const frame = packet(); feed(frame.slice(0, 20)); expect(h.start).not.toHaveBeenCalled(); feed(frame.slice(20)); await flush()
    expect(h.start).toHaveBeenCalledOnce(); expect(h.exit).not.toHaveBeenCalled(); expect(h.socket.write.mock.calls.at(-1)[0].toString()).toContain('ready')
    feed(packet({ sequence: 2, action: 'update', document: { ...document, revision: 2 } })); await flush(); expect(h.update).toHaveBeenCalledOnce()
    h.socket.emit('end'); expect(h.close).toHaveBeenCalledOnce(); expect(h.exit).toHaveBeenCalledWith(0)
  })
  it.each(['nonce', 'sequence', 'before-open', 'burst', 'json', 'null', 'action-object', 'oversize'] as const)('fails closed on %s without displaying model content', async kind => {
    start()
    if (kind === 'nonce') feed(packet({ nonce: 'wrong' }))
    else if (kind === 'sequence') feed(packet({ sequence: 2 }))
    else if (kind === 'before-open') feed(packet({ action: 'update' }))
    else if (kind === 'burst') feed(packet() + packet())
    else if (kind === 'json') feed('not-json\n')
    else if (kind === 'null') feed('null\n')
    else if (kind === 'action-object') feed(packet({ action: { toString: {} } }))
    else feed(Buffer.alloc(HTML_CHILD_FRAME_LIMIT + 1))
    await flush(); expect(h.exit).toHaveBeenCalledWith(1); expect(h.start).not.toHaveBeenCalled()
  })
  it('rejects a replay and emits no future events after transport loss', async () => {
    start(); feed(packet()); await flush(); feed(packet()); expect(h.exit).toHaveBeenCalledWith(1)
    const count = h.socket.write.mock.calls.length
    h.start.mock.calls[0][1].onEvent({ name: 'late', data: {}, revision: 1, origin: 'app', untrustedData: true, grantsPermission: false })
    expect(h.socket.write).toHaveBeenCalledTimes(count)
  })
  it('bounds output backpressure and pre-open idle lifetime', () => {
    startHtmlChildRuntime(); h.socket.writableLength = 128 * 1024; h.socket.emit('connect'); expect(h.exit).toHaveBeenCalledWith(1)
  })
  it('exits an idle disconnected launcher and never uses a default user profile', async () => {
    start(); await vi.advanceTimersByTimeAsync(15000); expect(h.exit).toHaveBeenCalledWith(1); expect(h.start).not.toHaveBeenCalled()
  })
  it('rejects a missing nonce before profile selection', () => {
    vi.stubEnv('MAGICPOT_HTML_CHILD_NONCE', ''); expect(() => startHtmlChildRuntime()).toThrow('launch contract'); expect(h.path).not.toHaveBeenCalled()
  })
})
