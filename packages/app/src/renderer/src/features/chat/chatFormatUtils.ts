export const formatCompactTokenCount = (value?: number | null): string => {
  if (!value || !Number.isFinite(value)) {
    return '0'
  }

  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`
  }

  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`
  }

  return `${Math.round(value)}`
}
