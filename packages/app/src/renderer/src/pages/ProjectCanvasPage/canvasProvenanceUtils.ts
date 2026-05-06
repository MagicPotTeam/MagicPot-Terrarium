import type { BridgeSourceContextSummary } from '@shared/api/bridgeSourceContext'

import type { CanvasItem, CanvasProvenanceSource } from './types'

type TimestampedOptions = {
  importedAt?: string
  notes?: string
}

type ExternalProvenanceOptions = TimestampedOptions &
  Partial<
    Pick<
      CanvasProvenanceSource,
      'sourceFileName' | 'sourceDocumentId' | 'sourceNodeId' | 'sourceNodeName' | 'bridgeTraceId'
    >
  >

const BRIDGE_SOURCE_ITEM_LABEL_LIMIT = 48

function resolveImportedAt(importedAt?: string): string {
  return importedAt ?? new Date().toISOString()
}

function mergeProvenanceNotes(...notes: Array<string | undefined>): string | undefined {
  const merged = notes.map((note) => note?.trim()).filter(Boolean)
  return merged.length > 0 ? merged.join(' | ') : undefined
}

function getComparableProvenanceKey(provenance: CanvasProvenanceSource): string {
  return JSON.stringify({
    kind: provenance.kind,
    sourceFileName: provenance.sourceFileName ?? null,
    sourceDocumentId: provenance.sourceDocumentId ?? null,
    sourceNodeId: provenance.sourceNodeId ?? null,
    sourceNodeName: provenance.sourceNodeName ?? null,
    bridgeTraceId: provenance.bridgeTraceId ?? null
  })
}

function truncateBridgeSourceLabel(value: string): string {
  if (value.length <= BRIDGE_SOURCE_ITEM_LABEL_LIMIT) return value
  return `${value.slice(0, BRIDGE_SOURCE_ITEM_LABEL_LIMIT)}...`
}

function formatBridgeProvenanceKind(kind: CanvasProvenanceSource['kind']): string {
  switch (kind) {
    case 'magicpot-native':
      return 'MagicPot native'
    case 'figma':
      return 'Figma'
    case 'psd':
      return 'PSD'
    case 'psb':
      return 'PSB'
    case 'svg':
      return 'SVG'
    case 'imported-file':
      return 'Imported file'
    case 'external':
      return 'External entry'
    default:
      return kind
  }
}

function getBridgeSourceTarget(provenance: CanvasProvenanceSource): string | null {
  return (
    provenance.sourceNodeName?.trim() ||
    provenance.sourceFileName?.trim() ||
    provenance.sourceDocumentId?.trim() ||
    provenance.sourceNodeId?.trim() ||
    provenance.bridgeTraceId?.trim() ||
    null
  )
}

function getBridgeSourceItemLabel(
  item: Pick<CanvasItem, 'id' | 'type'> & {
    fileName?: string
    text?: string
    label?: string
  }
): string {
  const rawLabel =
    item.fileName?.trim() || item.text?.trim() || item.label?.trim() || `${item.type} ${item.id}`

  return truncateBridgeSourceLabel(rawLabel)
}

export function createMagicPotNativeProvenance(
  options: TimestampedOptions = {}
): CanvasProvenanceSource {
  return {
    kind: 'magicpot-native',
    importedAt: resolveImportedAt(options.importedAt),
    ...(options.notes ? { notes: options.notes } : {})
  }
}

export function createImportedFileProvenance(
  sourceFileName: string,
  options: TimestampedOptions = {}
): CanvasProvenanceSource {
  return {
    kind: 'imported-file',
    sourceFileName,
    importedAt: resolveImportedAt(options.importedAt),
    ...(options.notes ? { notes: options.notes } : {})
  }
}

