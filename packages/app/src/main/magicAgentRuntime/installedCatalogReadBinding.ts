import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { isProxy } from 'node:util/types'
import { app } from 'electron'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { cancelInstalledCatalogPublication, registerInstalledCatalogPublication } from '@shared/api/createServer/installedCatalogPublication'
import { digestPolicyRequest, POLICY_REQUEST_DISCRIMINATOR, POLICY_REQUEST_VERSION, type PolicyDecision } from '@shared/magicAgentPlatform2/policy'
import { getConfig, onConfigCommitted } from '../config/config'
import { isMagicAgentPlatformEnabled } from './featureFlag'
import { isInstalledCatalogDirectoryId, type InstalledCatalogEntry } from './installedCatalogMetadata'
import { evaluateInstalledCatalogReadPolicy } from './installedCatalogPolicy'
import { readInstalledCatalogSnapshot, type InstalledCatalogReadOptions, type InstalledCatalogSnapshot } from './installedCatalogReader'
import { completeManagementReadLease, createManagementReadAdmission, type ManagementReadAdmission, type ManagementReadState, type ManagementReadWindow } from './managementReadAdmission'

export type InstalledCatalogReadHostDeps = {
  getReadState(): ManagementReadState
  onConfigCommitted(listener: () => void): () => void
  getUserData(): unknown
  evaluatePolicy(request: unknown, evaluatedAt: number): PolicyDecision | null
  readSnapshot(options: InstalledCatalogReadOptions): Promise<InstalledCatalogSnapshot>
  newRequestId(): string
  now(): number
  wallNow(): number
}
export type InstalledCatalogReadDelegate = (payload: unknown, invocation?: ServiceInvocationContext) => Promise<InstalledCatalogSnapshot>
export type InstalledCatalogReadHost = Readonly<{
  install(window: ManagementReadWindow, trustedRendererUrl: string, getMainWindow: () => ManagementReadWindow | null): () => void
  read(payload: unknown, invocation: ServiceInvocationContext | undefined, getMainWindow: () => ManagementReadWindow | null): Promise<InstalledCatalogSnapshot>
  dispose(): void
}>
const unavailable: InstalledCatalogSnapshot = Object.freeze({ status: 'unavailable', reason: 'unavailable' })
const defaults: InstalledCatalogReadHostDeps = {
  getReadState: () => { try { getConfig(); return isMagicAgentPlatformEnabled() ? 'ready' : 'disabled' } catch { return 'unavailable' } },
  onConfigCommitted, getUserData: () => app.getPath('userData'), evaluatePolicy: evaluateInstalledCatalogReadPolicy,
  readSnapshot: readInstalledCatalogSnapshot, newRequestId: () => 'installed-catalog-read:' + randomUUID(), now: () => performance.now(), wallNow: Date.now
}
const requestFor = (requestId: string) => Object.freeze({
  discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION, requestId,
  actor: Object.freeze({ kind: 'service', id: 'main-management-installed-catalog-reader' }), origin: 'renderer',
  action: 'management.installed-catalog.read', transport: 'electron-ipc',
  target: Object.freeze({ kind: 'installed-package-catalog', id: 'main-user-data-installed-packages' }), input: Object.freeze({}),
  effects: Object.freeze([Object.freeze({ kind: 'filesystem.read', risk: 'read', target: 'main-user-data-installed-packages' })])
})
const rootIsValid = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.trim() !== value || !path.isAbsolute(value) || path.resolve(value) !== value || [...value].some(c => c.charCodeAt(0) < 32)) return false
  if (process.platform === 'win32' && (value.startsWith('\\\\') || !/^[a-z]:\\/i.test(value))) return false
  const parts = value.slice(path.parse(value).root.length).split(path.sep)
  return parts.length <= 64 && parts.every(part => part && part.length <= 255 && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
}
const data = (value: unknown, keys: string[]): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null
  const result: Record<string, unknown> = {}
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !('value' in descriptor)) return null; result[key] = descriptor.value }
  return result
}
const displayText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && [...value].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127 && c.charCodeAt(0) !== 0xfffd)
function projectSnapshot(value: unknown): InstalledCatalogSnapshot | null {
  const snapshot = data(value, ['status', 'entries'])
  if (!snapshot || snapshot.status !== 'available' || !Array.isArray(snapshot.entries) || isProxy(snapshot.entries) || snapshot.entries.length > 64 || Reflect.ownKeys(snapshot.entries).length !== snapshot.entries.length + 1) return null
  const entries: InstalledCatalogEntry[] = [], ids = new Set<string>()
  for (let index = 0; index < snapshot.entries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(snapshot.entries, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) return null
    const entry = data(descriptor.value, ['id', 'name', 'version', 'installedAt'])
    if (!entry || !isInstalledCatalogDirectoryId(entry.id) || ids.has(entry.id) || !displayText(entry.name, 120) || !displayText(entry.version, 128) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version) || !displayText(entry.installedAt, 24) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.installedAt) || new Date(entry.installedAt).toISOString() !== entry.installedAt) return null
    ids.add(entry.id); entries.push(Object.freeze({ id: entry.id, name: entry.name, version: entry.version, installedAt: entry.installedAt }))
  }
  const projected = Object.freeze({ status: 'available' as const, entries: Object.freeze(entries) })
  return JSON.stringify(projected).length <= 131072 ? projected : null
}

