import type { QAppCfg, QAppCfgAuto, QAppCfgInput } from '@shared/qApp/cfgTypes'
import type { QAppMenuItem, QAppSvc } from '@shared/api/svcQApp'

import { CANVAS_TARGET_CANVAS_ACTIONS } from './canvasTargetCanvasActionCatalog'
import { normalizeNonEmptyString } from './canvasTargetCapabilityNormalizeUtils'
import type {
  CanvasTargetCapabilityCatalog,
  CanvasTargetQAppCapability,
  CanvasTargetQAppInputCapability
} from './canvasTargetCapabilityTypes'

const hasSlot = (value: QAppCfgInput): value is QAppCfgInput & { slot: string } =>
  'slot' in value && typeof value.slot === 'string' && value.slot.trim().length > 0

const summarizeQAppInputs = (cfg?: QAppCfg): CanvasTargetQAppInputCapability[] => {
  if (!cfg) return []
  return cfg.inputs
    .filter((input): input is QAppCfgInput => {
      return input.component !== 'Section' && input.component !== 'Description'
    })
    .map((input) => ({
      label: input.label,
      component: input.component,
      ...(hasSlot(input) ? { slot: input.slot } : {})
    }))
}

const summarizeQAppAutoInputs = (cfg?: QAppCfg): CanvasTargetQAppCapability['autoInputs'] => {
  return (cfg?.autoInputs || []).map((input) => ({
    label: input.label,
    component: input.component
  }))
}

const formatQAppCategory = (category: unknown): string | undefined => {
  if (typeof category === 'string') return category
  if (category && typeof category === 'object') {
    const record = category as Record<string, unknown>
    return normalizeNonEmptyString(record.name) || normalizeNonEmptyString(record.label)
  }
  return undefined
}

function flattenQAppMenuItems(
  items: QAppMenuItem[],
  path: string[] = []
): Array<{ item: QAppMenuItem; path: string[] }> {
  const result: Array<{ item: QAppMenuItem; path: string[] }> = []

  for (const item of items || []) {
    if (!item || item.isHidden) continue
    const nextPath = [...path, item.name || item.key]
    if (item.isDirectory) {
      result.push(...flattenQAppMenuItems(item.children || [], nextPath))
      continue
    }
    if (item.key?.trim()) {
      result.push({ item, path: nextPath })
    }
  }

  return result
}

export async function loadCanvasTargetCapabilityCatalog(
  qAppSvc: Pick<QAppSvc, 'listQAppCfgs' | 'getQAppCfg'> | undefined,
  options?: {
    maxQuickAppDetails?: number
  }
): Promise<CanvasTargetCapabilityCatalog> {
  const maxQuickAppDetails = options?.maxQuickAppDetails ?? 120

  if (!qAppSvc) {
    return {
      quickApps: [],
      canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
    }
  }

  const listResponse = await qAppSvc.listQAppCfgs({})
  const visibleQApps = flattenQAppMenuItems(listResponse.qApps || [])

  const quickApps = await Promise.all(
    visibleQApps.map(async ({ item, path }, index): Promise<CanvasTargetQAppCapability> => {
      if (index >= maxQuickAppDetails) {
        return {
          key: item.key,
          name: item.name || item.key,
          path,
          category: formatQAppCategory(item.category),
          inputs: [],
          autoInputs: [],
          detailUnavailable: true
        }
      }

      try {
        const detail = await qAppSvc.getQAppCfg({ key: item.key })
        return {
          key: item.key,
          name: item.name || item.key,
          path,
          category: formatQAppCategory(item.category),
          inputs: summarizeQAppInputs(detail.cfg),
          autoInputs: summarizeQAppAutoInputs(detail.cfg),
          outputNodeIds: detail.cfg.outputNodeIds
        }
      } catch {
        return {
          key: item.key,
          name: item.name || item.key,
          path,
          category: formatQAppCategory(item.category),
          inputs: [],
          autoInputs: [],
          detailUnavailable: true
        }
      }
    })
  )

  return {
    quickApps,
    canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
  }
}
