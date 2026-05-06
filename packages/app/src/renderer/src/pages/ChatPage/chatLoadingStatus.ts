export type ChatLoadingStatus = {
  label: string
  detail?: string
  step?: number
  totalSteps?: number
}

export const formatChatLoadingStatusProgress = (
  status?: ChatLoadingStatus | null
): string | null => {
  if (!status) {
    return null
  }

  if (
    typeof status.step !== 'number' ||
    !Number.isFinite(status.step) ||
    typeof status.totalSteps !== 'number' ||
    !Number.isFinite(status.totalSteps) ||
    status.totalSteps <= 0
  ) {
    return null
  }

  return `${Math.max(1, Math.round(status.step))}/${Math.max(1, Math.round(status.totalSteps))}`
}
