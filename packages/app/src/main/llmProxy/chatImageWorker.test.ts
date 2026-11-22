import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runChatImageWorker } from './chatImageWorker'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}
const png = (width = 50, height = 30): Buffer => {
  const header = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12)
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}
const jpeg = (): Buffer => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x1e, 0x00, 0x32, 0x01])
function worker() {
  const child = new FakeChild()
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
  return { child, spawn }
}
const basic = { binaryPath: 'C:\\safe\\image-worker.exe', source: new Uint8Array([1, 2, 3]) }
// Host-specific absolute path: tests must also run on non-Windows CI.
const input = { ...basic, binaryPath: process.platform === 'win32' ? basic.binaryPath : '/safe/image-worker' }

describe('chat image worker adapter', () => {
  it.each([['png', png(), 'image/png'], ['jpeg', jpeg(), 'image/jpeg']] as const)('streams %s bytes without a shell or source path', async (_name, output, mimeType) => {
    const { child, spawn } = worker()
    const promise = runChatImageWorker({ ...input, targetBytes: 2000 }, spawn)
    expect(spawn).toHaveBeenCalledWith(input.binaryPath, ['--chat-image', '--target-bytes', '2000', '--max-edge', '2000'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    expect(child.stdin.read()).toEqual(Buffer.from([1, 2, 3]))
    child.stdout.write(output)
    child.emit('close', 0)
    await expect(promise).resolves.toMatchObject({ bytes: output, mimeType, width: 50, height: 30 })
  })
  it.each([Buffer.from('not an image'), png(2001, 1), png(0, 1), Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff])])('rejects malformed, truncated or oversized encoded image', async (output) => {
    const { child, spawn } = worker()
    const promise = runChatImageWorker(input, spawn)
    child.stdout.write(output)
    child.emit('close', 0)
    await expect(promise).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_OUTPUT_INVALID' })
  })
  it('stops the worker before accepting data beyond the target and waits for native close', async () => {
    const { child, spawn } = worker()
    const promise = runChatImageWorker({ ...input, targetBytes: 10 }, spawn)
    const rejected = vi.fn()
    void promise.catch(rejected)
    child.stdout.write(Buffer.alloc(11))
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(rejected).not.toHaveBeenCalled()
    child.emit('close', 1)
    await expect(promise).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_OUTPUT_LIMIT' })
  })
  it.each([[1, 'CHAT_IMAGE_WORKER_FAILED'], [2, 'CHAT_IMAGE_WORKER_PROTOCOL_UNSUPPORTED']] as const)('keeps worker exit %s opaque without output or stderr data', async (exitCode, code) => {
    const { child, spawn } = worker()
    const promise = runChatImageWorker(input, spawn)
    child.stderr.write(Buffer.from('private/path and private input'))
    child.emit('close', exitCode)
    await expect(promise).rejects.toThrow(code)
  })
  it('cancels an in-flight worker and never resolves its later output', async () => {
    const controller = new AbortController()
    const { child, spawn } = worker()
    const promise = runChatImageWorker({ ...input, signal: controller.signal }, spawn)
    controller.abort()
    child.stdout.write(png())
    child.emit('close', 0)
    await expect(promise).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_ABORTED' })
    expect(child.kill).toHaveBeenCalledOnce()
  })
  it('holds the slot after kill fails, even if late data arrives', async () => {
    const { child, spawn } = worker()
    child.kill.mockImplementation(() => { throw new Error('untrusted child error') })
    const controller = new AbortController()
    const promise = runChatImageWorker({ ...input, signal: controller.signal }, spawn)
    const rejected = vi.fn()
    void promise.catch(rejected)
    controller.abort()
    child.stdout.write(png())
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(rejected).not.toHaveBeenCalled()
    child.emit('close', 0)
    await expect(promise).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_ABORTED' })
  })
  it('waits for close after an asynchronous start failure', async () => {
    const { child, spawn } = worker()
    const promise = runChatImageWorker(input, spawn)
    const rejected = vi.fn()
    void promise.catch(rejected)
    child.emit('error', new Error('private executable path'))
    await Promise.resolve()
    expect(rejected).not.toHaveBeenCalled()
    child.emit('close', -1)
    await expect(promise).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_START_FAILED' })
  })
  it('rejects an already-aborted signal and invalid limits before spawning', async () => {
    const { spawn } = worker()
    const controller = new AbortController(); controller.abort()
    await expect(runChatImageWorker({ ...input, signal: controller.signal }, spawn)).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_ABORTED' })
    await expect(runChatImageWorker({ ...input, targetBytes: 0 }, spawn)).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_INVALID_INPUT' })
    await expect(runChatImageWorker({ ...input, source: new Uint8Array(32 * 1024 * 1024 + 1) }, spawn)).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_INVALID_INPUT' })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('kills a hung worker on the bounded deadline', async () => {
    vi.useFakeTimers()
    try {
      const { child, spawn } = worker()
      const promise = runChatImageWorker({ ...input, timeoutMs: 10 }, spawn)
      const rejection = expect(promise).rejects.toMatchObject({ code: 'CHAT_IMAGE_WORKER_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(10)
      expect(child.kill).toHaveBeenCalledOnce()
      let settled = false
      void promise.finally(() => { settled = true }).catch(() => undefined)
      await Promise.resolve()
      expect(settled).toBe(false)
      child.emit('close', 1)
      await rejection
    } finally { vi.useRealTimers() }
  })
})
