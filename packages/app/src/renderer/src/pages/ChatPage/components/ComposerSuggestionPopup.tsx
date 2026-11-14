import React, { useLayoutEffect, useRef } from 'react'
import { Box } from '@mui/material'
import { useTranslation } from 'react-i18next'
import {
  getComposerSuggestionOptionId,
  type ComposerSuggestionItem,
  type ComposerSuggestions
} from '../composerSuggestions'

const LIST_PADDING = 4
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const

interface ComposerSuggestionPopupProps {
  id: string
  suggestions: ComposerSuggestions
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onAccept: (item: ComposerSuggestionItem) => void
}

/** Listbox above the composer. Focus stays in the textarea, which owns the keyboard. */
const ComposerSuggestionPopup: React.FC<ComposerSuggestionPopupProps> = ({
  id,
  suggestions,
  activeIndex,
  onActiveIndexChange,
  onAccept
}) => {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement | null>(null)

  // Scroll only the list itself: scrollIntoView would also move clipped ancestors of the pane.
  useLayoutEffect(() => {
    const list = listRef.current
    const option = list?.children[activeIndex] as HTMLElement | undefined
    if (!list || !option) return
    const top = option.offsetTop - LIST_PADDING
    const bottom = option.offsetTop + option.offsetHeight + LIST_PADDING
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight
  }, [activeIndex, suggestions.key, suggestions.items.length])

  return (
    <Box
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={t('chat.composer_suggestions.commands_label')}
      data-testid="chat-composer-suggestions"
      // Keep the caret in the textarea when the list or its scrollbar is pressed.
      onMouseDown={(event) => event.preventDefault()}
      sx={(theme) => ({
        position: 'absolute',
        left: theme.spacing(1.5),
        right: theme.spacing(1.5),
        bottom: '100%',
        mb: 0.75,
        zIndex: theme.zIndex.drawer,
        maxHeight: 'min(264px, 45vh)',
        overflowY: 'auto',
        display: 'grid',
        gridTemplateColumns: 'fit-content(56%) minmax(0, 1fr)',
        columnGap: 1.5,
        alignContent: 'start',
        p: `${LIST_PADDING}px`,
        borderRadius: 2,
        border: '1px solid',
        borderColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)',
        bgcolor: theme.palette.mode === 'dark' ? '#2a2b2d' : '#ffffff',
        boxShadow:
          theme.palette.mode === 'dark'
            ? '0 8px 24px rgba(0,0,0,0.5)'
            : '0 8px 24px rgba(0,0,0,0.12)'
      })}
    >
      {suggestions.items.map((item, index) => {
        const selected = index === activeIndex
        const description = t(item.descriptionKey)
        return (
          <Box
            key={`${index}:${item.label}`}
            id={getComposerSuggestionOptionId(id, index)}
            role="option"
            aria-selected={selected}
            onMouseMove={() => {
              if (!selected) onActiveIndexChange(index)
            }}
            onClick={() => onAccept(item)}
            sx={(theme) => ({
              // Rows share the list's two columns, so every description starts at the same edge.
              display: 'grid',
              gridTemplateColumns: 'subgrid',
              gridColumn: '1 / -1',
              alignItems: 'baseline',
              px: 1,
              py: 0.5,
              borderRadius: 1.5,
              cursor: 'pointer',
              lineHeight: '20px',
              bgcolor: selected
                ? theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.1)'
                  : 'rgba(0,0,0,0.06)'
                : 'transparent'
            })}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 0.75,
                minWidth: 0,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
              }}
            >
              <Box
                component="span"
                sx={{
                  flexShrink: item.argumentHintKey ? 0 : 1,
                  minWidth: 0,
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'text.primary',
                  ...ellipsis
                }}
              >
                {item.label}
              </Box>
              {item.argumentHintKey ? (
                <Box
                  component="span"
                  sx={{ minWidth: 0, fontSize: 12, color: 'text.secondary', ...ellipsis }}
                >
                  {t(item.argumentHintKey)}
                </Box>
              ) : null}
            </Box>
            <Box
              component="span"
              title={description}
              sx={{ minWidth: 0, fontSize: 12, color: 'text.secondary', ...ellipsis }}
            >
              {description}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export default ComposerSuggestionPopup
