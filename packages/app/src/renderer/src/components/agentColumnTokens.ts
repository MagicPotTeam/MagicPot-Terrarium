import { alpha, type Theme } from '@mui/material/styles'

/**
 * Shared design tokens of the right-hand Agent column.
 *
 * Base colours (text, muted text, dividers, selection, focus) come from
 * MagicPot's own palette. Structure, sizes, the low-alpha tint recipe and the
 * two fixed tints of tool lines and delegated-agent lines are set here so every
 * part of the column (toolbar, thread list, transcript rows, composer) draws
 * from the same values.
 */
export const AGENT_COLUMN_MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * The two tints below are fixed colours of the reference design, not palette
 * colours: every theme draws tool lines and delegated-agent lines with them.
 */
export const AGENT_COLUMN_TOOL_ACCENT = '#0F52BA'
export const AGENT_COLUMN_MEMBER_ACCENT = '#A57EAE'
/** Label of a delegated-agent line on a dark background. */
const AGENT_COLUMN_MEMBER_LABEL_DARK = '#E8D5ED'

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
  /** Tint of tool lines: stronger on the one-line header, half of it on the body. */
  toolTint: { header: string; body: string; hairline: string }
  /** Bold monospace tool name on a tool line. */
  toolName: string
  /** Tint of delegated-agent (team member) lines and the colour of their label. */
  memberTint: { header: string; stats: string; label: string }
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
      header: alpha(AGENT_COLUMN_TOOL_ACCENT, dark ? 0.12 : 0.08),
      body: alpha(AGENT_COLUMN_TOOL_ACCENT, dark ? 0.06 : 0.04),
      hairline: alpha(AGENT_COLUMN_TOOL_ACCENT, dark ? 0.2 : 0.15)
    },
    toolName: dark ? theme.palette.primary.light : theme.palette.primary.dark,
    memberTint: {
      header: alpha(AGENT_COLUMN_MEMBER_ACCENT, dark ? 0.12 : 0.08),
      stats: alpha(AGENT_COLUMN_MEMBER_ACCENT, dark ? 0.2 : 0.15),
      label: dark ? AGENT_COLUMN_MEMBER_LABEL_DARK : AGENT_COLUMN_MEMBER_ACCENT
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
