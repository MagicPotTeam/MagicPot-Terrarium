export type InputProps<T> = {
  value: T
  label: string
  Icon?: React.ComponentType<{ sx: { mr: number; color: string } }>
  onChange: (value: T) => void
  // TODO: 现在不是所有 Input 都支持 tooltip，需要逐步完善
  tooltip?: string
}
