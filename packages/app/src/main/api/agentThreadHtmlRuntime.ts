import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { AgentThreadHtmlRunLedger } from './agentThreadHtmlRunLedger'
import { AgentThreadHtmlStore } from './agentThreadHtmlStore'
import { openTrackedHtmlProcess } from './agentThreadHtmlTrackedProcess'
import type { HtmlCheckpointCodec } from './agentThreadHtmlStore'
import type { HtmlAppDocument } from './agentThreadHtmlHost'
import type { openHtmlProcess } from './agentThreadHtmlProcess'

export type HtmlStorageStatus = { initialized: boolean; available: boolean; unconfirmedRuns: number | null; canInitialize: boolean }
/** Fixed main-owned profile paths and OS codec only; no path/env from model or IPC. */
export class AgentThreadHtmlRuntime {
  private initializing = false
  private ledger?: AgentThreadHtmlRunLedger
  private store?: AgentThreadHtmlStore
  constructor(private readonly root: string, private readonly codec: HtmlCheckpointCodec, private readonly configuredEpoch: () => string | undefined) {}
  private directory(): string {
    const root = realpathSync.native(this.root)
    if (!path.isAbsolute(this.root) || path.resolve(root).toLowerCase() !== path.resolve(this.root).toLowerCase() || lstatSync(root).isSymbolicLink()) throw new Error('Invalid HTML storage profile directory.')
    return path.join(root, 'agent-thread-html')
  }
  private paths() { const root = this.directory(); return { root, runs: path.join(root, 'runs.sqlite'), apps: path.join(root, 'apps.sqlite') } }
  private getLedger(): AgentThreadHtmlRunLedger {
    if (this.initializing) throw new Error('HTML storage initialization is still committing.')
    const epoch = this.configuredEpoch()
    if (!epoch || !/^[a-f0-9-]{36}$/.test(epoch)) throw new Error('Initialize encrypted HTML execution storage before opening an app.')
    if (!this.codec.available()) throw new Error('Encrypted HTML execution storage unavailable.')
    if (!this.ledger) this.ledger = new AgentThreadHtmlRunLedger(this.codec, this.paths().runs)
    if (this.ledger.epochId !== epoch) throw new Error('HTML storage epoch changed; refusing automatic reset.')
    this.ledger.list() // Revalidate before returning any storage/runtime capability.
    return this.ledger
  }
  status(): HtmlStorageStatus {
    let initialized = false
    try {
      const epoch = this.configuredEpoch(); initialized = Boolean(epoch)
      if (this.initializing) return { initialized, available: false, unconfirmedRuns: null, canInitialize: false }
      const paths = this.paths()
      const exists = ['', '.anchor', '-journal', '-wal', '-shm'].some(suffix => lstatSync(paths.runs + suffix, { throwIfNoEntry: false }))
      if (!epoch) {
        if (this.ledger) return { initialized: false, available: false, unconfirmedRuns: this.ledger.list().filter(slot => slot.status === 'unconfirmed').length, canInitialize: false }
        if (!exists) return { initialized: false, available: this.codec.available(), unconfirmedRuns: 0, canInitialize: true }
        // Config commit may fail after creating an unused pair. Only a complete,
        // authenticated never-reserved ledger is eligible for adoption, not reset.
        const pending = new AgentThreadHtmlRunLedger(this.codec, paths.runs)
        try { return { initialized: false, available: true, unconfirmedRuns: pending.list().filter(slot => slot.status === 'unconfirmed').length, canInitialize: pending.isPristine() } }
        finally { pending.close() }
      }
      const slots = this.getLedger().list(), occupied = slots.filter(slot => slot.status === 'unconfirmed').length
      return { initialized: true, available: true, unconfirmedRuns: occupied, canInitialize: false }
    } catch { return { initialized, available: false, unconfirmedRuns: null, canInitialize: false } }
  }
  /** User-only service supplies config commit after checking a current trusted lease. */
  async initialize(commitEpoch: (epoch: string) => Promise<void>, assertLive: () => void): Promise<HtmlStorageStatus> {
    if (this.initializing) throw new Error('HTML storage initialization is already committing.')
    this.initializing = true
    try { await this.initializeFresh(commitEpoch, assertLive); this.initializing = false; return this.status() }
    finally { this.initializing = false }
  }
  private async initializeFresh(commitEpoch: (epoch: string) => Promise<void>, assertLive: () => void): Promise<void> {
    assertLive()
    if (this.configuredEpoch() || this.ledger) throw new Error('HTML storage already initialized; no reset is permitted.')
    if (!this.codec.available()) throw new Error('Encrypted HTML execution storage unavailable.')
    const paths = this.paths()
    const info = lstatSync(paths.root, { throwIfNoEntry: false })
    if (!info) mkdirSync(paths.root)
    else if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(realpathSync(paths.root)).toLowerCase() !== paths.root.toLowerCase()) throw new Error('Unsafe HTML storage directory.')
    assertLive()
    const exists = ['', '.anchor', '-journal', '-wal', '-shm'].some(suffix => lstatSync(paths.runs + suffix, { throwIfNoEntry: false }))
    const ledger = exists ? new AgentThreadHtmlRunLedger(this.codec, paths.runs) : AgentThreadHtmlRunLedger.initialize(this.codec, paths.runs)
    try {
      if (!ledger.isPristine()) throw new Error('Existing HTML ledger was used; refusing initialization or reset.')
      await commitEpoch(ledger.epochId); assertLive()
      if (this.configuredEpoch() !== ledger.epochId) throw new Error('HTML storage initialization config was not committed.')
      this.ledger = ledger
    }
    catch (error) { ledger.close(); throw error }
  }
  withSavedIdle<T>(ownerHash: string, savedId: string, operation: () => T): T { return this.getLedger().withSavedIdle(ownerHash, savedId, operation) }
  assertSavedIdle(ownerHash: string, savedId: string): void { if (this.getLedger().hasSavedRun(ownerHash, savedId)) throw new Error('Saved HTML has an active or unconfirmed run; cannot restore/delete/save it.') }
  assertReady(): void { this.getLedger() }
  checkpoints(): AgentThreadHtmlStore {
    this.getLedger()
    if (!this.store) this.store = new AgentThreadHtmlStore(this.codec, this.paths().apps)
    return this.store
  }
  launch(document: HtmlAppDocument, options: Parameters<typeof openHtmlProcess>[1], ownerHash: string, savedId?: string) {
    return openTrackedHtmlProcess(document, { ...options, ledger: this.getLedger(), ownerHash, ...(savedId ? { savedId } : {}) })
  }
  close(): void { this.store?.close(); this.ledger?.close(); this.store = undefined; this.ledger = undefined }
}
let singleton: Promise<AgentThreadHtmlRuntime> | undefined
export function getAgentThreadHtmlRuntime(): Promise<AgentThreadHtmlRuntime> {
  singleton ??= (async () => {
    const [{ checkpointCodec }, { createCheckpointBinaryCodec }, { getBuildEnv }, { getConfig }] = await Promise.all([import('../figplugin/checkpointEncryption'), import('../figplugin/checkpointBinaryCodec'), import('../config/buildEnv'), import('../config/config')])
    return new AgentThreadHtmlRuntime(realpathSync.native(getBuildEnv().pathMap.data), { available: () => checkpointCodec.available(), ...createCheckpointBinaryCodec(checkpointCodec) }, () => getConfig().project_trace_config.agent_html_storage_epoch)
  })().catch(error => { singleton = undefined; throw error })
  return singleton
}
