import { alpha, createTheme } from '@mui/material/styles'
import { describe, expect, it } from 'vitest'

import { AGENT_COLUMN_MONO_FONT, getAgentColumnTokens } from './agentColumnTokens'

describe('getAgentColumnTokens', () => {
  it('derives base colours from the MUI palette instead of fixed hex values', () => {
    const theme = createTheme({
      palette: {
        mode: 'dark',
        primary: { main: '#3366ff' },
        success: { main: '#22aa55' },
        warning: { main: '#ddaa00' },
        error: { main: '#ee3344' }
      }
    })
    const tokens = getAgentColumnTokens(theme)

    expect(tokens.border).toBe(theme.palette.divider)
    expect(tokens.text).toBe(theme.palette.text.primary)
    expect(tokens.muted).toBe(theme.palette.text.secondary)
    expect(tokens.accent).toBe('#3366ff')
    expect(tokens.selected).toBe(alpha('#3366ff', 0.24))
    expect(tokens.live).toBe('#22aa55')
    expect(tokens.attention).toBe('#ddaa00')
    expect(tokens.danger).toBe('#ee3344')
    expect(tokens.focusRing).toEqual({ outline: '2px solid #3366ff', outlineOffset: '-2px' })
  })

  it('uses the dark tint recipe on dark themes', () => {
    const theme = createTheme({ palette: { mode: 'dark' } })
    const tokens = getAgentColumnTokens(theme)

    expect(tokens.hover).toBe('rgba(255,255,255,0.05)')
    expect(tokens.surface).toBe('rgba(255,255,255,0.08)')
    // Fixed tints of the reference design: they do not follow the palette.
    expect(tokens.toolTint).toEqual({
      header: alpha('#0F52BA', 0.12),
      body: alpha('#0F52BA', 0.06),
      hairline: alpha('#0F52BA', 0.2)
    })
    expect(tokens.toolName).toBe(theme.palette.primary.light)
    expect(tokens.memberTint).toEqual({
      header: alpha('#A57EAE', 0.12),
      stats: alpha('#A57EAE', 0.2),
      label: '#E8D5ED'
    })
  })

  it('uses the lighter tint recipe on light themes', () => {
    const theme = createTheme({ palette: { mode: 'light' } })
    const tokens = getAgentColumnTokens(theme)

    expect(tokens.hover).toBe('rgba(0,0,0,0.04)')
    expect(tokens.surface).toBe('rgba(0,0,0,0.05)')
    expect(tokens.toolTint).toEqual({
      header: alpha('#0F52BA', 0.08),
      body: alpha('#0F52BA', 0.04),
      hairline: alpha('#0F52BA', 0.15)
    })
    expect(tokens.toolName).toBe(theme.palette.primary.dark)
    expect(tokens.memberTint).toEqual({
      header: alpha('#A57EAE', 0.08),
      stats: alpha('#A57EAE', 0.15),
      label: '#A57EAE'
    })
  })

  it('fixes the shared scale: radii, text sizes, spacing, mono stack and disabled opacity', () => {
    const tokens = getAgentColumnTokens(createTheme())

    expect(tokens.radius).toEqual({ shell: 12, banner: 10, content: 8, pill: 6, control: 4 })
    expect(tokens.fontSize).toEqual({ base: 13, small: 12, caption: 11, micro: 10 })
    expect(tokens.bodyLineHeight).toBe(1.65)
    expect(tokens.space).toEqual({ xs: 4, sm: 6, md: 8, lg: 12, xl: 16 })
    expect(tokens.monoFont).toBe(AGENT_COLUMN_MONO_FONT)
    expect(AGENT_COLUMN_MONO_FONT).toBe('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace')
    expect(tokens.disabledOpacity).toBe(0.55)
  })
})
