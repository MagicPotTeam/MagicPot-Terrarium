import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDocumentWorker, type DocumentWorkerPort } from './documentWorkerRuntime'
import { DOCUMENT_TEXT_PROTOCOL } from './documentSchema'
import { serializeDocumentTextRequest, parseDocumentTextResultFrame } from './documentWorkerWire'
import { pdfFixtures } from './__fixtures__/pdfFixtures'

const job = 'b'.repeat(32)
const frame = () =>
  serializeDocumentTextRequest({
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: job,
    format: 'pdf',
    bytes: pdfFixtures().multiPage
  })
function fixture() {
  const port = new EventEmitter() as EventEmitter & DocumentWorkerPort
  port.postMessage = vi.fn()
  const exit = vi.fn(),
    load = vi.fn(async () => {
      throw new Error('synthetic-private-runtime-path')
    })
  runDocumentWorker(port, exit, load)
  return { port, exit, load }
}
afterEach(() => vi.useRealTimers())
describe('single frame worker receipt protocol', () => {
  it('classifies runtime failure without detail and does not exit success until exact ACK', async () => {
    const f = fixture()
    f.port.emit('message', { data: frame() })
    await vi.waitFor(() => expect(f.port.postMessage).toHaveBeenCalledTimes(1))
    const output = (f.port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(parseDocumentTextResultFrame(output, job, 'pdf')).toMatchObject({
      ok: true,
      result: { ok: false, code: 'EXECUTION_FAILED' }
    })
    expect(output).not.toContain('synthetic-private')
    expect(f.exit).not.toHaveBeenCalled()
    f.port.emit('message', { data: 'ACK' })
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.port.eventNames()).toEqual([])
  })
  it.each([
    ['bad-json', '{'],
    ['nonstring', {}],
    ['early-ack', 'ACK']
  ] as const)('rejects %s before loading any parser', (_label, data) => {
    const f = fixture()
    f.port.emit('message', { data })
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(f.load).not.toHaveBeenCalled()
  })
  it('rejects transferred ports and duplicate frames', () => {
    const a = fixture()
    a.port.emit('message', { data: frame(), ports: [{}] })
    expect(a.exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(a.load).not.toHaveBeenCalled()
    const b = fixture()
    b.port.emit('message', { data: frame() })
    b.port.emit('message', { data: frame() })
    expect(b.exit).toHaveBeenCalledExactlyOnceWith(2)
  })
  it('uses a native self-exit watchdog when no parent receipt arrives', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await vi.advanceTimersByTimeAsync(6000)
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(f.port.eventNames()).toEqual([])
  })
})
