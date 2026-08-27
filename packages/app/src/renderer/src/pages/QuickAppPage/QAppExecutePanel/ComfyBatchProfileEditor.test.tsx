import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComfyBatchProfile } from '@shared/api/svcComfyBatch'
import ComfyBatchProfileEditor from './ComfyBatchProfileEditor'

const apiMock = {
  svcComfyBatch: {
    probeProfile: vi.fn()
  }
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (key === 'qapp.batch.test' ? 'Test' : (fallback ?? key))
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => apiMock
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: vi.fn()
  })
}))

const profiles: ComfyBatchProfile[] = [
  {
    id: 'local',
    baseUrl: 'http://127.0.0.1:8188',
    enabled: true,
    maxConcurrency: 1
  },
  {
    id: 'remote',
    baseUrl: 'https://comfy.example.com',
    enabled: false,
    maxConcurrency: 2
  }
]

describe('ComfyBatchProfileEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.svcComfyBatch.probeProfile.mockImplementation(
      async ({ baseUrl }: { baseUrl: string }) => ({
        result: {
          ok: true,
          baseUrl,
          latencyMs: baseUrl.includes('example') ? 12 : 7
        }
      })
    )
  })

  it('tests every configured profile from one top-level button', async () => {
    render(<ComfyBatchProfileEditor profiles={profiles} onProfilesChange={vi.fn()} />)

    const testButton = screen.getByRole('button', { name: 'Test' })
    expect(screen.getAllByRole('button', { name: 'Test' })).toHaveLength(1)
    expect(
      testButton.compareDocumentPosition(screen.getByDisplayValue(profiles[0].baseUrl)) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    fireEvent.click(testButton)

    await waitFor(() => {
      expect(apiMock.svcComfyBatch.probeProfile).toHaveBeenCalledTimes(2)
    })
    expect(apiMock.svcComfyBatch.probeProfile).toHaveBeenCalledWith({
      baseUrl: profiles[0].baseUrl
    })
    expect(apiMock.svcComfyBatch.probeProfile).toHaveBeenCalledWith({
      baseUrl: profiles[1].baseUrl
    })
  })

  it('renders a probe error below its address field', async () => {
    const errorMessage = 'ComfyUI HTTP 404: endpoint not found'
    apiMock.svcComfyBatch.probeProfile.mockRejectedValueOnce(new Error(errorMessage))
    render(<ComfyBatchProfileEditor profiles={profiles} onProfilesChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))

    const error = await screen.findByRole('alert')
    const address = screen.getByDisplayValue(profiles[0].baseUrl)
    const concurrency = screen.getAllByRole('spinbutton', { name: 'Concurrency' })[0]
    expect(concurrency).toBeTruthy()
    expect(error).toHaveTextContent(errorMessage)
    expect(screen.getAllByText(errorMessage)).toHaveLength(1)
    expect(address.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      error.compareDocumentPosition(concurrency) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
