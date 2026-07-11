import type { DesignInspectionItemSummary } from '@shared/designInspection'
import { summarizeDesignInspectionSelectionProvenance } from './designInspectionProvenancePresentation'

export type DesignInspectionSelectionProvenanceNarrative = {
  summarySuffix: string
  rationaleSuffix: string
  promptOverview: NonNullable<ReturnType<typeof summarizeDesignInspectionSelectionProvenance>>
}

export function buildDesignInspectionSelectionProvenanceNarrative(
  selectionItems: DesignInspectionItemSummary[]
): DesignInspectionSelectionProvenanceNarrative | null {
  const provenanceOverview = summarizeDesignInspectionSelectionProvenance(selectionItems, 2)
  if (!provenanceOverview) return null

  const kindSummary = provenanceOverview.kindLabels.join(', ')
  const detailSummary =
    provenanceOverview.detailLines.length > 0
      ? ` Key sources: ${provenanceOverview.detailLines.join('; ')}.`
      : ''

  return {
    summarySuffix: ` Source: ${kindSummary}.`,
    rationaleSuffix:
      ` Current source context: ${kindSummary}; ` +
      `MagicPot canvas elements and geometry remain the runtime inspection truth.${detailSummary}`,
    promptOverview: provenanceOverview
  }
}
