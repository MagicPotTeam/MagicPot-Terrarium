import { describe, expect, it } from 'vitest'
import {
  EXPORT_SUBMENU_GAP,
  EXPORT_SUBMENU_MIN_WIDTH,
  resolveExportSubmenuPlacement
} from './exportMenuPlacement'

describe('resolveExportSubmenuPlacement', () => {
  it('opens to the right when there is enough space', () => {
    expect(
      resolveExportSubmenuPlacement(900, 1140, 1600, EXPORT_SUBMENU_MIN_WIDTH, EXPORT_SUBMENU_GAP)
    ).toBe('right')
  })

  it('opens to the left when the right side is too tight', () => {
    expect(
      resolveExportSubmenuPlacement(980, 1220, 1500, EXPORT_SUBMENU_MIN_WIDTH, EXPORT_SUBMENU_GAP)
    ).toBe('left')
  })

  it('falls back to the roomier side when neither side fully fits', () => {
    expect(resolveExportSubmenuPlacement(520, 760, 980, 500, 12)).toBe('left')
    expect(resolveExportSubmenuPlacement(220, 460, 980, 500, 12)).toBe('right')
  })
})
