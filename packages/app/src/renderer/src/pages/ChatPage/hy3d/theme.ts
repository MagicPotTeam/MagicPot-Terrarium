// hy3d/theme.ts - Hunyuan 3D colors and shared styles

type HyColorKey =
  | 'bg'
  | 'navBg'
  | 'card'
  | 'cardHover'
  | 'activeItemBg'
  | 'border'
  | 'textPrimary'
  | 'textSecondary'
  | 'primary'
  | 'primaryHover'
  | 'badgeBg'
  | 'generateBtnGrad'
  | 'navActiveText'
  | 'navActiveBg'
  | 'navActiveOutline'
  | 'navHoverBg'
  | 'tipBg'
  | 'switchTrackBg'
  | 'scrollbarThumb'
  | 'inputPlaceholder'
  | 'softBorder'
  | 'dashedBorder'
  | 'softBg'
  | 'softBgStrong'
  | 'softHoverBg'
  | 'softHoverBorder'
  | 'mutedIcon'
  | 'disabledBg'
  | 'disabledText'
  | 'activeShadow'
  | 'iconBadgeFill'
  | 'iconBadgeRing'
  | 'iconBadgeInner'
  | 'iconGlyph'
  | 'iconGlyphSecondary'

type HyColorMap = Record<HyColorKey, string>

const hyDarkColors: HyColorMap = {
  bg: '#1c1d21',
  navBg: '#131416',
  card: '#242529',
  cardHover: '#2a2b30',
  activeItemBg: '#34363c',
  border: 'rgba(255, 255, 255, 0.08)',
  textPrimary: '#ffffff',
  textSecondary: '#8a8d93',
  primary: '#0052d9',
  primaryHover: '#266cf1',
  badgeBg: '#1470ff',
  generateBtnGrad: 'linear-gradient(135deg, #1a6dff 0%, #5b3dff 50%, #c054f0 100%)',
  navActiveText: '#5b8def',
  navActiveBg: 'rgba(91, 141, 239, 0.12)',
  navActiveOutline: 'rgba(91,141,239,0.14)',
  navHoverBg: 'rgba(255,255,255,0.04)',
  tipBg: 'rgba(255, 255, 255, 0.06)',
  switchTrackBg: '#3d3e42',
  scrollbarThumb: 'rgba(255,255,255,0.08)',
  inputPlaceholder: 'rgba(255,255,255,0.38)',
  softBorder: 'rgba(255,255,255,0.1)',
  dashedBorder: 'rgba(255,255,255,0.15)',
  softBg: 'rgba(255,255,255,0.02)',
  softBgStrong: 'rgba(255,255,255,0.03)',
  softHoverBg: 'rgba(255,255,255,0.05)',
  softHoverBorder: 'rgba(255,255,255,0.3)',
  mutedIcon: 'rgba(255,255,255,0.25)',
  disabledBg: 'rgba(255,255,255,0.06)',
  disabledText: 'rgba(255,255,255,0.25)',
  activeShadow: '0 10px 26px rgba(0,0,0,0.18)',
  iconBadgeFill: '#0f131b',
  iconBadgeRing: 'rgba(255,255,255,0.12)',
  iconBadgeInner: 'rgba(255,255,255,0.04)',
  iconGlyph: '#f6fbff',
  iconGlyphSecondary: 'rgba(246,251,255,0.68)'
}

const hyLightColors: HyColorMap = {
  bg: '#eef2f8',
  navBg: '#eef2f8',
  card: '#ffffff',
  cardHover: '#fbfcff',
  activeItemBg: 'rgba(255,255,255,0.94)',
  border: 'rgba(94, 107, 139, 0.12)',
  textPrimary: '#1a2438',
  textSecondary: '#71809b',
  primary: '#3562e7',
  primaryHover: '#2f5ce0',
  badgeBg: '#1470ff',
  generateBtnGrad: 'linear-gradient(135deg, #1a6dff 0%, #5b3dff 50%, #c054f0 100%)',
  navActiveText: '#2f5ce0',
  navActiveBg: 'rgba(255,255,255,0.96)',
  navActiveOutline: 'rgba(53,98,231,0.12)',
  navHoverBg: 'rgba(255,255,255,0.66)',
  tipBg: 'rgba(255,255,255,0.56)',
  switchTrackBg: '#d8dfeb',
  scrollbarThumb: 'rgba(94,107,139,0.18)',
  inputPlaceholder: 'rgba(74, 86, 114, 0.44)',
  softBorder: 'rgba(94,107,139,0.14)',
  dashedBorder: 'rgba(94,107,139,0.18)',
  softBg: 'rgba(255,255,255,0.58)',
  softBgStrong: 'rgba(255,255,255,0.74)',
  softHoverBg: '#ffffff',
  softHoverBorder: 'rgba(53,98,231,0.18)',
  mutedIcon: 'rgba(90,103,128,0.42)',
  disabledBg: 'rgba(94,107,139,0.10)',
  disabledText: 'rgba(94,107,139,0.42)',
  activeShadow: '0 12px 28px rgba(110,128,167,0.14)',
  iconBadgeFill: '#ffffff',
  iconBadgeRing: 'rgba(94,107,139,0.14)',
  iconBadgeInner: 'rgba(255,255,255,0.72)',
  iconGlyph: '#4a5a78',
  iconGlyphSecondary: 'rgba(74,90,120,0.58)'
}

