import {
  figPluginImageGenerationProposalPrepareResponseSchema,
  figPluginImageGenerationProposalStatusSchema,
  type FigPluginImageGenerationProposalPrepareResponse,
  type FigPluginImageGenerationProposalStatus
} from './nativeImageGeneration'

export type NativeImageGenerationReceiptIdentity = Readonly<{
  requestId: string
  now: number
  sessionExpiresAt: number
}>

export type NativeImageGenerationStatusIdentity = Readonly<{
  requestId: string
  proposalId: string
  createdAt: number
  expiresAt: number
  now: number
}>

// Validation only: callers retain their existing private transport, session epoch and cancellation.
export function validateNativeImageGenerationReceipt(
  input: unknown,
  expected: NativeImageGenerationReceiptIdentity
): Readonly<FigPluginImageGenerationProposalPrepareResponse> {
  const receipt = figPluginImageGenerationProposalPrepareResponseSchema.parse(input)
  if (
    receipt.requestId !== expected.requestId ||
    !Number.isSafeInteger(expected.now) ||
    !Number.isSafeInteger(expected.sessionExpiresAt) ||
    expected.now < receipt.createdAt ||
    expected.now >= receipt.expiresAt ||
    receipt.expiresAt > expected.sessionExpiresAt
  )
    throw new Error('IMAGE_GENERATION_RECEIPT_STALE_OR_UNBOUND')
  return Object.freeze(receipt)
}

export function validateNativeImageGenerationStatus(
  input: unknown,
  expected: NativeImageGenerationStatusIdentity
): Readonly<FigPluginImageGenerationProposalStatus> {
  const status = figPluginImageGenerationProposalStatusSchema.parse(input)
  if (
    status.requestId !== expected.requestId ||
    status.proposalId !== expected.proposalId ||
    status.createdAt !== expected.createdAt ||
    status.expiresAt !== expected.expiresAt ||
    !Number.isSafeInteger(expected.now) ||
    expected.now < status.updatedAt ||
    expected.now >= status.expiresAt
  )
    throw new Error('IMAGE_GENERATION_STATUS_STALE_OR_UNBOUND')
  return Object.freeze(status)
}
