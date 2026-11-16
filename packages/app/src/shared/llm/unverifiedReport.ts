import { isReportBundleBinding } from '../reportBundle'

/**
 * Shape pre-filter for primary-report descriptors, not an authority.
 *
 * Only report bundles that MAIN registered when they were written are honoured (a binding
 * issued by svcReportBundles). This synchronous check refuses, without any I/O, every
 * primary-report file that carries no well-formed binding: legacy descriptors from stored
 * conversations, imports, drags or model replies. A descriptor that passes it is still
 * unverified: the request path asks MAIN to verify the binding against the conversation and
 * the registered files before any manifest is read, and the MAIN chat boundary checks the
 * binding again against the primary's bytes. Removing or forging the role is not an
 * authorization mechanism either: unmarked files remain governed by their own path.
 */
export const UNVERIFIED_REPORT_BUNDLE_MESSAGE =
  'Report bundles are temporarily unavailable because their source cannot be verified. Remove the report from your current draft where possible, or start a new empty conversation without it. A new conversation does not carry over previous context.'

type ReportAttachmentDescriptor = {
  readonly type: string
  readonly reportBundleRole?: string
  readonly reportBundleBinding?: string
}

type ReportMessageDescriptor = {
  readonly attachments?: readonly ReportAttachmentDescriptor[]
}

/** True for an attachment that the request path expands as a primary report bundle. */
export function isPrimaryReportFileDescriptor(attachment: ReportAttachmentDescriptor): boolean {
  return attachment.type === 'file' && attachment.reportBundleRole === 'primary-report'
}

/**
 * Shape test only: the primary report carries a binding of the form MAIN issues. Says nothing
 * about whether MAIN registered it, for this conversation, or for these files.
 */
export function hasWellFormedReportBundleBinding(attachment: ReportAttachmentDescriptor): boolean {
  return isReportBundleBinding(attachment.reportBundleBinding)
}

export function assertNoUnverifiedPrimaryReports(
  messages: readonly ReportMessageDescriptor[]
): void {
  if (
    messages.some((message) =>
      message.attachments?.some(
        (attachment) =>
          isPrimaryReportFileDescriptor(attachment) && !hasWellFormedReportBundleBinding(attachment)
      )
    )
  ) {
    throw new Error(UNVERIFIED_REPORT_BUNDLE_MESSAGE)
  }
}