type Binding = { window: ManagementReadWindow; admission?: ManagementReadAdmission; ready: boolean; closed: boolean; removeClosed?: () => void }
/** Independent MAIN owner. Module evaluation selects no root and initializes no config/runtime/store. */
export function createInstalledCatalogReadHost(deps: InstalledCatalogReadHostDeps = defaults): InstalledCatalogReadHost {
  let current: Binding | undefined, epoch = 0, stopped = false
  const retire = (binding: Binding | undefined): void => {
    if (!binding || binding.closed) return
    binding.closed = true; binding.ready = false
    if (current === binding) { current = undefined; epoch++ }
    try { binding.removeClosed?.() } catch { /* Identity was revoked first. */ }
    binding.admission?.dispose()
  }
  const host: InstalledCatalogReadHost = Object.freeze({
    install(window, trustedRendererUrl, getMainWindow) {
      if (stopped) return () => {}
      const attempt = ++epoch, previous = current
      current = undefined; retire(previous)
      if (stopped || epoch !== attempt) return () => {}
      const binding: Binding = { window, ready: false, closed: false }
      current = binding
      try {
        const admission = createManagementReadAdmission({ window, trustedRendererUrl, getMainWindow, getReadState: deps.getReadState, onConfigCommitted: deps.onConfigCommitted, now: deps.now })
        binding.admission = admission
        if (binding.closed || current !== binding || epoch !== attempt) { admission.dispose(); return () => retire(binding) }
        const closed = () => retire(binding)
        binding.removeClosed = () => window.removeListener('closed', closed)
        window.on('closed', closed)
        if (binding.closed || current !== binding || epoch !== attempt) {
          // newListener reentry may retire before on() actually inserts this exact listener.
          window.removeListener('closed', closed); retire(binding); return () => retire(binding)
        }
        binding.ready = true
      } catch { retire(binding) }
      return () => retire(binding)
    },
    async read(payload, invocation, getMainWindow) {
      const binding = current
      if (stopped || !binding?.ready || binding.closed || !binding.admission) return unavailable
      try { if (getMainWindow() !== binding.window || current !== binding) return unavailable } catch { return unavailable }
      const lease = binding.admission.begin(payload, invocation)
      if (!lease) return unavailable
      let registered = false, cancelled = false, canPublish = false
      const close = () => { if (!cancelled) { cancelled = true; canPublish = false; lease.close() } }
      const reject = () => { if (registered) cancelInstalledCatalogPublication(invocation); else close(); return unavailable }
      try {
        let lastTime = deps.now()
        if (!Number.isFinite(lastTime) || lastTime < 0) return reject()
        const deadline = lastTime + 2000
        const clockValid = () => { const at = deps.now(); const valid = Number.isFinite(at) && at >= lastTime && at < deadline; lastTime = at; return valid }
        const owns = () => !stopped && current === binding && binding.ready && !binding.closed
        const working = () => owns() && lease.isCurrent() && getMainWindow() === binding.window && clockValid() && owns() && lease.isCurrent()
        if (!working()) return reject()
        const requestId = deps.newRequestId()
        if (typeof requestId !== 'string' || !/^installed-catalog-read:[A-Za-z0-9_-]{1,96}$/.test(requestId)) return reject()
        const request = requestFor(requestId), digest = digestPolicyRequest(request)
        const allowed = () => {
          const at = deps.wallNow()
          if (!Number.isSafeInteger(at) || at < 0) return false
          const decision = deps.evaluatePolicy(request, at), constraints = decision?.constraints
          return decision?.effect === 'allow-with-constraints' && decision.policyVersion === 'management-installed-catalog-read/v1' && decision.requestDigest === digest && decision.evaluatedAt === at && !decision.approvalRequirement && decision.matchedRuleIds.length === 1 && decision.matchedRuleIds[0] === 'management-installed-catalog-read-exact' && !!constraints && Object.keys(constraints).length === 4 && constraints.readOnly === true && constraints.requireNoShell === true && constraints.maxTimeoutMs === 2000 && constraints.maxOutputChars === 131072
        }
        if (!allowed() || !working()) return reject()
        const userData = deps.getUserData()
        if (!rootIsValid(userData) || !working()) return reject()
        const fresh = () => owns() && getMainWindow() === binding.window && deps.getReadState() === 'ready' && deps.getUserData() === userData && allowed() && clockValid() && owns()
        registered = registerInstalledCatalogPublication(invocation, { complete: () => canPublish && completeManagementReadLease(lease, () => fresh() ? Object.freeze({ deadline, minimumTime: lastTime }) : false), cancel: close })
        if (!registered || !working()) return reject()
        const raw = await deps.readSnapshot({ userData, lease, now: deps.now })
        if (!working()) return reject()
        const snapshot = projectSnapshot(raw)
        if (!snapshot || !fresh() || !working()) return reject()
        canPublish = true
        return snapshot // Transfer terminal ownership to the registered unary capsule, not a service finally.
      } catch { return reject() }
    },
    dispose() { if (stopped) return; stopped = true; epoch++; const previous = current; current = undefined; retire(previous) }
  })
  return host
}
const mainHost = createInstalledCatalogReadHost()
export const installInstalledCatalogReadBinding: InstalledCatalogReadHost['install'] = (...args) => mainHost.install(...args)
export const createInstalledCatalogReadDelegate = (getMainWindow: () => ManagementReadWindow | null): InstalledCatalogReadDelegate =>
  (payload, invocation) => mainHost.read(payload, invocation, getMainWindow)
