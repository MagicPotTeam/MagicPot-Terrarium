import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isProxy } from 'node:util/types'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getIpcInvocationOrigin } from '@shared/api/createServer/ipcInvocationOrigin'
import { cancelStartupStoragePublication, registerStartupStoragePublication } from '@shared/api/createServer/startupStoragePublication'
import { parseStartupStorageMetadataRequest, parseStartupStorageMetadataResponse, startupStorageMetadataUnavailable as unavailable, type StartupStorageMetadataResponse } from '@shared/api/startupStorageMetadata'
import { canonicalPolicyJson, POLICY_REQUEST_DISCRIMINATOR, POLICY_REQUEST_VERSION, type PolicyDecision, type PolicyJsonValue } from '@shared/magicAgentPlatform2/policy'
import { getConfig, onConfigCommitted } from '../config/config'
import { startupStorageSnapshot, type StartupStorageCapture } from '../config/startupStorageSnapshot'
import { isMagicAgentPlatformEnabled } from '../magicAgentRuntime/featureFlag'
import { evaluateStartupStorageReadPolicy } from './startupStorageReadPolicy'
import { completeStartupStorageReadLease, createStartupStorageReadAdmission, STARTUP_STORAGE_READ_METHOD, type StartupStorageReadAdmission, type StartupStorageReadState, type StartupStorageReadWindow } from './startupStorageReadAdmission'

