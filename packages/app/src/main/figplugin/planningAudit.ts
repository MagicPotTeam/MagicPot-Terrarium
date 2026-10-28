import {
  figPluginPlanningAuditEventSchema,
  type FigPluginPlanningAuditEvent
} from '@shared/figplugin/planningAudit'
import { auditStoreKey, BoundedAuditStore } from './boundedAuditStore'

export {
  FIGPLUGIN_AUDIT_TTL_MS,
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  FIGPLUGIN_AUDIT_MAX_LINE_BYTES,
  type FigPluginPlanningAuditEvent
} from '@shared/figplugin/planningAudit'

const stores = new Map<string, FigPluginPlanningAuditStore>()

export class FigPluginPlanningAuditStore extends BoundedAuditStore<FigPluginPlanningAuditEvent> {
  constructor(root: string, now: () => number = Date.now) {
    super(root, 'planning-audit.jsonl', figPluginPlanningAuditEventSchema, now)
  }
}

export function getFigPluginPlanningAuditStore(root: string): FigPluginPlanningAuditStore {
  const key = auditStoreKey(root, 'planning-audit.jsonl')
  let store = stores.get(key)
  if (!store) {
    store = new FigPluginPlanningAuditStore(root)
    stores.set(key, store)
  }
  return store
}

export async function flushFigPluginPlanningAuditStores(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => store.flush()))
}
