export type TeamMessageReceiptState = 'queued' | 'unknown' | 'acknowledged'

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

export interface TeamMessageReceiptInput {
  readonly id: string
  readonly teamKey: string
  readonly text: string
  readonly recipients: readonly string[]
  readonly now: number
}

export const TEAM_MESSAGE_RECEIPT_LIMIT = 200

const receiptKey = (receipt: Pick<TeamMessageReceipt, 'id' | 'recipientId'>): string =>
  `${receipt.id}\u0000${receipt.recipientId}`

const validState = (value: unknown): value is TeamMessageReceiptState =>
  value === 'queued' || value === 'unknown' || value === 'acknowledged'

const validTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const normalizeReceipt = (value: unknown): TeamMessageReceipt | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<TeamMessageReceipt>
  if (candidate.version !== 1 || typeof candidate.id !== 'string' || !candidate.id.trim() ||
      typeof candidate.recipientId !== 'string' || !candidate.recipientId.trim() ||
      typeof candidate.teamKey !== 'string' || !candidate.teamKey.trim() ||
      typeof candidate.text !== 'string' || !candidate.text.trim() ||
      !validState(candidate.state) || !validTimestamp(candidate.createdAt) || !validTimestamp(candidate.updatedAt)) {
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

const normalizeReceipts = (receipts: readonly TeamMessageReceipt[] | undefined): TeamMessageReceipt[] =>
  (receipts ?? []).map(normalizeReceipt).filter((receipt): receipt is TeamMessageReceipt => receipt !== null)

/**
 * Build one durable pending record per recipient. A queued record is an intent snapshot,
 * not proof of delivery or processing.
 */
export function createTeamMessageReceipts(input: TeamMessageReceiptInput): TeamMessageReceipt[] {
  if (!input || typeof input.id !== 'string' || !input.id.trim() ||
      typeof input.teamKey !== 'string' || !input.teamKey.trim() ||
      typeof input.text !== 'string' || !input.text.trim() ||
      !validTimestamp(input.now)) throw new Error('Invalid team message receipt.')
  const recipients = [...new Set(input.recipients.filter(recipient => typeof recipient === 'string' && recipient.trim()))]
  return recipients.map(recipient => Object.freeze({
    version: 1 as const,
    id: input.id,
    recipientId: recipient,
    teamKey: input.teamKey,
    text: input.text,
    state: 'queued' as const,
    createdAt: input.now,
    updatedAt: input.now
  }))
}

/** Merge a new outbox snapshot without allowing duplicate (message, recipient) keys. */
export function mergeTeamMessageReceipts(
  existing: readonly TeamMessageReceipt[] | undefined,
  additions: readonly TeamMessageReceipt[],
  limit = TEAM_MESSAGE_RECEIPT_LIMIT
): TeamMessageReceipt[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid team message receipt limit.')
  const merged = new Map<string, TeamMessageReceipt>()
  for (const receipt of normalizeReceipts(existing)) merged.set(receiptKey(receipt), receipt)
  for (const receipt of normalizeReceipts(additions)) merged.set(receiptKey(receipt), receipt)
  return [...merged.values()]
    .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt)
    .slice(-limit)
}

/**
 * A process restart cannot prove whether a queued intent was sent. Mark matching records
 * unknown for manual review; this helper deliberately never schedules an automatic retry.
 */
export function markTeamMessageReceiptsUnknown(
  receipts: readonly TeamMessageReceipt[] | undefined,
  teamKey: string,
  now: number
): TeamMessageReceipt[] {
  if (!teamKey.trim() || !validTimestamp(now)) throw new Error('Invalid team message receipt recovery scope.')
  return normalizeReceipts(receipts).map(receipt =>
    receipt.teamKey === teamKey && receipt.state === 'queued'
      ? Object.freeze({ ...receipt, state: 'unknown' as const, updatedAt: now })
      : receipt
  )
}

/** Apply a later explicit receipt without changing other teams or recipients. */
export function updateTeamMessageReceipt(
  receipts: readonly TeamMessageReceipt[] | undefined,
  input: Readonly<{ id: string; recipientId: string; teamKey: string; state: Exclude<TeamMessageReceiptState, 'queued'>; now: number }>
): TeamMessageReceipt[] {
  if (!input.id.trim() || !input.recipientId.trim() || !input.teamKey.trim() || !validTimestamp(input.now)) {
    throw new Error('Invalid team message receipt update.')
  }
  return normalizeReceipts(receipts).map(receipt =>
    receipt.id === input.id && receipt.recipientId === input.recipientId && receipt.teamKey === input.teamKey
      ? Object.freeze({ ...receipt, state: input.state, updatedAt: input.now })
      : receipt
  )
}

