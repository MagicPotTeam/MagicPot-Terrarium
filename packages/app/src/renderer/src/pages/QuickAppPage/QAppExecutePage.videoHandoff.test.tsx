import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
vi.mock('./components/QAppMenu', () => ({ default: () => null }))
vi.mock('./components/StatusBar', () => ({ default: () => null }))
vi.mock('./ResultList/ResultSection', () => ({ default: () => null }))
vi.mock('./QAppExecutePanel/QAppInputPanel', () => ({ default: () => null }))
vi.mock('./duplicateCheck/DuplicateCheckWorkspace', () => ({ default: () => <div>duplicate-fixture</div> }))
vi.mock('./videoGeneration/VideoGenerationWorkspace', () => ({ default: () => <div>video-workspace-fixture</div> }))
vi.mock('./components/QAppContext', () => ({ QAppContextProvider: ({ children }: { children: React.ReactNode }) => children, dispatchQAppFillParams: vi.fn() }))
import QAppExecutePage from './QAppExecutePage'
function StateWitness() { const location = useLocation(); return <div data-testid="state-witness">{JSON.stringify(location.state)}</div> }
describe('video workspace explicit navigation handoff', () => {
  it('selects video only from explicit fixed state then clears that state', async () => {
    localStorage.removeItem('qapp.currentQAppKey')
    render(<MemoryRouter initialEntries={[{ pathname: '/qappexecute', state: { magicpotOpenVideoGeneration: true } }]}><QAppExecutePage /><StateWitness /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('video-workspace-fixture')).toBeInTheDocument())
    expect(screen.getByTestId('state-witness')).toHaveTextContent('null')
  })
})
