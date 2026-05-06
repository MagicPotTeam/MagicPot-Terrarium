export type ExportSubmenuPlacement = 'left' | 'right'

export const EXPORT_SUBMENU_MIN_WIDTH = 348
export const EXPORT_SUBMENU_GAP = 8

export function resolveExportSubmenuPlacement(
  anchorLeft: number,
  anchorRight: number,
  viewportWidth: number,
  submenuWidth: number = EXPORT_SUBMENU_MIN_WIDTH,
  gap: number = EXPORT_SUBMENU_GAP
): ExportSubmenuPlacement {
  const requiredSpace = submenuWidth + gap
  const rightSpace = viewportWidth - anchorRight
  const leftSpace = anchorLeft

  if (rightSpace >= requiredSpace) {
    return 'right'
  }

  if (leftSpace >= requiredSpace) {
    return 'left'
  }

  return leftSpace > rightSpace ? 'left' : 'right'
}
