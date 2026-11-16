import { useState, type ComponentProps } from 'react'
import AgentTeamMenu from './AgentTeamMenu'

/**
 * Test stand-in for the composer "+" menu entry that opens team management: the button asks
 * the menu to open through `openRequest`, as the page does.
 */
export function TeamMenuHarness(props: ComponentProps<typeof AgentTeamMenu>) {
  const [requests, setRequests] = useState(0)
  return <>
    <button type="button" aria-label="团队管理" onClick={() => setRequests(value => value + 1)}>团队…</button>
    <AgentTeamMenu {...props} openRequest={(props.openRequest ?? 0) + requests} />
  </>
}