export function createExternalCanvasProvenance(
  options: ExternalProvenanceOptions = {}
): CanvasProvenanceSource {
  return {
    kind: 'external',
    importedAt: resolveImportedAt(options.importedAt),
    ...(options.sourceFileName ? { sourceFileName: options.sourceFileName } : {}),
    ...(options.sourceDocumentId ? { sourceDocumentId: options.sourceDocumentId } : {}),
    ...(options.sourceNodeId ? { sourceNodeId: options.sourceNodeId } : {}),
    ...(options.sourceNodeName ? { sourceNodeName: options.sourceNodeName } : {}),
    ...(options.bridgeTraceId ? { bridgeTraceId: options.bridgeTraceId } : {}),
    ...(options.notes ? { notes: options.notes } : {})
  }
}

export function summarizeCanvasItemProvenanceForBridge(
  items: Array<
    Pick<CanvasItem, 'id' | 'type' | 'provenance'> & {
      fileName?: string
      text?: string
      label?: string
    }
  >,
  maxDetailLines = 3
): BridgeSourceContextSummary | undefined {
  const itemsWithProvenance = items.filter(
    (
      item
    ): item is Pick<CanvasItem, 'id' | 'type'> & {
      provenance: CanvasProvenanceSource
      fileName?: string
      text?: string
      label?: string
    } => Boolean(item.provenance)
  )

  if (itemsWithProvenance.length === 0) return undefined

  const kindCounts = new Map<string, number>()
  const detailLines = itemsWithProvenance.map((item) => {
    const kindLabel = formatBridgeProvenanceKind(item.provenance.kind)
    kindCounts.set(kindLabel, (kindCounts.get(kindLabel) || 0) + 1)

    const itemLabel = getBridgeSourceItemLabel(item)
    const sourceTarget = getBridgeSourceTarget(item.provenance)
    return sourceTarget
      ? `${itemLabel} -> ${kindLabel} / ${truncateBridgeSourceLabel(sourceTarget)}`
      : `${itemLabel} -> ${kindLabel}`
  })

  return {
    kindLabels: [...kindCounts.entries()].map(([label, count]) => `${label} ${count}`),
    detailLines: detailLines.slice(0, maxDetailLines),
    totalItemCount: itemsWithProvenance.length,
    hiddenDetailCount: Math.max(0, detailLines.length - maxDetailLines)
  }
}

export const summarizeCanvasItemProvenanceForAdobeBridge = summarizeCanvasItemProvenanceForBridge

export const summarizeCanvasItemProvenanceForDccBridge = summarizeCanvasItemProvenanceForBridge

export function deriveCanvasGroupProvenance(
  items: Array<Pick<CanvasItem, 'provenance'>>,
  options: { importedAt?: string; groupName?: string } = {}
): CanvasProvenanceSource {
  const provenanceItems = items
    .map((item) => item.provenance)
    .filter((provenance): provenance is CanvasProvenanceSource => Boolean(provenance))

  const groupNote = options.groupName
    ? `Grouped in MagicPot as ${options.groupName}`
    : 'Grouped in MagicPot'

  if (provenanceItems.length === items.length && provenanceItems.length > 0) {
    const reference = provenanceItems[0]
    const referenceKey = getComparableProvenanceKey(reference)
    const hasSharedUpstreamSource =
      reference.kind !== 'magicpot-native' &&
      provenanceItems.every((provenance) => getComparableProvenanceKey(provenance) === referenceKey)

    if (hasSharedUpstreamSource) {
      return {
        kind: reference.kind,
        ...(reference.sourceFileName ? { sourceFileName: reference.sourceFileName } : {}),
        ...(reference.sourceDocumentId ? { sourceDocumentId: reference.sourceDocumentId } : {}),
        ...(reference.sourceNodeId ? { sourceNodeId: reference.sourceNodeId } : {}),
        ...(reference.sourceNodeName ? { sourceNodeName: reference.sourceNodeName } : {}),
        ...(reference.bridgeTraceId ? { bridgeTraceId: reference.bridgeTraceId } : {}),
        importedAt: resolveImportedAt(options.importedAt),
        ...(mergeProvenanceNotes(reference.notes, groupNote)
          ? { notes: mergeProvenanceNotes(reference.notes, groupNote) }
          : {})
      }
    }
  }

  return createMagicPotNativeProvenance({
    importedAt: options.importedAt,
    notes: groupNote
  })
}
