import type { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceValidationError } from './apiUtils/serviceValidation'
import {
  REPORT_BUNDLE_MAX_MANIFEST_ENTRIES,
  REPORT_BUNDLE_VERIFY_MAX_ITEMS,
  isReportBundleBinding,
  isReportBundleTicket
} from '../reportBundle'

/**
 * MAIN-owned registry of canvas report bundles.
 *
 * beginBundle opens a one-shot write session for one directory under
 * `<root>/.report_bundles`; the producer then writes the bundle and calls register with the
 * ticket, which seals it and returns a binding. verify later checks that a bound primary report
 * still belongs to the conversation and that its files are unchanged. No file content crosses
 * IPC. Threat model: protects against report descriptors that arrive as data (stored
 * conversations, imports, drags, model or tool replies), not against a compromised renderer.
 */
export type ReportBundleConversation = {
  conversationId: string
  storageScope?: string
}

export type BeginReportBundleReq = {
  bundleDir: string
  conversation: ReportBundleConversation
}
export type BeginReportBundleResp = { ticket: string }

export type RegisterReportBundleReq = { ticket: string }
export type RegisterReportBundleResp = {
  binding: string
  bundleId: string
  imageCount: number
  /** Manifest entries MAIN did not honour (for example images known only by a source URL). */
  omittedEntries: number
}

export type VerifyReportBundleItem = { binding: string; primaryUrl: string }
export type VerifyReportBundlesReq = {
  conversation: ReportBundleConversation
  items: VerifyReportBundleItem[]
}
export type VerifyReportBundleStatus = 'verified' | 'refused'
export type VerifyReportBundleResult = {
  binding: string
  status: VerifyReportBundleStatus
  /** MAIN's own snapshot manifest (local-media URL under userData); only when verified. */
  manifestUrl?: string
  imageCount?: number
}
export type VerifyReportBundlesResp = { results: VerifyReportBundleResult[] }

export type ReportBundlesSvc = {
  beginBundle(req: BeginReportBundleReq): Promise<BeginReportBundleResp>
  register(req: RegisterReportBundleReq): Promise<RegisterReportBundleResp>
  verify(req: VerifyReportBundlesReq): Promise<VerifyReportBundlesResp>
}

export const REPORT_BUNDLE_MAX_PATH_CHARS = 4096
export const REPORT_BUNDLE_MAX_URL_CHARS = 16384
export const REPORT_BUNDLE_MAX_CONVERSATION_ID_CHARS = 256
export const REPORT_BUNDLE_MAX_STORAGE_SCOPE_CHARS = 512
export const REPORT_BUNDLE_MAX_BUNDLE_ID_CHARS = 255

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hasAllowedKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean => {
  const keys = Object.keys(value)
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const isBoundedText = (value: unknown, maxChars: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxChars &&
  value.trim() === value &&
  !CONTROL_CHARACTERS.test(value)
const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

function validateConversation(value: unknown, label: string): ReportBundleConversation {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ['conversationId'], ['storageScope']) ||
    !isBoundedText(value.conversationId, REPORT_BUNDLE_MAX_CONVERSATION_ID_CHARS) ||
    (value.storageScope !== undefined &&
      !isBoundedText(value.storageScope, REPORT_BUNDLE_MAX_STORAGE_SCOPE_CHARS))
  ) {
    throw new ServiceValidationError(label)
  }
  return {
    conversationId: value.conversationId,
    ...(value.storageScope !== undefined ? { storageScope: value.storageScope as string } : {})
  }
}

export function validateBeginReportBundleReq(value: unknown): BeginReportBundleReq {
  const label = 'svcReportBundles.beginBundle request'
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ['bundleDir', 'conversation']) ||
    !isBoundedText(value.bundleDir, REPORT_BUNDLE_MAX_PATH_CHARS)
  ) {
    throw new ServiceValidationError(label)
  }
  return {
    bundleDir: value.bundleDir,
    conversation: validateConversation(value.conversation, label)
  }
}

export function validateBeginReportBundleResp(value: unknown): BeginReportBundleResp {
  if (!isRecord(value) || !hasAllowedKeys(value, ['ticket']) || !isReportBundleTicket(value.ticket))
    throw new ServiceValidationError('svcReportBundles.beginBundle response')
  return { ticket: value.ticket }
}

