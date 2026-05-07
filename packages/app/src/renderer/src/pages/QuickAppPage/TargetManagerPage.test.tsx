import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TargetScheme } from '@shared/targetScheme'
import { theme } from '@renderer/theme'
import TargetManagerPage from './TargetManagerPage'

const {
  listTargetSchemesMock,
  saveTargetSchemeMock,
  deleteTargetSchemeMock,
  notifySuccessMock,
  notifyWarningMock,
  setSchemes
} = vi.hoisted(() => {
  let schemesState: TargetScheme[] = []
  const clone = (scheme: TargetScheme): TargetScheme => ({
    ...scheme,
    files: scheme.files.map((file) => ({ ...file }))
  })

  return {
    listTargetSchemesMock: vi.fn(async () => ({
      schemes: schemesState.map(clone)
    })),
    saveTargetSchemeMock: vi.fn(async () => ({})),
    deleteTargetSchemeMock: vi.fn(async () => ({})),
    notifySuccessMock: vi.fn(),
    notifyWarningMock: vi.fn(),
    setSchemes: (schemes: TargetScheme[]) => {
      schemesState = schemes.map(clone)
    }
  }
})

const originalWindowApi = window.api

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: 'en',
      resolvedLanguage: 'en'
    }
  })
}))

vi.mock('./components/CustomWorkshopTabs', () => ({
  default: () => <div data-testid="custom-workshop-tabs" />
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: notifySuccessMock,
    notifyWarning: notifyWarningMock
  })
}))

const renderPage = async () => {
  render(
    <ThemeProvider theme={theme}>
      <TargetManagerPage />
    </ThemeProvider>
  )

  await waitFor(() => expect(listTargetSchemesMock).toHaveBeenCalled())
  await waitFor(() =>
    expect(screen.queryByText('Loading target schemes...')).not.toBeInTheDocument()
  )
}

const openCreateDialog = async () => {
  await renderPage()
  fireEvent.click(screen.getAllByRole('button', { name: 'Create target scheme' })[0])
  return screen.findByRole('dialog')
}

describe('TargetManagerPage', () => {
  beforeEach(() => {
    listTargetSchemesMock.mockClear()
    saveTargetSchemeMock.mockClear()
    deleteTargetSchemeMock.mockClear()
    notifySuccessMock.mockClear()
    notifyWarningMock.mockClear()
    setSchemes([])

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcTargetScheme: {
          listTargetSchemes: listTargetSchemesMock,
          saveTargetScheme: saveTargetSchemeMock,
          deleteTargetScheme: deleteTargetSchemeMock
        }
      } as unknown as Window['api']
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: originalWindowApi
    })
  })

  it('supports saving a scheme with only a description and no files', async () => {
    const dialog = await openCreateDialog()

    expect(within(dialog).getByTestId('target-files-help-button')).toBeInTheDocument()
    expect(within(dialog).getByTestId('target-files-empty-state')).toBeInTheDocument()
    expect(within(dialog).getByTestId('target-file-detail-empty-state')).toBeInTheDocument()

    fireEvent.mouseOver(within(dialog).getByTestId('target-files-help-button'))
    expect(
      await screen.findByText(
        /You can also run the target without any rule or reference files by using only the scheme description/i
      )
    ).toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Run the check using only the scheme description.' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(saveTargetSchemeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          scheme: expect.objectContaining({
            description: 'Run the check using only the scheme description.',
            files: []
          })
        })
      )
    )
  })

  it('allows deleting the last file and keeps the empty optional state visible', async () => {
    setSchemes([
      {
        id: 'scheme-1',
        name: 'Single file scheme',
        description: 'Has one file to start.',
        enabled: true,
        files: [
          {
            id: 'file-1',
            name: 'rules.md',
            content: 'Check spacing and alignment.',
            language: 'markdown',
            mimeType: 'text/markdown'
          }
        ],
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      }
    ])

    await renderPage()
    fireEvent.click(screen.getByText('Single file scheme'))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText('Delete file'))

    expect(within(dialog).getByTestId('target-files-empty-state')).toBeInTheDocument()
    expect(within(dialog).getByTestId('target-file-detail-empty-state')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(saveTargetSchemeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          scheme: expect.objectContaining({
            id: 'scheme-1',
            files: []
          })
        })
      )
    )
  })

  it('wraps long file names instead of forcing a single-line card', async () => {
    const longFileName =
      'game-ui-inspection-rules-for-onboarding-and-new-user-retention-with-extra-notes-and-context.pdf'

    setSchemes([
      {
        id: 'scheme-2',
        name: 'Long file name scheme',
        description: 'Uses a long file name.',
        enabled: true,
        files: [
          {
            id: 'file-long',
            name: longFileName,
            content: 'Reference content',
            language: 'text',
            mimeType: 'application/pdf'
          }
        ],
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      }
    ])

    await renderPage()
    fireEvent.click(screen.getByText('Long file name scheme'))

    const dialog = await screen.findByRole('dialog')
    const fileName = within(dialog).getByTestId('target-file-name-file-long')

    expect(fileName).toHaveTextContent(longFileName)
    expect(fileName).toHaveStyle('white-space: normal')
    expect(fileName).toHaveStyle('overflow-wrap: anywhere')
    expect(fileName).toHaveStyle('word-break: break-word')
  })
})
