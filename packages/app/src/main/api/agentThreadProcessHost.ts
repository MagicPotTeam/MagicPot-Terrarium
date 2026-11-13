import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { AssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { CommandJobsToolHost, type CommandJobRecord, createProductionCommandJobsConfinementAdapter, type CommandJobsConfinementAdapter } from '../magicAgentPlatform2/toolHost'

export type ThreadProcessControl = {
  jobId: string
  status(): CommandJobRecord
  read(stream: 'stdout' | 'stderr', cursor: number, maxBytes: number): { data: string; nextCursor: number; eof: boolean; truncated: boolean }
  stop(): Promise<CommandJobRecord>
}
export function threadProcessControl(manager: CommandJobsToolHost, job: CommandJobRecord): ThreadProcessControl {
  const scope = { jobId: job.jobId, routeKey: job.routeKey, sessionId: job.sessionId }
  return { jobId: job.jobId, status: () => manager.status(scope), read: (stream, cursor, maxBytes) => manager.read({ ...scope, stream, cursor, maxBytes }), stop: () => manager.stop(scope) }
}

export const THREAD_PROCESS_RESOURCE_LIMITS = { metadata: { maxMemoryBytes: 512 * 1024 * 1024, maxCpuTimeMs: 60000 } }
const managers = new WeakMap<AssistantTerminalPolicyRuntime, Map<string, CommandJobsToolHost>>()
const locks = new Set<string>()
let activeOperations = 0
const key = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
export function ensureThreadProcessDirectory(root: string, relative: string): string {
  let current = root
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('Invalid process metadata directory.')
    current = path.join(current, part)
    if (existsSync(current)) {
      const info = lstatSync(current)
      if (!info.isDirectory() || info.isSymbolicLink() || key(realpathSync.native(current)) !== key(current)) throw new Error('Linked script metadata directories are not allowed.')
    } else mkdirSync(current)
  }
  return current
}
export function assertThreadProcessAvailable(runtime: AssistantTerminalPolicyRuntime, root: string): void {
  managers.get(runtime)?.get(key(root))?.assertNoUncertainStop()
}
/** Same manager for all approved Python/Notebook/shell work in a canonical root.
 * A second tool family must never bypass the shared process slots/quarantine.
 */
export function getThreadProcessHost(runtime: AssistantTerminalPolicyRuntime, root: string, confinement?: CommandJobsConfinementAdapter): CommandJobsToolHost {
  let roots = managers.get(runtime)
  if (!roots) { roots = new Map(); managers.set(runtime, roots) }
  let manager = roots.get(key(root))
  if (!manager) {
    if (roots.size >= 32) throw new Error('Too many process workspaces this application lifetime; restart before opening another.')
    ensureThreadProcessDirectory(root, '.magicpot/command-jobs/thread-script')
    manager = new CommandJobsToolHost(runtime.authorization, { workspaceRoot: root, namespace: 'thread-script', maxConcurrentJobs: 2, mandatoryResourceLimits: THREAD_PROCESS_RESOURCE_LIMITS.metadata, allowedEnvironmentKeys: ['PIP_NO_INDEX', 'PIP_DISABLE_PIP_VERSION_CHECK', 'PYTHONNOUSERSITE'], auditSink: runtime.eventStore, confinementAdapter: confinement ?? createProductionCommandJobsConfinementAdapter() })
    roots.set(key(root), manager)
  }
  manager.assertNoUncertainStop()
  manager.assertConfinement(THREAD_PROCESS_RESOURCE_LIMITS)
  return manager
}
export function acquireThreadProcessOperation(root: string, namespace: string): () => void {
  const lock = `${key(root)}\0${namespace}`
  if (locks.has(lock)) throw new Error('Another process mutation is active for this conversation.')
  if (activeOperations >= 4) throw new Error('Global process operation limit reached.')
  locks.add(lock); activeOperations++
  let released = false
  return () => { if (!released) { released = true; locks.delete(lock); activeOperations-- } }
}
