import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit'
import { ResultItem } from '@shared/qApp/resultTypes'
import { appendResults, clearResults, deleteResult, ComfyStatusState } from './slices/comfyStatus'

type StateWithComfyStatus = { comfyStatus: ComfyStatusState }

export const createComfyResultAutoSaveClaimManager = () => {
  const claimedResultIds = new Set<string>()

  return {
    claim(resultId: string): boolean {
      if (claimedResultIds.has(resultId)) return false
      claimedResultIds.add(resultId)
      return true
    },
    release(resultId: string): void {
      claimedResultIds.delete(resultId)
    },
    sync(results: ResultItem[]): void {
      const retainedResultIds = new Set(results.map((result) => result.id))
      claimedResultIds.forEach((resultId) => {
        if (!retainedResultIds.has(resultId)) claimedResultIds.delete(resultId)
      })
    },
    teardown(): void {
      claimedResultIds.clear()
    },
    get size(): number {
      return claimedResultIds.size
    }
  }
}

const getBlobUrls = (results: ResultItem[]): Set<string> =>
  new Set(
    results.flatMap((result) =>
      'objectUrl' in result && result.objectUrl.startsWith('blob:') ? [result.objectUrl] : []
    )
  )

export const createComfyResultResourceManager = (
  revokeObjectURL: (url: string) => void = URL.revokeObjectURL.bind(URL)
) => {
  const activeUrls = new Set<string>()

  const revoke = (url: string) => {
    if (!activeUrls.delete(url)) return
    revokeObjectURL(url)
  }

  return {
    sync(previousResults: ResultItem[], currentResults: ResultItem[]) {
      const previousUrls = getBlobUrls(previousResults)
      const currentUrls = getBlobUrls(currentResults)

      currentUrls.forEach((url) => activeUrls.add(url))
      previousUrls.forEach((url) => {
        if (!currentUrls.has(url)) revoke(url)
      })
    },
    teardown() {
      Array.from(activeUrls).forEach(revoke)
      activeUrls.clear()
    }
  }
}

export const comfyResultListenerMiddleware = createListenerMiddleware()
export const comfyResultResourceManager = createComfyResultResourceManager()
export const comfyResultAutoSaveClaims = createComfyResultAutoSaveClaimManager()

comfyResultListenerMiddleware.startListening({
  matcher: isAnyOf(appendResults, deleteResult, clearResults),
  effect: (_action, listenerApi) => {
    const previousState = listenerApi.getOriginalState() as StateWithComfyStatus
    const currentState = listenerApi.getState() as StateWithComfyStatus
    comfyResultResourceManager.sync(
      previousState.comfyStatus.results,
      currentState.comfyStatus.results
    )
    comfyResultAutoSaveClaims.sync(currentState.comfyStatus.results)
  }
})

export const teardownComfyResultResources = () => {
  comfyResultResourceManager.teardown()
  comfyResultAutoSaveClaims.teardown()
}
