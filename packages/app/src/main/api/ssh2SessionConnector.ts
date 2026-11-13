import { Client } from 'ssh2'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { SshConnector } from './sshBashBackend'

/** MAIN-only connector: keys are read only when an explicitly configured connection is
 * dispatched after approval. No implicit private-key discovery or authentication logging.
 */
const learnedHostKeys = new Map<string, string>()
export const connectSsh2Session: SshConnector = config => connectSsh2SessionWithKnownHosts(config)
export async function connectSsh2SessionWithKnownHosts(config: Parameters<SshConnector>[0], suppliedKnownHosts?: string): ReturnType<SshConnector> {
  const client = new Client()
  let active = false
  const host = config.port && config.port !== 22 ? `[${config.host}]:${config.port}` : config.host
  const knownFile = path.join(os.homedir(), '.ssh', 'known_hosts')
  const known = (suppliedKnownHosts ?? (existsSync(knownFile) ? readFileSync(knownFile, 'utf8') : '')).split(/\r?\n/).filter(line => line && !line.startsWith('#'))
  const matchesHost = (entry: string) => {
    if (!entry) return false
    const patterns = entry.split(',')
    if (patterns.some(value => value.startsWith('!'))) return true
    if (!entry.startsWith('|1|') && patterns.some(value => /[*?]/.test(value))) return patterns.some(value => {
      const escaped = value.replace(/[.+^${}()|[\]\\]/g,'\\$&')
      const pattern = escaped.replaceAll('*','.*').replaceAll('?','.')
      return new RegExp(`^${pattern}$`).test(host)
    })
    if (entry.startsWith('|1|')) {
      const [, , salt, hash] = entry.split('|')
      if (!salt || !hash) return false
      const digest = createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest(), expected = Buffer.from(hash, 'base64')
      return digest.length === expected.length && timingSafeEqual(digest, expected)
    }
    return entry.split(',').some(value => value === host)
  }
  const parsedKnown = known.map(line => line.trim().split(/\s+/)).map(parts => ({ marker: parts[0].startsWith('@') ? parts.shift() : undefined, parts }))
  const matching = parsedKnown.filter(entry => matchesHost(entry.parts[0]))
  const entries = matching.filter(entry => !entry.marker).map(entry => entry.parts)
  const learnedKey = `${config.host}:${config.port ?? 22}`
  const keyPath = config.key_filename?.replace(/^~(?=[\\/])/, os.homedir())
  const privateKey = keyPath ? readFileSync(keyPath) : undefined
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => { active = true; resolve() })
    client.on('error', () => { active = false; reject(new Error('SSH connection or authentication failed.')) })
    client.on('close', () => { active = false })
    client.connect({ host: config.host, port: config.port ?? 22, username: config.user,
      ...(privateKey ? { privateKey } : {}), ...(config.password ? { password: config.password } : {}),
      readyTimeout: 20000, keepaliveInterval: (config.keep_alive_seconds ?? 30) * 1000,
      hostVerifier: key => {
        const encoded = key.toString('base64')
        if (matching.some(entry => entry.marker || entry.parts[0].split(',').some(value=>value.startsWith('!')))) return false
        if (entries.length) return entries.some(parts => parts[2] === encoded)
        const pinned = learnedHostKeys.get(learnedKey)
        if (pinned) return pinned === encoded
        if ((config.known_hosts_policy ?? 'auto_add') === 'reject') return false
        if (config.known_hosts_policy === 'warn') process.emitWarning('SSH accepted an unknown host key under explicit warn policy.', { code: 'SSH_UNKNOWN_HOST_KEY' })
        else learnedHostKeys.set(learnedKey, encoded)
        return true
      }
    })
  }).catch(error => { client.destroy(); throw error })
  return {
    isActive: () => active,
    execute(commandLine) {
      return new Promise((resolve, reject) => {
        client.exec(commandLine, (error, channel) => {
          if (error) { reject(new Error('SSH command channel unavailable.')); return }
          const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8')
          let stdout = '', stderr = '', exitCode = -1, stdoutChars = 0, stderrChars = 0
          const max = Math.max(1, config.max_result_size_chars ?? 200000)
          const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
            const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk)
            // Finite retention independent of remote lifetime; no remote kill is implied.
            const chars = Array.from(text)
            const count = stream === 'stdout' ? stdoutChars : stderrChars
            const kept = chars.slice(0, Math.max(0, max - count)).join('')
            if (stream === 'stdout') { stdout += kept; stdoutChars += chars.length } else { stderr += kept; stderrChars += chars.length }
          }
          channel.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
          channel.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'))
          channel.on('exit', (code: number) => { exitCode = code ?? -1 })
          channel.on('error', () => reject(new Error('SSH command channel failed.')))
          channel.on('close', () => { stdout += stdoutDecoder.end(); stderr += stderrDecoder.end(); resolve({ stdout, stderr, exitCode, stdoutChars, stderrChars }) })
        })
      })
    },
    async close() { active = false; client.destroy() }
  }
}
