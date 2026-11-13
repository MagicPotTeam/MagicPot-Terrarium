/**
 * Report bundle metadata currently carries no main-issued proof that the
 * manifest and every child belong to the selected source and destination.
 * Until that binding exists, never expand or send a primary-report descriptor.
 * This checks a marker, not authority: removing or forging the marker is not an
 * authorization mechanism, and unmarked files remain governed by their own path.
 */
export const UNVERIFIED_REPORT_BUNDLE_MESSAGE =
  'Report bundles are temporarily unavailable because their source cannot be verified. Remove the report from your current draft where possible, or start a new empty conversation without it. A new conversation does not carry over previous context.'

type ReportAttachmentDescriptor = {
  readonly type: string
  readonly reportBundleRole?: string
}

type ReportMessageDescriptor = {
  readonly attachments?: readonly ReportAttachmentDescriptor[]
}

export function assertNoUnverifiedPrimaryReports(
  messages: readonly ReportMessageDescriptor[]
): void {
  if (messages.some((message) =>
    message.attachments?.some((attachment) =>
      attachment.type === 'file' && attachment.reportBundleRole === 'primary-report'
    )
  )) {
    throw new Error(UNVERIFIED_REPORT_BUNDLE_MESSAGE)
  }
}
