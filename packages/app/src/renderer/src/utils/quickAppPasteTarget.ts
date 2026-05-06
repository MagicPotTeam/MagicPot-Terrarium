const activeQuickAppImagePasteTargets = new Set<symbol>()

export const activateQuickAppImagePasteTarget = (token: symbol): void => {
  activeQuickAppImagePasteTargets.add(token)
}

export const deactivateQuickAppImagePasteTarget = (token: symbol): void => {
  activeQuickAppImagePasteTargets.delete(token)
}

export const hasActiveQuickAppImagePasteTarget = (): boolean => {
  return activeQuickAppImagePasteTargets.size > 0
}

export const resetQuickAppImagePasteTargetsForTest = (): void => {
  activeQuickAppImagePasteTargets.clear()
}
