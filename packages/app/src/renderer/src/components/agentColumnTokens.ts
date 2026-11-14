import { alpha, type Theme } from '@mui/material/styles'

/**
 * Shared design tokens of the right-hand Agent column.
 *
 * The column keeps MagicPot's own palette; only structure, sizes and the
 * low-alpha tint recipe are fixed here so every part of the column (toolbar,
 * thread list, transcript rows, composer) draws from the same values.
 */
export const AGENT_COLUMN_MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Accent reserved for delegated agents (team members); not part of the MUI palette. */
const AGENT_COLUMN_MEMBER_ACCENT = '#a78bfa'

export interface AgentColumnTokens {
  /** 1px separators between flat regions and rows. */
  border: string
  text: string
  muted: string
  /** The palette's primary colour: focus ring, drop target, links. */
  accent: string
  /** Row hover fill. */
  hover: string
  /** Fill of the selected row or of a toolbar button whose panel is open. */
  selected: string
  /** Neutral raised surface (user bubble, chips). */
  surface: string
  /** Tint of tool lines: stronger on the one-line header, lighter on the body. */
  toolTint: { header: string; body: string }
  /** Tint of delegated-agent (team member) lines. */
  memberTint: { header: string; stats: string }
  /** Working, queued or waiting for the person. */
  attention: string
  /** Errors and destructive rows. */
  danger: string
  /** The "running" dot and success glyphs. */
  live: string
  /** Rounding is for content only; chrome (header, toolbar, rows) stays square. */
  radius: { shell: 12; banner: 10; content: 8; pill: 6; control: 4 }
  fontSize: { base: 13; small: 12; caption: 11; micro: 10 }
  /** Line height of message bodies. */
  bodyLineHeight: 1.65
  space: { xs: 4; sm: 6; md: 8; lg: 12; xl: 16 }
  monoFont: string
  /** Keyboard focus: an inset 2px ring. */
  focusRing: { outline: string; outlineOffset: string }
  disabledOpacity: 0.55
}

export const getAgentColumnTokens = (theme: Theme): AgentColumnTokens => {
  const dark = theme.palette.mode === 'dark'
  const primary = theme.palette.primary.main

  return {
    border: theme.palette.divider,
    text: theme.palette.text.primary,
    muted: theme.palette.text.secondary,
    accent: primary,
    hover: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
    selected: alpha(primary, 0.24),
    surface: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    toolTint: {
      header: alpha(primary, dark ? 0.12 : 0.08),
      body: alpha(primary, dark ? 0.06 : 0.04)
    },
    memberTint: {
      header: alpha(AGENT_COLUMN_MEMBER_ACCENT, 0.12),
      stats: alpha(AGENT_COLUMN_MEMBER_ACCENT, 0.2)
    },
    attention: theme.palette.warning.main,
    danger: theme.palette.error.main,
    live: theme.palette.success.main,
    radius: { shell: 12, banner: 10, content: 8, pill: 6, control: 4 },
    fontSize: { base: 13, small: 12, caption: 11, micro: 10 },
    bodyLineHeight: 1.65,
    space: { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 },
    monoFont: AGENT_COLUMN_MONO_FONT,
    focusRing: { outline: `2px solid ${primary}`, outlineOffset: '-2px' },
    disabledOpacity: 0.55
  }
}
