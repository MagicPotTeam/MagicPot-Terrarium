import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LightingPanel } from './LightingPanel'
import { MultiAnglePanel } from './MultiAnglePanel'
import { ViewplanePanel } from './ViewplanePanel'
import {
  canLaunchImageEditWorkflow,
  IMAGE_PERSPECTIVE_WORKFLOW,
  VIDEO_PERSPECTIVE_WORKFLOW
} from './imageEditWorkflowTargets'
import { useNavigate } from 'react-router-dom'

const navigateMock = vi.fn()
const getQAppCfgMock = vi.fn(async () => ({ cfg: {}, workflow: {} }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: vi.fn()
  }
})

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcQApp: {
      getQAppCfg: getQAppCfgMock
    }
  })
}))

describe('ImageEditPanel launchers', () => {
  beforeEach(() => {
    navigateMock.mockClear()
    getQAppCfgMock.mockClear()
    getQAppCfgMock.mockResolvedValue({ cfg: {}, workflow: {} })
    vi.mocked(useNavigate).mockReturnValue(navigateMock)
  })

  it('shows the concrete image and video workflow entry labels', async () => {
    render(<LightingPanel />)

    expect(screen.getByText('Image-side workflow')).toBeInTheDocument()
    expect(screen.getByText('Video-side workflow')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getAllByText('Shipped Quick App template is available.').length
      ).toBeGreaterThan(0)
    )
  })

  it('opens the real perspective/lighting qApp from the lighting panel', async () => {
    render(<LightingPanel />)

    const button = screen.getByRole('button', { name: 'Open image workflow in designer' })
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)

    expect(navigateMock).toHaveBeenCalledWith('/qappdesign', {
      state: { loadQAppKey: IMAGE_PERSPECTIVE_WORKFLOW.key }
    })
  })

  it('opens the shipped video workflow from the lighting panel', async () => {
    render(<LightingPanel />)

    const button = screen.getByRole('button', { name: 'Open video workflow in designer' })
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)

    expect(navigateMock).toHaveBeenCalledWith('/qappdesign', {
      state: { loadQAppKey: VIDEO_PERSPECTIVE_WORKFLOW.key }
    })
  })

  it('opens the same shipped qApp from the multi-angle panel', async () => {
    render(<MultiAnglePanel />)

    const button = screen.getByRole('button', { name: 'Open multi-angle template' })
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)

    expect(navigateMock).toHaveBeenCalledWith('/qappdesign', {
      state: { loadQAppKey: IMAGE_PERSPECTIVE_WORKFLOW.key }
    })
  })

  it('opens the same shipped qApp from the viewplane panel', async () => {
    render(<ViewplanePanel />)

    const button = screen.getByRole('button', { name: 'Open viewplane workflow' })
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)

    expect(navigateMock).toHaveBeenCalledWith('/qappdesign', {
      state: { loadQAppKey: IMAGE_PERSPECTIVE_WORKFLOW.key }
    })
  })

  it('treats empty workflow keys as not launchable', () => {
    expect(
      canLaunchImageEditWorkflow({
        key: '   ',
        title: 'Broken workflow',
        description: 'missing key',
        entryLabel: 'Broken',
        launchLabel: 'Open broken workflow'
      })
    ).toBe(false)
  })

  it('keeps launch buttons disabled when the shipped qApp lookup fails', async () => {
    getQAppCfgMock.mockRejectedValueOnce(new Error('missing qApp'))
    render(<ViewplanePanel />)

    await waitFor(() =>
      expect(
        screen.getByText(
          'Image perspective / lighting is unavailable until its shipped Quick App template can be loaded.'
        )
      ).toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: 'Open viewplane workflow' })).toBeDisabled()
  })
})
