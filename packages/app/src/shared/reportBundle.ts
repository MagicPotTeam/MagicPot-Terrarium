export type ReportBundleRole = 'primary-report' | 'report-image' | 'report-ocr' | 'manifest'

export type ReportBundleManifestEntry = {
  role: ReportBundleRole
  fileName: string
  mimeType?: string
  refName?: string
  relativePath?: string
  sourceUrl?: string
  sizeBytes?: number
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
