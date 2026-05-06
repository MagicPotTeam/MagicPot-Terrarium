import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import CanvasFilePreviewDialog from './CanvasFilePreviewDialog'
import type { CanvasFileItem } from '../types'
import { CANVAS_OCR_HOVER_EVENT, type CanvasOcrHoverDetail } from '../ocrCanvasUtils'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: 'en-US',
      resolvedLanguage: 'en-US'
    }
  })
}))

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material')

  const Dialog = ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null

  const Menu = ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div role="menu">{children}</div> : null

  const MenuItem = React.forwardRef<
    HTMLButtonElement,
    React.ButtonHTMLAttributes<HTMLButtonElement>
  >(function MockMenuItem({ children, ...props }, ref) {
    return (
      <button ref={ref} type="button" role="menuitem" {...props}>
        {children}
      </button>
    )
  })

  type MockTextFieldProps = {
    children?: React.ReactNode
    multiline?: boolean
    InputProps?: { readOnly?: boolean }
    value?: string
    placeholder?: string
    onChange?: React.ChangeEventHandler<HTMLTextAreaElement | HTMLInputElement>
    onFocus?: React.FocusEventHandler<HTMLTextAreaElement | HTMLInputElement>
    onClick?: React.MouseEventHandler<HTMLTextAreaElement | HTMLInputElement>
  }

  const TextField = React.forwardRef<HTMLTextAreaElement | HTMLInputElement, MockTextFieldProps>(
    function MockTextField(
      { multiline, InputProps, value, placeholder, onChange, onFocus, onClick },
      ref
    ) {
      const readOnly = Boolean(InputProps?.readOnly || !onChange)

      if (multiline) {
        return (
          <textarea
            ref={ref as React.ForwardedRef<HTMLTextAreaElement>}
            readOnly={readOnly}
            value={value}
            placeholder={placeholder}
            onChange={onChange as React.ChangeEventHandler<HTMLTextAreaElement> | undefined}
            onFocus={onFocus as React.FocusEventHandler<HTMLTextAreaElement> | undefined}
            onClick={onClick as React.MouseEventHandler<HTMLTextAreaElement> | undefined}
          />
        )
      }

      return (
        <input
          ref={ref as React.ForwardedRef<HTMLInputElement>}
          readOnly={readOnly}
          value={value}
          placeholder={placeholder}
          onChange={onChange as React.ChangeEventHandler<HTMLInputElement> | undefined}
          onFocus={onFocus as React.FocusEventHandler<HTMLInputElement> | undefined}
          onClick={onClick as React.MouseEventHandler<HTMLInputElement> | undefined}
        />
      )
    }
  )

  return {
    ...actual,
    Dialog,
    Menu,
    MenuItem,
    TextField
  }
})

function createFileItem(overrides: Partial<CanvasFileItem> = {}): CanvasFileItem {
  return {
    id: 'file-1',
    type: 'file',
    src: 'blob:file-1',
    fileName: 'brief.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileKind: 'word',
    x: 0,
    y: 0,
    width: 240,
    height: 160,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    editable: false,
    previewText: 'Full extracted document text.',
    previewImages: [],
    previewSheets: undefined,
    content: undefined,
    ...overrides
  }
}