const hyColorVarNames: Record<HyColorKey, string> = {
  bg: '--hy3d-bg',
  navBg: '--hy3d-nav-bg',
  card: '--hy3d-card',
  cardHover: '--hy3d-card-hover',
  activeItemBg: '--hy3d-active-item-bg',
  border: '--hy3d-border',
  textPrimary: '--hy3d-text-primary',
  textSecondary: '--hy3d-text-secondary',
  primary: '--hy3d-primary',
  primaryHover: '--hy3d-primary-hover',
  badgeBg: '--hy3d-badge-bg',
  generateBtnGrad: '--hy3d-generate-btn-grad',
  navActiveText: '--hy3d-nav-active-text',
  navActiveBg: '--hy3d-nav-active-bg',
  navActiveOutline: '--hy3d-nav-active-outline',
  navHoverBg: '--hy3d-nav-hover-bg',
  tipBg: '--hy3d-tip-bg',
  switchTrackBg: '--hy3d-switch-track-bg',
  scrollbarThumb: '--hy3d-scrollbar-thumb',
  inputPlaceholder: '--hy3d-input-placeholder',
  softBorder: '--hy3d-soft-border',
  dashedBorder: '--hy3d-dashed-border',
  softBg: '--hy3d-soft-bg',
  softBgStrong: '--hy3d-soft-bg-strong',
  softHoverBg: '--hy3d-soft-hover-bg',
  softHoverBorder: '--hy3d-soft-hover-border',
  mutedIcon: '--hy3d-muted-icon',
  disabledBg: '--hy3d-disabled-bg',
  disabledText: '--hy3d-disabled-text',
  activeShadow: '--hy3d-active-shadow',
  iconBadgeFill: '--hy3d-icon-badge-fill',
  iconBadgeRing: '--hy3d-icon-badge-ring',
  iconBadgeInner: '--hy3d-icon-badge-inner',
  iconGlyph: '--hy3d-icon-glyph',
  iconGlyphSecondary: '--hy3d-icon-glyph-secondary'
}

export const hyColors = Object.fromEntries(
  Object.entries(hyColorVarNames).map(([key, cssVar]) => [key, `var(${cssVar})`])
) as HyColorMap

export function getHy3dCssVars(mode: 'light' | 'dark'): Record<string, string> {
  const palette = mode === 'light' ? hyLightColors : hyDarkColors
  return Object.fromEntries(
    Object.entries(palette).map(([key, value]) => [hyColorVarNames[key as HyColorKey], value])
  )
}

export const scrollbarSx = {
  '&::-webkit-scrollbar': { width: 3 },
  '&::-webkit-scrollbar-track': { bgcolor: 'transparent' },
  '&::-webkit-scrollbar-thumb': { bgcolor: hyColors.scrollbarThumb, borderRadius: 2 }
}

export const hySwitchSx = {
  width: 36,
  height: 20,
  p: 0,
  '& .MuiSwitch-switchBase': {
    p: '2px',
    '&.Mui-checked': {
      transform: 'translateX(16px)',
      color: '#fff',
      '& + .MuiSwitch-track': { bgcolor: hyColors.primary, opacity: 1 }
    }
  },
  '& .MuiSwitch-thumb': { width: 16, height: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.3)' },
  '& .MuiSwitch-track': { borderRadius: 10, bgcolor: hyColors.switchTrackBg, opacity: 1 }
}
