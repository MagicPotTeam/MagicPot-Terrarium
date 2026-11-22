import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Box } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import { getAgentColumnTokens } from './agentColumnTokens'

export type AgentColumnOverlayPrimary = {
  label: string
  /** Accessible name when it must say more than the visible label. */
  ariaLabel?: string
  disabled?: boolean
  busy?: boolean
  onClick: () => void
}

export type AgentColumnOverlayProps = {
  open: boolean
  /**
   * The Agent column's overlay host (it covers the column below the header). Without one the
   * overlay is drawn in place, over the nearest positioned ancestor.
   */
  container?: HTMLElement | null
  /** Accessible name of the dialog. */
  label: string
  /** Top row: a search field or controls. */
  top?: React.ReactNode
  /** Top row as a plain title, when there is no search field. */
  title?: string
  children?: React.ReactNode
  /** A fixed area between the scrolling content and the footer. */
  bottom?: React.ReactNode
  onClose: () => void
  /** Text of the footer's secondary button (default "取消" / "Cancel"). */
  cancelLabel?: string
  cancelAriaLabel?: string
  cancelDisabled?: boolean
  primary?: AgentColumnOverlayPrimary
  /** Where the focus goes on open: the first control of the overlay (default) or the cancel button. */
  initialFocus?: 'first' | 'cancel'
  /**
   * Called instead of focusing the element that had the focus before the overlay opened, when
   * the overlay closes while it holds the focus.
   */
  onReturnFocus?: () => void
  'data-testid'?: string
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const isPlainBody = (element: Element | null) =>
  !element || element === document.body || !element.isConnected

/**
 * The Agent column's overlay drawer: a dimmed layer over the column below the header and a
 * bottom sheet (85% of that height) with a top row, scrolling content and a footer with
 * Cancel and one primary button. Escape and Cancel close it; the focus goes back to what
 * opened it.
 */
const AgentColumnOverlay: React.FC<AgentColumnOverlayProps> = ({
  open,
  container,
  label,
  top,
  title,
  children,
  bottom,
  onClose,
  cancelLabel,
  cancelAriaLabel,
  cancelDisabled,
  primary,
  initialFocus = 'first',
  onReturnFocus,
  'data-testid': testId
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = getAgentColumnTokens(theme)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  // The focus was inside the sheet and has not moved to another element outside it since.
  const focusInsideRef = useRef(false)
  const wasOpenRef = useRef(false)
  const onReturnFocusRef = useRef(onReturnFocus)
  onReturnFocusRef.current = onReturnFocus
  const closeRef = useRef<() => void>(() => undefined)
  // The pending focus retry, and whether the sheet is still mounted when it fires.
  const retryTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const returnFocus = () => {
    if (onReturnFocusRef.current) onReturnFocusRef.current()
    else if (openerRef.current?.isConnected) openerRef.current.focus()
  }
  // After the sheet went away with the focus: the target may not take it yet (a composer that
  // is re-enabled a moment later), so try again briefly while the focus is still nowhere.
  const returnLostFocus = (attempt = 0) => {
    if (!isPlainBody(document.activeElement)) return
    returnFocus()
    if (attempt < 20 && isPlainBody(document.activeElement)) {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null
        // An unmounted sheet has no focus to hand back (and its document may be gone).
        if (mountedRef.current) returnLostFocus(attempt + 1)
      }, 50)
    }
  }

  // Every focus change of the page while open tells whether the sheet holds the focus (a
  // focused control that goes away with the sheet leaves the focus nowhere).
  useEffect(() => {
    if (!open) return
    const track = (event: FocusEvent) => {
      focusInsideRef.current = Boolean(
        dialogRef.current &&
        event.target instanceof Node &&
        dialogRef.current.contains(event.target)
      )
    }
    document.addEventListener('focusin', track, true)
    return () => document.removeEventListener('focusin', track, true)
  }, [open])

  // Escape with the focus nowhere (the focused control went away) still closes the topmost sheet.
  useEffect(() => {
    if (!open) return
    const handle = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (!isPlainBody(document.activeElement)) return
      const root = dialogRef.current?.parentElement
      if (!root || root.parentElement?.lastElementChild !== root) return
      event.preventDefault()
      closeRef.current()
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open])

  // Unmounted while open (its owner went away or was re-keyed) while it held the focus: the
  // focus would be left nowhere, so it goes back as on a close.
  useLayoutEffect(
    () => () => {
      if (!wasOpenRef.current) return
      const dialog = dialogRef.current
      const held = focusInsideRef.current || Boolean(dialog?.contains(document.activeElement))
      if (!held) return
      window.setTimeout(() => returnLostFocus(), 0)
    },
    // Runs once, on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useLayoutEffect(() => {
    if (open) {
      wasOpenRef.current = true
      focusInsideRef.current = false
      const current = document.activeElement
      openerRef.current =
        current instanceof HTMLElement && current !== document.body ? current : null
      const timer = window.setTimeout(() => {
        const dialog = dialogRef.current
        if (!dialog || dialog.contains(document.activeElement)) return
        const target =
          initialFocus === 'cancel'
            ? cancelRef.current
            : (dialog.querySelector<HTMLElement>(FOCUSABLE) ?? cancelRef.current)
        target?.focus()
      }, 0)
      return () => window.clearTimeout(timer)
    }
    if (!wasOpenRef.current) return
    wasOpenRef.current = false
    // Closed while it held the focus (the focused control went away with it): give it back.
    if (focusInsideRef.current && isPlainBody(document.activeElement)) returnLostFocus()
    focusInsideRef.current = false
    return undefined
    // The focus target is chosen once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  // Closing from inside the sheet (Escape, Cancel, the dimmed area) hands the focus back first.
  const close = () => {
    if (cancelDisabled) return
    const held = Boolean(dialogRef.current?.contains(document.activeElement))
    if (held) {
      focusInsideRef.current = false
      returnFocus()
    }
    onClose()
    // An opener in the column header cannot take the focus while the open sheet keeps the
    // header inert: it gets the focus once the sheet has gone.
    const opener = openerRef.current
    if (held && !onReturnFocusRef.current && opener?.closest('[inert]')) {
      const focusOpener = (attempt = 0) => {
        if (!opener.isConnected || !isPlainBody(document.activeElement)) return
        opener.focus()
        if (document.activeElement !== opener && attempt < 20) {
          window.setTimeout(() => focusOpener(attempt + 1), 50)
        }
      }
      window.setTimeout(() => focusOpener(), 0)
    }
  }
  closeRef.current = close

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const dialog = event.currentTarget
    // Keys of nested pop-ups drawn elsewhere (a select's list) are theirs, not the sheet's.
    if (!dialog.contains(event.target as Node)) return
    if (event.key === 'Escape') {
      if (
        event.defaultPrevented ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229
      ) {
        return
      }
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab') return
    // Keep Tab inside the sheet while it is open.
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const buttonSx = {
    boxSizing: 'border-box',
    minWidth: 0,
    minHeight: 28,
    m: 0,
    padding: '3px 14px',
    borderRadius: `${tokens.radius.control}px`,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSize.small,
    lineHeight: '20px',
    whiteSpace: 'nowrap',
    '&:disabled': { opacity: tokens.disabledOpacity, cursor: 'default' }
  } as const

  const overlay = (
    <Box
      data-testid={testId ?? 'agent-column-overlay'}
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        pointerEvents: 'auto',
        overflow: 'hidden'
      }}
    >
      {/* The dimmed column; a click on it closes the sheet. */}
      <Box
        aria-hidden
        data-testid="agent-column-overlay-scrim"
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return
          // The press would move the focus to the page body after the focus went back.
          event.preventDefault()
          close()
        }}
        sx={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)' }}
      />
      <Box
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={handleKeyDown}
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          // 85% of the column body: the host also covers the header, whose height it gives.
          height: 'calc((100% - var(--agent-column-header-height, 0px)) * 0.85)',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          backgroundColor: theme.palette.background.paper,
          color: tokens.text,
          fontSize: tokens.fontSize.base,
          boxShadow: `0 -8px 24px ${alpha('#000', 0.25)}`
        }}
      >
        {top || title ? (
          <Box
            data-testid="agent-column-overlay-top"
            sx={{ flex: 'none', minWidth: 0, padding: '12px 12px 0' }}
          >
            {top ?? (
              <Box
                component="h2"
                sx={{
                  m: 0,
                  fontSize: tokens.fontSize.base,
                  fontWeight: 600,
                  lineHeight: '20px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {title}
              </Box>
            )}
          </Box>
        ) : null}
        <Box
          data-testid="agent-column-overlay-content"
          sx={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '12px'
          }}
        >
          {children}
        </Box>
        {bottom ? <Box sx={{ flex: 'none', minWidth: 0 }}>{bottom}</Box> : null}
        <Box
          data-testid="agent-column-overlay-footer"
          sx={{
            flex: 'none',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '8px',
            padding: '10px 12px',
            borderTop: `1px solid ${tokens.border}`
          }}
        >
          <Box
            component="button"
            type="button"
            ref={cancelRef}
            aria-label={cancelAriaLabel}
            disabled={cancelDisabled}
            onClick={close}
            sx={{
              ...buttonSx,
              border: `1px solid ${tokens.border}`,
              backgroundColor: 'transparent',
              color: tokens.text,
              '&:hover:not(:disabled)': { backgroundColor: tokens.hover },
              '&:focus-visible': { outline: `2px solid ${tokens.accent}`, outlineOffset: '2px' }
            }}
          >
            {cancelLabel ?? t('agent_workspace.overlay.cancel')}
          </Box>
          {primary ? (
            <Box
              component="button"
              type="button"
              data-testid="agent-column-overlay-primary"
              aria-label={primary.ariaLabel}
              aria-busy={primary.busy || undefined}
              disabled={primary.disabled || primary.busy}
              onClick={primary.onClick}
              sx={{
                ...buttonSx,
                border: `1px solid ${tokens.accent}`,
                backgroundColor: tokens.accent,
                color: theme.palette.getContrastText(theme.palette.primary.main),
                '&:hover:not(:disabled)': { filter: 'brightness(1.1)' },
                '&:focus-visible': { outline: `2px solid ${tokens.accent}`, outlineOffset: '2px' }
              }}
            >
              {primary.label}
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  )

  return container ? createPortal(overlay, container) : overlay
}

export default AgentColumnOverlay