export function validateRegisterReportBundleReq(value: unknown): RegisterReportBundleReq {
  if (!isRecord(value) || !hasAllowedKeys(value, ['ticket']) || !isReportBundleTicket(value.ticket))
    throw new ServiceValidationError('svcReportBundles.register request')
  return { ticket: value.ticket }
}

export function validateRegisterReportBundleResp(value: unknown): RegisterReportBundleResp {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ['binding', 'bundleId', 'imageCount', 'omittedEntries']) ||
    !isReportBundleBinding(value.binding) ||
    !isBoundedText(value.bundleId, REPORT_BUNDLE_MAX_BUNDLE_ID_CHARS) ||
    !isCount(value.imageCount, REPORT_BUNDLE_MAX_MANIFEST_ENTRIES) ||
    !isCount(value.omittedEntries, REPORT_BUNDLE_MAX_MANIFEST_ENTRIES)
  ) {
    throw new ServiceValidationError('svcReportBundles.register response')
  }
  return {
    binding: value.binding,
    bundleId: value.bundleId,
    imageCount: value.imageCount,
    omittedEntries: value.omittedEntries
  }
}

export function validateVerifyReportBundlesReq(value: unknown): VerifyReportBundlesReq {
  const label = 'svcReportBundles.verify request'
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ['conversation', 'items']) ||
    !Array.isArray(value.items) ||
    value.items.length > REPORT_BUNDLE_VERIFY_MAX_ITEMS
  ) {
    throw new ServiceValidationError(label)
  }
  const conversation = validateConversation(value.conversation, label)
  const items = value.items.map((item): VerifyReportBundleItem => {
    if (
      !isRecord(item) ||
      !hasAllowedKeys(item, ['binding', 'primaryUrl']) ||
      !isReportBundleBinding(item.binding) ||
      !isBoundedText(item.primaryUrl, REPORT_BUNDLE_MAX_URL_CHARS)
    ) {
      throw new ServiceValidationError(label)
    }
    return { binding: item.binding, primaryUrl: item.primaryUrl }
  })
  return { conversation, items }
}

export function validateVerifyReportBundlesResp(value: unknown): VerifyReportBundlesResp {
  const label = 'svcReportBundles.verify response'
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ['results']) ||
    !Array.isArray(value.results) ||
    value.results.length > REPORT_BUNDLE_VERIFY_MAX_ITEMS
  ) {
    throw new ServiceValidationError(label)
  }
  const results = value.results.map((result): VerifyReportBundleResult => {
    if (
      !isRecord(result) ||
      !isReportBundleBinding(result.binding) ||
      (result.status === 'refused' && !hasAllowedKeys(result, ['binding', 'status'])) ||
      (result.status === 'verified' &&
        (!hasAllowedKeys(result, ['binding', 'status', 'manifestUrl', 'imageCount']) ||
          !isBoundedText(result.manifestUrl, REPORT_BUNDLE_MAX_URL_CHARS) ||
          !result.manifestUrl.startsWith('local-media://') ||
          !isCount(result.imageCount, REPORT_BUNDLE_MAX_MANIFEST_ENTRIES))) ||
      (result.status !== 'verified' && result.status !== 'refused')
    ) {
      throw new ServiceValidationError(label)
    }
    return result.status === 'verified'
      ? {
          binding: result.binding,
          status: 'verified',
          manifestUrl: result.manifestUrl as string,
          imageCount: result.imageCount as number
        }
      : { binding: result.binding, status: 'refused' }
  })
  return { results }
}

export const reportBundlesSvcDef: ServiceDefSheet<ReportBundlesSvc> = {
  beginBundle: {
    type: 'unary',
    request: validateBeginReportBundleReq,
    response: validateBeginReportBundleResp
  },
  register: {
    type: 'unary',
    request: validateRegisterReportBundleReq,
    response: validateRegisterReportBundleResp
  },
  verify: {
    type: 'unary',
    request: validateVerifyReportBundlesReq,
    response: validateVerifyReportBundlesResp
  }
}
