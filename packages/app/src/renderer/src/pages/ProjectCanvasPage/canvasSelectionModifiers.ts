export type CanvasSelectionModifierLike = {
  shiftKey?: boolean | null
  ctrlKey?: boolean | null
  metaKey?: boolean | null
}

export function isCanvasAdditiveSelectionModifier(
  event: CanvasSelectionModifierLike | null | undefined
): boolean {
  return Boolean(event?.shiftKey || event?.ctrlKey || event?.metaKey)
}
