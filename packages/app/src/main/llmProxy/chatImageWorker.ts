import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

/** The worker operates on request copies; it never receives or writes a user path. */
export const CHAT_IMAGE_WORKER_MAX_INPUT_BYTES = 32 * 1024 * 1024
export const CHAT_IMAGE_WORKER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
export const CHAT_IMAGE_WORKER_MAX_EDGE = 2000
export const CHAT_IMAGE_WORKER_DEFAULT_TARGET_BYTES = 512_000

export type ChatImageWorkerResult = {
  bytes: Buffer
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

export type ChatImageWorkerInput = {
  binaryPath: string
  source: Uint8Array
  targetBytes?: number
  maxEdge?: number
  signal?: AbortSignal
  timeoutMs?: number
}

type Spawn = (
  file: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true; shell: false }
) => ChildProcessWithoutNullStreams

function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

/** Read dimensions from a bounded encoded result, without decoding pixel data. */
function imageResultDimensions(bytes: Buffer): Omit<ChatImageWorkerResult, 'bytes'> | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let index = 2
  while (index < bytes.length) {
    if (bytes[index++] !== 0xff) return null
    while (index < bytes.length && bytes[index] === 0xff) index += 1
    if (index >= bytes.length) return null
    const marker = bytes[index++]
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (index + 2 > bytes.length) return null
    const length = bytes.readUInt16BE(index)
    if (length < 2 || index + length > bytes.length) return null
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      if (length < 8) return null
      return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(index + 3), width: bytes.readUInt16BE(index + 5) }
    }
    index += length
  }
  return null
}

/**
 * Runs the explicit bytes-in/bytes-out image-worker mode. Errors deliberately omit
 * source data, worker stderr and file paths. Callers must own concurrency and input
 * authorization, and must not use a stale worker that lacks this protocol.
 */
export async function runChatImageWorker(
  input: ChatImageWorkerInput,
  spawn: Spawn = nodeSpawn as Spawn
): Promise<ChatImageWorkerResult> {
  const target = input.targetBytes ?? CHAT_IMAGE_WORKER_DEFAULT_TARGET_BYTES
  const edge = input.maxEdge ?? CHAT_IMAGE_WORKER_MAX_EDGE
  const timeout = input.timeoutMs ?? 30_000
  if (
    !path.isAbsolute(input.binaryPath) || input.binaryPath.includes('\0') ||
    !(input.source instanceof Uint8Array) || input.source.byteLength < 1 ||
    input.source.byteLength > CHAT_IMAGE_WORKER_MAX_INPUT_BYTES ||
    !Number.isSafeInteger(target) || target < 1 || target > CHAT_IMAGE_WORKER_MAX_OUTPUT_BYTES ||
    !Number.isSafeInteger(edge) || edge < 1 || edge > CHAT_IMAGE_WORKER_MAX_EDGE ||
    !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000
  ) throw failure('CHAT_IMAGE_WORKER_INVALID_INPUT')
  if (input.signal?.aborted) throw failure('CHAT_IMAGE_WORKER_ABORTED')

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(input.binaryPath, ['--chat-image', '--target-bytes', String(target), '--max-edge', String(edge)], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
      })
    } catch {
      reject(failure('CHAT_IMAGE_WORKER_START_FAILED'))
      return
    }
    let settled = false
    let stopping = false
    let deferredError: Error | undefined
    let received = 0
    let stderrBytes = 0
    const parts: Buffer[] = []
    const finish = (error?: Error, result?: ChatImageWorkerResult, kill = false): void => {
      if (settled || stopping) return
      if (kill) {
        // Requesting termination is not evidence of native exit. Keep this Promise
        // pending so a caller's process-wide admission cannot start another decoder.
        stopping = true
        deferredError = error ?? failure('CHAT_IMAGE_WORKER_FAILED')
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
        try { child.kill() } catch { /* quarantine until close, even if termination failed */ }
        return
      }
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(failure('CHAT_IMAGE_WORKER_FAILED'))
    }
    const onAbort = (): void => finish(failure('CHAT_IMAGE_WORKER_ABORTED'), undefined, true)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => finish(failure('CHAT_IMAGE_WORKER_TIMEOUT'), undefined, true), timeout)
    child.on('error', () => finish(failure('CHAT_IMAGE_WORKER_START_FAILED'), undefined, true))
    child.stdin.on('error', () => finish(failure('CHAT_IMAGE_WORKER_INPUT_FAILED'), undefined, true))
    child.stdout.on('error', () => finish(failure('CHAT_IMAGE_WORKER_OUTPUT_FAILED'), undefined, true))
    child.stderr.on('error', () => finish(failure('CHAT_IMAGE_WORKER_OUTPUT_FAILED'), undefined, true))
    child.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled || stopping) return
      if (!(chunk instanceof Uint8Array)) return finish(failure('CHAT_IMAGE_WORKER_OUTPUT_INVALID'), undefined, true)
      received += chunk.byteLength
      if (received > target || received > CHAT_IMAGE_WORKER_MAX_OUTPUT_BYTES) {
        finish(failure('CHAT_IMAGE_WORKER_OUTPUT_LIMIT'), undefined, true)
        return
      }
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled || stopping) return
      if (!(chunk instanceof Uint8Array)) return finish(failure('CHAT_IMAGE_WORKER_OUTPUT_INVALID'), undefined, true)
      stderrBytes += chunk.byteLength
      if (stderrBytes > 4096) finish(failure('CHAT_IMAGE_WORKER_OUTPUT_LIMIT'), undefined, true)
    })
    child.on('close', (code) => {
      if (settled) return
      if (stopping) {
        stopping = false
        return finish(deferredError)
      }
      if (code === 2) return finish(failure('CHAT_IMAGE_WORKER_PROTOCOL_UNSUPPORTED'))
      if (code !== 0) return finish(failure('CHAT_IMAGE_WORKER_FAILED'))
      const bytes = Buffer.concat(parts, received)
      const info = imageResultDimensions(bytes)
      if (!info || !info.width || !info.height || info.width > edge || info.height > edge) {
        finish(failure('CHAT_IMAGE_WORKER_OUTPUT_INVALID'))
        return
      }
      finish(undefined, { ...info, bytes })
    })
    // An abort can race listener installation and stdin creation.
    if (input.signal?.aborted) return onAbort()
    try { child.stdin.end(input.source) } catch { finish(failure('CHAT_IMAGE_WORKER_INPUT_FAILED'), undefined, true) }
  })
}
