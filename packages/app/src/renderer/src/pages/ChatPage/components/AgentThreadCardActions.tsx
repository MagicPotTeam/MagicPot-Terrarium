import React from 'react'
import { Box, Button, Link } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import {
  type AgentThreadCardAction,
  isAgentThreadCardLinkAction,
  isAgentThreadCardLinkUrl
} from '@shared/api/agentThreadCardDisplay'
import { getToolCardActionStyle } from '../chatToolCallDisplay'
import { api } from '../../../utils/windowUtils'

/**
 * show_card actions that cannot answer: a link action (KohakuTerrarium style link) opens its
 * http(s) url in the system browser and never replies; with linksOnly unset, the other buttons of
 * a card that did not wait are shown disabled.
 */
export default function AgentThreadCardActions({
  actions,
  linksOnly = false
}: {
  actions: readonly AgentThreadCardAction[]
  linksOnly?: boolean
}) {
  const shown = actions.filter(
    (action) =>
      (!linksOnly || isAgentThreadCardLinkAction(action)) &&
      (!isAgentThreadCardLinkAction(action) || isAgentThreadCardLinkUrl(action.url))
  )
  if (!shown.length) return null
  return (
    <Box
      data-testid="agent-card-actions"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
        my: '8px',
        px: '4px'
      }}
    >
      {shown.map((action) => {
        if (isAgentThreadCardLinkAction(action)) {
          const url = action.url!
          return (
            <Link
              key={action.id}
              component="button"
              type="button"
              title={url}
              underline="hover"
              onClick={(event: React.MouseEvent) => {
                event.preventDefault()
                // The main process admits only http(s) URLs (svcShell.openExternal).
                void Promise.resolve(api().svcShell.openExternal(url)).catch(() => undefined)
              }}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: 13,
                textAlign: 'left',
                overflowWrap: 'anywhere'
              }}
            >
              <OpenInNewIcon aria-hidden="true" sx={{ fontSize: 14 }} />
              {action.label}
            </Link>
          )
        }
        const style = getToolCardActionStyle(action.style)
        return (
          <Button
            key={action.id}
            size="small"
            disabled
            variant={style?.variant ?? 'outlined'}
            color={style?.color ?? 'primary'}
          >
            {action.label}
          </Button>
        )
      })}
    </Box>
  )
}