describe('CanvasFilePreviewDialog', () => {
  it('renders extracted text and embedded preview images for read-only office files', () => {
    render(
      <CanvasFilePreviewDialog
        open
        item={createFileItem({
          previewImages: [
            {
              id: 'image-1',
              src: 'data:image/png;base64,aW1hZ2Ux',
              mimeType: 'image/png',
              fileName: 'image1.png'
            }
          ]
        })}
        draftContent=""
        draftSheets={[]}
        activeOcrHover={null}
        onDraftChange={vi.fn()}
        onDraftSheetsChange={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByDisplayValue('Full extracted document text.')).toBeInTheDocument()
    expect(screen.getByText('Embedded Images (1)')).toBeInTheDocument()
    expect(screen.getByAltText('image1.png')).toHaveAttribute(
      'src',
      'data:image/png;base64,aW1hZ2Ux'
    )
  }, 15000)

  it('supports editable text files', () => {
    const onDraftChange = vi.fn()
    const onSave = vi.fn()

    render(
      <CanvasFilePreviewDialog
        open
        item={createFileItem({
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          fileKind: 'text',
          editable: true
        })}
        draftContent="Editable draft"
        draftSheets={[]}
        activeOcrHover={null}
        onDraftChange={onDraftChange}
        onDraftSheetsChange={vi.fn()}
        onClose={vi.fn()}
        onSave={onSave}
      />
    )

    fireEvent.change(screen.getByDisplayValue('Editable draft'), {
      target: { value: 'Updated draft' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onDraftChange).toHaveBeenCalledWith('Updated draft')
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('offers document export formats from the preview dialog', () => {
    const onExport = vi.fn()

    render(
      <CanvasFilePreviewDialog
        open
        item={createFileItem()}
        draftContent=""
        draftSheets={[]}
        activeOcrHover={null}
        onDraftChange={vi.fn()}
        onDraftSheetsChange={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onExport={onExport}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Markdown (.md)' }))

    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), 'md')
  })

  it('renders worksheet previews for spreadsheet files', () => {
    const previewSheets = [
      {
        id: 'sheet-1',
        name: 'Scores',
        rows: 3,
        cols: 2,
        cells: [
          { row: 1, col: 1, text: 'Name', ocrCellId: 'cell-header-1' },
          { row: 1, col: 2, text: 'Score', ocrCellId: 'cell-header-2' },
          { row: 2, col: 1, text: 'Alice', ocrCellId: 'cell-1', ocrBboxIds: ['box-1'] },
          { row: 2, col: 2, text: '90', ocrCellId: 'cell-2', ocrBboxIds: ['box-2'] }
        ]
      }
    ]

    render(
      <CanvasFilePreviewDialog
        open
        item={createFileItem({
          fileName: 'scores.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileKind: 'excel',
          previewText: undefined,
          ocrBundleId: 'bundle-1',
          previewSheets
        })}
        draftContent=""
        draftSheets={previewSheets}
        activeOcrHover={null}
        onDraftChange={vi.fn()}
        onDraftSheetsChange={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText('Scores')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Scores' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument()
    expect(screen.getByDisplayValue('90')).toBeInTheDocument()
  }, 15000)

  it('dispatches OCR hover events and reflects active OCR cell state in spreadsheet previews', () => {
    const hoverListener = vi.fn()
    window.addEventListener(CANVAS_OCR_HOVER_EVENT, hoverListener as EventListener)

    const item = createFileItem({
      fileName: 'scores.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileKind: 'excel',
      previewText: undefined,
      ocrBundleId: 'bundle-1',
      previewSheets: [
        {
          id: 'sheet-1',
          name: 'Scores',
          rows: 2,
          cols: 2,
          cells: [
            { row: 1, col: 1, text: 'Name', ocrCellId: 'cell-header-1' },
            { row: 1, col: 2, text: 'Score', ocrCellId: 'cell-header-2' },
            { row: 2, col: 1, text: 'Alice', ocrCellId: 'cell-1', ocrBboxIds: ['box-1'] }
          ]
        }
      ]
    })

    const { rerender } = render(
      <CanvasFilePreviewDialog
        open
        item={item}
        draftContent=""
        draftSheets={item.previewSheets || []}
        activeOcrHover={null}
        onDraftChange={vi.fn()}
        onDraftSheetsChange={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    fireEvent.pointerOver(screen.getByDisplayValue('Alice'))

    const hoverEvent = hoverListener.mock.calls
      .map(([event]) => event)
      .find((event) => event instanceof CustomEvent) as
      | CustomEvent<CanvasOcrHoverDetail>
      | undefined

    expect(hoverEvent?.detail).toEqual({
      bundleId: 'bundle-1',
      bboxIds: ['box-1'],
      cellIds: ['cell-1']
    })

    rerender(
      <CanvasFilePreviewDialog
        open
        item={item}
        draftContent=""
        draftSheets={item.previewSheets || []}
        activeOcrHover={{
          bundleId: 'bundle-1',
          bboxIds: ['box-1'],
          cellIds: ['cell-1']
        }}
        onDraftChange={vi.fn()}
        onDraftSheetsChange={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByDisplayValue('Alice').closest('td')).toHaveAttribute(
      'data-ocr-active',
      'true'
    )

    window.removeEventListener(CANVAS_OCR_HOVER_EVENT, hoverListener as EventListener)
  }, 15000)

  it('updates spreadsheet draft cells and saves edited workbook previews', () => {
    const onDraftSheetsChange = vi.fn()
    const onSave = vi.fn()
    const draftSheets = [
      {
        id: 'sheet-1',
        name: 'Scores',
        rows: 2,
        cols: 2,
        cells: [
          { row: 1, col: 1, text: 'Name' },
          { row: 1, col: 2, text: 'Score' },
          { row: 2, col: 1, text: 'Alice' },
          { row: 2, col: 2, text: '90' }
        ]
      }
    ]

    render(
      <CanvasFilePreviewDialog
        open
        item={createFileItem({
          fileName: 'scores.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileKind: 'excel',
          previewText: undefined,
          previewSheets: draftSheets
        })}
        draftContent=""
        draftSheets={draftSheets}
        activeOcrHover={null}
        onDraftChange={vi.fn()}
        onDraftSheetsChange={onDraftSheetsChange}
        onClose={vi.fn()}
        onSave={onSave}
      />
    )

    fireEvent.change(screen.getByDisplayValue('90'), {
      target: { value: '95' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onDraftSheetsChange).toHaveBeenCalledWith([
      {
        id: 'sheet-1',
        name: 'Scores',
        rows: 2,
        cols: 2,
        cells: [
          { row: 1, col: 1, text: 'Name' },
          { row: 1, col: 2, text: 'Score' },
          { row: 2, col: 1, text: 'Alice' },
          { row: 2, col: 2, text: '95' }
        ]
      }
    ])
    expect(onSave).toHaveBeenCalledTimes(1)
  }, 15000)

  it('supports spreadsheet row and column controls from the current cell', () => {
    const onDraftSheetsChange = vi.fn()
    const draftSheets = [
      {
        id: 'sheet-1',
        name: 'Scores',
        rows: 2,
        cols: 2,
        cells: [
          { row: 1, col: 1, text: 'Name' },
          { row: 1, col: 2, text: 'Score' },
          { row: 2, col: 1, text: 'Alice' },
          { row: 2, col: 2, text: '90' }
        ]
      }
    ]

    const { rerender } = render(
      <CanvasFilePreviewDialog
        open
        item={createFileItem({
          fileName: 'scores.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileKind: 'excel',
          previewText: undefined,
          previewSheets: draftSheets
        })}
        draftContent=""
        draftSheets={draftSheets}
        activeOcrHover={null}
        onDraftChange={vi.fn()}
        onDraftSheetsChange={onDraftSheetsChange}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    fireEvent.focus(screen.getByDisplayValue('Alice'))
    fireEvent.click(screen.getByRole('button', { name: 'Add Row' }))

    const nextSheetsAfterRowInsert = [
      {
        id: 'sheet-1',
        name: 'Scores',
        rows: 3,
        cols: 2,
        cells: [
          { row: 1, col: 1, text: 'Name' },
          { row: 1, col: 2, text: 'Score' },
          { row: 2, col: 1, text: 'Alice' },
          { row: 2, col: 2, text: '90' }
        ]
      }
    ]

    expect(onDraftSheetsChange).toHaveBeenNthCalledWith(1, nextSheetsAfterRowInsert)

    rerender(
      <CanvasFilePreviewDialog
        open
        item={createFileItem({
          fileName: 'scores.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileKind: 'excel',
          previewText: undefined,
          previewSheets: nextSheetsAfterRowInsert
        })}
        draftContent=""
        draftSheets={nextSheetsAfterRowInsert}
        activeOcrHover={null}
        onDraftChange={vi.fn()}
        onDraftSheetsChange={onDraftSheetsChange}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    fireEvent.focus(screen.getByDisplayValue('Alice'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Column' }))

    expect(onDraftSheetsChange).toHaveBeenNthCalledWith(2, [
      {
        id: 'sheet-1',
        name: 'Scores',
        rows: 3,
        cols: 1,
        cells: [
          { row: 1, col: 1, text: 'Score' },
          { row: 2, col: 1, text: '90' }
        ]
      }
    ])
  }, 30000)
})
