import { validateImportManagedMediaResp } from '@shared/api/svcManagedMedia'
import {
  figPluginManagedAssetReferenceSchema,
  type FigPluginManagedAssetReference
} from '@shared/figplugin/managedSessionAsset'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import type { ResultItem, ResultItemImage } from '@shared/qApp/resultTypes'

export type ManagedOutputChoice = {
  result: ResultItemImage
  reference: FigPluginManagedAssetReference
  localMediaUrl: string
  identity: string
}

export type ManagedOutputSelection = {
  reference: FigPluginManagedAssetReference
  isCurrent: () => boolean
}

/** The results list is a UI scope, not proof of project/task ownership in main. */
export function managedOutputChoices(
  results: ResultItem[],
  projectId: string
): ManagedOutputChoice[] {
  const counts = new Map<string, number>()
  for (const result of results) counts.set(result.id, (counts.get(result.id) ?? 0) + 1)
  return results.flatMap((result) => {
    if (
      result.type !== 'image' ||
      result.projectId !== projectId ||
      counts.get(result.id) !== 1 ||
      !result.media
    )
      return []
    try {
      const imported = validateImportManagedMediaResp({
        reference: result.media,
        localMediaUrl: result.objectUrl
      })
      if (imported.reference.status !== undefined && imported.reference.status !== 'ready')
        return []
      const { version, kind, relativePath, sha256, sizeBytes, mimeType, originalFileName } =
        result.media
      const reference = figPluginManagedAssetReferenceSchema.parse({
        version,
        kind,
        relativePath,
        sha256,
        sizeBytes,
        mimeType,
        originalFileName
      })
      return [
        {
          result,
          reference,
          localMediaUrl: imported.localMediaUrl,
          identity: canonicalFigPluginJson({
            id: result.id,
            task: result.promptId,
            project: result.projectId,
            media: imported.reference,
            url: imported.localMediaUrl
          })
        }
      ]
    } catch {
      return []
    }
  })
}
