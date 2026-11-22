import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AgentThreadMemoryPanel, { AgentArchiveResponder } from './AgentThreadMemoryPanel'

const getApi = vi.hoisted(() => vi.fn(() => { throw new Error('Removed feature must never request API access') }))
vi.mock('../../../utils/windowUtils', () => ({ api: getApi }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('retired notes and archive responder render nothing and perform no I/O', () => {
  const page = render(<><AgentThreadMemoryPanel /><AgentArchiveResponder /></>)
  expect(page.container).toBeEmptyDOMElement()
  expect(getApi).not.toHaveBeenCalled()
})