export type StartupStorageReadHostDeps = {
  getReadState(): StartupStorageReadState
  onConfigCommitted(listener: () => void): () => void
  capture(): StartupStorageCapture | null
  evaluatePolicy(request: unknown, evaluatedAt: number): PolicyDecision | null
  newRequestId(): string
  now(): number
  wallNow(): number
}
export type StartupStorageReadDelegate = (payload: unknown, invocation?: ServiceInvocationContext) => Promise<StartupStorageMetadataResponse>
export type StartupStorageReadHost = Readonly<{
  install(window: StartupStorageReadWindow, trustedRendererUrl: string, getMainWindow: () => StartupStorageReadWindow | null): () => void
  read(payload: unknown, invocation: ServiceInvocationContext | undefined, getMainWindow: () => StartupStorageReadWindow | null): Promise<StartupStorageMetadataResponse>
  dispose(): void
}>
const defaults: StartupStorageReadHostDeps = {
  getReadState: () => { try { getConfig(); return isMagicAgentPlatformEnabled() ? 'ready' : 'disabled' } catch { return 'unavailable' } },
  onConfigCommitted, capture: () => startupStorageSnapshot.capture(), evaluatePolicy: evaluateStartupStorageReadPolicy,
  newRequestId: () => 'startup-storage-read:' + randomUUID(), now: () => performance.now(), wallNow: Date.now
}
const requestFor = (requestId: string) => Object.freeze({
  discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION, requestId,
  actor: Object.freeze({ kind: 'service', id: 'main-management-startup-storage-reader' }), origin: 'renderer',
  action: 'management.startup-storage-metadata.read', transport: 'electron-ipc',
  target: Object.freeze({ kind: 'startup-storage-metadata', id: 'main-startup-storage-snapshot' }), input: Object.freeze({}), effects: Object.freeze([])
})
function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
  const own = Reflect.ownKeys(value), result: Record<string, unknown> = {}
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !('value' in descriptor)) return null; result[key] = descriptor.value }
  return result
}
const invalid = Symbol('invalid-startup-storage-decision')
/** Bounded own-data clone BEFORE generic canonical JSON code; nested proxies/accessors never run. */
function decisionData(input: unknown): PolicyJsonValue | typeof invalid {
  let nodes = 0
  const ancestors = new WeakSet<object>()
  const visit = (value: unknown, depth: number): PolicyJsonValue | typeof invalid => {
    if (++nodes > 128 || depth > 6) return invalid
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'string') return value.length <= 1024 ? value : invalid
    if (typeof value === 'number') return Number.isFinite(value) ? value : invalid
    if (!value || typeof value !== 'object' || isProxy(value) || ancestors.has(value)) return invalid
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid
    if (keys.length > 16 || keys.some(key => typeof key !== 'string' || key.length > 64 || ['__proto__', 'prototype', 'constructor'].includes(key))) return invalid
    ancestors.add(value)
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 || keys.length !== length + 1) return invalid
      const result: PolicyJsonValue[] = []
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) return invalid
        const item = visit(descriptor.value, depth + 1); if (item === invalid) return invalid; result.push(item)
      }
      ancestors.delete(value); return result
    }
    const result: Record<string, PolicyJsonValue> = {}
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return invalid
      const item = visit(descriptor.value, depth + 1); if (item === invalid) return invalid; result[key] = item
    }
    ancestors.delete(value); return result
  }
  try { return visit(input, 0) } catch { return invalid }
}
type Binding = {
  window: StartupStorageReadWindow
  sender: StartupStorageReadWindow['webContents']
  getMainWindow: () => StartupStorageReadWindow | null
  now(): number
  admission?: StartupStorageReadAdmission
  ready: boolean
  closed: boolean
  removeClosed?: () => void
}
/** MAIN-only host: construction/install do not read config, paths, stores or the startup cache. */
export function createStartupStorageReadHost(deps: StartupStorageReadHostDeps = defaults): StartupStorageReadHost {
  const bindings = new Map<StartupStorageReadWindow, Binding>(), generations = new WeakMap<StartupStorageReadWindow, number>(), installing = new WeakMap<StartupStorageReadWindow, number>()
  let stopped = false
  const retire = (binding: Binding | undefined): void => {
    if (!binding || binding.closed) return
    binding.closed = true; binding.ready = false
    if (bindings.get(binding.window) === binding) bindings.delete(binding.window)
    try { binding.removeClosed?.() } catch { /* Revoke before any teardown callback. */ }
    binding.admission?.dispose()
  }
  const host: StartupStorageReadHost = Object.freeze({
    install(window, trustedRendererUrl, getMainWindow) {
      if (stopped) return () => {}
      const generation = (generations.get(window) ?? 0) + 1, previous = bindings.get(window)
      generations.set(window, generation); installing.set(window, generation)
      let floor = 0, brokenClock = false
      const now = (): number => {
        const time = deps.now()
        if (brokenClock || !Number.isFinite(time) || time < 0 || time < floor) { brokenClock = true; return NaN }
        floor = time; return time
      }
      let binding: Binding | undefined
      const settingUp = (): boolean => !stopped && generations.get(window) === generation && installing.get(window) === generation
      try {
        binding = { window, sender: window.webContents, getMainWindow, now, ready: false, closed: false }
        // Keep old navigation observers active through the complete replacement admission setup.
        binding.admission = createStartupStorageReadAdmission({ window, trustedRendererUrl, getMainWindow, getReadState: deps.getReadState, onConfigCommitted: deps.onConfigCommitted, now, timeoutMs: 2000 })
        if (!settingUp()) { retire(binding); return () => retire(binding) }
        retire(previous)
        if (!settingUp()) { retire(binding); return () => retire(binding) }
        bindings.set(window, binding)
        const installed = binding, closed = () => retire(installed)
        installed.removeClosed = () => window.removeListener('closed', closed)
        window.on('closed', closed)
        if (!settingUp() || installed.closed || bindings.get(window) !== installed) {
          // newListener reentry may remove before on() actually inserts this exact listener.
          installed.removeClosed(); retire(installed); return () => retire(installed)
        }
        installed.ready = true
      } catch { retire(binding); if (settingUp()) retire(previous) }
      finally { if (installing.get(window) === generation) installing.delete(window) }
      return () => retire(binding)
    },
    async read(payload, invocation, getMainWindow) {
      let binding: Binding | undefined
      try {
        if (stopped || !invocation || invocation.methodName !== STARTUP_STORAGE_READ_METHOD) return unavailable
        const origin = getIpcInvocationOrigin(invocation)
        if (!origin) return unavailable
        if (payload && (typeof payload === 'object' || typeof payload === 'function') && isProxy(payload)) return unavailable
        parseStartupStorageMetadataRequest(payload)
        binding = [...bindings.values()].find(item => item.getMainWindow === getMainWindow && item.sender === origin.sender)
        if (!binding?.admission) return unavailable
        const installed = binding, admission = binding.admission
        const owns = (): boolean => !stopped && installed.ready && !installed.closed && bindings.get(installed.window) === installed && !installing.has(installed.window)
        if (!owns() || getMainWindow() !== installed.window || deps.getReadState() !== 'ready' || !owns()) return unavailable
        // Earlier than admission's start: the host may tighten but never extend its deadline.
        let lastTime = installed.now()
        const deadline = lastTime + 2000
        if (!Number.isFinite(lastTime) || lastTime < 0 || !Number.isFinite(deadline) || deadline <= lastTime || !owns()) return unavailable
        const lease = admission.begin(payload, invocation)
        if (!lease) return unavailable
        let registered = false, cancelled = false, canPublish = false
        const close = (): void => { if (cancelled) return; cancelled = true; canPublish = false; lease.close() }
        const reject = (): typeof unavailable => { if (registered) cancelStartupStoragePublication(invocation); else close(); return unavailable }
        try {
          const clockValid = (): boolean => { const at = installed.now(); const valid = Number.isFinite(at) && at >= lastTime && at < deadline; lastTime = at; return valid }
          const working = (): boolean => !cancelled && owns() && lease.isCurrent() && getMainWindow() === installed.window && clockValid() && owns() && lease.isCurrent()
          if (!working()) return reject()
          const requestId = deps.newRequestId()
          if (typeof requestId !== 'string' || !/^startup-storage-read:[A-Za-z0-9_-]{1,96}$/.test(requestId)) return reject()
          const request = requestFor(requestId)
          const allowed = (): boolean => {
            const at = deps.wallNow()
            if (!Number.isSafeInteger(at) || at < 0) return false
            const expected = evaluateStartupStorageReadPolicy(request, at), decision = decisionData(deps.evaluatePolicy(request, at))
            return !!expected && expected.effect === 'allow-with-constraints' && decision !== invalid && canonicalPolicyJson(decision) === canonicalPolicyJson(expected as unknown as PolicyJsonValue)
          }
          if (!allowed() || !working()) return reject()
          const captured = deps.capture(), capture = ownData(captured, ['snapshot', 'isCurrent'])
          if (!capture || !Object.isFrozen(captured) || typeof capture.isCurrent !== 'function' || isProxy(capture.isCurrent)) return reject()
          const metadata = ownData(capture.snapshot, ['source', 'legacyLayout'])
          if (!metadata || !Object.isFrozen(capture.snapshot)) return reject()
          const snapshot = parseStartupStorageMetadataResponse({ status: 'available', source: metadata.source, legacyLayout: metadata.legacyLayout })
          if (snapshot.status !== 'available' || JSON.stringify(snapshot).length > 256 || !working()) return reject()
          const captureIsCurrent = capture.isCurrent as () => boolean
          if (captureIsCurrent() !== true || !working()) return reject()
          registered = registerStartupStoragePublication(invocation, {
            complete: () => canPublish && !cancelled && completeStartupStorageReadLease(lease, () => {
              // Admission already revoked the work lease/timer/abort BEFORE these callbacks.
              if (!owns() || getMainWindow() !== installed.window || deps.getReadState() !== 'ready' || !allowed() || !clockValid() || !owns()) return false
              return Object.freeze({ deadline, minimumTime: lastTime, storageCapture: captured! })
            }), cancel: close
          })
          if (!registered || !working()) return reject()
          canPublish = true
          return snapshot // The last transport transform, not this async return, consumes publication.
        } catch { return reject() }
      } catch { return unavailable }
    },
    dispose() { if (stopped) return; stopped = true; for (const binding of [...bindings.values()]) retire(binding) }
  })
  return host
}
const mainHost = createStartupStorageReadHost()
export const installStartupStorageReadBinding: StartupStorageReadHost['install'] = (...args) => mainHost.install(...args)
export const createStartupStorageReadDelegate = (getMainWindow: () => StartupStorageReadWindow | null): StartupStorageReadDelegate =>
  (payload, invocation) => mainHost.read(payload, invocation, getMainWindow)
