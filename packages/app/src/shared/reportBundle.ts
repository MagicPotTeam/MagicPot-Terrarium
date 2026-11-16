export type ReportBundleRole = 'primary-report' | 'report-image' | 'report-ocr' | 'manifest'

export type ReportBundleManifestEntry = {
  role: ReportBundleRole
  fileName: string
  mimeType?: string
  refName?: string
  relativePath?: string
  sourceUrl?: string
  sizeBytes?: number
  imageCount?: number
}

export type ReportBundleManifest = {
  version: 1
  bundleId: string
  title: string
  createdAt: string
  primaryRefName?: string
  entries: ReportBundleManifestEntry[]
}

export const REPORT_BUNDLE_MANIFEST_VERSION = 1

/** Directory under the project/data root that holds canvas report bundles. */
export const REPORT_BUNDLES_ROOT_DIR_NAME = '.report_bundles'

/**
 * Bearer secret MAIN issues when it seals a report bundle (`rb1.` + 32 random bytes in
 * base64url). It must never enter prompt text, logs, diagnostics or error strings.
 */
export const REPORT_BUNDLE_BINDING_PATTERN = /^rb1\.[A-Za-z0-9_-]{43}$/

/** One-shot write-session ticket from svcReportBundles.beginBundle. */
export const REPORT_BUNDLE_TICKET_PATTERN = /^rbt1\.[A-Za-z0-9_-]{43}$/

/** At most this many distinct bindings are verified per request; more is refused. */
export const REPORT_BUNDLE_VERIFY_MAX_ITEMS = 64

/** Bound for manifest entries accepted by MAIN at registration. */
export const REPORT_BUNDLE_MAX_MANIFEST_ENTRIES = 200

export function isReportBundleBinding(value: unknown): value is string {
  return typeof value === 'string' && REPORT_BUNDLE_BINDING_PATTERN.test(value)
}

export function isReportBundleTicket(value: unknown): value is string {
  return typeof value === 'string' && REPORT_BUNDLE_TICKET_PATTERN.test(value)
}
