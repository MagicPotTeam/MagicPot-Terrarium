import { api } from '@renderer/utils/windowUtils'

/**
 * MAIN keeps a record and a manifest snapshot for every report bundle it bound to a
 * conversation. When the user deletes conversations or a project, those records follow
 * (best effort: a failure only leaves records that the age bound removes later). Bundle files
 * are never touched.
 */
export function purgeReportBundlesOfDeletedConversation(
  conversationId: string,
  storageScope: string
): void {
  if (!conversationId) return
  void Promise.resolve()
    .then(() =>
      api().svcReportBundles.purge({
        conversationIds: [conversationId],
        ...(storageScope ? { storageScope } : {})
      })
    )
    .catch(() => undefined)
}

/** A deleted project's panes all use storage scopes `<projectId>.<paneId>`. */
export function purgeReportBundlesOfDeletedProject(projectId: string): void {
  if (!projectId) return
  void Promise.resolve()
    .then(() => api().svcReportBundles.purge({ storageScopePrefix: `${projectId}.` }))
    .catch(() => undefined)
}
