type TeamMessageReceiptState = 'queued' | 'unknown' | 'acknowledged'

export interface TeamMessageReceipt {
  readonly version: 1
  readonly id: string
  readonly recipientId: string
  readonly teamKey: string
  readonly text: string
  readonly state: TeamMessageReceiptState
  readonly createdAt: number
  readonly updatedAt: number
}

const validState = (value: unknown): value is TeamMessageReceiptState =>
  value === 'queued' || value === 'unknown' || value === 'acknowledged'

const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const normalizeReceipt = (value: unknown): TeamMessageReceipt | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<TeamMessageReceipt>
  if (
    candidate.version !== 1 ||
    typeof candidate.id !== 'string' ||
    !candidate.id.trim() ||
    typeof candidate.recipientId !== 'string' ||
    !candidate.recipientId.trim() ||
    typeof candidate.teamKey !== 'string' ||
    !candidate.teamKey.trim() ||
    typeof candidate.text !== 'string' ||
    !candidate.text.trim() ||
    !validState(candidate.state) ||
    !validTimestamp(candidate.createdAt) ||
    !validTimestamp(candidate.updatedAt)
  ) {
    return null
  }
  return Object.freeze({
    version: 1,
    id: candidate.id,
    recipientId: candidate.recipientId,
    teamKey: candidate.teamKey,
    text: candidate.text,
    state: candidate.state,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt
  })
}

const normalizeReceipts = (
  receipts: readonly TeamMessageReceipt[] | undefined
): TeamMessageReceipt[] =>
  (receipts ?? [])
    .map(normalizeReceipt)
    .filter((receipt): receipt is TeamMessageReceipt => receipt !== null)

/**
 * A process restart cannot prove whether a queued intent was sent. Mark matching records
 * unknown for manual review; this helper deliberately never schedules an automatic retry.
 */
export function markTeamMessageReceiptsUnknown(
  receipts: readonly TeamMessageReceipt[] | undefined,
  teamKey: string,
  now: number
): TeamMessageReceipt[] {
  if (!teamKey.trim() || !validTimestamp(now))
    throw new Error('Invalid team message receipt recovery scope.')
  return normalizeReceipts(receipts).map((receipt) =>
    receipt.teamKey === teamKey && receipt.state === 'queued'
      ? Object.freeze({ ...receipt, state: 'unknown' as const, updatedAt: now })
      : receipt
  )
}
