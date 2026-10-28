import {
  figPluginExecutionAuditEventSchema,
  type FigPluginExecutionAuditEvent
} from '@shared/figplugin/executionAudit'
import { auditStoreKey, BoundedAuditStore } from './boundedAuditStore'

export {
  FIGPLUGIN_AUDIT_TTL_MS,
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  FIGPLUGIN_AUDIT_MAX_LINE_BYTES,
  type FigPluginExecutionAuditEvent
} from '@shared/figplugin/executionAudit'

const stores = new Map<string, FigPluginExecutionAuditStore>()

/** Fixed execution history; shared storage never recreates sessions, grants or plans. */
export class FigPluginExecutionAuditStore extends BoundedAuditStore<FigPluginExecutionAuditEvent> {
  constructor(root: string, now: () => number = Date.now) {
    super(root, 'execution-audit.jsonl', figPluginExecutionAuditEventSchema, now)
  }
}

export function getFigPluginExecutionAuditStore(root: string): FigPluginExecutionAuditStore {
  const key = auditStoreKey(root, 'execution-audit.jsonl')
  let store = stores.get(key)
  if (!store) {
    store = new FigPluginExecutionAuditStore(root)
    stores.set(key, store)
  }
  return store
}

export async function flushFigPluginExecutionAuditStores(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => store.flush()))
}
