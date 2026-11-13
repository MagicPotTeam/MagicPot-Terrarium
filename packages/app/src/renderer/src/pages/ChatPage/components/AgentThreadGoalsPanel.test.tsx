import React, { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AgentThreadGoalsPanel from './AgentThreadGoalsPanel'
import type { AgentGoalProgressHandle } from '../goalProgressHandle'

const getApi = vi.hoisted(() => vi.fn(() => { throw new Error('Duplicate panel must not access IPC') }))
vi.mock('../../../utils/windowUtils', () => ({ api: getApi }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('retires duplicate goals/counter/cap UI without preparing shares or reading storage', () => {
  const ref = createRef<AgentGoalProgressHandle>()
  const page = render(<AgentThreadGoalsPanel ref={ref} />)
  expect(page.container).toBeEmptyDOMElement()
  expect(ref.current?.take('old-scope', 'profile', true)).toBeUndefined()
  expect(getApi).not.toHaveBeenCalled()
})
