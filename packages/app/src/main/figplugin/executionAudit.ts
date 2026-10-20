import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

export const FIGPLUGIN_AUDIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const FIGPLUGIN_AUDIT_MAX_RECORDS = 256
export const FIGPLUGIN_AUDIT_MAX_BYTES = 1024 * 1024
export const FIGPLUGIN_AUDIT_MAX_LINE_BYTES = 4096

const eventSchema = z
  .object({
    schemaVersion: z.literal(1),
    at: z.number().int().min(0),
    executionId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]{32}$/),
    callId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]{32}$/),
    requestId: z.string().min(1).max(80),
    pluginId: z.string().min(1).max(128),
    host: z.enum(['figma', 'photoshop']),
    projectId: z.string().min(1).max(160),
    state: z.enum([
      'awaiting-approval',
      'approved',
      'claimed',
      'executing',
      'readback',
      'completed',
      'cancelled',
      'denied',
      'failed',
      'expired'
    ]),
    completed: z.number().int().min(0).max(20),
    total: z.number().int().min(1).max(20),
    effect: z.enum(['none', 'applied', 'rolled-back', 'partial', 'unknown']),
    risk: z.enum(['low', 'medium', 'high']),
    planSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    previewSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    adapterVersion: z.string().min(1).max(64),
    rollback: z.enum(['verified-in-place', 'native-history', 'none']),
    visualAudit: z.enum(['hash-only', 'unavailable']),
    durationMs: z.number().int().min(0),
    errorCode: z.string().min(1).max(64).optional()
  })
  .strict()
export type FigPluginExecutionAuditEvent = z.output<typeof eventSchema>

type Stored = FigPluginExecutionAuditEvent

const parseLine = (line: string): Stored | undefined => {
  if (!line || Buffer.byteLength(line, 'utf8') > FIGPLUGIN_AUDIT_MAX_LINE_BYTES) return undefined
  try {
    const parsed = eventSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export class FigPluginExecutionAuditStore {
  readonly #file: string
  #queue: Promise<void> = Promise.resolve()
  #now: () => number

  constructor(root: string, now: () => number = Date.now) {
    if (!path.isAbsolute(root) || root.includes('\0')) throw new Error('INVALID_AUDIT_ROOT')
    this.#file = path.join(root, 'execution-audit.jsonl')
    this.#now = now
  }

  record(value: FigPluginExecutionAuditEvent): void {
    const parsed = eventSchema.safeParse(value)
    if (!parsed.success) return
    const line = `${JSON.stringify(parsed.data)}\n`
    if (Buffer.byteLength(line, 'utf8') > FIGPLUGIN_AUDIT_MAX_LINE_BYTES) return
    this.#queue = this.#queue.then(() => this.#append(line)).catch(() => undefined)
  }

  flush(): Promise<void> {
    return this.#queue
  }

  async list(): Promise<readonly FigPluginExecutionAuditEvent[]> {
    await this.#queue
    return this.#read()
  }

  async #append(line: string): Promise<void> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    const handle = await fs.open(this.#file, 'a', 0o600)
    try {
      await handle.writeFile(line, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this.#compact()
  }

  async #read(): Promise<Stored[]> {
    let text: string
    try {
      text = await fs.readFile(this.#file, 'utf8')
    } catch {
      return []
    }
    if (Buffer.byteLength(text, 'utf8') > FIGPLUGIN_AUDIT_MAX_BYTES * 2) return []
    const now = this.#now()
    return text
      .split('\n')
      .filter(Boolean)
      .map(parseLine)
      .filter((event): event is Stored => !!event && event.at + FIGPLUGIN_AUDIT_TTL_MS > now)
      .slice(-FIGPLUGIN_AUDIT_MAX_RECORDS)
  }

  async #compact(): Promise<void> {
    let info
    try {
      info = await fs.stat(this.#file)
    } catch {
      return
    }
    if (info.size <= FIGPLUGIN_AUDIT_MAX_BYTES) return
    const events = (await this.#read()).slice(-FIGPLUGIN_AUDIT_MAX_RECORDS)
    let text = events.map((event) => JSON.stringify(event)).join('\n')
    if (text) text += '\n'
    while (Buffer.byteLength(text, 'utf8') > FIGPLUGIN_AUDIT_MAX_BYTES && events.length)
      events.shift()
    text = events.map((event) => JSON.stringify(event)).join('\n')
    if (text) text += '\n'
    const temporary = `${this.#file}.${process.pid}.${this.#now()}.tmp`
    await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, this.#file)
  }
}
