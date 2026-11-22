import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export type DockerBashConfig = { image?: string; volumes?: string[]; working_dir?: string; env?: Record<string, string>; network_mode?: string; auto_remove?: boolean; name_prefix?: string; default_timeout_seconds?: number; max_result_size_chars?: number; socketPath?: string }
export type DockerTransport = (method: string, route: string, body?: unknown, signal?: AbortSignal, outputChars?: number) => Promise<Buffer>
export function createDockerOutputCollector(maxChars: number) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 200000) throw new Error('Invalid retained Docker output limit.')
  let header = Buffer.alloc(0), remaining = 0, total = 0, retained = '', pendingHigh = ''
  const decoder = new StringDecoder('utf8')
  const accept = (text: string, final = false) => {
    text = pendingHigh + text; pendingHigh = ''
    if (!final && text.length && /[\uD800-\uDBFF]/.test(text.at(-1)!)) { pendingHigh = text.at(-1)!; text = text.slice(0,-1) }
    for (const char of text) { if (total < maxChars) retained += char; total++ }
  }
  return {
    push(chunk: Buffer) {
      let offset = 0
      while (offset < chunk.length) {
        if (!remaining) {
          const count = Math.min(8 - header.length, chunk.length - offset)
          header = Buffer.concat([header, chunk.subarray(offset, offset + count)]); offset += count
          if (header.length < 8) continue
          if (![0,1,2].includes(header[0]) || header[1] || header[2] || header[3]) throw new Error('Invalid Docker stream header.')
          remaining = header.readUInt32BE(4); header = Buffer.alloc(0)
          if (!remaining) continue
        }
        const count = Math.min(remaining, chunk.length - offset)
        accept(decoder.write(chunk.subarray(offset, offset + count)))
        offset += count; remaining -= count
      }
    },
    finishFrame() {
      if (remaining || header.length) throw new Error('Incomplete Docker stream.')
      accept(decoder.end(), true)
      const bytes = Buffer.from(retained), frame = Buffer.alloc(8 + bytes.length) as Buffer & { totalOutputChars?: number }
      frame[0] = 1; frame.writeUInt32BE(bytes.length,4); bytes.copy(frame,8); frame.totalOutputChars = total
      return frame
    }
  }
}
export function createDockerEngineTransport(socketPath = process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'): DockerTransport {
  return (method, route, body, signal, outputChars) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = http.request({ socketPath, path: route, method, signal, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, response => {
      const collector = outputChars === undefined ? undefined : createDockerOutputCollector(outputChars)
      const parts: Buffer[] = []
      let retainedBytes = 0
      response.on('data', chunk => {
        if (collector && (response.statusCode ?? 500) < 300) {
          try { collector.push(Buffer.from(chunk)) } catch { response.destroy(new Error('Invalid Docker output framing.')) }
          return
        }
        retainedBytes += chunk.length
        if (retainedBytes > 8 * 1024 * 1024) { response.destroy(new Error('Docker response exceeds retained transport cap.')); return }
        parts.push(Buffer.from(chunk))
      })
      response.on('end', () => {
        let bytes: Buffer
        try { bytes = collector && (response.statusCode ?? 500) < 300 ? collector.finishFrame() : Buffer.concat(parts) }
        catch { reject(new Error('Incomplete Docker output framing.')); return }
        if ((response.statusCode ?? 500) >= 300) reject(new Error(`Docker Engine request failed (${response.statusCode}).`))
        else resolve(bytes)
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end(payload)
  })
}
function expandVolume(spec: string, cwd: string) {
  const expanded = spec.replaceAll('{cwd}', cwd)
  const separator = expanded.indexOf(':', /^[a-z]:[\\/]/i.test(expanded) ? 2 : 0)
  if (separator < 0) return expanded
  let host = expanded.slice(0, separator)
  if (host === '~' || host.startsWith('~/')) host = path.join(os.homedir(), host.slice(2))
  if (!path.isAbsolute(host)) host = path.resolve(cwd, host)
  return `${host}${expanded.slice(separator)}`
}
export function decodeDockerOutput(bytes: Buffer): string {
  const decoder = new StringDecoder('utf8')
  let offset = 0, output = ''
  while (offset + 8 <= bytes.length) {
    if (![0, 1, 2].includes(bytes[offset]) || bytes[offset + 1] || bytes[offset + 2] || bytes[offset + 3]) throw new Error('Invalid Docker output framing.')
    const length = bytes.readUInt32BE(offset + 4); offset += 8
    if (offset + length > bytes.length) throw new Error('Incomplete Docker output frame.')
    output += decoder.write(bytes.subarray(offset, offset + length)); offset += length
  }
  if (offset !== bytes.length) throw new Error('Incomplete Docker output framing.')
  return output + decoder.end()
}
/** Upstream semantics: lazy persistent container, local timeout only; remote exec may continue.
 * This backend does not supply approval. Invoke only after MAIN consumes formal permission.
 */
export function createDockerBashBackend(config: DockerBashConfig, transport = createDockerEngineTransport(config.socketPath)) {
  const settings = structuredClone(config)
  let container: string | undefined, creating: Promise<string> | undefined, busy = false, closed = false
  const json = async (method: string, route: string, body?: unknown, signal?: AbortSignal) => JSON.parse((await transport(method, route, body, signal)).toString('utf8'))
  const ensure = async (cwd: string): Promise<string> => {
    if (container) {
      try { const status = await json('GET', `/containers/${encodeURIComponent(container)}/json`); if (status.State?.Running || status.State?.Status === 'created') return container } catch { /* Match upstream recreation. */ }
      container = undefined
    }
    if (!creating) creating = (async () => {
      const created = await json('POST', `/containers/create?name=${encodeURIComponent((settings.name_prefix ?? 'kt-bash-') + randomUUID().slice(0, 8))}`, {
        Image: settings.image ?? 'python:3.13-slim', Cmd: ['sleep', 'infinity'], Tty: false,
        WorkingDir: settings.working_dir ?? '/workspace', Env: Object.entries(settings.env ?? {}).map(([key, value]) => `${key}=${value}`),
        HostConfig: { Binds: (settings.volumes ?? []).map(spec => expandVolume(spec, cwd)), NetworkMode: settings.network_mode ?? 'bridge', AutoRemove: settings.auto_remove ?? true }
      })
      if (typeof created.Id !== 'string' || !created.Id) throw new Error('Docker create returned no container.')
      const id: string = created.Id
      container = id
      await transport('POST', `/containers/${encodeURIComponent(id)}/start`)
      return id
    })().finally(() => { creating = undefined })
    return creating!
  }
  return Object.freeze({
    async execute(command: string, cwd: string, shell = 'bash', timeout = settings.default_timeout_seconds ?? 120, signal?: AbortSignal, outputLimit = settings.max_result_size_chars ?? 200000) {
      if (closed || busy) throw new Error('Docker backend closed or busy.')
      if (!command.trim() || !['bash', 'sh', 'zsh', 'fish'].includes(shell) || !Number.isFinite(timeout)) throw new Error('Invalid Docker shell request.')
      busy = true
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      try {
        signal?.throwIfAborted()
        if (timeout > 0) timer = setTimeout(abort, timeout * 1000)
        const id = await Promise.race([ensure(cwd), new Promise<never>((_resolve, reject) => {
          const cancelled = () => reject(new Error('Docker local waiting ended.'))
          if (controller.signal.aborted) cancelled()
          else controller.signal.addEventListener('abort', cancelled, { once: true })
        })])
        if (closed) throw new Error('Docker backend closed.')
        signal?.throwIfAborted()
        const execution = await json('POST', `/containers/${encodeURIComponent(id)}/exec`, { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: [shell, '-c', command.trim()], WorkingDir: settings.working_dir ?? '/workspace', Env: Object.entries(settings.env ?? {}).map(([key, value]) => `${key}=${value}`) }, controller.signal)
        if (typeof execution.Id !== 'string' || !execution.Id) throw new Error('Docker exec returned no identity.')
        const outputFrame = await transport('POST', `/exec/${encodeURIComponent(execution.Id)}/start`, { Detach: false, Tty: false }, controller.signal, Math.min(outputLimit, settings.max_result_size_chars ?? 200000))
        const output = decodeDockerOutput(outputFrame)
        const status = await json('GET', `/exec/${encodeURIComponent(execution.Id)}/json`, undefined, controller.signal)
        const chars = Array.from(output), max = Math.min(outputLimit, settings.max_result_size_chars ?? 200000)
        const total = (outputFrame as Buffer & { totalOutputChars?: number }).totalOutputChars ?? chars.length
        return { exitCode: status.ExitCode ?? 0, output: max > 0 && total > max ? chars.slice(0, max).join('') + `\n... (truncated, ${total - max} chars omitted)` : output, remoteMayContinue: false }
      } catch (error) {
        if (controller.signal.aborted) return { error: signal?.aborted ? 'Local waiting cancelled; remote command may continue.' : `Command timed out after ${timeout}s`, remoteMayContinue: true }
        throw error
      } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); busy = false }
    },
    async close() {
      closed = true
      try { await creating } catch { /* best effort shutdown */ }
      const id = container; container = undefined
      if (!id) return
      try { await transport('POST', `/containers/${encodeURIComponent(id)}/stop?t=5`) } catch { /* upstream best effort */ }
      if (settings.auto_remove === false) { try { await transport('DELETE', `/containers/${encodeURIComponent(id)}?force=1`) } catch { /* upstream best effort */ } }
    }
  })
}
